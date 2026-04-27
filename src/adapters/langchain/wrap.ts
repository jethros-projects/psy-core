import { randomUUID } from 'node:crypto';

import { Auditor, resolveIdentity, summarizeError } from '../../auditor.js';
import type { WrapOptions } from '../../types.js';

import {
  LANGCHAIN_PATH_PREFIX,
  type LangChainChatMessageHistory,
  type LangChainMessage,
  type LangChainWrapOptions,
} from './types.js';

type LangChainOperation = 'view' | 'insert' | 'delete';

/**
 * Wrap a LangChain `BaseChatMessageHistory` so every mutation and read
 * produces a tamper-evident audit row in the psy chain.
 *
 * Coverage (v0.3):
 *   - getMessages    : view
 *   - addMessage     : insert  (semantics: append-only)
 *   - addMessages    : insert  (bulk; one audit row per call, not per msg)
 *   - addUserMessage : insert
 *   - addAIMessage   : insert
 *   - clear          : delete  (nukes the whole conversation)
 *
 * `create`, `str_replace`, `rename` are absent: chat history is
 * append-only with bulk-clear semantics — there is no per-message edit
 * or rename in the BaseChatMessageHistory contract.
 *
 * The convenience methods (`addUserMessage`, `addAIMessage`) are wrapped
 * directly because some backends override them to skip the round-trip
 * through `addMessage` — wrapping only `addMessage` would miss those.
 *
 * Path scheme:
 *   - langchain://sessions/<sessionId>/messages       (bulk and clear)
 *   - langchain://sessions/<sessionId>/messages/<n>   (single, n is monotonic)
 *
 * The per-call message counter is local to the wrap instance; it lets
 * multiple `addMessage` calls within one session disambiguate on the
 * audit row even though `BaseMessage` has no inherent id.
 */
export function wrap<T extends LangChainChatMessageHistory>(
  history: T,
  options: LangChainWrapOptions & WrapOptions,
): T {
  if (typeof options.sessionId !== 'string' || options.sessionId.length === 0) {
    throw new TypeError('LangChain wrap requires a non-empty sessionId option');
  }

  let auditorPromise: Promise<Auditor> | null = null;
  const getAuditor = () => (auditorPromise ??= Auditor.create(options));
  let messageCounter = 0;

  const audited = {
    async getMessages() {
      const auditor = await getAuditor();
      return runAudited<LangChainMessage[]>(auditor, options, {
        operation: 'view',
        memoryPath: messagesBasePath(options.sessionId),
        run: () => history.getMessages(),
      });
    },
    async addMessage(message: LangChainMessage) {
      const auditor = await getAuditor();
      const idx = ++messageCounter;
      return runAudited<void>(auditor, options, {
        operation: 'insert',
        memoryPath: messageIndexPath(options.sessionId, idx),
        run: () => history.addMessage(message),
      });
    },
    async addMessages(messages: LangChainMessage[]) {
      const auditor = await getAuditor();
      const startIdx = messageCounter + 1;
      messageCounter += messages.length;
      return runAudited<void>(auditor, options, {
        operation: 'insert',
        memoryPath: messageIndexPath(options.sessionId, `${startIdx}+${messages.length - 1}`),
        run: () => history.addMessages(messages),
      });
    },
    async addUserMessage(message: string) {
      const auditor = await getAuditor();
      const idx = ++messageCounter;
      return runAudited<void>(auditor, options, {
        operation: 'insert',
        memoryPath: messageIndexPath(options.sessionId, `user-${idx}`),
        run: () => history.addUserMessage(message),
      });
    },
    async addAIMessage(message: string) {
      const auditor = await getAuditor();
      const idx = ++messageCounter;
      return runAudited<void>(auditor, options, {
        operation: 'insert',
        memoryPath: messageIndexPath(options.sessionId, `ai-${idx}`),
        run: () => history.addAIMessage(message),
      });
    },
    async clear() {
      const auditor = await getAuditor();
      return runAudited<void>(auditor, options, {
        operation: 'delete',
        memoryPath: messagesBasePath(options.sessionId),
        run: () => history.clear(),
      });
    },
  };

  return new Proxy(history, {
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
  operation: LangChainOperation;
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

function messagesBasePath(sessionId: string): string {
  return `${LANGCHAIN_PATH_PREFIX}sessions/${sessionId}/messages`;
}

function messageIndexPath(sessionId: string, idx: number | string): string {
  return `${messagesBasePath(sessionId)}/${idx}`;
}
