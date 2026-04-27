import { randomUUID } from "node:crypto";
import path from "node:path";

import { canonicalJson, type JsonValue } from "./canonical.js";
import { SCHEMA_VERSION, loadConfig, type PsyConfig } from "./config.js";
import { maybeGetContext } from "./context.js";
import { PsyChainBroken, PsyConfigInvalid } from "./errors.js";
import { hashCanonical, randomGenesisNonce } from "./hash.js";
import { Sealer, defaultSealPaths, type HeadPointer } from "./seal.js";
import { PsyStore, type StoreOptions } from "./store.js";
import { verifyStore } from "./verify.js";
import { defaultRegexRedactor } from "./redactor.js";
import type {
  AuditEvent,
  AuditEventInput,
  AuditIdentity,
  AuditQuery,
  AuditRecord,
  AuditStatus,
  AuditorOptions,
  DraftAuditEvent,
  InternalVerifyResult,
  MemoryCommand,
  MemoryToolResult,
  PayloadPreview,
  VerifyResult,
  WrapOptions,
} from "./types.js";
import { validateMemoryCommandPaths } from "./adapters/anthropic-memory/path-guard.js";

export const DEFAULT_AUDIT_DB_PATH = ".psy/events.sqlite";

type AuditorRuntimeOptions = AuditorOptions & Partial<WrapOptions> & { archivesPath?: string };

type AuditJsonObject = { [key: string]: JsonValue | undefined };

export interface AuditPayload extends AuditJsonObject {
  status: AuditStatus;
  command: string;
  identity: JsonValue;
  memoryPath?: string;
  paths?: JsonValue;
  payloadPreview?: JsonValue;
  error?: JsonValue;
  result?: JsonValue;
  purpose?: string;
}

export class Auditor {
  readonly dbPath: string | undefined;
  private readonly store: PsyStore;
  private readonly ownsStore: boolean;
  private readonly now: (() => Date | string) | undefined;
  private readonly options: AuditorRuntimeOptions;
  private sealer: Sealer | null;
  private sealerInitialized: boolean;

  constructor(options: AuditorRuntimeOptions = {}) {
    this.dbPath = options.dbPath ?? (options.store ? undefined : options.config?.sqlite_path ?? defaultAuditDbPath());
    this.store = options.store ?? new PsyStore(storeOptions(this.dbPath ?? DEFAULT_AUDIT_DB_PATH, options.config, options.archivesPath));
    this.ownsStore = !options.store;
    this.now = options.now;
    this.options = options;
    this.sealer = null;
    this.sealerInitialized = false;
  }

  static init(dbPath: string = defaultAuditDbPath()): Auditor {
    return new Auditor({ dbPath });
  }

  static async create(options: WrapOptions = {}): Promise<Auditor> {
    if (!options.store && options.configPath) {
      const loaded = await loadConfig({ configPath: options.configPath });
      return new Auditor({
        ...options,
        config: options.config ?? loaded.config,
        dbPath: options.dbPath ?? loaded.paths.sqlitePath,
        archivesPath: loaded.paths.archivesPath,
      });
    }

    return new Auditor(options);
  }

  record(input: AuditEventInput): AuditRecord {
    const sealer = this.ensureSealer();
    if (sealer) {
      this.assertSealMatchesTail(sealer);
    }
    const event = this.store.append(createDraftEvent(input, this.now));
    if (sealer) {
      sealer.writeHead(event.seq, event.event_hash, event.timestamp);
    }
    return storedEventToAuditEvent(event);
  }

  /**
   * Lazily set up the sealer. Returns null only if seal cannot be initialized
   * (no dbPath context — for in-memory stores or test fixtures that explicitly
   * disable sealing). On first call, also handles v0.1 → v0.2 migration: if
   * the audit DB has rows but no head pointer exists, seal the current tail.
   */
  private ensureSealer(): Sealer | null {
    if (this.sealerInitialized) {
      return this.sealer;
    }
    this.sealerInitialized = true;
    const dbPath = this.dbPath;
    if (!dbPath || dbPath === ':memory:') {
      this.sealer = null;
      return null;
    }
    const paths = defaultSealPaths(dbPath);
    const { sealer } = Sealer.bootstrap({
      ...paths,
      envKey: process.env.PSY_SEAL_KEY,
    });
    this.sealer = sealer;

    const existingHead = sealer.readHead();
    if (!existingHead) {
      // Migration path: existing v0.1 DB with rows but no head.
      const tail = this.store.lastEvent();
      if (tail) {
        sealer.writeHead(tail.seq, tail.event_hash);
      }
    }
    return sealer;
  }

  /**
   * Pre-append guard. The sealed head must match the current DB tail. If they
   * disagree, something has tampered with the DB (or the head) since the last
   * write. Throw before letting the new append silently paper over the gap.
   */
  private assertSealMatchesTail(sealer: Sealer): void {
    // Always read on-disk head, never the in-memory cache: another process
    // (or another instance of this one) may have advanced the seal between
    // our last write and now. A stale cached head paired with a truncated DB
    // would let us re-seal at the truncation point, erasing the evidence.
    const head: HeadPointer | null = sealer.readHead();
    if (!head) {
      // Fresh DB; the migration path already populates head if rows exist.
      return;
    }
    // Query the actual events table, not the meta cache: a direct-DB
    // truncation (e.g. `DELETE FROM events`) leaves meta untouched, so meta
    // alone would miss the tampering. lastEvent() reads the rows themselves.
    const tail = this.store.lastEvent();
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

  async recordCommand(
    handlers: Record<string, (command: MemoryCommand) => unknown>,
    command: MemoryCommand,
  ): Promise<MemoryToolResult> {
    const callId = this.options.callId?.() ?? randomUUID();
    const identityResolution = resolveIdentity(this.options);
    const identity = identityResolution.identity;
    const paths = extractPaths(command);
    const memoryPath = primaryMemoryPath(paths);

    const base = {
      callId,
      command: command.command,
      identity,
      paths,
      ...(memoryPath === undefined ? {} : { memoryPath }),
      ...(this.options.purpose === undefined ? {} : { purpose: this.options.purpose }),
    };

    this.record({
      phase: "intent",
      status: "pending",
      ...base,
    });

    if (identityResolution.error) {
      this.record({
        phase: "result",
        status: "validation_error",
        ...base,
        error: summarizeError(identityResolution.error),
      });
      throw identityResolution.error;
    }

    try {
      validateMemoryCommandPaths(command);
    } catch (error) {
      this.record({
        phase: "result",
        status: "validation_error",
        ...base,
        error: summarizeError(error),
      });
      throw error;
    }

    const handler = handlers[command.command];
    if (typeof handler !== "function") {
      const error = new TypeError(`MemoryToolHandlers.${command.command} must be a function`);
      this.record({
        phase: "result",
        status: "validation_error",
        ...base,
        error: summarizeError(error),
      });
      throw error;
    }

    let result: MemoryToolResult;
    try {
      result = (await handler.call(handlers, command)) as MemoryToolResult;
    } catch (error) {
      this.record({
        phase: "result",
        status: "error",
        ...base,
        error: summarizeError(error),
      });
      throw error;
    }

    let redactorError: unknown;
    let payloadPreview: PayloadPreview | undefined;
    let payloadRedacted = false;
    let redactorId: string | null = null;

    if (shouldCapturePayload(this.options)) {
      try {
        const captured = await payloadPreviewFor(command, this.options);
        payloadPreview = captured?.preview;
        payloadRedacted = captured?.redacted ?? false;
        redactorId = captured?.redactorId ?? null;
      } catch (error) {
        redactorError = error;
        redactorId = activeRedactorId(this.options);
      }
    }

    this.record({
      phase: "result",
      status: redactorError ? "redactor_failed" : "ok",
      ...base,
      ...(redactorError ? { error: summarizeError(redactorError) } : {}),
      ...(payloadPreview === undefined ? {} : { payloadPreview }),
      payloadRedacted,
      redactorId,
      redactorError: redactorError instanceof Error ? redactorError.message : redactorError ? String(redactorError) : null,
      result: summarizeResult(result),
    });

    return result;
  }

  tail(limit = 50): AuditRecord[] {
    const afterSeq = Math.max(0, this.store.meta().last_seq ? Number(this.store.meta().last_seq) - limit : 0);
    return this.store.eventAfter(afterSeq, limit).map(storedEventToAuditEvent);
  }

  query(query: AuditQuery = {}): AuditRecord[] {
    const events = this.store
      .query({
        operation: query.command,
        limit: query.limit,
      })
      .map(storedEventToAuditEvent);

    return events.filter((event) => {
      if (query.callId && event.callId !== query.callId) return false;
      if (query.phase && event.phase !== query.phase) return false;
      if (query.status && event.status !== query.status) return false;
      if (query.since && event.timestamp < toTimestamp(query.since)) return false;
      if (query.until && event.timestamp > toTimestamp(query.until)) return false;
      return true;
    });
  }

  verify(): InternalVerifyResult {
    return toInternalVerifyResult(verifyStore(this.store));
  }

  exportJsonl(query: AuditQuery = {}): string {
    return this.query(query)
      .map((event) => canonicalJson(event))
      .join("\n");
  }

  close(): void {
    if (this.ownsStore) {
      this.store.close();
    }
  }
}

export function defaultAuditDbPath(): string {
  return process.env.PSY_AUDIT_DB_PATH ?? process.env.PSY_DB_PATH ?? DEFAULT_AUDIT_DB_PATH;
}

export function storedEventToAuditEvent(event: AuditEvent): AuditRecord {
  const payload = parsePayload(event);
  const command = commandFromOperation(event.operation);
  const status = event.audit_phase === "intent"
    ? "pending"
    : isAuditStatus(payload.status)
      ? payload.status
      : statusFromOutcome(event.outcome);

  return {
    schemaVersion: 1,
    sequence: event.seq,
    eventId: event.event_id,
    timestamp: event.timestamp,
    phase: event.audit_phase,
    status,
    callId: event.tool_call_id ?? event.operation_id,
    command,
    identity: {
      actorId: event.actor_id,
      tenantId: event.tenant_id,
      sessionId: event.session_id,
    },
    memoryPath: event.memory_path,
    paths: isJsonObject(payload.paths) ? pathsFromJson(payload.paths) : { path: event.memory_path },
    ...(isJsonObject(payload.payloadPreview) ? { payloadPreview: previewFromJson(payload.payloadPreview) } : {}),
    ...(isJsonObject(payload.error)
      ? { error: errorFromJson(payload.error) }
      : event.error_message
        ? {
            error: {
              name: event.error_type ?? "Error",
              message: event.error_message,
              ...(event.error_code === null ? {} : { code: event.error_code }),
            },
          }
        : {}),
    ...(isJsonObject(payload.result) ? { result: resultFromJson(payload.result) } : {}),
    ...(typeof event.purpose === "string" ? { purpose: event.purpose } : {}),
    prevHash: event.prev_hash,
    hash: event.event_hash,
  };
}

export function auditPayload(input: AuditEventInput): AuditPayload {
  return {
    status: input.status,
    command: input.command,
    identity: input.identity as unknown as JsonValue,
    ...(input.memoryPath === undefined ? {} : { memoryPath: input.memoryPath }),
    ...(input.paths === undefined ? {} : { paths: input.paths as unknown as JsonValue }),
    ...(input.payloadPreview === undefined ? {} : { payloadPreview: input.payloadPreview }),
    ...(input.payloadRedacted === undefined ? {} : { payloadRedacted: input.payloadRedacted }),
    ...(input.redactorId === undefined ? {} : { redactorId: input.redactorId }),
    ...(input.redactorError === undefined ? {} : { redactorError: input.redactorError }),
    ...(input.error === undefined ? {} : { error: input.error as unknown as JsonValue }),
    ...(input.result === undefined ? {} : { result: input.result as unknown as JsonValue }),
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
  };
}

export function operationFor(input: Pick<AuditEventInput, "command">): string {
  return input.command;
}

function createDraftEvent(input: AuditEventInput, now?: () => Date | string): DraftAuditEvent {
  const payload = auditPayload(input);
  const operation = operationFor(input);
  const eventId = input.eventId ?? randomUUID();
  const operationId = input.callId;
  const memoryPath = input.memoryPath ?? input.paths?.path ?? input.paths?.old_path ?? input.paths?.new_path ?? "/memories";
  const error = input.error;

  return {
    schema_version: SCHEMA_VERSION,
    event_id: eventId,
    operation_id: operationId,
    timestamp: input.timestamp ?? timestampFromClock(now) ?? new Date().toISOString(),
    operation,
    audit_phase: input.phase,
    tool_call_id: input.callId,
    actor_id: input.identity.actorId,
    tenant_id: input.identity.tenantId,
    session_id: input.identity.sessionId,
    memory_path: memoryPath,
    purpose: input.purpose ?? null,
    payload_preview: input.payloadPreview ? canonicalJson(input.payloadPreview) : null,
    payload_redacted: input.payloadRedacted ?? false,
    redactor_id: input.redactorId ?? null,
    redactor_error: input.redactorError ?? (input.status === "redactor_failed" ? (error?.message ?? "redactor failed") : null),
    tool_input_hash: hashCanonical({
      command: input.command,
      paths: input.paths ?? null,
      payloadPreview: input.payloadPreview ?? null,
    }),
    tool_output_hash:
      input.phase === "result"
        ? hashCanonical({
            status: input.status,
            error: input.error ?? null,
            result: input.result ?? null,
          })
        : null,
    outcome:
      input.status === "validation_error" && error?.code === "E_CONFIG_INVALID"
        ? "rejected_by_anonymous_check"
        : outcomeFromStatus(input.status),
    error_code: error?.code ?? null,
    error_type: error?.name ?? null,
    error_message: error?.message ?? null,
    policy_result: "allow",
  };
}

function storeOptions(dbPath: string, configOverride?: PsyConfig, archivesPathOverride?: string): StoreOptions {
  const sqlitePath = dbPath;
  const archivesPath = archivesPathOverride ?? configOverride?.archives_path ?? path.join(path.dirname(dbPath), "archives");
  const config: PsyConfig = configOverride ?? {
    schema_version: SCHEMA_VERSION,
    sqlite_path: sqlitePath,
    archives_path: archivesPath,
    payload_capture: {
      enabled: false,
      max_bytes: 512,
    },
    rotation: {
      max_days: 30,
      max_size_mb: 1024,
    },
    chain_seed: {
      nonce: randomGenesisNonce(),
    },
    redactor: {
      id: "default-regex-v1",
    },
    seal: "optional",
  };

  return {
    sqlitePath,
    archivesPath,
    config,
  };
}

export function resolveIdentity(options: Pick<WrapOptions, "actorId" | "tenantId" | "sessionId" | "identity" | "allowAnonymous">): {
  identity: AuditIdentity;
  error: PsyConfigInvalid | null;
} {
  const identityInput = options.identity;
  const context = maybeGetContext();
  const identity: AuditIdentity = {
    actorId:
      typeof identityInput === "string"
        ? identityInput
        : (identityInput?.actorId ?? options.actorId ?? context?.actorId ?? null),
    tenantId:
      typeof identityInput === "string"
        ? (options.tenantId ?? context?.tenantId ?? null)
        : (identityInput?.tenantId ?? options.tenantId ?? context?.tenantId ?? null),
    sessionId:
      typeof identityInput === "string"
        ? (options.sessionId ?? context?.sessionId ?? null)
        : (identityInput?.sessionId ?? options.sessionId ?? context?.sessionId ?? null),
  };

  try {
    const hasIdentity = Boolean(identity.actorId ?? identity.tenantId ?? identity.sessionId);
    validateIdentityField(identity.actorId, "actorId", !hasIdentity && options.allowAnonymous !== true);
    validateIdentityField(identity.tenantId, "tenantId", false);
    validateIdentityField(identity.sessionId, "sessionId", false);
    return { identity, error: null };
  } catch (error) {
    return {
      identity,
      error: error instanceof PsyConfigInvalid ? error : new PsyConfigInvalid(String(error)),
    };
  }
}

function validateIdentityField(value: string | null, fieldName: string, required: boolean): void {
  if (value === null) {
    if (required) {
      throw new PsyConfigInvalid(`${fieldName} is required for audited memory writes`, {
        details: { anonymous: true },
      });
    }
    return;
  }
  if (value.trim().length === 0) {
    throw new PsyConfigInvalid(`${fieldName} must be non-empty`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PsyConfigInvalid(`${fieldName} must not contain control characters`);
  }
}

function shouldCapturePayload(options: WrapOptions): boolean {
  return options.includePayloadPreview ?? options.previewPayloads ?? options.config?.payload_capture.enabled ?? false;
}

async function payloadPreviewFor(command: MemoryCommand, options: WrapOptions): Promise<{
  preview: PayloadPreview;
  redacted: boolean;
  redactorId: string | null;
} | undefined> {
  const maxChars = options.payloadPreviewMaxChars ?? options.config?.payload_capture.max_bytes ?? 512;
  const preview: PayloadPreview = {};
  let redacted = false;
  let redactorId: string | null = null;
  for (const field of ["file_text", "insert_text", "new_str"] as const) {
    const value = (command as unknown as Record<string, unknown>)[field];
    if (typeof value !== "string") continue;
    const truncated = truncate(value, maxChars);
    const redactor = options.redactor === undefined ? defaultRegexRedactor : options.redactor;
    if (redactor) {
      redactorId = redactor.id;
      const result = await redactor.redact(truncated);
      preview[field] = result.content;
      redacted ||= result.redacted;
    } else {
      preview[field] = truncated;
    }
  }
  return Object.keys(preview).length === 0 ? undefined : { preview, redacted, redactorId };
}

function activeRedactorId(options: WrapOptions): string | null {
  if (options.redactor === null) return null;
  if (options.redactor) return options.redactor.id;
  return defaultRegexRedactor.id;
}

function truncate(value: string, maxChars: number): string {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.trunc(maxChars)) : 512;
  return value.length > limit ? value.slice(0, limit) : value;
}

function extractPaths(command: MemoryCommand): { path?: string; old_path?: string; new_path?: string } {
  if (command.command === "rename") {
    return {
      old_path: command.old_path,
      new_path: command.new_path,
    };
  }
  return { path: command.path };
}

function primaryMemoryPath(paths: { path?: string; old_path?: string; new_path?: string }): string | undefined {
  return paths.path ?? paths.old_path ?? paths.new_path;
}

function summarizeResult(result: MemoryToolResult): { kind: "string" | "content_blocks" | "unknown"; blockCount?: number } {
  if (typeof result === "string") return { kind: "string" };
  if (Array.isArray(result)) return { kind: "content_blocks", blockCount: result.length };
  return { kind: "unknown" };
}

export function summarizeError(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    const errorWithCode = error as Error & { code?: unknown };
    return {
      name: error.name || "Error",
      message: error.message,
      ...(typeof errorWithCode.code === "string" ? { code: errorWithCode.code } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function toInternalVerifyResult(result: VerifyResult): InternalVerifyResult {
  return {
    ok: result.ok,
    checked: result.checkedRows,
    issues: result.issues.map((issue) => ({
      ...(issue.seq === null ? {} : { sequence: issue.seq }),
      message: `${issue.code}: ${issue.message}`,
    })),
  };
}

function parsePayload(event: AuditEvent): Partial<AuditPayload> {
  if (!event.payload_preview) {
    return {
      status: statusFromOutcome(event.outcome),
      command: commandFromOperation(event.operation),
    };
  }

  try {
    return {
      status: statusFromOutcome(event.outcome),
      command: commandFromOperation(event.operation),
      payloadPreview: JSON.parse(event.payload_preview) as unknown as JsonValue,
    };
  } catch {
    return {
      status: statusFromOutcome(event.outcome),
      command: commandFromOperation(event.operation),
    };
  }
}

function timestampFromClock(now?: () => Date | string): string | undefined {
  if (!now) return undefined;
  return toTimestamp(now());
}

function toTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function commandFromOperation(operation: string): AuditRecord["command"] {
  const command = operation.startsWith("memory.") ? operation.slice("memory.".length) : operation;
  if (
    command === "view" ||
    command === "create" ||
    command === "str_replace" ||
    command === "insert" ||
    command === "delete" ||
    command === "rename"
  ) {
    return command;
  }
  return "view";
}

function isAuditStatus(value: unknown): value is AuditStatus {
  return (
    value === "pending" ||
    value === "ok" ||
    value === "error" ||
    value === "validation_error" ||
    value === "redactor_failed"
  );
}

function outcomeFromStatus(status: AuditStatus): AuditEvent["outcome"] {
  if (status === "error") return "handler_error";
  if (status === "validation_error") return "rejected_by_path_guard";
  if (status === "redactor_failed") return "redactor_failed";
  return "success";
}

function statusFromOutcome(outcome: AuditEvent["outcome"]): AuditStatus {
  if (outcome === "handler_error") return "error";
  if (outcome === "rejected_by_path_guard" || outcome === "rejected_by_anonymous_check") {
    return "validation_error";
  }
  if (outcome === "redactor_failed") return "redactor_failed";
  return "ok";
}

function isJsonObject(value: unknown): value is AuditJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathsFromJson(value: AuditJsonObject): AuditRecord["paths"] {
  return {
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.old_path === "string" ? { old_path: value.old_path } : {}),
    ...(typeof value.new_path === "string" ? { new_path: value.new_path } : {}),
  };
}

function previewFromJson(value: AuditJsonObject): AuditRecord["payloadPreview"] {
  const preview: AuditRecord["payloadPreview"] = {};
  for (const field of ["file_text", "insert_text", "new_str"] as const) {
    const item = value[field];
    if (typeof item === "string") {
      preview[field] = item;
    }
  }
  return Object.keys(preview).length === 0 ? undefined : preview;
}

function errorFromJson(value: AuditJsonObject): AuditRecord["error"] {
  const name = typeof value.name === "string" ? value.name : "Error";
  const message = typeof value.message === "string" ? value.message : "";
  const code = typeof value.code === "string" ? value.code : undefined;
  return {
    name,
    message,
    ...(code === undefined ? {} : { code }),
  };
}

function resultFromJson(value: AuditJsonObject): AuditRecord["result"] {
  const kind = value.kind;
  return {
    kind: kind === "string" || kind === "content_blocks" || kind === "unknown" ? kind : "unknown",
    ...(typeof value.blockCount === "number" ? { blockCount: value.blockCount } : {}),
  };
}
