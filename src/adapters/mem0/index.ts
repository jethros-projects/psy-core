import {
  CURRENT_AUDIT_SCHEMA_VERSION,
  registerProvider,
  type MemoryProvider,
} from '../../provider.js';

import { wrap } from './wrap.js';

export { MEM0_PATH_PREFIX } from './types.js';
export type {
  Mem0AddOptions,
  Mem0Client,
  Mem0EntityOptions,
  Mem0GetAllOptions,
  Mem0Memory,
  Mem0SearchOptions,
  Mem0SearchResult,
  Mem0UpdateBody,
} from './types.js';
export { wrap } from './wrap.js';

/**
 * MemoryProvider metadata for the Mem0 adapter.
 *
 * Mem0's `add` is a semantic upsert (LLM-driven extraction can return ADD,
 * UPDATE, DELETE, or NOOP rows from one call) — psy logs the wrapped call
 * once at the boundary; consumers who need per-row event detail can read
 * the audit row's `result` plus the SDK's own response.
 *
 * `compatibleProviderVersions` pins to `mem0ai >= 3 < 4`. The cloud client
 * (`MemoryClient`, default export) and OSS client (`Memory`, `mem0ai/oss`)
 * have divergent surfaces for `add`/`update`; the wrap accepts both.
 */
export const provider: MemoryProvider<unknown> = {
  name: 'mem0',
  auditSchemaVersion: `^${CURRENT_AUDIT_SCHEMA_VERSION}`,
  compatibleProviderVersions: '>=3 <4',
  capabilities: ['view', 'create', 'str_replace', 'delete'],
  memoryPathScheme: 'mem0://',
  wrap: ((handler: unknown) =>
    wrap(handler as Parameters<typeof wrap>[0])) as MemoryProvider<unknown>['wrap'],
};

registerProvider(provider);
