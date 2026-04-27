/**
 * Structural types for the @mastra/memory v1.17+ Memory class.
 *
 * Mastra's Memory exposes four primitives (working memory, message history,
 * semantic recall, observational memory) through a single class. psy
 * intentionally only depends on a duck-typed subset — consumers install
 * `@mastra/core` and `@mastra/memory` themselves (declared as optional peer
 * dependencies). The structural compatibility check is enough because every
 * Mastra version in the supported range exposes the same shape on these
 * methods.
 *
 * If a future Mastra version reshuffles the surface, the adapter's
 * `compatibleProviderVersions` range (declared on the MemoryProvider) is the
 * place to bump; consumers will get a registration-time error instead of a
 * silent type mismatch.
 *
 * Coverage is the public mutation path plus the most-used reads. Internal
 * caches (`embeddingCache`, `_embeddingDimensionPromise`,
 * `indexValidationCache`) and protected methods (`getMemoryStore`,
 * `embedMessageContent`, etc.) are NOT wrapped — they live behind the public
 * methods and would double-count.
 */

export interface MastraThread {
  id: string;
  resourceId?: string;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MastraMessage {
  id?: string;
  threadId?: string;
  resourceId?: string;
  role?: string;
  content?: unknown;
  [extra: string]: unknown;
}

export interface ThreadIdParams {
  threadId: string;
  resourceId?: string;
  memoryConfig?: unknown;
}

export interface CreateThreadParams {
  resourceId: string;
  threadId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  memoryConfig?: unknown;
  saveThread?: boolean;
}

export interface UpdateThreadParams {
  id: string;
  title?: string;
  metadata?: Record<string, unknown>;
  memoryConfig?: unknown;
}

export interface UpdateWorkingMemoryParams extends ThreadIdParams {
  workingMemory: string | Record<string, unknown>;
  observabilityContext?: unknown;
}

export interface SaveMessagesParams {
  messages: MastraMessage[];
  memoryConfig?: unknown;
  observabilityContext?: unknown;
}

export interface UpdateMessagesParams {
  messages: MastraMessage[];
  memoryConfig?: unknown;
}

export interface DeleteMessagesInput {
  id: string;
}

export interface SearchMessagesParams {
  query: string;
  resourceId: string;
  topK?: number;
  filter?: Record<string, unknown>;
}

export interface IndexObservationParams {
  text: string;
  groupId: string;
  range: unknown;
  threadId: string;
  resourceId: string;
  observedAt?: string;
}

export interface RecallParams extends ThreadIdParams {
  threadConfig?: unknown;
  vectorSearchString?: string;
  includeSystemReminders?: boolean;
  observabilityContext?: unknown;
}

/**
 * The minimal shape of a Mastra `Memory` instance that psy wraps. End users
 * pass the real instance; structural typing lets us avoid a compile-time
 * dependency on `@mastra/memory`.
 *
 * Every method is async (Promise-returning) — confirmed by Mastra's type
 * definitions. No callbacks, no AsyncIterators on the memory surface.
 */
export interface MastraMemoryInstance {
  // working memory
  getWorkingMemory(params: ThreadIdParams): Promise<string | null>;
  updateWorkingMemory(params: UpdateWorkingMemoryParams): Promise<void>;

  // threads (conversation history scaffolding)
  createThread(params: CreateThreadParams): Promise<MastraThread>;
  updateThread(params: UpdateThreadParams): Promise<MastraThread>;
  deleteThread(threadId: string): Promise<void>;
  getThreadById(params: { threadId: string }): Promise<MastraThread | null>;

  // messages (conversation history payload)
  saveMessages(params: SaveMessagesParams): Promise<{ messages: MastraMessage[]; usage?: unknown }>;
  updateMessages(params: UpdateMessagesParams): Promise<MastraMessage[]>;
  deleteMessages(
    input: ReadonlyArray<string> | ReadonlyArray<DeleteMessagesInput>,
    observabilityContext?: unknown,
  ): Promise<void>;

  // recall (read across threads + semantic recall in one call)
  recall(params: RecallParams): Promise<unknown>;

  // semantic recall direct surfaces
  searchMessages(params: SearchMessagesParams): Promise<unknown>;
  indexObservation?(params: IndexObservationParams): Promise<void>;

  [extra: string]: unknown;
}

export const MASTRA_PATH_PREFIX = 'mastra://';
