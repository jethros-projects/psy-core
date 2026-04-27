/**
 * psy-core/anthropic-memory — adapter for Anthropic's MemoryTool API.
 *
 * Wraps an `MemoryToolHandlers` instance (the helper exposed by the official
 * Anthropic SDK at `@anthropic-ai/sdk/helpers/beta/memory`) and routes every
 * memory operation through psy's audit pipeline before delegating to the
 * underlying handler.
 *
 * Usage:
 *   import { betaMemoryTool } from '@anthropic-ai/sdk/helpers/beta/memory';
 *   import { BetaLocalFilesystemMemoryTool } from '@anthropic-ai/sdk/tools/memory/node';
 *   import { wrap } from 'psy-core/anthropic-memory';
 *
 *   const fsHandlers = await BetaLocalFilesystemMemoryTool.init('./memory');
 *   const memory = betaMemoryTool(wrap(fsHandlers, { actorId: 'user-123' }));
 *
 * Path-guard policy is Anthropic-specific: paths must start with `/memories/`,
 * be ASCII-only in v0.1, and reject percent-encoded sequences. Other adapters
 * (Letta, Mastra, Mem0) ship their own scheme-specific validation.
 */

import {
  CURRENT_AUDIT_SCHEMA_VERSION,
  registerProvider,
  type MemoryProvider,
} from '../../provider.js';

import { wrap } from './wrap.js';

export { wrap } from './wrap.js';
export {
  MEMORY_ROOT,
  validateMemoryPath,
  validateMemoryCommandPaths,
} from './path-guard.js';
export type { MemoryOperation } from './path-guard.js';

/**
 * Provider metadata. Auto-registered at module-load: importing
 * `psy-core/anthropic-memory` is sufficient to register; users do not call
 * registerProvider directly.
 */
export const provider: MemoryProvider<unknown> = {
  name: 'anthropic-memory',
  auditSchemaVersion: `^${CURRENT_AUDIT_SCHEMA_VERSION}`,
  // Track Anthropic SDK majors. Update this range when bumping the
  // @anthropic-ai/sdk peerDependency in psy-core's package.json.
  compatibleProviderVersions: '>=0.91 <2',
  capabilities: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'],
  memoryPathScheme: '/memories/',
  wrap: ((handler: unknown) =>
    wrap(handler as Parameters<typeof wrap>[0])) as MemoryProvider<unknown>['wrap'],
};

registerProvider(provider);
