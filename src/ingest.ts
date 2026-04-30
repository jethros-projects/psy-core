/**
 * Ingest envelope parsing, validation, and dispatch.
 *
 * The `psy ingest` CLI subcommand consumes JSONL on stdin, where each line is
 * an envelope produced by an external observer (such as the `psy-core-hermes`
 * Python plugin). The envelope describes a single audit event — either an
 * intent (pre-tool-call) or a result (post-tool-call / filesystem-confirmed).
 *
 * TypeScript is the sole writer of the audit chain. The envelope schema
 * intentionally mirrors `AppendIntentInput` / `AppendResultInput` rather than
 * the on-disk row shape so callers don't need to canonicalize payloads or
 * compute hashes themselves; the store handles that.
 */
import { z } from 'zod';

import { PsyChainBroken } from './errors.js';
import { defaultRegexRedactor, type Redactor } from './redactor.js';
import type { Sealer } from './seal.js';
import type { PsyStore, StoredEvent } from './store.js';

export const INGEST_PROTOCOL_VERSION = '1.0.0';

const IdentitySchema = z
  .object({
    actor_id: z.string().min(1).nullable().optional(),
    tenant_id: z.string().min(1).nullable().optional(),
    session_id: z.string().min(1).nullable().optional(),
  })
  .strict();

const IntentEnvelopeSchema = z
  .object({
    type: z.literal('intent'),
    operation: z.string().min(1),
    call_id: z.string().min(1),
    timestamp: z.string().min(1).optional(),
    identity: IdentitySchema.optional(),
    memory_path: z.string().min(1).optional(),
    purpose: z.string().min(1).nullable().optional(),
    payload: z.unknown().optional(),
    redact_payload: z.boolean().optional(),
    source: z.string().min(1).optional(),
  })
  .strict();

const ResultEnvelopeSchema = z
  .object({
    type: z.literal('result'),
    operation: z.string().min(1),
    call_id: z.string().min(1),
    timestamp: z.string().min(1).optional(),
    identity: IdentitySchema.optional(),
    memory_path: z.string().min(1).optional(),
    purpose: z.string().min(1).nullable().optional(),
    payload: z.unknown().optional(),
    redact_payload: z.boolean().optional(),
    source: z.string().min(1).optional(),
    outcome: z
      .enum([
        'success',
        'handler_error',
        'handler_timeout',
        'audit_error',
        'audit_timeout',
        'rejected_by_path_guard',
        'rejected_by_anonymous_check',
        'redactor_failed',
        'unattributed',
      ])
      .optional(),
  })
  .strict();

const IngestEnvelopeSchema = z.discriminatedUnion('type', [
  IntentEnvelopeSchema,
  ResultEnvelopeSchema,
]);

export type IntentEnvelope = z.infer<typeof IntentEnvelopeSchema>;
export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>;
export type IngestEnvelope = z.infer<typeof IngestEnvelopeSchema>;

export interface IngestAck {
  ok: boolean;
  type?: 'intent' | 'result';
  call_id?: string;
  seq?: number;
  event_hash?: string;
  error?: { code: string; message: string };
}

export interface IngestStartup {
  ok: true;
  version: string;
  schema_version: string;
}

export interface IngestOptions {
  redactor?: Redactor | null;
  /** Override the default capture/redact behavior. When a payload is captured
   *  with `redact_payload: true` we run the redactor; this option lets tests
   *  inject a deterministic implementation. */
  /** When provided, the sealer is advanced to the new tail after each
   *  successful append (and the existing head is verified against the DB tail
   *  beforehand). Mirrors the sealing wrapper in `Auditor.record`. */
  sealer?: Sealer | null;
}

/**
 * Parse one JSONL line into an envelope. Returns either the validated
 * envelope or a structured error suitable for emitting as an ACK line.
 */
export function parseIngestLine(
  line: string,
): { ok: true; envelope: IngestEnvelope } | { ok: false; error: { code: string; message: string } } {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: { code: 'E_INGEST_EMPTY_LINE', message: 'empty input line' } };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'E_INGEST_BAD_JSON',
        message: error instanceof Error ? error.message : 'invalid JSON',
      },
    };
  }
  const parsed = IngestEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'E_INGEST_BAD_ENVELOPE',
        message: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; '),
      },
    };
  }
  return { ok: true, envelope: parsed.data };
}

/**
 * Append a parsed envelope to the store. Returns the resulting ACK shape.
 */
export async function appendFromEnvelope(
  store: PsyStore,
  envelope: IngestEnvelope,
  options: IngestOptions = {},
): Promise<IngestAck> {
  const payload = await capturePayload(envelope, options);
  const identity = envelope.identity
    ? {
        actorId: envelope.identity.actor_id ?? null,
        tenantId: envelope.identity.tenant_id ?? null,
        sessionId: envelope.identity.session_id ?? null,
      }
    : undefined;

  try {
    if (options.sealer) {
      assertSealMatchesTail(store, options.sealer);
    }
    let event: StoredEvent;
    if (envelope.type === 'intent') {
      event = store.appendIntent({
        operation: envelope.operation,
        callId: envelope.call_id,
        timestamp: envelope.timestamp,
        identity,
        memoryPath: envelope.memory_path,
        purpose: envelope.purpose,
        payload,
      });
    } else {
      event = store.appendResult({
        operation: envelope.operation,
        callId: envelope.call_id,
        timestamp: envelope.timestamp,
        identity,
        memoryPath: envelope.memory_path,
        purpose: envelope.purpose,
        payload,
        outcome: envelope.outcome === 'unattributed' ? 'success' : envelope.outcome,
      });
    }
    if (options.sealer) {
      options.sealer.writeHead(event.seq, event.hash, event.timestamp);
    }
    return {
      ok: true,
      type: envelope.type,
      call_id: envelope.call_id,
      seq: event.seq,
      event_hash: event.hash,
    };
  } catch (error) {
    return {
      ok: false,
      type: envelope.type,
      call_id: envelope.call_id,
      error: {
        code: 'E_INGEST_APPEND_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function assertSealMatchesTail(store: PsyStore, sealer: Sealer): void {
  const head = sealer.readHead();
  if (!head) {
    // Migration path: an existing v0.1 DB with rows but no head pointer.
    const tail = store.lastEvent();
    if (tail) sealer.writeHead(tail.seq, tail.event_hash);
    return;
  }
  const tail = store.lastEvent();
  const tailSeq = tail?.seq ?? 0;
  const tailHash = tail?.event_hash ?? null;
  if (tailSeq !== head.seq || tailHash !== head.event_hash) {
    throw new PsyChainBroken(
      `Audit DB tail does not match sealed head — possible truncation or tampering (head seq=${head.seq}, db seq=${tailSeq})`,
      {
        details: {
          head_seq: head.seq,
          head_event_hash: head.event_hash,
          db_seq: tailSeq,
          db_event_hash: tailHash,
        },
      },
    );
  }
}

async function capturePayload(envelope: IngestEnvelope, options: IngestOptions): Promise<unknown> {
  if (envelope.payload === undefined || envelope.payload === null) return null;
  if (envelope.redact_payload === false) return envelope.payload;
  // Default: redact strings inside the payload via the configured redactor.
  // Server-side redaction provides defense-in-depth; the Python observer
  // already runs an equivalent regex tier before stdio crossing.
  const redactor = options.redactor === undefined ? defaultRegexRedactor : options.redactor;
  if (!redactor) return envelope.payload;
  return redactInPlace(envelope.payload, redactor);
}

async function redactInPlace(value: unknown, redactor: Redactor): Promise<unknown> {
  if (typeof value === 'string') {
    const { content } = await redactor.redact(value);
    return content;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await redactInPlace(item, redactor));
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = await redactInPlace(child, redactor);
    }
    return out;
  }
  return value;
}

export type AppendFromEnvelope = typeof appendFromEnvelope;

export function ingestStartupLine(version: string, schemaVersion: string): string {
  const startup: IngestStartup = {
    ok: true,
    version,
    schema_version: schemaVersion,
  };
  return `${JSON.stringify(startup)}\n`;
}

/**
 * Test-only convenience. Returns an unwrapped envelope or throws.
 */
export function parseIngestLineOrThrow(line: string): IngestEnvelope {
  const result = parseIngestLine(line);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.envelope;
}

export type StoredEventFromIngest = StoredEvent;

export { IngestEnvelopeSchema, IntentEnvelopeSchema, ResultEnvelopeSchema };
