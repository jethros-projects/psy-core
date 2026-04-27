import {
  CURRENT_AUDIT_SCHEMA_VERSION,
  registerProvider,
  type MemoryProvider,
} from '../../provider.js';

import { wrap } from './wrap.js';

export { MASTRA_PATH_PREFIX } from './types.js';
export type {
  CreateThreadParams,
  DeleteMessagesInput,
  IndexObservationParams,
  MastraMemoryInstance,
  MastraMessage,
  MastraThread,
  RecallParams,
  SaveMessagesParams,
  SearchMessagesParams,
  ThreadIdParams,
  UpdateMessagesParams,
  UpdateThreadParams,
  UpdateWorkingMemoryParams,
} from './types.js';
export { wrap } from './wrap.js';

/**
 * MemoryProvider metadata for the Mastra memory adapter.
 *
 * Mastra exposes four memory primitives (working memory, message history,
 * semantic recall, observational memory) through a single `Memory` class.
 * This adapter audits the public mutation path plus the most-used reads.
 *
 * Capabilities reflect the union across all four primitives. `insert` is
 * absent because no primitive has insert-at-position semantics; `rename` is
 * absent because Mastra's only rename-shaped op (`updateThread({ title })`)
 * is recorded as `str_replace` for v0.2 (a future bump can split it out).
 *
 * The `compatibleProviderVersions` range pins to `@mastra/memory` (the
 * package that ships the consumer-facing `Memory` class). `@mastra/core` is
 * also required at runtime by Mastra itself; consumers install both.
 */
export const provider: MemoryProvider<unknown> = {
  name: 'mastra',
  auditSchemaVersion: `^${CURRENT_AUDIT_SCHEMA_VERSION}`,
  compatibleProviderVersions: '>=1.17 <2',
  capabilities: ['view', 'create', 'str_replace', 'delete'],
  memoryPathScheme: 'mastra://',
  wrap: ((handler: unknown) =>
    wrap(handler as Parameters<typeof wrap>[0])) as MemoryProvider<unknown>['wrap'],
};

registerProvider(provider);
