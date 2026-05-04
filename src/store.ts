import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import type { PsyConfig } from './config.js';
import { SCHEMA_VERSION } from './config.js';
import { canonicalJson, normalizeJsonStrings, type JsonValue } from './canonical.js';
import { PsyAuditTimeout, PsySchemaMigrationRequired } from './errors.js';
import { computeEventHash, genesisHash, hashCanonical, randomGenesisNonce, sha256Hex } from './hash.js';
import type { AuditEvent, DraftAuditEvent, QueryFilters } from './types.js';

export interface StoreOptions {
  sqlitePath: string;
  archivesPath: string;
  config: PsyConfig;
}

export interface StoreCompatOptions {
  genesisNonce?: string;
  archivesPath?: string;
  config?: Partial<PsyConfig>;
  busyTimeoutMs?: number;
}

export type EventPhase = 'intent' | 'result';

export const EVENT_MATERIAL_VERSION = 1;
export const ARCHIVE_RECORD_SCHEMA = 'psy-rotation-event-v1';

export interface EventHashMaterial {
  version: number;
  seq: number;
  timestamp: string;
  phase: EventPhase;
  operation: string;
  callId: string;
  intentSeq: number | null;
  payload: JsonValue;
  prevHash: string;
  segmentId: number;
}

export interface StoredEvent extends EventHashMaterial {
  hash: string;
  archived: boolean;
}

export interface AppendIdentityInput {
  actorId?: string | null;
  tenantId?: string | null;
  sessionId?: string | null;
}

export interface AppendIntentInput {
  operation: string;
  payload?: unknown;
  callId?: string;
  timestamp?: string | Date;
  identity?: AppendIdentityInput;
  memoryPath?: string;
  purpose?: string | null;
  outcome?: import('./types.js').AuditOutcome;
}

export interface AppendResultInput {
  operation: string;
  payload?: unknown;
  callId: string;
  intentSeq?: number | null;
  timestamp?: string | Date;
  identity?: AppendIdentityInput;
  memoryPath?: string;
  purpose?: string | null;
  outcome?: import('./types.js').AuditOutcome;
}

export interface QueryEventsOptions {
  includeArchived?: boolean;
  phase?: EventPhase;
  operation?: string;
  callId?: string;
  fromSeq?: number;
  toSeq?: number;
  limit?: number;
}

export interface StoreHead {
  seq: number;
  hash: string;
  activeSegmentId: number;
}

export interface RotationOptions {
  archivePath: string;
  prune?: boolean;
  timestamp?: string | Date;
}

export interface RotationResult {
  rotated: boolean;
  archivePath: string | null;
  archiveSha256: string | null;
  segmentId: number;
  nextSegmentId: number;
  startSeq: number;
  endSeq: number;
  headHash: string;
  eventCount: number;
  pruned: boolean;
}

type EventRow = Omit<AuditEvent, 'payload_redacted'> & { payload_redacted: 0 | 1 };

export class PsyStore {
  readonly db: Database.Database;
  readonly sqlitePath: string;
  readonly archivesPath: string;
  readonly config: PsyConfig;

  constructor(options: StoreOptions | string, compatOptions: StoreCompatOptions = {}) {
    const normalized = normalizeStoreOptions(options, compatOptions);
    this.sqlitePath = normalized.sqlitePath;
    this.archivesPath = normalized.archivesPath;
    this.config = normalized.config;
    if (this.sqlitePath !== ':memory:') {
      mkdirSync(path.dirname(this.sqlitePath), { recursive: true });
    }
    mkdirSync(this.archivesPath, { recursive: true });
    this.db = new Database(this.sqlitePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma(`busy_timeout = ${compatOptions.busyTimeoutMs ?? 5000}`);
    this.ensureSchema();
  }

  close(): void {
    this.db.close();
  }

  getMeta(): Record<string, string> {
    return this.meta();
  }

  getHead(): StoreHead {
    const meta = this.meta();
    return {
      seq: Number(meta.last_seq ?? 0),
      hash: meta.chain_head_hash ?? genesisHash(this.config.chain_seed.nonce),
      activeSegmentId: this.rotationSegments().length + 1,
    };
  }

  appendIntent(input: AppendIntentInput): StoredEvent {
    const callId = input.callId ?? randomUUID();
    const payload = normalizeJsonStrings(input.payload ?? null);
    const event = this.append(compatDraft({
      phase: 'intent',
      operation: input.operation,
      callId,
      payload,
      timestamp: input.timestamp,
      identity: input.identity,
      memoryPath: input.memoryPath,
      purpose: input.purpose,
      outcome: input.outcome,
    }));
    return this.toStoredEvent(event);
  }

  appendResult(input: AppendResultInput): StoredEvent {
    const intentSeq = input.intentSeq ?? this.findIntentSeq(input.operation, input.callId);
    if (intentSeq === null && input.outcome !== 'unattributed') {
      throw new Error(`No intent found for result ${input.operation}/${input.callId}`);
    }

    const payload = normalizeJsonStrings(input.payload ?? null);
    const event = this.append(compatDraft({
      phase: 'result',
      operation: input.operation,
      callId: input.callId,
      payload,
      timestamp: input.timestamp,
      identity: input.identity,
      memoryPath: input.memoryPath,
      purpose: input.purpose,
      outcome: input.outcome,
    }));
    return { ...this.toStoredEvent(event), intentSeq };
  }

  append(draft: DraftAuditEvent): AuditEvent {
    this.rotateIfNeeded();
    const started = Date.now();
    const delays = [10, 100, 1000];
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= delays.length) {
      try {
        return this.appendOnce(draft);
      } catch (error) {
        lastError = error;
        this.safeRollback();
        if (!isBusyError(error)) break;
        if (Date.now() - started > 5000 || attempt === delays.length) {
          throw new PsyAuditTimeout('Audit append timed out waiting for SQLite writer lock', {
            cause: error,
            operationId: draft.operation_id,
          });
        }
        sleep(delays[attempt] ?? 1000);
        attempt += 1;
      }
    }

    throw lastError;
  }

  query(filters: QueryFilters = {}): AuditEvent[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filters.actor) {
      where.push('actor_id = @actor');
      params.actor = filters.actor;
    }
    if (filters.tenant) {
      where.push('tenant_id = @tenant');
      params.tenant = filters.tenant;
    }
    if (filters.session) {
      where.push('session_id = @session');
      params.session = filters.session;
    }
    if (filters.operation) {
      const operations = Array.isArray(filters.operation) ? filters.operation : [filters.operation];
      if (operations.length === 1) {
        where.push('operation = @operation');
        params.operation = operations[0];
      } else if (operations.length > 1) {
        const placeholders = operations.map((_operation, index) => `@operation${index}`);
        where.push(`operation IN (${placeholders.join(', ')})`);
        operations.forEach((operation, index) => {
          params[`operation${index}`] = operation;
        });
      }
    }
    if (filters.since) {
      where.push('timestamp >= @since');
      params.since = filters.since.toISOString();
    }
    params.limit = filters.limit ?? 100;
    params.offset = filters.offset ?? 0;

    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq ASC LIMIT @limit OFFSET @offset`;
    return this.db.prepare(sql).all(params).map(rowToEvent);
  }

  tail(limit = 20, options: Omit<QueryEventsOptions, 'limit'> = {}): StoredEvent[] {
    if (limit <= 0) return [];
    return this.queryEvents({ ...options, limit }).slice(-limit);
  }

  queryEvents(options: QueryEventsOptions = {}): StoredEvent[] {
    if (options.includeArchived) {
      return archivedEventsFromStore(this)
        .concat(this.allActiveEvents())
        .filter((event) => compatEventMatches(event, options))
        .sort((left, right) => left.seq - right.seq)
        .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
        .map((event) => this.toStoredEvent(event));
    }

    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (options.phase) {
      where.push('audit_phase = @phase');
      params.phase = options.phase;
    }
    if (options.operation) {
      where.push('operation = @operation');
      params.operation = options.operation;
    }
    if (options.callId) {
      where.push('(tool_call_id = @callId OR operation_id = @callId)');
      params.callId = options.callId;
    }
    if (options.fromSeq !== undefined) {
      where.push('seq >= @fromSeq');
      params.fromSeq = options.fromSeq;
    }
    if (options.toSeq !== undefined) {
      where.push('seq <= @toSeq');
      params.toSeq = options.toSeq;
    }
    params.limit = options.limit ?? 100;
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq ASC LIMIT @limit`;
    return this.db.prepare(sql).all(params).map(rowToEvent).map((event) => this.toStoredEvent(event));
  }

  allActiveEvents(): AuditEvent[] {
    return this.db.prepare('SELECT * FROM events ORDER BY seq ASC').all().map(rowToEvent);
  }

  eventAfter(seq: number, limit = 100): AuditEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(seq, limit).map(rowToEvent);
  }

  /**
   * Return the actual highest-seq row from the events table, or null if empty.
   * Reads rows directly (not the meta cache) so that direct-DB tampering
   * which leaves meta untouched still surfaces. O(log N) on the seq B-tree.
   */
  lastEvent(): AuditEvent | null {
    const row = this.db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT 1').get();
    return row ? rowToEvent(row) : null;
  }

  meta(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  rotationSegments(): Array<{
    id: number;
    archive_path: string;
    start_seq: number;
    end_seq: number;
    start_hash: string;
    end_hash: string;
    row_count: number;
    rotated_at: string;
    archive_sha256: string | null;
  }> {
    return this.db.prepare('SELECT * FROM rotation_segments ORDER BY id ASC').all() as ReturnType<PsyStore['rotationSegments']>;
  }

  exportJsonl(): string {
    return this.allActiveEvents().map((event) => canonicalJson(event)).join('\n') + (this.allActiveEvents().length ? '\n' : '');
  }

  rotateActiveSegment(options: RotationOptions): RotationResult {
    const rows = this.allActiveEvents();
    const segmentId = this.rotationSegments().length + 1;
    const head = this.getHead();
    if (rows.length === 0) {
      return {
        rotated: false,
        archivePath: null,
        archiveSha256: null,
        segmentId,
        nextSegmentId: segmentId,
        startSeq: head.seq + 1,
        endSeq: head.seq,
        headHash: head.hash,
        eventCount: 0,
        pruned: false,
      };
    }

    const archivePath = path.resolve(options.archivePath);
    const archiveSha256 = this.rotateRows(rows, archivePath, timestampString(options.timestamp));
    const last = rows[rows.length - 1]!;
    return {
      rotated: true,
      archivePath,
      archiveSha256,
      segmentId,
      nextSegmentId: segmentId + 1,
      startSeq: rows[0]!.seq,
      endSeq: last.seq,
      headHash: last.event_hash,
      eventCount: rows.length,
      pruned: true,
    };
  }

  private appendOnce(draft: DraftAuditEvent): AuditEvent {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const meta = this.meta();
      const prevHash = meta.chain_head_hash ?? genesisHash(this.config.chain_seed.nonce);
      const lastSeq = Number(meta.last_seq ?? 0);
      const rowWithoutHash = {
        ...draft,
        seq: lastSeq + 1,
        prev_hash: prevHash,
      };
      const event_hash = computeEventHash(rowWithoutHash);
      const event: AuditEvent = { ...rowWithoutHash, event_hash };
      insertEvent(this.db, event);
      this.setMeta('chain_head_hash', event_hash);
      this.setMeta('last_seq', String(event.seq));
      this.db.exec('COMMIT');
      return event;
    } catch (error) {
      this.safeRollback();
      throw error;
    }
  }

  private findIntentSeq(operation: string, callId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT seq
         FROM events
         WHERE audit_phase = 'intent' AND operation = ? AND (tool_call_id = ? OR operation_id = ?)
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get(operation, callId, callId) as { seq: number } | undefined;
    return row?.seq ?? null;
  }

  private toStoredEvent(event: AuditEvent): StoredEvent {
    return auditEventToStoredEvent(event, this.findIntentSeq(event.operation, event.tool_call_id ?? event.operation_id), this.rotationSegments().length + 1);
  }

  private rotateIfNeeded(): void {
    const rows = this.allActiveEvents();
    if (rows.length === 0) return;
    const maxBytes = this.config.rotation.max_size_mb * 1024 * 1024;
    const tooLarge = existsSync(this.sqlitePath) && statSync(this.sqlitePath).size >= maxBytes;
    const oldest = new Date(rows[0]?.timestamp ?? Date.now()).getTime();
    const maxAgeMs = this.config.rotation.max_days * 24 * 60 * 60 * 1000;
    const tooOld = Date.now() - oldest >= maxAgeMs;
    if (!tooLarge && !tooOld) return;

    const first = rows[0]!;
    const last = rows[rows.length - 1]!;
    const archiveName = `events-${String(first.seq).padStart(8, '0')}-${String(last.seq).padStart(8, '0')}.jsonl.gz`;
    this.rotateRows(rows, path.join(this.archivesPath, archiveName), new Date().toISOString());
  }

  private rotateRows(rows: AuditEvent[], archivePath: string, rotatedAt: string): string {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lockedRows = this.allActiveEvents();
      if (lockedRows.length === 0) {
        this.db.exec('COMMIT');
        return sha256Hex(Buffer.alloc(0));
      }
      const first = lockedRows[0]!;
      const last = lockedRows[lockedRows.length - 1]!;
      const jsonl = lockedRows.map((event) => canonicalJson(event)).join('\n') + '\n';
      const archiveBuffer = gzipSync(jsonl);
      const archiveSha256 = sha256Hex(archiveBuffer);
      mkdirSync(path.dirname(archivePath), { recursive: true });
      writeFileSync(archivePath, archiveBuffer, { flag: 'wx' });
      this.db
        .prepare(
          `INSERT INTO rotation_segments
          (archive_path, start_seq, end_seq, start_hash, end_hash, row_count, rotated_at, archive_sha256)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(archivePath, first.seq, last.seq, first.prev_hash, last.event_hash, lockedRows.length, rotatedAt, archiveSha256);
      this.db.prepare('DELETE FROM events').run();
      this.setMeta('chain_head_hash', last.event_hash);
      this.setMeta('last_seq', String(last.seq));
      this.db.exec('COMMIT');
      return archiveSha256;
    } catch (error) {
      this.safeRollback();
      throw error;
    }
  }

  private ensureSchema(): void {
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

    const existingVersion = this.meta().schema_version;
    if (existingVersion && existingVersion !== SCHEMA_VERSION) {
      throw new PsySchemaMigrationRequired(`Database schema ${existingVersion} requires migration to ${SCHEMA_VERSION}`);
    }
    this.setMeta('schema_version', SCHEMA_VERSION);
    if (!this.meta().genesis_nonce) this.setMeta('genesis_nonce', this.config.chain_seed.nonce);
    if (!this.meta().genesis_hash) this.setMeta('genesis_hash', genesisHash(this.config.chain_seed.nonce));
    if (!this.meta().chain_head_hash) this.setMeta('chain_head_hash', genesisHash(this.config.chain_seed.nonce));
    if (!this.meta().last_seq) this.setMeta('last_seq', '0');
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private safeRollback(): void {
    try {
      if (this.db.inTransaction) this.db.exec('ROLLBACK');
    } catch {
      // Best effort rollback only.
    }
  }
}

export function insertEvent(db: Database.Database, event: AuditEvent): void {
  db.prepare(
    `INSERT INTO events (
      schema_version, seq, event_id, operation_id, timestamp, operation, audit_phase,
      tool_call_id, actor_id, tenant_id, session_id, memory_path, purpose,
      payload_preview, payload_redacted, redactor_id, redactor_error,
      tool_input_hash, tool_output_hash, prev_hash, event_hash, outcome,
      error_code, error_type, error_message, policy_result
    ) VALUES (
      @schema_version, @seq, @event_id, @operation_id, @timestamp, @operation, @audit_phase,
      @tool_call_id, @actor_id, @tenant_id, @session_id, @memory_path, @purpose,
      @payload_preview, @payload_redacted, @redactor_id, @redactor_error,
      @tool_input_hash, @tool_output_hash, @prev_hash, @event_hash, @outcome,
      @error_code, @error_type, @error_message, @policy_result
    )`,
  ).run({ ...event, payload_redacted: event.payload_redacted ? 1 : 0 });
}

export function rowToEvent(row: unknown): AuditEvent {
  const event = row as EventRow;
  return {
    ...event,
    payload_redacted: event.payload_redacted === 1,
  };
}

export function openStore(dbPath: string, options: StoreCompatOptions = {}): PsyStore {
  return new PsyStore(dbPath, options);
}

export function initStore(dbPath: string, options: StoreCompatOptions = {}): void {
  const store = openStore(dbPath, options);
  store.close();
}

export function auditEventToStoredEvent(
  event: AuditEvent,
  resolvedIntentSeq: number | null,
  segmentId: number,
): StoredEvent {
  return {
    version: EVENT_MATERIAL_VERSION,
    seq: event.seq,
    timestamp: event.timestamp,
    phase: event.audit_phase,
    operation: event.operation,
    callId: event.tool_call_id ?? event.operation_id,
    intentSeq: event.audit_phase === 'result' ? resolvedIntentSeq : null,
    payload: parsePayload(event.payload_preview),
    prevHash: event.prev_hash,
    segmentId,
    hash: event.event_hash,
    archived: false,
  };
}

function normalizeStoreOptions(options: StoreOptions | string, compatOptions: StoreCompatOptions): StoreOptions {
  if (typeof options !== 'string') {
    return options;
  }

  const sqlitePath = options;
  const nonce = compatOptions.genesisNonce ?? randomGenesisNonce();
  const archivesPath = compatOptions.archivesPath ?? path.join(path.dirname(path.resolve(sqlitePath)), 'archives');
  const config = {
    schema_version: SCHEMA_VERSION,
    sqlite_path: sqlitePath,
    archives_path: archivesPath,
    payload_capture: { enabled: false, max_bytes: 512 },
    rotation: { max_days: 30, max_size_mb: 1024 },
    chain_seed: { nonce },
    redactor: { id: 'default-regex-v1' },
    ...compatOptions.config,
  } as PsyConfig;

  return { sqlitePath, archivesPath, config };
}

function compatDraft(input: {
  phase: EventPhase;
  operation: string;
  callId: string;
  payload: JsonValue;
  timestamp?: string | Date;
  identity?: AppendIdentityInput;
  memoryPath?: string;
  purpose?: string | null;
  outcome?: import('./types.js').AuditOutcome;
}): DraftAuditEvent {
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
    memory_path: input.memoryPath ?? '/memories',
    purpose: input.purpose ?? null,
    payload_preview: payloadJson,
    payload_redacted: false,
    redactor_id: null,
    redactor_error: null,
    tool_input_hash: hashCanonical(input.phase === 'intent' ? input.payload : { callId: input.callId, operation: input.operation }),
    tool_output_hash: input.phase === 'result' ? hashCanonical(input.payload) : null,
    outcome: input.outcome ?? 'success',
    error_code: null,
    error_type: null,
    error_message: null,
    policy_result: 'allow',
  };
}

function parsePayload(payloadPreview: string | null): JsonValue {
  if (!payloadPreview) {
    return null;
  }
  return normalizeJsonStrings(JSON.parse(payloadPreview));
}

function compatEventMatches(event: AuditEvent, options: QueryEventsOptions): boolean {
  if (options.phase && event.audit_phase !== options.phase) return false;
  if (options.operation && event.operation !== options.operation) return false;
  if (options.callId && event.tool_call_id !== options.callId && event.operation_id !== options.callId) return false;
  if (options.fromSeq !== undefined && event.seq < options.fromSeq) return false;
  if (options.toSeq !== undefined && event.seq > options.toSeq) return false;
  return true;
}

function archivedEventsFromStore(store: PsyStore): AuditEvent[] {
  const rows: AuditEvent[] = [];
  for (const segment of store.rotationSegments()) {
    const jsonl = gzipToJsonl(segment.archive_path);
    rows.push(...jsonl.split('\n').filter(Boolean).map((line) => rowToEvent(JSON.parse(line))));
  }
  return rows;
}

function gzipToJsonl(archivePath: string): string {
  return gunzipSync(readFileSync(archivePath)).toString('utf8');
}

function timestampString(timestamp: string | Date | undefined): string {
  if (timestamp === undefined) return new Date().toISOString();
  if (timestamp instanceof Date) return timestamp.toISOString();
  return timestamp.normalize('NFC');
}

function isBusyError(error: unknown): boolean {
  return error instanceof Error && /\b(SQLITE_BUSY|SQLITE_LOCKED|database is locked)\b/i.test(error.message);
}

function sleep(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}
