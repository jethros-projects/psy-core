import { randomUUID } from 'node:crypto';

import { Auditor, resolveIdentity, summarizeError } from '../../auditor.js';
import type { WrapOptions } from '../../types.js';

import {
  LANGGRAPH_PATH_PREFIX,
  type LangGraphChannelVersions,
  type LangGraphCheckpoint,
  type LangGraphCheckpointListOptions,
  type LangGraphCheckpointMetadata,
  type LangGraphCheckpointSaver,
  type LangGraphCheckpointTuple,
  type LangGraphPendingWrite,
  type LangGraphRunnableConfig,
} from './types.js';

type LangGraphOperation = 'view' | 'create' | 'insert' | 'delete';

/**
 * Wrap a LangGraph `BaseCheckpointSaver` so every state save and load
 * produces a tamper-evident audit row in the psy chain.
 *
 * Coverage (v0.3):
 *   - getTuple     : view
 *   - get          : view  (concrete on the base; calls getTuple)
 *   - list         : view  (single intent/result pair for the whole listing,
 *                    not one per yielded item — see docs/types.ts rationale)
 *   - put          : create  (each LangGraph step produces a fresh
 *                    checkpoint_id; rare overwrite is also recorded as
 *                    create — distinguishing would require an extra
 *                    getTuple round-trip per put)
 *   - putWrites    : insert  (partial appends to an existing checkpoint)
 *   - deleteThread : delete  (bulk delete of every checkpoint for a thread)
 *
 * `str_replace` and `rename` are absent: LangGraph checkpoints are
 * immutable point-in-time snapshots; new state means new checkpoint_id,
 * not edit-in-place.
 */
export function wrap<T extends LangGraphCheckpointSaver>(saver: T, options: WrapOptions = {}): T {
  let auditorPromise: Promise<Auditor> | null = null;
  const getAuditor = () => (auditorPromise ??= Auditor.create(options));

  const audited = {
    async getTuple(config: LangGraphRunnableConfig) {
      const auditor = await getAuditor();
      return runAudited<LangGraphCheckpointTuple | undefined>(auditor, options, {
        operation: 'view',
        memoryPath: checkpointPath(config),
        run: () => saver.getTuple(config),
      });
    },
    async get(config: LangGraphRunnableConfig) {
      const auditor = await getAuditor();
      return runAudited<LangGraphCheckpoint | undefined>(auditor, options, {
        operation: 'view',
        memoryPath: checkpointPath(config),
        run: () =>
          (saver.get
            ? saver.get(config)
            : saver.getTuple(config).then((t) => t?.checkpoint)) as Promise<LangGraphCheckpoint | undefined>,
      });
    },
    list(config: LangGraphRunnableConfig, listOpts?: LangGraphCheckpointListOptions) {
      // Cannot make `list` async without changing its return type — the
      // upstream contract is AsyncGenerator. Emit one audit pair around
      // the iteration as a whole.
      return auditedListGenerator(saver, getAuditor, options, config, listOpts);
    },
    async put(
      config: LangGraphRunnableConfig,
      checkpoint: LangGraphCheckpoint,
      metadata: LangGraphCheckpointMetadata,
      newVersions: LangGraphChannelVersions,
    ) {
      const auditor = await getAuditor();
      // For put, the meaningful identity is the NEW checkpoint, not the
      // parent. Use checkpoint.id directly.
      const path = `${LANGGRAPH_PATH_PREFIX}threads/${threadIdOf(config)}/${nsOf(config)}/${checkpoint.id}`;
      return runAudited<LangGraphRunnableConfig>(auditor, options, {
        operation: 'create',
        memoryPath: path,
        run: () => saver.put(config, checkpoint, metadata, newVersions),
      });
    },
    async putWrites(
      config: LangGraphRunnableConfig,
      writes: ReadonlyArray<LangGraphPendingWrite>,
      taskId: string,
    ) {
      const auditor = await getAuditor();
      const path = `${checkpointPath(config)}/writes/${taskId}+${writes.length}`;
      return runAudited<void>(auditor, options, {
        operation: 'insert',
        memoryPath: path,
        run: () => saver.putWrites(config, writes, taskId),
      });
    },
    async deleteThread(threadId: string) {
      const auditor = await getAuditor();
      return runAudited<void>(auditor, options, {
        operation: 'delete',
        memoryPath: `${LANGGRAPH_PATH_PREFIX}threads/${threadId}`,
        run: () => saver.deleteThread(threadId),
      });
    },
  };

  return new Proxy(saver, {
    get(target, prop, receiver) {
      if (prop in audited) {
        return (audited as Record<string, unknown>)[prop as string];
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as Function).bind(target) : value;
    },
  }) as T;
}

interface AuditedCall<T> {
  operation: LangGraphOperation;
  memoryPath: string;
  run: () => Promise<T>;
}

async function runAudited<T>(auditor: Auditor, options: WrapOptions, call: AuditedCall<T>): Promise<T> {
  const callId = options.callId?.() ?? randomUUID();
  const identityResolution = resolveIdentity(options);
  const identity = identityResolution.identity;

  const base = {
    callId,
    command: call.operation,
    identity,
    memoryPath: call.memoryPath,
    paths: { path: call.memoryPath },
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
  } as const;

  auditor.record({ phase: 'intent', status: 'pending', ...base });

  if (identityResolution.error) {
    auditor.record({
      phase: 'result',
      status: 'validation_error',
      ...base,
      error: summarizeError(identityResolution.error),
    });
    throw identityResolution.error;
  }

  let result: T;
  try {
    result = await call.run();
  } catch (error) {
    auditor.record({
      phase: 'result',
      status: 'error',
      ...base,
      error: summarizeError(error),
    });
    throw error;
  }

  auditor.record({
    phase: 'result',
    status: 'ok',
    ...base,
    result: { kind: 'unknown' },
  });

  return result;
}

/**
 * Wrap LangGraph's `list` AsyncGenerator. Emits one intent before the
 * iteration begins and one result after it completes (success or throw),
 * counting how many tuples were yielded. Each yielded item is forwarded
 * unchanged so callers see the same shape they would without the wrap.
 */
async function* auditedListGenerator(
  saver: LangGraphCheckpointSaver,
  getAuditor: () => Promise<Auditor>,
  options: WrapOptions,
  config: LangGraphRunnableConfig,
  listOpts?: LangGraphCheckpointListOptions,
): AsyncGenerator<LangGraphCheckpointTuple, void, void> {
  const auditor = await getAuditor();
  const callId = options.callId?.() ?? randomUUID();
  const identityResolution = resolveIdentity(options);
  const identity = identityResolution.identity;

  const path = `${LANGGRAPH_PATH_PREFIX}threads/${threadIdOf(config)}/${nsOf(config)}/list`;
  const base = {
    callId,
    command: 'view' as const,
    identity,
    memoryPath: path,
    paths: { path },
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
  };

  auditor.record({ phase: 'intent', status: 'pending', ...base });

  if (identityResolution.error) {
    auditor.record({
      phase: 'result',
      status: 'validation_error',
      ...base,
      error: summarizeError(identityResolution.error),
    });
    throw identityResolution.error;
  }

  let count = 0;
  let success = true;
  try {
    for await (const item of saver.list(config, listOpts)) {
      count++;
      yield item;
    }
  } catch (error) {
    success = false;
    auditor.record({
      phase: 'result',
      status: 'error',
      ...base,
      error: summarizeError(error),
    });
    throw error;
  } finally {
    // Codex review [P2]: if a caller breaks out of the for-await early
    // (very common with `for await (...) { if (cond) break; }`), the
    // generator is closed at the yield and execution skips any
    // post-loop code. Without `finally` here, the intent row would be
    // orphaned, and `psy verify` would flag it as broken. The success
    // path records here too — the only case where we don't record from
    // finally is when the catch already recorded an error.
    if (success) {
      auditor.record({
        phase: 'result',
        status: 'ok',
        ...base,
        result: { kind: 'unknown', blockCount: count },
      });
    }
  }
}

function threadIdOf(config: LangGraphRunnableConfig): string {
  return config.configurable?.thread_id ?? 'unknown-thread';
}

function nsOf(config: LangGraphRunnableConfig): string {
  const ns = config.configurable?.checkpoint_ns;
  return ns && ns.length > 0 ? ns : '_';
}

function checkpointPath(config: LangGraphRunnableConfig): string {
  const id = config.configurable?.checkpoint_id;
  const base = `${LANGGRAPH_PATH_PREFIX}threads/${threadIdOf(config)}/${nsOf(config)}`;
  return id ? `${base}/${id}` : `${base}/latest`;
}
