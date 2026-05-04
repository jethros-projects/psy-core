import { describe, expect, it, vi } from 'vitest';

import { runWithContext } from '../src/context.js';
import { PsyConfigInvalid } from '../src/errors.js';
import { wrap } from '../src/adapters/langchain/wrap.js';
import type {
  LangChainChatMessageHistory,
  LangChainMessage,
} from '../src/adapters/langchain/types.js';
import { initProject } from './helpers.js';

function message(content: string, type: string = 'human'): LangChainMessage {
  return { type, content, _getType: () => type };
}

function stubHistory(): LangChainChatMessageHistory & {
  getMessages: ReturnType<typeof vi.fn>;
  addMessage: ReturnType<typeof vi.fn>;
  addMessages: ReturnType<typeof vi.fn>;
  addUserMessage: ReturnType<typeof vi.fn>;
  addAIMessage: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  unwrappedHelper: ReturnType<typeof vi.fn>;
} {
  const messages: LangChainMessage[] = [];
  return {
    getMessages: vi.fn(async () => [...messages]),
    addMessage: vi.fn(async (m) => { messages.push(m); }),
    addMessages: vi.fn(async (ms) => { messages.push(...ms); }),
    addUserMessage: vi.fn(async (text) => { messages.push(message(text, 'human')); }),
    addAIMessage: vi.fn(async (text) => { messages.push(message(text, 'ai')); }),
    clear: vi.fn(async () => { messages.length = 0; }),
    unwrappedHelper: vi.fn(() => 'passthrough-ok'),
  } as unknown as ReturnType<typeof stubHistory>;
}

async function readEvents(paths: { sqlitePath: string; archivesPath: string }, config: unknown) {
  const { PsyStore } = await import('../src/store.js');
  const store = new PsyStore({
    sqlitePath: paths.sqlitePath,
    archivesPath: paths.archivesPath,
    config: config as never,
  });
  const events = store.allActiveEvents();
  store.close();
  return events;
}

describe('langchain wrap', () => {
  it('audits all four mutation paths, getMessages, and clear', async () => {
    const { paths, config } = await initProject();
    const target = stubHistory();
    const audited = wrap(target, { actorId: 'tester', sessionId: 'sess_1', configPath: paths.configPath });

    await audited.getMessages();
    await audited.addMessage(message('hi'));
    await audited.addMessages([message('a'), message('b')]);
    await audited.addUserMessage('hello');
    await audited.addAIMessage('hi back');
    await audited.clear();

    const events = await readEvents(paths, config);
    expect(events.map((e) => `${e.operation}:${e.audit_phase}`)).toEqual([
      'view:intent', 'view:result',
      'insert:intent', 'insert:result',
      'insert:intent', 'insert:result',
      'insert:intent', 'insert:result',
      'insert:intent', 'insert:result',
      'delete:intent', 'delete:result',
    ]);
    expect(events[0]?.memory_path).toBe('langchain://sessions/sess_1/messages');
    expect(events[2]?.memory_path).toBe('langchain://sessions/sess_1/messages/1');
    expect(events[4]?.memory_path).toBe('langchain://sessions/sess_1/messages/2+1');
    expect(events[6]?.memory_path).toBe('langchain://sessions/sess_1/messages/user-4');
    expect(events[8]?.memory_path).toBe('langchain://sessions/sess_1/messages/ai-5');
    expect(events[10]?.memory_path).toBe('langchain://sessions/sess_1/messages');
  });

  it('throws if sessionId is missing or empty', async () => {
    const { paths } = await initProject();
    const target = stubHistory();
    expect(() =>
      wrap(target, { actorId: 't', sessionId: '', configPath: paths.configPath } as never),
    ).toThrow(/non-empty sessionId/);
  });

  it('passes through unwrapped methods', async () => {
    const { paths } = await initProject();
    const target = stubHistory();
    const audited = wrap(target, { actorId: 'tester', sessionId: 's1', configPath: paths.configPath });

    const result = (audited as unknown as { unwrappedHelper: () => string }).unwrappedHelper();
    expect(result).toBe('passthrough-ok');
    expect(target.unwrappedHelper).toHaveBeenCalledOnce();
  });

  it('binds pass-through methods to the original history object', async () => {
    const { paths } = await initProject();
    const target = stubHistory();
    const checkThis = vi.fn(function (this: unknown) {
      return this;
    });
    (target as unknown as { checkThis: typeof checkThis }).checkThis = checkThis;
    const audited = wrap(target, { actorId: 'tester', sessionId: 's1', configPath: paths.configPath });

    const result = (audited as unknown as { checkThis: () => unknown }).checkThis();

    expect(result).toBe(target);
    expect(checkThis).toHaveBeenCalledOnce();
  });

  it('preserves the exact getMessages array returned by the backend', async () => {
    const { paths, config } = await initProject();
    const target = stubHistory();
    const expected = [message('persisted', 'system')];
    target.getMessages.mockResolvedValueOnce(expected);
    const audited = wrap(target, { actorId: 'tester', sessionId: 's1', configPath: paths.configPath });

    const result = await audited.getMessages();

    expect(result).toBe(expected);
    const events = await readEvents(paths, config);
    const payload = events[1]?.payload_preview ? JSON.parse(events[1].payload_preview) : null;
    expect(payload?.__psy_audit?.result).toEqual({ kind: 'unknown' });
  });

  it('keeps the local message counter monotonic across clear', async () => {
    const { paths, config } = await initProject();
    const target = stubHistory();
    const audited = wrap(target, { actorId: 'tester', sessionId: 's1', configPath: paths.configPath });

    await audited.addMessage(message('before clear'));
    await audited.clear();
    await audited.addMessage(message('after clear'));

    const intents = (await readEvents(paths, config)).filter((e) => e.audit_phase === 'intent');
    expect(intents.map((e) => e.memory_path)).toEqual([
      'langchain://sessions/s1/messages/1',
      'langchain://sessions/s1/messages',
      'langchain://sessions/s1/messages/2',
    ]);
  });

  it('does not advance the message counter for an empty bulk append', async () => {
    const { paths, config } = await initProject();
    const target = stubHistory();
    const audited = wrap(target, { actorId: 'tester', sessionId: 's1', configPath: paths.configPath });

    await audited.addMessages([]);
    await audited.addMessage(message('first actual message'));

    const intents = (await readEvents(paths, config)).filter((e) => e.audit_phase === 'intent');
    expect(intents[1]?.memory_path).toBe('langchain://sessions/s1/messages/1');
  });

  it('promotes the LangChain sessionId to the audit Identity.sessionId field', async () => {
    // LangChain's per-conversation `sessionId` option maps naturally onto
    // psy's `Identity.sessionId`, so a wrap with only a sessionId (no
    // actorId, no tenantId) is NOT anonymous — the session identity satisfies
    // the v0.1 "at least one identity field" requirement. Truly anonymous
    // calls would need to opt in via `allowAnonymous: true`, but at that
    // point the wrap can't function (sessionId is structurally required).
    const { paths, config } = await initProject();
    const target = stubHistory();
    const audited = wrap(target, { sessionId: 's1', configPath: paths.configPath });

    await audited.addMessage(message('hi'));
    expect(target.addMessage).toHaveBeenCalledOnce();

    const events = await readEvents(paths, config);
    expect(events[1]?.outcome).toBe('success');
    expect(events[1]?.session_id).toBe('s1');
  });

  it('records handler error and rethrows', async () => {
    const { paths, config } = await initProject();
    const target = stubHistory();
    const error = Object.assign(new Error('store offline'), { code: 'E_HISTORY' });
    target.clear.mockRejectedValueOnce(error);
    const audited = wrap(target, { actorId: 't', sessionId: 's1', configPath: paths.configPath });

    await expect(audited.clear()).rejects.toBe(error);

    const events = await readEvents(paths, config);
    expect(events.at(-1)?.outcome).toBe('handler_error');
    expect(events.at(-1)?.error_code).toBe('E_HISTORY');
  });

  it('uses identity from runWithContext', async () => {
    const { paths, config } = await initProject();
    const target = stubHistory();
    const audited = wrap(target, { sessionId: 's1', configPath: paths.configPath });

    await runWithContext({ actorId: 'ctx-actor' }, () => audited.getMessages());

    const events = await readEvents(paths, config);
    expect(events[0]?.actor_id).toBe('ctx-actor');
  });
});
