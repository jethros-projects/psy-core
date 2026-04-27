import { describe, expect, it, vi } from 'vitest';

import { runWithContext } from '../src/context.js';
import { PsyConfigInvalid } from '../src/errors.js';
import { wrap } from '../src/adapters/mastra/wrap.js';
import type {
  MastraMemoryInstance,
  MastraMessage,
  MastraThread,
} from '../src/adapters/mastra/types.js';
import { initProject } from './helpers.js';

function thread(overrides: Partial<MastraThread> = {}): MastraThread {
  return { id: 't1', resourceId: 'res_1', title: 'demo', metadata: null, ...overrides };
}

function message(overrides: Partial<MastraMessage> = {}): MastraMessage {
  return {
    id: 'msg_default',
    threadId: 't1',
    resourceId: 'res_1',
    role: 'user',
    content: 'hello',
    ...overrides,
  };
}

function stubMemory(): MastraMemoryInstance & {
  getWorkingMemory: ReturnType<typeof vi.fn>;
  updateWorkingMemory: ReturnType<typeof vi.fn>;
  createThread: ReturnType<typeof vi.fn>;
  updateThread: ReturnType<typeof vi.fn>;
  deleteThread: ReturnType<typeof vi.fn>;
  getThreadById: ReturnType<typeof vi.fn>;
  saveMessages: ReturnType<typeof vi.fn>;
  updateMessages: ReturnType<typeof vi.fn>;
  deleteMessages: ReturnType<typeof vi.fn>;
  recall: ReturnType<typeof vi.fn>;
  searchMessages: ReturnType<typeof vi.fn>;
  indexObservation: ReturnType<typeof vi.fn>;
  unwrappedHelper: ReturnType<typeof vi.fn>;
} {
  return {
    getWorkingMemory: vi.fn(async () => 'working memory body'),
    updateWorkingMemory: vi.fn(async () => undefined),
    createThread: vi.fn(async (params) => thread({ id: params.threadId ?? 't_new', resourceId: params.resourceId })),
    updateThread: vi.fn(async (params) => thread({ id: params.id, title: params.title ?? 'old' })),
    deleteThread: vi.fn(async () => undefined),
    getThreadById: vi.fn(async (params) => thread({ id: params.threadId })),
    saveMessages: vi.fn(async (params) => ({ messages: params.messages })),
    updateMessages: vi.fn(async (params) => params.messages),
    deleteMessages: vi.fn(async () => undefined),
    recall: vi.fn(async () => ({ messages: [], total: 0 })),
    searchMessages: vi.fn(async () => ({ results: [] })),
    indexObservation: vi.fn(async () => undefined),
    unwrappedHelper: vi.fn(() => 'passthrough result'),
  } as unknown as ReturnType<typeof stubMemory>;
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

describe('mastra wrap (working memory)', () => {
  it('writes intent + result for getWorkingMemory and updateWorkingMemory', async () => {
    const { paths, config } = await initProject();
    const target = stubMemory();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await audited.getWorkingMemory({ threadId: 't1', resourceId: 'res_1' });
    await audited.updateWorkingMemory({ threadId: 't1', resourceId: 'res_1', workingMemory: 'new body' });

    const events = await readEvents(paths, config);
    expect(events.map((e) => `${e.operation}:${e.audit_phase}`)).toEqual([
      'view:intent', 'view:result',
      'str_replace:intent', 'str_replace:result',
    ]);
    expect(events[0]?.memory_path).toBe('mastra://working-memory/res_1');
    expect(events[2]?.memory_path).toBe('mastra://working-memory/res_1');
    expect(target.updateWorkingMemory).toHaveBeenCalledOnce();
  });

  it('falls back to threadId in the path when resourceId is absent', async () => {
    const { paths, config } = await initProject();
    const target = stubMemory();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await audited.getWorkingMemory({ threadId: 't_alone' });

    const events = await readEvents(paths, config);
    expect(events[0]?.memory_path).toBe('mastra://working-memory/t_alone');
  });
});

describe('mastra wrap (threads)', () => {
  it('audits create / update / delete / getThreadById with thread-scoped paths', async () => {
    const { paths, config } = await initProject();
    const target = stubMemory();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await audited.createThread({ resourceId: 'res_1', threadId: 't_new', title: 'demo' });
    await audited.updateThread({ id: 't_new', title: 'demo v2' });
    await audited.getThreadById({ threadId: 't_new' });
    await audited.deleteThread('t_new');

    const events = await readEvents(paths, config);
    expect(events.map((e) => `${e.operation}:${e.audit_phase}`)).toEqual([
      'create:intent', 'create:result',
      'str_replace:intent', 'str_replace:result',
      'view:intent', 'view:result',
      'delete:intent', 'delete:result',
    ]);
    for (const ev of events) {
      expect(ev.memory_path).toBe('mastra://threads/t_new');
    }
  });

  it('uses resource: prefix in path when createThread omits threadId', async () => {
    const { paths, config } = await initProject();
    const target = stubMemory();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await audited.createThread({ resourceId: 'res_42' });

    const events = await readEvents(paths, config);
    expect(events[0]?.memory_path).toBe('mastra://threads/resource:res_42');
  });
});

describe('mastra wrap (messages)', () => {
  it('audits saveMessages, updateMessages, deleteMessages, recall', async () => {
    const { paths, config } = await initProject();
    const target = stubMemory();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await audited.saveMessages({ messages: [message({ threadId: 't1' })] });
    await audited.updateMessages({ messages: [message({ id: 'msg_1' })] });
    await audited.deleteMessages([{ id: 'msg_1' }, { id: 'msg_2' }]);
    await audited.recall({ threadId: 't1', resourceId: 'res_1' });

    const events = await readEvents(paths, config);
    expect(events.map((e) => `${e.operation}:${e.audit_phase}`)).toEqual([
      'create:intent', 'create:result',
      'str_replace:intent', 'str_replace:result',
      'delete:intent', 'delete:result',
      'view:intent', 'view:result',
    ]);
    expect(events[0]?.memory_path).toBe('mastra://messages/t1');
    expect(events[4]?.memory_path).toBe('mastra://messages/by-id/msg_1+1');
    expect(events[6]?.memory_path).toBe('mastra://messages/t1');
  });

  it('handles deleteMessages with array of string ids (not just objects)', async () => {
    const { paths, config } = await initProject();
    const target = stubMemory();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await audited.deleteMessages(['msg_only']);

    const events = await readEvents(paths, config);
    expect(events[0]?.memory_path).toBe('mastra://messages/by-id/msg_only');
  });

  it('falls back to "unknown" thread when no message carries threadId', async () => {
    const { paths, config } = await initProject();
    const target = stubMemory();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await audited.saveMessages({ messages: [message({ threadId: undefined })] });

    const events = await readEvents(paths, config);
    expect(events[0]?.memory_path).toBe('mastra://messages/unknown');
  });
});

describe('mastra wrap (semantic recall)', () => {
  it('audits searchMessages with an opaque query hash in the path (no raw text)', async () => {
    const { paths, config } = await initProject();
    const target = stubMemory();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    const sensitiveQuery = 'ssn 123-45-6789 lookup user records';
    await audited.searchMessages({ query: sensitiveQuery, resourceId: 'res_1' });

    const events = await readEvents(paths, config);
    expect(events[0]?.operation).toBe('view');
    // Path must NOT contain any substring of the raw query.
    expect(events[0]?.memory_path).not.toContain('123');
    expect(events[0]?.memory_path).not.toContain('ssn');
    expect(events[0]?.memory_path).not.toContain('lookup');
    // Path is the resource scope plus a 16-hex-char SHA-256 prefix.
    expect(events[0]?.memory_path).toMatch(/^mastra:\/\/semantic-recall\/res_1\/[0-9a-f]{16}$/);
  });

  it('produces a stable hash for the same query+resource pair', async () => {
    const { paths, config } = await initProject();
    const target = stubMemory();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await audited.searchMessages({ query: 'recurring search', resourceId: 'res_1' });
    await audited.searchMessages({ query: 'recurring search', resourceId: 'res_1' });

    const events = await readEvents(paths, config);
    expect(events[0]?.memory_path).toBe(events[2]?.memory_path);
  });

  // Regression: ISSUE-003 + codex [P2] — searchMessages must not crash on
  // unicode-heavy queries (originally crashed via URIError on a split
  // surrogate pair, now hashed so the encoder never sees the raw text).
  // Found by /qa on 2026-04-26.
  it('handles unicode-heavy queries without crashing', async () => {
    const { paths, config } = await initProject();
    const target = stubMemory();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    const tricky = 'a'.repeat(31) + '😀😀';
    await expect(audited.searchMessages({ query: tricky, resourceId: 'res_1' })).resolves.toBeDefined();

    const events = await readEvents(paths, config);
    expect(events.map((e) => e.audit_phase)).toEqual(['intent', 'result']);
    expect(events[0]?.memory_path).toMatch(/^mastra:\/\/semantic-recall\/res_1\/[0-9a-f]{16}$/);
  });

  it('audits indexObservation under the observational-memory scheme', async () => {
    const { paths, config } = await initProject();
    const target = stubMemory();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await audited.indexObservation!({
      text: 'observed something',
      groupId: 'g_1',
      range: {},
      threadId: 't1',
      resourceId: 'res_1',
    });

    const events = await readEvents(paths, config);
    expect(events.map((e) => `${e.operation}:${e.audit_phase}`)).toEqual([
      'create:intent', 'create:result',
    ]);
    expect(events[0]?.memory_path).toBe('mastra://observational-memory/t1/g_1');
  });

  it('throws helpfully when the underlying memory has no indexObservation', async () => {
    const { paths } = await initProject();
    const target = stubMemory();
    delete (target as Record<string, unknown>).indexObservation;
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await expect(
      audited.indexObservation!({ text: 'x', groupId: 'g', range: {}, threadId: 't', resourceId: 'r' }),
    ).rejects.toThrow(/indexObservation is not available/);
  });
});

describe('mastra wrap (cross-cutting)', () => {
  it('passes through unwrapped methods with this-binding intact', async () => {
    const { paths } = await initProject();
    const target = stubMemory();
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    const result = (audited as unknown as { unwrappedHelper: () => string }).unwrappedHelper();
    expect(result).toBe('passthrough result');
    expect(target.unwrappedHelper).toHaveBeenCalledOnce();
  });

  it('rejects anonymous calls and records a validation_error result', async () => {
    const { paths, config } = await initProject();
    const target = stubMemory();
    const audited = wrap(target, { configPath: paths.configPath });

    await expect(
      audited.updateWorkingMemory({ threadId: 't1', resourceId: 'res_1', workingMemory: 'x' }),
    ).rejects.toBeInstanceOf(PsyConfigInvalid);
    expect(target.updateWorkingMemory).not.toHaveBeenCalled();

    const events = await readEvents(paths, config);
    expect(events.map((e) => e.audit_phase)).toEqual(['intent', 'result']);
    expect(events[1]?.outcome).toBe('rejected_by_anonymous_check');
  });

  it('records handler error and rethrows the original exception', async () => {
    const { paths, config } = await initProject();
    const target = stubMemory();
    target.saveMessages.mockRejectedValueOnce(new Error('mastra 503'));
    const audited = wrap(target, { actorId: 'actor-1', configPath: paths.configPath });

    await expect(audited.saveMessages({ messages: [message()] })).rejects.toThrow('mastra 503');

    const events = await readEvents(paths, config);
    expect(events.at(-1)?.outcome).toBe('handler_error');
    expect(events.at(-1)?.error_message).toBe('mastra 503');
  });

  it('uses identity from runWithContext when actorId is not in options', async () => {
    const { paths, config } = await initProject();
    const target = stubMemory();
    const audited = wrap(target, { configPath: paths.configPath });

    await runWithContext({ actorId: 'ctx-actor', tenantId: 't-1' }, () =>
      audited.recall({ threadId: 't1', resourceId: 'res_1' }),
    );

    const events = await readEvents(paths, config);
    expect(events[0]?.actor_id).toBe('ctx-actor');
    expect(events[0]?.tenant_id).toBe('t-1');
  });
});
