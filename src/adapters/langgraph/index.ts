import {
  CURRENT_AUDIT_SCHEMA_VERSION,
  registerProvider,
  type MemoryProvider,
} from '../../provider.js';

import { wrap } from './wrap.js';

export { LANGGRAPH_PATH_PREFIX } from './types.js';
export type {
  LangGraphChannelVersions,
  LangGraphCheckpoint,
  LangGraphCheckpointListOptions,
  LangGraphCheckpointMetadata,
  LangGraphCheckpointSaver,
  LangGraphCheckpointTuple,
  LangGraphPendingWrite,
  LangGraphRunnableConfig,
} from './types.js';
export { wrap } from './wrap.js';

/**
 * MemoryProvider metadata for the LangGraph checkpointer adapter.
 *
 * The wrap target is `BaseCheckpointSaver` from
 * `@langchain/langgraph-checkpoint`. Concrete savers (`MemorySaver`,
 * `SqliteSaver`, `PostgresSaver`) all implement the same contract, so a
 * single wrap covers every persistence backend.
 *
 * Capabilities: `view` (getTuple/get/list), `create` (put), `insert`
 * (putWrites), `delete` (deleteThread). No `str_replace` / `rename`
 * because checkpoints are immutable point-in-time snapshots.
 *
 * `compatibleProviderVersions` pins to `@langchain/langgraph-checkpoint
 * >= 1 < 2` (the v1 release was the API stabilization).
 */
export const provider: MemoryProvider<unknown> = {
  name: 'langgraph',
  auditSchemaVersion: `^${CURRENT_AUDIT_SCHEMA_VERSION}`,
  compatibleProviderVersions: '>=1 <2',
  capabilities: ['view', 'create', 'insert', 'delete'],
  memoryPathScheme: 'langgraph://',
  wrap: ((handler: unknown) =>
    wrap(handler as Parameters<typeof wrap>[0])) as MemoryProvider<unknown>['wrap'],
};

registerProvider(provider);
