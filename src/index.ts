import type { MemoryToolHandlers as AnthropicMemoryToolHandlers } from '@anthropic-ai/sdk/helpers/beta/memory';

import {
  initConfig,
  loadConfig,
  type ConfigOptions,
} from './config.js';
import { PsyStore } from './store.js';
import { verifyStore } from './verify.js';
import { wrap as wrapInternal } from './adapters/anthropic-memory/wrap.js';
import type {
  AuditEvent,
  AuditIdentityInput,
  MemoryToolHandlers as InternalMemoryToolHandlers,
  QueryFilters,
  VerifyResult,
  WrapOptions as InternalWrapOptions,
} from './types.js';

export type { MemoryToolHandlers } from '@anthropic-ai/sdk/helpers/beta/memory';

export {
  canonicalJson,
  canonicalize,
  normalizeForCanonical,
  normalizeJsonStrings,
} from './canonical.js';
export {
  CONFIG_FILE,
  SCHEMA_VERSION,
  findConfigPath,
  initConfig,
  loadConfig,
} from './config.js';
export {
  getCurrentContext,
  maybeGetContext,
  runWithContext,
} from './context.js';
export {
  PsyAuditTimeout,
  PsyChainBroken,
  PsyConfigInvalid,
  PsyError,
  PsyPathTraversal,
  PsyRedactorFailed,
  PsySchemaMigrationRequired,
  errorCodeFor,
  isPsyError,
  truncateMessage,
} from './errors.js';
export {
  computeEventHash,
  eventHash,
  eventHashPayload,
  genesisHash,
  genesisMaterial,
  hashCanonical,
  isSha256Hex,
  randomGenesisNonce,
  sha256Hex,
} from './hash.js';
// v0.1 → v0.2 back-compat: these helpers physically moved to
// src/adapters/anthropic-memory/path-guard.ts (and ship via
// 'psy-core/anthropic-memory'), but the root entry keeps re-exporting them so
// existing `import { validateMemoryPath } from 'psy-core'` callers don't break.
// New code should prefer the subpath import.
export {
  MEMORY_ROOT,
  validateMemoryCommandPaths,
  validateMemoryPath,
} from './adapters/anthropic-memory/path-guard.js';
export {
  defaultRegexRedactor,
} from './redactor.js';
export {
  HEAD_SCHEMA_VERSION,
  SEAL_KEY_BYTES,
  SEAL_KEY_HEX_LENGTH,
  Sealer,
  defaultSealPaths,
} from './seal.js';
export {
  CURRENT_AUDIT_SCHEMA_VERSION,
  registerProvider,
  getProvider,
  listProviders,
  unregisterProvider,
  clearProviders,
} from './provider.js';
export type {
  AuditEmitter,
  AuditEventIntent,
  AuditEventResult,
  MemoryOperation,
  MemoryProvider,
} from './provider.js';
export type {
  HeadPointer,
  SealPaths,
  SealerOptions,
  BootstrapResult,
} from './seal.js';
export {
  PsyStore,
  insertEvent,
  rowToEvent,
} from './store.js';
export {
  INGEST_PROTOCOL_VERSION,
  IngestEnvelopeSchema,
  IntentEnvelopeSchema,
  ResultEnvelopeSchema,
  appendFromEnvelope,
  ingestStartupLine,
  parseIngestLine,
  parseIngestLineOrThrow,
} from './ingest.js';
export type {
  IngestAck,
  IngestEnvelope,
  IngestOptions,
  IngestStartup,
  IntentEnvelope,
  ResultEnvelope,
} from './ingest.js';
export {
  archivedEvents,
  verifyStore,
} from './verify.js';
export type {
  AuditEvent,
  AuditEventPhase,
  AuditEventStatus,
  AuditIdentity,
  AuditIdentityInput,
  AuditOutcome,
  AuditPhase,
  DraftAuditEvent,
  ExportFormat,
  MemoryCommand,
  MemoryCommandName,
  MemoryToolCommand,
  MemoryToolResult,
  QueryFilters,
  QueryResult,
  VerificationResult,
  VerifyIssue,
  VerifyResult,
} from './types.js';

export interface WrapOptions extends InternalWrapOptions {
  databasePath?: string;
  actor?: string;
  runId?: string;
}

export interface InitOptions extends ConfigOptions {
  dbPath?: string;
  databasePath?: string;
  migrate?: boolean;
}

export interface InitResult {
  databasePath: string;
  created: boolean;
  migrated: boolean;
  migrationsApplied: number;
}

export interface TailOptions extends ConfigOptions {
  dbPath?: string;
  databasePath?: string;
  limit?: number;
}

export interface QueryOptions extends QueryFilters, ConfigOptions {
  dbPath?: string;
  databasePath?: string;
}

export interface VerifyOptions extends ConfigOptions {
  dbPath?: string;
  databasePath?: string;
  all?: boolean;
}

export interface ExportOptions extends QueryOptions {
  format?: 'jsonl' | 'ndjson';
}

export function wrap(
  handlers: AnthropicMemoryToolHandlers,
  options: WrapOptions = {},
): AnthropicMemoryToolHandlers {
  const { actor, databasePath, runId, ...rest } = options;
  const identity =
    rest.identity ??
    (actor || runId
      ? ({ actor, runId } as unknown as AuditIdentityInput)
      : undefined);

  return wrapInternal(
    handlers as unknown as InternalMemoryToolHandlers,
    {
      ...rest,
      dbPath: rest.dbPath ?? databasePath,
      identity,
    },
  ) as unknown as AnthropicMemoryToolHandlers;
}

export async function init(options: InitOptions = {}): Promise<InitResult> {
  const { created, paths } = await initConfig(options);
  return {
    databasePath: options.dbPath ?? options.databasePath ?? paths.sqlitePath,
    created,
    migrated: Boolean(options.migrate),
    migrationsApplied: 0,
  };
}

export async function tail(options: TailOptions = {}): Promise<AuditEvent[]> {
  return withStore(options, (store) =>
    store.query({ limit: options.limit ?? 20 }),
  );
}

export async function query(options: QueryOptions = {}): Promise<AuditEvent[]> {
  return withStore(options, (store) =>
    store.query({
      actor: options.actor,
      tenant: options.tenant,
      session: options.session,
      operation: normalizeOperation(options.operation),
      since: normalizeSince(options.since),
      limit: options.limit,
      offset: options.offset,
    }),
  );
}

export async function verify(options: VerifyOptions = {}): Promise<VerifyResult> {
  return withStore(options, (store) =>
    verifyStore(store, { includeArchives: options.all }),
  );
}

export async function exportEvents(options: ExportOptions = {}): Promise<AuditEvent[]> {
  return query(options);
}

async function withStore<T>(
  options: ConfigOptions & { dbPath?: string; databasePath?: string },
  callback: (store: PsyStore) => T,
): Promise<T> {
  const { config, paths } = await loadConfig(options);
  const store = new PsyStore({
    sqlitePath: options.dbPath ?? options.databasePath ?? paths.sqlitePath,
    archivesPath: paths.archivesPath,
    config,
  });

  try {
    return callback(store);
  } finally {
    store.close();
  }
}

function normalizeOperation(operation: string | undefined): string | undefined {
  return operation?.startsWith('memory.') ? operation : operation ? `memory.${operation}` : undefined;
}

function normalizeSince(value: QueryFilters['since']): Date | undefined {
  if (value === undefined || value instanceof Date) {
    return value;
  }
  return new Date(value);
}
