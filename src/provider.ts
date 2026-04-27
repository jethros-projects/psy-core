import { satisfies as semverSatisfies, validRange } from 'semver';

import { PsyConfigInvalid } from './errors.js';

/**
 * Canonical memory operations recorded in the audit log.
 *
 * The naming follows Anthropic's MemoryTool surface (filesystem-shaped CRUD)
 * because that was psy v0.1's first integration. Other adapters (Letta blocks,
 * Mastra working memory, Mem0 facts, etc.) map their native operations onto
 * this enum and use synthetic memory paths with adapter-scoped schemes
 * (e.g., `letta://blocks/<id>`, `mastra://working-memory/<key>`,
 * `mem0://users/<u>/fact-<n>`) to disambiguate.
 *
 * If a future framework's operation genuinely doesn't fit any of these six,
 * the schema would need to bump (current schema is `auditSchemaVersion = "1.0.0"`).
 */
export type MemoryOperation =
  | 'view'
  | 'create'
  | 'str_replace'
  | 'insert'
  | 'delete'
  | 'rename';

/**
 * Schema version of the audit event format that psy emits to SQLite.
 * Bumps when the 26-field row schema changes incompatibly.
 */
export const CURRENT_AUDIT_SCHEMA_VERSION = '1.0.0';

/**
 * MemoryProvider — registration metadata for a memory-framework adapter.
 *
 * This is the contract every adapter package implements. End users do NOT
 * import or call this directly. They import the adapter's typed `wrap()`
 * helper (e.g., `import { wrap } from 'psy-core/letta'`) and the adapter
 * registers its provider metadata at module load.
 *
 * Pattern source: OpenTelemetry instrumentation (`InstrumentationBase`) +
 * Sentry transports (`createTransport`) + LangChain partner packages.
 *
 * Lessons applied:
 *   1. Wrap-pattern, not event-emitter — preserves request/response
 *      correlation needed for the hash-chained audit log.
 *   2. Schema versioning + provider versioning declared explicitly — fail
 *      loud at registration, not at audit-write time.
 *   3. Capabilities declared per adapter — consumers know coverage upfront,
 *      and `psy verify` can flag suspicious gaps.
 */
export interface MemoryProvider<H = unknown> {
  /**
   * Adapter identifier. Lowercase hyphenated. Used in audit-event metadata
   * and CLI / log output. Examples: "anthropic-memory", "letta-blocks",
   * "mastra", "mem0".
   */
  readonly name: string;

  /**
   * Audit schema version range this adapter knows how to emit, expressed as
   * an npm-style semver range (e.g., ">=1.0 <2"). psy core's current schema
   * version (CURRENT_AUDIT_SCHEMA_VERSION) must satisfy this range or
   * registerProvider throws.
   */
  readonly auditSchemaVersion: string;

  /**
   * Semver range of the wrapped third-party library this adapter supports.
   * Example: an `psy-core/letta` adapter might pin "@letta-ai/letta-client"
   * with `compatibleProviderVersions: ">=1.10 <2"`. End users get a clear
   * error if their installed framework version drifts outside the range.
   */
  readonly compatibleProviderVersions: string;

  /**
   * Audit operations this adapter can emit. An adapter that wraps a
   * framework with no rename concept (e.g., Letta blocks, Mem0) declares
   * a subset and verify can flag chains that contain unexpected operations.
   */
  readonly capabilities: ReadonlyArray<MemoryOperation>;

  /**
   * Per-adapter scheme for synthesizing `memory_path` values when the wrapped
   * framework doesn't have a native filesystem-shaped path. Examples:
   *   - "/memories/" for Anthropic MemoryTool (real virtual paths)
   *   - "letta://blocks/" for Letta blocks
   *   - "mastra://" for Mastra (sub-namespaced per memory primitive)
   *
   * The scheme is documentation, not enforcement: each adapter is responsible
   * for its own path validation (Anthropic ships an ASCII-only `/memories/`
   * grammar; others define their own).
   */
  readonly memoryPathScheme: string;

  /**
   * Wrap a handler instance and return a same-shape proxy whose method calls
   * are routed through psy's audit pipeline. Same-shape-in/same-shape-out
   * means the wrapped handler is a drop-in replacement: existing typed
   * callers continue to work without code changes.
   */
  wrap(handler: H): H;
}

/**
 * Emit an audit event into psy's chain. Adapters call this from their wrapped
 * method bodies. The auditor handles intent/result two-phase recording, hash
 * chaining, and seal updates — the adapter just describes WHAT happened.
 *
 * Returned promise resolves once the event is durable on disk (post-fsync).
 * Rejection means the audit failed and the wrapped operation must NOT
 * proceed (the wrap layer enforces this fail-closed semantic).
 */
export interface AuditEmitter {
  /**
   * Record an `intent` row before the wrapped handler executes. Returns the
   * operation_id which the adapter uses to pair the subsequent `result` row.
   * If this rejects, the handler must not run.
   */
  recordIntent(input: AuditEventIntent): Promise<{ operationId: string; eventId: string }>;

  /**
   * Record a `result` row after the wrapped handler succeeded or threw.
   */
  recordResult(input: AuditEventResult): Promise<void>;
}

/**
 * Shape of an intent event the adapter passes to the emitter. Mirrors the
 * 26-field schema's intent-row inputs minus the chain-internal fields
 * (seq, hashes, timestamps) which the auditor populates.
 */
export interface AuditEventIntent {
  operation: MemoryOperation;
  memoryPath: string;
  toolCallId?: string | null;
  actorId?: string | null;
  tenantId?: string | null;
  sessionId?: string | null;
  purpose?: string | null;
  toolInputHash: string;
}

export interface AuditEventResult {
  operationId: string;
  outcome: 'success' | 'handler_error' | 'handler_timeout' | 'audit_error' | 'audit_timeout' | 'rejected_by_path_guard' | 'rejected_by_anonymous_check' | 'redactor_failed';
  toolOutputHash?: string | null;
  payloadPreview?: string | null;
  payloadRedacted?: boolean;
  redactorId?: string | null;
  redactorError?: string | null;
  errorCode?: string | null;
  errorType?: string | null;
  errorMessage?: string | null;
}

/**
 * Registry of installed providers, keyed by `name`. Stored on `globalThis`
 * via a `Symbol.for` key so all bundles in a process share the same Map.
 *
 * Why: tsup builds each subpath entry as an independent bundle, which
 * duplicates `provider.ts` once per entry. Without a shared singleton, a
 * provider that auto-registers from `psy-core/anthropic-memory` writes to a
 * different Map than the one `listProviders()` reads from `psy-core`. The
 * `Symbol.for` key resolves to the same global symbol across realms and
 * bundles, so every copy of this module talks to one Map.
 *
 * Threading note: this is single-process state. Multi-process correctness is
 * provided by the seal / chain layer, not by this registry.
 */
const REGISTRY_KEY = Symbol.for('psy.provider.registry.v1');
const globalSlot = globalThis as Record<symbol, unknown>;
if (!(globalSlot[REGISTRY_KEY] instanceof Map)) {
  globalSlot[REGISTRY_KEY] = new Map<string, MemoryProvider<unknown>>();
}
const REGISTRY = globalSlot[REGISTRY_KEY] as Map<string, MemoryProvider<unknown>>;

/**
 * Register a memory provider. Throws PsyConfigInvalid if:
 *   - core's CURRENT_AUDIT_SCHEMA_VERSION does not satisfy the adapter's
 *     auditSchemaVersion range
 *   - another provider with the same `name` is already registered
 *   - either version-range string is malformed
 *
 * Adapter packages call this at module load (top-level side effect in their
 * `index.ts`). The end-user `wrap()` helper exported by the adapter is the
 * actual API surface; registration is the metadata side-channel.
 */
export function registerProvider(provider: MemoryProvider<unknown>): void {
  if (typeof provider.name !== 'string' || provider.name.length === 0) {
    throw new PsyConfigInvalid('MemoryProvider.name must be a non-empty string');
  }
  if (REGISTRY.has(provider.name)) {
    const existing = REGISTRY.get(provider.name)!;
    if (existing === provider) {
      // Same instance re-registering (e.g., test reset). Idempotent.
      return;
    }
    throw new PsyConfigInvalid(
      `MemoryProvider "${provider.name}" is already registered with a different instance`,
      { details: { name: provider.name } },
    );
  }
  if (!validRange(provider.auditSchemaVersion)) {
    throw new PsyConfigInvalid(
      `MemoryProvider "${provider.name}".auditSchemaVersion is not a valid semver range: ${provider.auditSchemaVersion}`,
    );
  }
  if (!validRange(provider.compatibleProviderVersions)) {
    throw new PsyConfigInvalid(
      `MemoryProvider "${provider.name}".compatibleProviderVersions is not a valid semver range: ${provider.compatibleProviderVersions}`,
    );
  }
  if (!semverSatisfies(CURRENT_AUDIT_SCHEMA_VERSION, provider.auditSchemaVersion)) {
    throw new PsyConfigInvalid(
      `MemoryProvider "${provider.name}" requires audit schema ${provider.auditSchemaVersion}, but psy ships ${CURRENT_AUDIT_SCHEMA_VERSION}. Upgrade or downgrade ${provider.name === 'unknown' ? 'the adapter' : `psy-core/${provider.name}`}.`,
      {
        details: {
          name: provider.name,
          required: provider.auditSchemaVersion,
          actual: CURRENT_AUDIT_SCHEMA_VERSION,
        },
      },
    );
  }
  REGISTRY.set(provider.name, provider);
}

/**
 * Look up a registered provider by name. Returns null if not registered.
 * Useful for CLI / verify code that wants to emit per-adapter context.
 */
export function getProvider(name: string): MemoryProvider<unknown> | null {
  return REGISTRY.get(name) ?? null;
}

/**
 * Snapshot of registered providers — for diagnostics and debugging.
 */
export function listProviders(): ReadonlyArray<MemoryProvider<unknown>> {
  return Array.from(REGISTRY.values());
}

/**
 * Unregister a provider. Primarily for tests. End-users should not need this.
 */
export function unregisterProvider(name: string): boolean {
  return REGISTRY.delete(name);
}

/**
 * Reset the registry. Tests only.
 */
export function clearProviders(): void {
  REGISTRY.clear();
}
