import { randomUUID } from 'node:crypto';

import { Auditor, resolveIdentity, summarizeError } from '../../auditor.js';
import { sha256Hex } from '../../hash.js';
import type { WrapOptions } from '../../types.js';

import {
  MASTRA_PATH_PREFIX,
  type CreateThreadParams,
  type DeleteMessagesInput,
  type IndexObservationParams,
  type MastraMemoryInstance,
  type RecallParams,
  type SaveMessagesParams,
  type SearchMessagesParams,
  type ThreadIdParams,
  type UpdateMessagesParams,
  type UpdateThreadParams,
  type UpdateWorkingMemoryParams,
} from './types.js';

type MastraOperation = 'view' | 'create' | 'str_replace' | 'delete';

/**
 * Wrap a Mastra `Memory` instance so every public mutation and the most
 * common reads produce a tamper-evident audit row in the psy chain.
 *
 * Mastra ships its own observability layer (`wrapMastra`,
 * `observabilityContext` on every write). Use psy's wrap OR Mastra's
 * observability tracing — not both — otherwise the same operation surfaces
 * twice in two different audit trails.
 *
 * The Proxy preserves `this`-binding and passes through methods we don't
 * audit (e.g., protected methods, internal caches, the lazy `omEngine`
 * accessor). Internal mutex / cache state on the original instance stays
 * intact because the Proxy never clones.
 *
 * Coverage (v0.2):
 *   - working memory  : view, str_replace
 *   - threads         : view, create, str_replace, delete
 *   - messages        : view (recall), create, str_replace, delete
 *   - semantic recall : view, create (indexObservation)
 *
 * Cascading effects inside a single Mastra call (e.g., `saveMessages`
 * triggers SemanticRecall embeds + ObservationalMemory observe/reflect) are
 * recorded as a single audit row at the call boundary. Background OM work
 * that resolves after the wrapped call returns is NOT captured here;
 * consumers who need that detail should integrate at the processor layer.
 */
export function wrap<T extends MastraMemoryInstance>(memory: T, options: WrapOptions = {}): T {
  let auditorPromise: Promise<Auditor> | null = null;
  const getAuditor = () => (auditorPromise ??= Auditor.create(options));

  const audited = {
    async getWorkingMemory(params: ThreadIdParams) {
      const auditor = await getAuditor();
      return runAudited(auditor, options, {
        operation: 'view',
        memoryPath: workingMemoryPath(params),
        run: () => memory.getWorkingMemory(params),
      });
    },
    async updateWorkingMemory(params: UpdateWorkingMemoryParams) {
      const auditor = await getAuditor();
      return runAudited(auditor, options, {
        operation: 'str_replace',
        memoryPath: workingMemoryPath(params),
        run: () => memory.updateWorkingMemory(params),
      });
    },

    async createThread(params: CreateThreadParams) {
      const auditor = await getAuditor();
      return runAudited(auditor, options, {
        operation: 'create',
        memoryPath: threadPath(params.threadId ?? `resource:${params.resourceId}`),
        run: () => memory.createThread(params),
      });
    },
    async updateThread(params: UpdateThreadParams) {
      const auditor = await getAuditor();
      return runAudited(auditor, options, {
        operation: 'str_replace',
        memoryPath: threadPath(params.id),
        run: () => memory.updateThread(params),
      });
    },
    async deleteThread(threadId: string) {
      const auditor = await getAuditor();
      return runAudited(auditor, options, {
        operation: 'delete',
        memoryPath: threadPath(threadId),
        run: () => memory.deleteThread(threadId),
      });
    },
    async getThreadById(params: { threadId: string }) {
      const auditor = await getAuditor();
      return runAudited(auditor, options, {
        operation: 'view',
        memoryPath: threadPath(params.threadId),
        run: () => memory.getThreadById(params),
      });
    },

    async saveMessages(params: SaveMessagesParams) {
      const auditor = await getAuditor();
      return runAudited(auditor, options, {
        operation: 'create',
        memoryPath: messagesPath(firstMessageThreadId(params.messages)),
        run: () => memory.saveMessages(params),
      });
    },
    async updateMessages(params: UpdateMessagesParams) {
      const auditor = await getAuditor();
      return runAudited(auditor, options, {
        operation: 'str_replace',
        memoryPath: messagesPath(firstMessageThreadId(params.messages)),
        run: () => memory.updateMessages(params),
      });
    },
    async deleteMessages(
      input: ReadonlyArray<string> | ReadonlyArray<DeleteMessagesInput>,
      observabilityContext?: unknown,
    ) {
      const auditor = await getAuditor();
      return runAudited(auditor, options, {
        operation: 'delete',
        memoryPath: deletedMessagesPath(input),
        run: () => memory.deleteMessages(input, observabilityContext),
      });
    },

    async recall(params: RecallParams) {
      const auditor = await getAuditor();
      return runAudited(auditor, options, {
        operation: 'view',
        memoryPath: messagesPath(params.threadId),
        run: () => memory.recall(params),
      });
    },

    async searchMessages(params: SearchMessagesParams) {
      const auditor = await getAuditor();
      return runAudited(auditor, options, {
        operation: 'view',
        memoryPath: semanticPath(params.resourceId, params.query),
        run: () => memory.searchMessages(params),
      });
    },
    async indexObservation(params: IndexObservationParams) {
      const auditor = await getAuditor();
      if (typeof memory.indexObservation !== 'function') {
        throw new TypeError('memory.indexObservation is not available on this Mastra version');
      }
      return runAudited(auditor, options, {
        operation: 'create',
        memoryPath: observationalPath(params.threadId, params.groupId),
        run: () => memory.indexObservation!(params),
      });
    },
  };

  return new Proxy(memory, {
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
  operation: MastraOperation;
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

function workingMemoryPath(params: ThreadIdParams): string {
  const scope = params.resourceId ?? params.threadId;
  return `${MASTRA_PATH_PREFIX}working-memory/${scope}`;
}

function threadPath(threadId: string): string {
  return `${MASTRA_PATH_PREFIX}threads/${threadId}`;
}

function messagesPath(threadId: string | undefined): string {
  return `${MASTRA_PATH_PREFIX}messages/${threadId ?? 'unknown'}`;
}

function semanticPath(resourceId: string, query: string): string {
  // Codex review [P2]: store an opaque hash prefix, not raw query text. A
  // truncated query in the path would leak search content (potentially PII or
  // secrets) into memory_path even when payload_capture is off, bypassing the
  // redactor. The full query is still recoverable from payload_preview when
  // capture is on. 16 hex chars = 64 bits, plenty for per-resource uniqueness.
  const queryHash = sha256Hex(query).slice(0, 16);
  return `${MASTRA_PATH_PREFIX}semantic-recall/${resourceId}/${queryHash}`;
}

function observationalPath(threadId: string, groupId: string): string {
  return `${MASTRA_PATH_PREFIX}observational-memory/${threadId}/${groupId}`;
}

function firstMessageThreadId(messages: ReadonlyArray<{ threadId?: string }>): string | undefined {
  for (const m of messages) {
    if (typeof m.threadId === 'string') return m.threadId;
  }
  return undefined;
}

function deletedMessagesPath(
  input: ReadonlyArray<string> | ReadonlyArray<DeleteMessagesInput>,
): string {
  if (input.length === 0) {
    return `${MASTRA_PATH_PREFIX}messages/empty`;
  }
  const first = input[0];
  const id = typeof first === 'string' ? first : first?.id;
  return `${MASTRA_PATH_PREFIX}messages/by-id/${id ?? 'unknown'}${input.length > 1 ? `+${input.length - 1}` : ''}`;
}
