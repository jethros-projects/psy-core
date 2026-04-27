import {
  CURRENT_AUDIT_SCHEMA_VERSION,
  registerProvider,
  type MemoryProvider,
} from '../../provider.js';

import { wrap } from './wrap.js';

export { LANGCHAIN_PATH_PREFIX } from './types.js';
export type {
  LangChainChatMessageHistory,
  LangChainMessage,
  LangChainWrapOptions,
} from './types.js';
export { wrap } from './wrap.js';

/**
 * MemoryProvider metadata for the LangChain chat-history adapter.
 *
 * Wraps the v1 idiomatic surface (`BaseChatMessageHistory` from
 * `@langchain/core/chat_history`), not the legacy `BaseMemory` family
 * (which moved to `@langchain/classic` and is being deprecated).
 *
 * Capabilities reflect the contract: `view` (getMessages), `insert`
 * (addMessage / addMessages / addUserMessage / addAIMessage), `delete`
 * (clear). No `create` / `str_replace` / `rename` because chat history is
 * append-only with whole-conversation clear.
 *
 * `compatibleProviderVersions` pins to `@langchain/core >= 1 < 2` since
 * the v1 release was the major API reshuffle.
 */
export const provider: MemoryProvider<unknown> = {
  name: 'langchain',
  auditSchemaVersion: `^${CURRENT_AUDIT_SCHEMA_VERSION}`,
  compatibleProviderVersions: '>=1 <2',
  capabilities: ['view', 'insert', 'delete'],
  memoryPathScheme: 'langchain://',
  wrap: ((handler: unknown) => {
    // The provider-level wrap can't supply a sessionId — adapters that
    // need extra args expose a typed `wrap` helper instead. This shim
    // exists so capability discovery still surfaces a callable value.
    throw new Error(
      'langchain provider.wrap requires sessionId; import wrap from psy-core/langchain directly',
    );
  }) as MemoryProvider<unknown>['wrap'],
};

registerProvider(provider);
