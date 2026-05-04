import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";

const SCHEMA_VERSION = "1.0.0";
const HEAD_SCHEMA_VERSION = "1.0.0";
const EVENT_MATERIAL_VERSION = 1;
const GENESIS_DOMAIN = "psy-genesis-v1";
const SEAL_KEY_BYTES = 32;
const SEAL_KEY_HEX_LENGTH = 64;
const SEAL_KEY_PATTERN = /^[a-f0-9]{64}$/i;
const ROTATION_MAX_DAYS = 30;
const ROTATION_MAX_SIZE_MB = 1024;

const OUTCOMES = new Set([
  "success",
  "handler_error",
  "handler_timeout",
  "audit_error",
  "audit_timeout",
  "rejected_by_path_guard",
  "rejected_by_anonymous_check",
  "redactor_failed",
  "unattributed",
]);

const REDACTION_PATTERNS = [
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED-anthropic-key]"],
  [/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{16,}\b/g, "[REDACTED-openai-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED-aws-access-key]"],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED-google-key]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED-github-pat]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED-github-token]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g, "Bearer [REDACTED-token]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED-jwt]"],
  [/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g, "[REDACTED-pem-private-key]"],
  [
    /(["']?(?:api[_-]?key|secret|token|password|authorization)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
    "$1[REDACTED-secret]",
  ],
];

export class IngestClient {
  constructor({ config, logger = console, env = process.env } = {}) {
    this.config = config;
    this.logger = logger;
    this.env = env;
    this.store = null;
    this.closed = false;
    this.openFailed = false;
  }

  send(envelope) {
    if (this.closed) return false;
    const store = this.ensureStore();
    if (!store) return false;
    let ack;
    try {
      ack = store.appendEnvelope(envelope);
    } catch (error) {
      this.logger.error?.(`psy-core-openclaw: failed to append audit envelope: ${formatError(error)}`);
      return false;
    }
    if (ack.ok === false) {
      this.logger.warn?.(`psy-core-openclaw: ingest rejected audit envelope: ${JSON.stringify(ack)}`);
      return false;
    }
    return true;
  }

  close() {
    this.closed = true;
    if (!this.store) return;
    try {
      this.store.close();
    } catch {}
    this.store = null;
  }

  ensureStore() {
    if (this.store || this.openFailed) return this.store;
    try {
      this.store = new PsyIngestStore(this.config, this.env);
      return this.store;
    } catch (error) {
      this.openFailed = true;
      this.logger.error?.(`psy-core-openclaw: failed to open psy audit store: ${formatError(error)}`);
      return null;
    }
  }
}

export function resolveIngestTarget(config) {
  return {
    dbPath: config.dbPath,
    archivesPath: path.join(path.dirname(config.dbPath), "archives"),
    sealKeyPath: config.sealKeyPath,
    headPath: path.join(path.dirname(config.sealKeyPath), "head.json"),
  };
}

class PsyIngestStore {
  constructor(config, env = process.env) {
    this.config = config;
    this.env = env;
    this.target = resolveIngestTarget(config);
    mkdirSync(path.dirname(this.target.dbPath), { recursive: true });
    mkdirSync(this.target.archivesPath, { recursive: true });
    this.db = new DatabaseSync(this.target.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.ensureSchema();
    this.sealKey = bootstrapSealKey(this.target.sealKeyPath, env.PSY_SEAL_KEY);
  }

  close() {
    this.db.close();
  }

  appendEnvelope(input) {
    const parsed = parseEnvelope(roundTripJson(input));
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }

    const envelope = parsed.envelope;
    const payload = capturePayload(envelope);
    const identity = envelope.identity
      ? {
          actorId: envelope.identity.actor_id ?? null,
          tenantId: envelope.identity.tenant_id ?? null,
          sessionId: envelope.identity.session_id ?? null,
        }
      : undefined;

    try {
      this.assertSealMatchesTail();
      const event =
        envelope.type === "intent"
          ? this.appendIntent({
              operation: envelope.operation,
              callId: envelope.call_id,
              timestamp: envelope.timestamp,
              identity,
              memoryPath: envelope.memory_path,
              purpose: envelope.purpose,
              payload,
            })
          : this.appendResult({
              operation: envelope.operation,
              callId: envelope.call_id,
              timestamp: envelope.timestamp,
              identity,
              memoryPath: envelope.memory_path,
              purpose: envelope.purpose,
              payload,
              outcome: envelope.outcome,
            });
      this.writeHead(event.seq, event.hash, event.timestamp);
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
          code: "E_INGEST_APPEND_FAILED",
          message: formatError(error),
        },
      };
    }
  }

  appendIntent(input) {
    return this.appendDraft(
      createDraftEvent({
        phase: "intent",
        operation: input.operation,
        callId: input.callId,
        payload: normalizeJsonStrings(input.payload ?? null),
        timestamp: input.timestamp,
        identity: input.identity,
        memoryPath: input.memoryPath,
        purpose: input.purpose,
      }),
    );
  }

  appendResult(input) {
    const intentSeq = this.findIntentSeq(input.operation, input.callId);
    if (intentSeq === null && input.outcome !== "unattributed") {
      throw new Error(`No intent found for result ${input.operation}/${input.callId}`);
    }
    return {
      ...this.appendDraft(
        createDraftEvent({
          phase: "result",
          operation: input.operation,
          callId: input.callId,
          payload: normalizeJsonStrings(input.payload ?? null),
          timestamp: input.timestamp,
          identity: input.identity,
          memoryPath: input.memoryPath,
          purpose: input.purpose,
          outcome: input.outcome,
        }),
      ),
      intentSeq,
    };
  }

  appendDraft(draft) {
    this.rotateIfNeeded();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const meta = this.meta();
      const prevHash = meta.chain_head_hash ?? genesisHash(meta.genesis_nonce);
      const lastSeq = Number(meta.last_seq ?? 0);
      const rowWithoutHash = {
        ...draft,
        seq: lastSeq + 1,
        prev_hash: prevHash,
      };
      const event_hash = computeEventHash(rowWithoutHash);
      const event = { ...rowWithoutHash, event_hash };
      this.insertEvent(event);
      this.setMeta("chain_head_hash", event_hash);
      this.setMeta("last_seq", String(event.seq));
      this.db.exec("COMMIT");
      return auditEventToStoredEvent(
        event,
        this.findIntentSeq(event.operation, event.tool_call_id),
        this.rotationSegments().length + 1,
      );
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        schema_version TEXT NOT NULL,
        seq INTEGER PRIMARY KEY,
        event_id TEXT UNIQUE NOT NULL,
        operation_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        operation TEXT NOT NULL,
        audit_phase TEXT NOT NULL CHECK (audit_phase IN ('intent', 'result')),
        tool_call_id TEXT,
        actor_id TEXT,
        tenant_id TEXT,
        session_id TEXT,
        memory_path TEXT NOT NULL,
        purpose TEXT,
        payload_preview TEXT,
        payload_redacted INTEGER NOT NULL CHECK (payload_redacted IN (0, 1)),
        redactor_id TEXT,
        redactor_error TEXT,
        tool_input_hash TEXT NOT NULL,
        tool_output_hash TEXT,
        prev_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL,
        outcome TEXT NOT NULL,
        error_code TEXT,
        error_type TEXT,
        error_message TEXT,
        policy_result TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_operation_id_idx ON events(operation_id);
      CREATE INDEX IF NOT EXISTS events_actor_idx ON events(actor_id);
      CREATE INDEX IF NOT EXISTS events_tenant_idx ON events(tenant_id);
      CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp);
      CREATE TABLE IF NOT EXISTS rotation_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_path TEXT NOT NULL,
        start_seq INTEGER NOT NULL,
        end_seq INTEGER NOT NULL,
        start_hash TEXT NOT NULL,
        end_hash TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        rotated_at TEXT NOT NULL,
        archive_sha256 TEXT
      );
    `);

    const meta = this.meta();
    if (meta.schema_version && meta.schema_version !== SCHEMA_VERSION) {
      throw new Error(`Database schema ${meta.schema_version} requires migration to ${SCHEMA_VERSION}`);
    }
    const nonce = meta.genesis_nonce ?? randomGenesisNonce();
    this.setMeta("schema_version", SCHEMA_VERSION);
    this.setMeta("genesis_nonce", nonce);
    this.setMeta("genesis_hash", meta.genesis_hash ?? genesisHash(nonce));
    this.setMeta("chain_head_hash", meta.chain_head_hash ?? genesisHash(nonce));
    this.setMeta("last_seq", meta.last_seq ?? "0");
  }

  meta() {
    const rows = this.db.prepare("SELECT key, value FROM meta").all();
    const out = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  }

  setMeta(key, value) {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  insertEvent(event) {
    this.db
      .prepare(
        `INSERT INTO events (
          schema_version, seq, event_id, operation_id, timestamp, operation, audit_phase,
          tool_call_id, actor_id, tenant_id, session_id, memory_path, purpose,
          payload_preview, payload_redacted, redactor_id, redactor_error,
          tool_input_hash, tool_output_hash, prev_hash, event_hash, outcome,
          error_code, error_type, error_message, policy_result
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?
        )`,
      )
      .run(
        event.schema_version,
        event.seq,
        event.event_id,
        event.operation_id,
        event.timestamp,
        event.operation,
        event.audit_phase,
        event.tool_call_id,
        event.actor_id,
        event.tenant_id,
        event.session_id,
        event.memory_path,
        event.purpose,
        event.payload_preview,
        event.payload_redacted ? 1 : 0,
        event.redactor_id,
        event.redactor_error,
        event.tool_input_hash,
        event.tool_output_hash,
        event.prev_hash,
        event.event_hash,
        event.outcome,
        event.error_code,
        event.error_type,
        event.error_message,
        event.policy_result,
      );
  }

  findIntentSeq(operation, callId) {
    const row = this.db
      .prepare(
        `SELECT seq
         FROM events
         WHERE audit_phase = 'intent' AND operation = ? AND (tool_call_id = ? OR operation_id = ?)
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get(operation, callId, callId);
    return row?.seq ?? null;
  }

  lastEvent() {
    const row = this.db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT 1").get();
    return row ? rowToEvent(row) : null;
  }

  allActiveEvents() {
    return this.db.prepare("SELECT * FROM events ORDER BY seq ASC").all().map(rowToEvent);
  }

  rotationSegments() {
    return this.db.prepare("SELECT * FROM rotation_segments ORDER BY id ASC").all();
  }

  rotateIfNeeded() {
    const rows = this.allActiveEvents();
    if (rows.length === 0) return;
    const maxBytes = ROTATION_MAX_SIZE_MB * 1024 * 1024;
    const tooLarge = existsSync(this.target.dbPath) && statSync(this.target.dbPath).size >= maxBytes;
    const oldest = new Date(rows[0]?.timestamp ?? Date.now()).getTime();
    const maxAgeMs = ROTATION_MAX_DAYS * 24 * 60 * 60 * 1000;
    const tooOld = Date.now() - oldest >= maxAgeMs;
    if (!tooLarge && !tooOld) return;

    const first = rows[0];
    const last = rows[rows.length - 1];
    const archiveName = `events-${String(first.seq).padStart(8, "0")}-${String(last.seq).padStart(8, "0")}.jsonl.gz`;
    this.rotateRows(path.join(this.target.archivesPath, archiveName), new Date().toISOString());
  }

  rotateRows(archivePath, rotatedAt) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.allActiveEvents();
      if (rows.length === 0) {
        this.db.exec("COMMIT");
        return sha256Hex(Buffer.alloc(0));
      }
      const first = rows[0];
      const last = rows[rows.length - 1];
      const jsonl = `${rows.map((event) => canonicalJson(event)).join("\n")}\n`;
      const archiveBuffer = gzipSync(jsonl);
      const archiveSha256 = sha256Hex(archiveBuffer);
      mkdirSync(path.dirname(archivePath), { recursive: true });
      writeFileSync(archivePath, archiveBuffer, { flag: "wx" });
      this.db
        .prepare(
          `INSERT INTO rotation_segments
          (archive_path, start_seq, end_seq, start_hash, end_hash, row_count, rotated_at, archive_sha256)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(archivePath, first.seq, last.seq, first.prev_hash, last.event_hash, rows.length, rotatedAt, archiveSha256);
      this.db.prepare("DELETE FROM events").run();
      this.setMeta("chain_head_hash", last.event_hash);
      this.setMeta("last_seq", String(last.seq));
      this.db.exec("COMMIT");
      return archiveSha256;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  assertSealMatchesTail() {
    const head = this.readHead();
    if (!head) {
      const tail = this.lastEvent();
      if (tail) this.writeHead(tail.seq, tail.event_hash, tail.timestamp);
      return;
    }
    const tail = this.lastEvent();
    const tailSeq = tail?.seq ?? 0;
    const tailHash = tail?.event_hash ?? null;
    if (tailSeq !== head.seq || tailHash !== head.event_hash) {
      throw new Error(
        `Audit DB tail does not match sealed head - possible truncation or tampering (head seq=${head.seq}, db seq=${tailSeq})`,
      );
    }
  }

  readHead() {
    if (!existsSync(this.target.headPath)) return null;
    const raw = readFileSync(this.target.headPath, "utf8");
    const head = JSON.parse(raw);
    if (!isHeadPointer(head)) {
      throw new Error(`Head pointer schema invalid at ${this.target.headPath}`);
    }
    const expected = computeHmac(this.sealKey, {
      schema_version: head.schema_version,
      seq: head.seq,
      event_hash: head.event_hash,
      timestamp: head.timestamp,
    });
    const expectedBuffer = Buffer.from(expected, "hex");
    const actualBuffer = Buffer.from(head.hmac, "hex");
    if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
      throw new Error("Head pointer HMAC does not match seal key - possible tampering or wrong key");
    }
    return head;
  }

  writeHead(seq, eventHash, timestamp = new Date().toISOString()) {
    const existing = this.readHead();
    if (existing) {
      if (existing.seq > seq) return existing;
      if (existing.seq === seq) {
        if (existing.event_hash !== eventHash) {
          throw new Error(`Sealed head at seq=${seq} already has a different event_hash`);
        }
        return existing;
      }
    }
    const payload = {
      schema_version: HEAD_SCHEMA_VERSION,
      seq,
      event_hash: eventHash,
      timestamp,
    };
    const head = { ...payload, hmac: computeHmac(this.sealKey, payload) };
    atomicWriteJson(this.target.headPath, head);
    return head;
  }

  rollback() {
    try {
      this.db.exec("ROLLBACK");
    } catch {}
  }
}

function parseEnvelope(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return badEnvelope("<root>: Expected object");
  }
  const envelope = raw;
  if (envelope.type !== "intent" && envelope.type !== "result") {
    return badEnvelope("type: Expected 'intent' or 'result'");
  }
  if (!nonEmptyString(envelope.operation)) return badEnvelope("operation: Required");
  if (!nonEmptyString(envelope.call_id)) return badEnvelope("call_id: Required");
  if (envelope.timestamp !== undefined && !nonEmptyString(envelope.timestamp)) {
    return badEnvelope("timestamp: Expected non-empty string");
  }
  if (envelope.memory_path !== undefined && !nonEmptyString(envelope.memory_path)) {
    return badEnvelope("memory_path: Expected non-empty string");
  }
  if (envelope.purpose !== undefined && envelope.purpose !== null && !nonEmptyString(envelope.purpose)) {
    return badEnvelope("purpose: Expected non-empty string or null");
  }
  if (envelope.redact_payload !== undefined && typeof envelope.redact_payload !== "boolean") {
    return badEnvelope("redact_payload: Expected boolean");
  }
  if (envelope.identity !== undefined && !isIdentity(envelope.identity)) {
    return badEnvelope("identity: Expected actor_id/tenant_id/session_id strings");
  }
  if (envelope.type === "result" && envelope.outcome !== undefined && !OUTCOMES.has(envelope.outcome)) {
    return badEnvelope("outcome: Unsupported value");
  }
  return { ok: true, envelope };
}

function badEnvelope(message) {
  return { ok: false, error: { code: "E_INGEST_BAD_ENVELOPE", message } };
}

function isIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(["actor_id", "tenant_id", "session_id"]);
  for (const [key, child] of Object.entries(value)) {
    if (!allowed.has(key)) return false;
    if (child !== null && child !== undefined && !nonEmptyString(child)) return false;
  }
  return true;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function roundTripJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function capturePayload(envelope) {
  if (envelope.payload === undefined || envelope.payload === null) return null;
  if (envelope.redact_payload === false) return envelope.payload;
  return redactJson(envelope.payload);
}

function redactJson(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactJson(child);
    }
    return out;
  }
  return value;
}

function redactString(content) {
  let next = content;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    next = next.replace(pattern, replacement);
  }
  return next;
}

function createDraftEvent(input) {
  const timestamp = timestampString(input.timestamp);
  const payloadJson = canonicalJson(input.payload);
  return {
    schema_version: SCHEMA_VERSION,
    event_id: randomUUID(),
    operation_id: input.callId,
    timestamp,
    operation: input.operation,
    audit_phase: input.phase,
    tool_call_id: input.callId,
    actor_id: input.identity?.actorId ?? null,
    tenant_id: input.identity?.tenantId ?? null,
    session_id: input.identity?.sessionId ?? null,
    memory_path: input.memoryPath ?? "/memories",
    purpose: input.purpose ?? null,
    payload_preview: payloadJson,
    payload_redacted: false,
    redactor_id: null,
    redactor_error: null,
    tool_input_hash: hashCanonical(
      input.phase === "intent" ? input.payload : { callId: input.callId, operation: input.operation },
    ),
    tool_output_hash: input.phase === "result" ? hashCanonical(input.payload) : null,
    outcome: input.outcome ?? "success",
    error_code: null,
    error_type: null,
    error_message: null,
    policy_result: "allow",
  };
}

function rowToEvent(row) {
  return {
    ...row,
    payload_redacted: row.payload_redacted === 1,
  };
}

function auditEventToStoredEvent(event, resolvedIntentSeq, segmentId) {
  return {
    version: EVENT_MATERIAL_VERSION,
    seq: event.seq,
    timestamp: event.timestamp,
    phase: event.audit_phase,
    operation: event.operation,
    callId: event.tool_call_id ?? event.operation_id,
    intentSeq: event.audit_phase === "result" ? resolvedIntentSeq : null,
    payload: event.payload_preview ? JSON.parse(event.payload_preview) : null,
    prevHash: event.prev_hash,
    segmentId,
    hash: event.event_hash,
    archived: false,
  };
}

function timestampString(timestamp) {
  if (timestamp === undefined) return new Date().toISOString();
  return String(timestamp).normalize("NFC");
}

function canonicalJson(value) {
  return stringifyCanonical(normalizeJsonStrings(value));
}

function normalizeJsonStrings(value) {
  return normalizeJsonValue(value, "$", new WeakSet());
}

function normalizeJsonValue(value, location, seen) {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return value.normalize("NFC");
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${location} is not a finite JSON number`);
      return Object.is(value, -0) ? 0 : value;
    case "boolean":
      return value;
    case "object":
      break;
    default:
      throw new TypeError(`${location} is not a JSON value`);
  }
  if (seen.has(value)) throw new TypeError(`${location} contains a circular reference`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalizeJsonValue(item, `${location}[${index}]`, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${location} is not a plain JSON object`);
    }
    const out = {};
    for (const key of Object.keys(value)) {
      const normalizedKey = key.normalize("NFC");
      if (Object.prototype.hasOwnProperty.call(out, normalizedKey)) {
        throw new TypeError(`${location} contains duplicate key after NFC normalization: ${normalizedKey}`);
      }
      out[normalizedKey] = normalizeJsonValue(value[key], `${location}.${normalizedKey}`, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function stringifyCanonical(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stringifyCanonical(item)).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stringifyCanonical(value[key])}`);
  return `{${entries.join(",")}}`;
}

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function randomGenesisNonce() {
  return randomBytes(32).toString("hex");
}

function genesisHash(nonce) {
  return sha256Hex(`${nonce.normalize("NFC")}${GENESIS_DOMAIN}`);
}

function hashCanonical(value) {
  return sha256Hex(canonicalJson(value));
}

function computeEventHash(row) {
  const { event_hash: _eventHash, hash: _hash, ...payload } = row;
  return hashCanonical(payload);
}

function bootstrapSealKey(keyPath, envKey) {
  const trimmedEnv = trimmedEnvKey(envKey);
  if (trimmedEnv) {
    validateHexKey(trimmedEnv, "PSY_SEAL_KEY");
    return Buffer.from(trimmedEnv, "hex");
  }
  if (existsSync(keyPath)) return readSealKey(keyPath);
  const key = randomBytes(SEAL_KEY_BYTES);
  mkdirSync(path.dirname(keyPath), { recursive: true });
  writeKeyFile(keyPath, key);
  return key;
}

function readSealKey(keyPath) {
  const raw = readFileSync(keyPath);
  const trimmed = raw.toString("utf8").trim();
  if (SEAL_KEY_PATTERN.test(trimmed)) return Buffer.from(trimmed, "hex");
  if (raw.length === SEAL_KEY_BYTES) return raw;
  throw new Error(
    `Seal key at ${keyPath} is malformed (expected ${SEAL_KEY_BYTES} raw bytes or ${SEAL_KEY_HEX_LENGTH} hex chars)`,
  );
}

function trimmedEnvKey(envKey) {
  if (typeof envKey !== "string") return null;
  const trimmed = envKey.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function validateHexKey(value, source) {
  if (!SEAL_KEY_PATTERN.test(value)) {
    throw new Error(`${source} must be ${SEAL_KEY_HEX_LENGTH} hex characters (${SEAL_KEY_BYTES} bytes)`);
  }
}

function writeKeyFile(keyPath, key) {
  const tmp = `${keyPath}.tmp.${process.pid}`;
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      unlinkSync(tmp);
    } catch {}
    fd = openSync(tmp, "wx", 0o600);
  }
  try {
    const buffer = Buffer.from(`${key.toString("hex")}\n`, "utf8");
    writeAll(fd, buffer);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, keyPath);
  chmodSync(keyPath, 0o600);
  fsyncDir(path.dirname(keyPath));
}

function computeHmac(key, payload) {
  return createHmac("sha256", key).update(canonicalJson(payload)).digest("hex");
}

function isHeadPointer(value) {
  if (!value || typeof value !== "object") return false;
  return (
    value.schema_version === HEAD_SCHEMA_VERSION &&
    Number.isInteger(value.seq) &&
    value.seq >= 0 &&
    typeof value.event_hash === "string" &&
    value.event_hash.length > 0 &&
    typeof value.timestamp === "string" &&
    typeof value.hmac === "string" &&
    value.hmac.length > 0
  );
}

function atomicWriteJson(target, value) {
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = `${target}.tmp.${process.pid}`;
  let fd;
  try {
    fd = openSync(tmp, "w", 0o644);
    writeAll(fd, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
    fsyncDir(dir);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset, null);
  }
}

function fsyncDir(dirPath) {
  if (process.platform === "win32") return;
  let fd;
  try {
    fd = openSync(dirPath, "r");
    fsyncSync(fd);
  } catch {
    return;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
