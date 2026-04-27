import {
  CURRENT_AUDIT_SCHEMA_VERSION,
  registerProvider,
  type MemoryProvider,
} from '../../provider.js';

import { wrap } from './wrap.js';

export {
  LETTA_AGENT_PATH_PREFIX,
  LETTA_GLOBAL_PATH_PREFIX,
} from './types.js';
export type {
  AgentBlockRetrieveParams,
  AgentBlockUpdateBody,
  AgentBlocksResource,
  AnyBlocksResource,
  BlockCreateBody,
  BlockResponse,
  BlockUpdateBody,
  BlocksResource,
} from './types.js';
export { wrap } from './wrap.js';

/**
 * MemoryProvider metadata for the Letta blocks adapter.
 *
 * Capability set is intentionally narrower than Anthropic MemoryTool: Letta
 * blocks have no insert-at-position primitive and the v0.2 wrap does not
 * dispatch label-changes as a separate `rename` op (an update with a new
 * label is recorded as `str_replace`). Subsequent versions can split rename
 * out without breaking the schema, since `rename` is already in the canonical
 * MemoryOperation enum.
 */
export const provider: MemoryProvider<unknown> = {
  name: 'letta',
  auditSchemaVersion: `^${CURRENT_AUDIT_SCHEMA_VERSION}`,
  compatibleProviderVersions: '>=1.10 <2',
  capabilities: ['view', 'create', 'str_replace', 'delete'],
  memoryPathScheme: 'letta://',
  wrap: ((handler: unknown) =>
    wrap(handler as Parameters<typeof wrap>[0])) as MemoryProvider<unknown>['wrap'],
};

registerProvider(provider);
