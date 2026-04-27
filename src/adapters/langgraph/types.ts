/**
 * Structural types for the LangGraph TypeScript v1.x checkpointer surface.
 *
 * The wrap target is `BaseCheckpointSaver` from
 * `@langchain/langgraph-checkpoint`. Every concrete saver
 * (`MemorySaver` in the same package, `SqliteSaver`, `PostgresSaver`)
 * implements the same contract. One wrap covers all of them.
 *
 * Identity comes from `config.configurable.{thread_id, checkpoint_ns,
 * checkpoint_id}`. The wrap reads those off the `RunnableConfig` argument
 * and synthesizes audit `memory_path` values; if `checkpoint_ns` is empty
 * (the default) we substitute `_` so paths stay parseable.
 *
 * These are intentionally a duck-typed subset — psy does not import
 * `@langchain/langgraph-checkpoint` at compile time. Consumers install it
 * themselves (declared as an optional peer dependency).
 *
 * Notes for users:
 *   - `list()` is an `AsyncGenerator<CheckpointTuple>`. The wrap
 *     re-yields each item and emits a single (intent, result) audit pair
 *     for the whole listing rather than one row per yielded checkpoint.
 *     Per-item auditing of historical reads is rarely useful and would
 *     spam the chain.
 *   - LangGraph's parallel-node execution can fire concurrent `put` /
 *     `putWrites` calls. The chain handles concurrency the same way it
 *     does for any adapter (BEGIN IMMEDIATE serializes the SQLite append).
 *   - LangSmith traces graph node invocations, not the checkpointer
 *     boundary. No double-emit risk.
 */

export interface LangGraphRunnableConfig {
  configurable?: {
    thread_id?: string;
    checkpoint_ns?: string;
    checkpoint_id?: string;
    [extra: string]: unknown;
  };
  [extra: string]: unknown;
}

export interface LangGraphCheckpoint {
  /** uuid6, monotonic. */
  id: string;
  ts?: string;
  channel_values?: Record<string, unknown>;
  channel_versions?: Record<string, unknown>;
  versions_seen?: Record<string, unknown>;
  pending_sends?: unknown[];
  v?: number;
  [extra: string]: unknown;
}

export interface LangGraphCheckpointMetadata {
  source?: 'input' | 'loop' | 'update' | 'fork' | string;
  step?: number;
  parents?: Record<string, string>;
  writes?: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface LangGraphCheckpointTuple {
  config: LangGraphRunnableConfig;
  checkpoint: LangGraphCheckpoint;
  metadata?: LangGraphCheckpointMetadata;
  parentConfig?: LangGraphRunnableConfig;
  pendingWrites?: ReadonlyArray<readonly [string, string, unknown]>;
}

export interface LangGraphCheckpointListOptions {
  limit?: number;
  before?: LangGraphRunnableConfig;
  filter?: Record<string, unknown>;
}

export type LangGraphPendingWrite = readonly [string, string, unknown];

export type LangGraphChannelVersions = Record<string, unknown>;

/**
 * Structural shape of `BaseCheckpointSaver` (TypeScript naming, no `a`
 * prefix unlike the Python original).
 */
export interface LangGraphCheckpointSaver {
  /** Convenience read; concrete on the abstract base — calls getTuple. */
  get?(config: LangGraphRunnableConfig): Promise<LangGraphCheckpoint | undefined>;
  getTuple(config: LangGraphRunnableConfig): Promise<LangGraphCheckpointTuple | undefined>;
  list(
    config: LangGraphRunnableConfig,
    options?: LangGraphCheckpointListOptions,
  ): AsyncGenerator<LangGraphCheckpointTuple, void, void>;
  put(
    config: LangGraphRunnableConfig,
    checkpoint: LangGraphCheckpoint,
    metadata: LangGraphCheckpointMetadata,
    newVersions: LangGraphChannelVersions,
  ): Promise<LangGraphRunnableConfig>;
  putWrites(
    config: LangGraphRunnableConfig,
    writes: ReadonlyArray<LangGraphPendingWrite>,
    taskId: string,
  ): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  [extra: string]: unknown;
}

export const LANGGRAPH_PATH_PREFIX = 'langgraph://';
