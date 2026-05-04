import {
  CURRENT_AUDIT_SCHEMA_VERSION,
  registerProvider,
  type MemoryProvider,
} from '../../provider.js';

import { wrapEngine, wrapOperations } from './wrap.js';
import type { GBrainEngine, GBrainOperation } from './types.js';

export {
  GBRAIN_PATH_PREFIX,
} from './types.js';
export type {
  GBrainAuditClassification,
  GBrainAuditOperation,
  GBrainAuthInfo,
  GBrainEngine,
  GBrainLogger,
  GBrainOperation,
  GBrainOperationContext,
  GBrainWrapOptions,
} from './types.js';
export {
  wrapEngine,
  wrapOperation,
  wrapOperations,
} from './wrap.js';

/**
 * MemoryProvider metadata for the GBrain adapter.
 *
 * GBrain is a memory substrate, not merely a client SDK. The typed helpers
 * therefore expose two boundaries:
 *
 * - `wrapOperations(operations)` for MCP/CLI-facing Operation handlers
 * - `wrapEngine(engine)` for direct BrainEngine users and transaction bodies
 *
 * Capabilities reflect the union across GBrain's operation and engine
 * contracts. `view` covers page/search/list/chunk/graph reads,
 * `str_replace` covers page upserts plus raw-data, version, and link-rewrite
 * writes, `insert` covers tags/links/timeline/version creation, `delete`
 * covers removals, and `rename` covers `updateSlug`. Query text is hashed
 * in memory paths.
 *
 * Non-memory infrastructure surfaces such as raw SQL, config, migrations,
 * jobs, eval/code capture, and health/stats are intentionally skipped by
 * default. Hosts that need those can opt in with `classifyOperation` or
 * `classifyEngineMethod`.
 *
 * A stock `gbrain serve` or CLI process is not instrumented automatically;
 * the host must import this adapter and wrap the GBrain surface it exposes.
 *
 * The registry-level `wrap()` accepts either an operations array or an engine
 * instance for diagnostics/tooling symmetry with the other psy adapters.
 */
export const provider: MemoryProvider<unknown> = {
  name: 'gbrain',
  auditSchemaVersion: `^${CURRENT_AUDIT_SCHEMA_VERSION}`,
  compatibleProviderVersions: '>=0.26 <1',
  capabilities: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'],
  memoryPathScheme: 'gbrain://',
  wrap: ((handler: unknown) => {
    if (Array.isArray(handler)) {
      return wrapOperations(handler as GBrainOperation[]);
    }
    if (handler && typeof handler === 'object') {
      return wrapEngine(handler as GBrainEngine);
    }
    throw new TypeError('gbrain provider.wrap expects a GBrain operations array or BrainEngine instance');
  }) as MemoryProvider<unknown>['wrap'],
};

registerProvider(provider);
