import { describe, expect, it, vi } from 'vitest';

import { runWithContext } from '../src/context.js';
import { PsyConfigInvalid } from '../src/errors.js';
import { wrap } from '../src/adapters/mem0/wrap.js';
import type { Mem0Client, Mem0Memory } from '../src/adapters/mem0/types.js';
import { initProject } from './helpers.js';

function memory(overrides: Partial<Mem0Memory> = {}): Mem0Memory {
  return {
    id: 'm_default',
    memory: 'a fact',
    user_id: 'u1',
    metadata: null,
    ...overrides,
  };
}

function stubClient(): Mem0Client & {
  add: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
} {
  return {
    add: vi.fn(async () => [memory({ id: 'm_new', event: 'ADD' })]),
    search: vi.fn(async () => ({ results: [memory()] })),
    get: vi.fn(async (id: string) => memory({ id })),
    getAll: vi.fn(async () => ({ results: [memory()] })),
    update: vi.fn(async (id: string) => [memory({ id })]),
    delete: vi.fn(async () => ({ message: 'ok' })),
    history: vi.fn(async () => ({ history: [] })),
    ping: vi.fn(async () => ({ ok: true })),
  } as unknown as ReturnType<typeof stubClient>;
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

describe('mem0 wrap', () => {
  it('audits add/search/get/getAll/update/delete/history with paired intent+result', async () => {
    const { paths, config } = await initProject();
    const client = stubClient();
    const audited = wrap(client, { actorId: 'tester', configPath: paths.configPath });

    await audited.add([{ role: 'user', content: 'hi' }], { userId: 'u1' });
    await audited.search('something', { userId: 'u1' });
    await audited.get('m_42');
    await audited.getAll({ userId: 'u1' });
    await audited.update('m_42', { text: 'updated' });
    await audited.history('m_42');
    await audited.delete('m_42');

    const events = await readEvents(paths, config);
    expect(events.map((e) => `${e.operation}:${e.audit_phase}`)).toEqual([
      'create:intent', 'create:result',
      'view:intent', 'view:result',
      'view:intent', 'view:result',
      'view:intent', 'view:result',
      'str_replace:intent', 'str_replace:result',
      'view:intent', 'view:result',
      'delete:intent', 'delete:result',
    ]);
    expect(events[0]?.memory_path).toBe('mem0://users/u1/pending');
    expect(events[4]?.memory_path).toBe('mem0://memories/m_42');
    expect(events[8]?.memory_path).toBe('mem0://memories/m_42');
  });

  // Regression: codex [P2] — entityScope only checked camelCase userId/agentId,
  // missing snake_case (user_id/agent_id) which the upstream HTTP docs use.
  // Calls with only snake_case fields silently fell through to "unscoped".
  it('accepts snake_case entity option names (user_id, agent_id, run_id, app_id)', async () => {
    const { paths, config } = await initProject();
    const client = stubClient();
    const audited = wrap(client, { actorId: 'tester', configPath: paths.configPath });

    await audited.add([], { user_id: 'u_snake' } as never);
    await audited.add([], { agent_id: 'a_snake' } as never);
    await audited.add([], { run_id: 'r_snake' } as never);
    await audited.add([], { app_id: 'app_snake' } as never);

    const events = await readEvents(paths, config);
    const intents = events.filter((e) => e.audit_phase === 'intent');
    expect(intents.map((e) => e.memory_path)).toEqual([
      'mem0://users/u_snake/pending',
      'mem0://agents/a_snake/pending',
      'mem0://runs/r_snake/pending',
      'mem0://apps/app_snake/pending',
    ]);
  });

  it('uses entity scope (agents > runs > apps > unscoped) when userId is absent', async () => {
    const { paths, config } = await initProject();
    const client = stubClient();
    const audited = wrap(client, { actorId: 'tester', configPath: paths.configPath });

    await audited.add([], { agentId: 'a1' });
    await audited.add([], { runId: 'r1' });
    await audited.add([], { appId: 'app1' });
    await audited.add([], {});

    const events = await readEvents(paths, config);
    const adds = events.filter((e) => e.audit_phase === 'intent');
    expect(adds.map((e) => e.memory_path)).toEqual([
      'mem0://agents/a1/pending',
      'mem0://runs/r1/pending',
      'mem0://apps/app1/pending',
      'mem0://unscoped/pending',
    ]);
  });

  it('gives user scope precedence over other entity scopes', async () => {
    const { paths, config } = await initProject();
    const client = stubClient();
    const audited = wrap(client, { actorId: 'tester', configPath: paths.configPath });

    await audited.add([], {
      userId: 'u1',
      agentId: 'a1',
      runId: 'r1',
      appId: 'app1',
    });

    const events = await readEvents(paths, config);
    expect(events[0]?.memory_path).toBe('mem0://users/u1/pending');
  });

  it('records distinct paths for scoped search, getAll, and history reads', async () => {
    const { paths, config } = await initProject();
    const client = stubClient();
    const audited = wrap(client, { actorId: 'tester', configPath: paths.configPath });

    await audited.search('query text', { agentId: 'a1' });
    await audited.getAll({ runId: 'r1' });
    await audited.history('m_42');

    const intents = (await readEvents(paths, config)).filter((e) => e.audit_phase === 'intent');
    expect(intents.map((e) => e.memory_path)).toEqual([
      'mem0://search/agents/a1',
      'mem0://all/runs/r1',
      'mem0://memories/m_42/history',
    ]);
  });

  it('preserves exact update results for OSS-style string updates', async () => {
    const { paths, config } = await initProject();
    const client = stubClient();
    const expected = memory({ id: 'm_42', memory: 'updated text' });
    client.update.mockResolvedValueOnce(expected);
    const audited = wrap(client, { actorId: 'tester', configPath: paths.configPath });

    const result = await audited.update('m_42', 'updated text');

    expect(result).toBe(expected);
    expect(client.update).toHaveBeenCalledWith('m_42', 'updated text');
    const events = await readEvents(paths, config);
    const payload = events[1]?.payload_preview ? JSON.parse(events[1].payload_preview) : null;
    expect(payload?.__psy_audit?.result).toEqual({ kind: 'unknown' });
  });

  it('passes through unwrapped methods like ping', async () => {
    const { paths } = await initProject();
    const client = stubClient();
    const audited = wrap(client, { actorId: 'tester', configPath: paths.configPath });

    const result = await (audited as unknown as { ping: () => Promise<unknown> }).ping();
    expect(result).toEqual({ ok: true });
    expect(client.ping).toHaveBeenCalledOnce();
  });

  it('binds pass-through methods to the original client', async () => {
    const { paths } = await initProject();
    const client = stubClient();
    const checkThis = vi.fn(function (this: unknown) {
      return this;
    });
    (client as unknown as { checkThis: typeof checkThis }).checkThis = checkThis;
    const audited = wrap(client, { actorId: 'tester', configPath: paths.configPath });

    const result = (audited as unknown as { checkThis: () => unknown }).checkThis();

    expect(result).toBe(client);
    expect(checkThis).toHaveBeenCalledOnce();
  });

  it('rejects anonymous calls and records validation_error', async () => {
    const { paths, config } = await initProject();
    const client = stubClient();
    const audited = wrap(client, { configPath: paths.configPath });

    await expect(audited.delete('m_42')).rejects.toBeInstanceOf(PsyConfigInvalid);
    expect(client.delete).not.toHaveBeenCalled();

    const events = await readEvents(paths, config);
    expect(events[1]?.outcome).toBe('rejected_by_anonymous_check');
  });

  it('records handler error on update failure and rethrows', async () => {
    const { paths, config } = await initProject();
    const client = stubClient();
    const error = Object.assign(new Error('mem0 429'), { code: 'E_MEM0' });
    client.update.mockRejectedValueOnce(error);
    const audited = wrap(client, { actorId: 'tester', configPath: paths.configPath });

    await expect(audited.update('m_42', { text: 'x' })).rejects.toBe(error);

    const events = await readEvents(paths, config);
    expect(events.at(-1)?.outcome).toBe('handler_error');
    expect(events.at(-1)?.error_code).toBe('E_MEM0');
    expect(events.at(-1)?.error_message).toBe('mem0 429');
  });

  it('uses identity from runWithContext when actorId is absent from options', async () => {
    const { paths, config } = await initProject();
    const client = stubClient();
    const audited = wrap(client, { configPath: paths.configPath });

    await runWithContext({ actorId: 'ctx-actor', tenantId: 't1' }, () =>
      audited.search('q', { userId: 'u1' }),
    );

    const events = await readEvents(paths, config);
    expect(events[0]?.actor_id).toBe('ctx-actor');
    expect(events[0]?.tenant_id).toBe('t1');
  });
});
