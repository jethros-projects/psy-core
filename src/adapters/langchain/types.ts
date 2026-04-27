/**
 * Structural types for the LangChain TypeScript v1.x chat-history surface.
 *
 * The wrap target is `BaseChatMessageHistory` from
 * `@langchain/core/chat_history`. This is the modern memory surface in
 * LangChain v1 (the legacy `BaseMemory` family was evicted from `langchain`
 * proper into `@langchain/classic`; we don't wrap it). Every backend in
 * `@langchain/community/stores/message/*` (Postgres, Redis, DynamoDB,
 * Firestore, etc.) implements this same interface, so one wrap covers all
 * of them.
 *
 * These are intentionally a duck-typed subset — psy does not import
 * `@langchain/core` at compile time. Consumers install it themselves
 * (declared as an optional peer dependency).
 *
 * Note on observability: LangChain ships its own tracing via the LangSmith
 * callback system at the Runnable level. That captures graph-level runs,
 * not the cryptographic audit chain psy provides. The two are
 * complementary; consumers who use both should expect each event to
 * appear in both trails.
 */

export interface LangChainMessage {
  /** `human` | `ai` | `system` | `tool` | `function` etc. — backend-defined. */
  _getType?(): string;
  type?: string;
  content: unknown;
  id?: string;
  name?: string;
  additional_kwargs?: Record<string, unknown>;
  response_metadata?: Record<string, unknown>;
  [extra: string]: unknown;
}

/**
 * Structural shape covering `BaseChatMessageHistory` and its concrete
 * `BaseListChatMessageHistory` subclass. Default convenience methods
 * (`addUserMessage` / `addAIMessage`) are present on the abstract base —
 * the wrap audits all four mutation paths plus `getMessages` and `clear`.
 */
export interface LangChainChatMessageHistory {
  getMessages(): Promise<LangChainMessage[]>;
  addMessage(message: LangChainMessage): Promise<void>;
  addMessages(messages: LangChainMessage[]): Promise<void>;
  /**
   * `addUserMessage` and `addAIMessage` may route through `addMessage` on
   * the abstract base, but some backends override them to skip the
   * round-trip. Wrap both directly so a backend that goes its own way
   * still gets audited.
   */
  addUserMessage(message: string): Promise<void>;
  addAIMessage(message: string): Promise<void>;
  clear(): Promise<void>;
  [extra: string]: unknown;
}

export interface LangChainWrapOptions {
  /**
   * Stable identifier for the conversation, typically the same string
   * passed via `RunnableConfig.configurable.sessionId`. Used to scope
   * audit-log paths and group related rows.
   */
  sessionId: string;
}

export const LANGCHAIN_PATH_PREFIX = 'langchain://';
