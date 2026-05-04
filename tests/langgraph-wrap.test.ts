import { describe, expect, it, vi } from 'vitest';

import { runWithContext } from '../src/context.js';
import { PsyConfigInvalid } from '../src/errors.js';
import { wrap } from '../src/adapters/langgraph/wrap.js';
import type {
  LangGraphCheckpoint,
  LangGraphCheckpointSaver,
  LangGraphCheckpointTuple,
  LangGraphRunnableConfig,
} from '../src/adapters/langgraph/types.js';
import { initProject } from './helpers.js';

function checkpoint(id: string): LangGraphCheckpoint {
  return { id, ts: '2026-04-26T12:00:00.000Z', channel_values: {}, v: 1 };
}

function tuple(id: string, threadId = 't1'): LangGraphCheckpointTuple {
  return {
    config: { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: id } },
    checkpoint: checkpoint(id),
    metadata: { source: 'loop', step: 1 },
  };
}

function stubSaver(): LangGraphCheckpointSaver & {
  getTuple: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  putWrites: ReturnType<typeof vi.fn>;
  deleteThread: ReturnType<typeof vi.fn>;
  unwrappedHelper: ReturnType<typeof vi.fn>;
} {
  const list = vi.fn(async function* () {
    yield tuple('cp_1');
    yield tuple('cp_2');
    yield tuple('cp_3');
  });
  return {
    getTuple: vi.fn(async (config) => tuple(config.configurable?.checkpoint_id ?? 'cp_x')),
    list: list as unknown as ReturnType<typeof vi.fn>,
    put: vi.fn(async (config) => config),
    putWrites: vi.fn(async () => undefined),
    deleteThread: vi.fn(async () => undefined),
    unwrappedHelper: vi.fn(() => 'passthrough-ok'),
  } as unknown as ReturnType<typeof stubSaver>;
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

const baseConfig: LangGraphRunnableConfig = {
  configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: 'cp_42' },
};

async function consume<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) {
    result.push(item);
  }
  return result;
}

describe('langgraph wrap', () => {
  it('audits getTuple/put/putWrites/deleteThread with correct paths', async () => {
    const { paths, config } = await initProject();
    const target = stubSaver();
    const audited = wrap(target, { actorId: 'tester', configPath: paths.configPath });

    await audited.getTuple(baseConfig);
    await audited.put(baseConfig, checkpoint('cp_43'), { source: 'loop' }, {});
    await audited.putWrites(baseConfig, [['ch1', 'set', 'value']], 'task_1');
    await audited.deleteThread('t1');

    const events = await readEvents(paths, config);
    expect(events.map((e) => `${e.operation}:${e.audit_phase}`)).toEqual([
      'view:intent', 'view:result',
      'create:intent', 'create:result',
      'insert:intent', 'insert:result',
      'delete:intent', 'delete:result',
    ]);
    expect(events[0]?.memory_path).toBe('langgraph://threads/t1/_/cp_42');
    expect(events[2]?.memory_path).toBe('langgraph://threads/t1/_/cp_43');
    expect(events[4]?.memory_path).toBe('langgraph://threads/t1/_/cp_42/writes/task_1+1');
    expect(events[6]?.memory_path).toBe('langgraph://threads/t1');
  });

  // Regression: codex [P2] — when a caller breaks out of the for-await
  // before the generator is exhausted, the post-loop success record
  // never ran, leaving an orphaned intent that `psy verify` flags. The
  // try/finally in the wrap now records on early-close as well.
  it('records a result when list iteration is closed early via break', async () => {
    const { paths, config } = await initProject();
    const target = stubSaver();
    const audited = wrap(target, { actorId: 'tester', configPath: paths.configPath });

    let seen = 0;
    for await (const _t of audited.list(baseConfig)) {
      seen++;
      if (seen === 1) break;   // break early — generator gets closed at yield
    }
    expect(seen).toBe(1);

    const events = await readEvents(paths, config);
    expect(events.map((e) => `${e.operation}:${e.audit_phase}`)).toEqual([
      'view:intent', 'view:result',
    ]);
    expect(events[1]?.outcome).toBe('success');
    // The result row should reflect the partial count.
    const payload = events[1]?.payload_preview ? JSON.parse(events[1].payload_preview as never) : null;
    // payload may be null when payload_capture is off; the key signal is
    // that the chain has a paired result, not the count itself.
    expect(events.length).toBe(2);
  });

  it('audits list as a single intent+result pair counting yielded items', async () => {
    const { paths, config } = await initProject();
    const target = stubSaver();
    const audited = wrap(target, { actorId: 'tester', configPath: paths.configPath });

    const items: LangGraphCheckpointTuple[] = [];
    for await (const item of audited.list(baseConfig)) {
      items.push(item);
    }
    expect(items).toHaveLength(3);

    const events = await readEvents(paths, config);
    expect(events.map((e) => `${e.operation}:${e.audit_phase}`)).toEqual([
      'view:intent', 'view:result',
    ]);
    expect(events[0]?.memory_path).toBe('langgraph://threads/t1/_/list');
  });

  it('forwards list options while re-yielding the original tuples', async () => {
    const { paths, config } = await initProject();
    const target = stubSaver();
    const expected = [tuple('cp_a'), tuple('cp_b')];
    target.list.mockImplementationOnce(async function* (_config, _opts) {
      yield expected[0]!;
      yield expected[1]!;
    });
    const audited = wrap(target, { actorId: 'tester', configPath: paths.configPath });
    const listOpts = { limit: 2, filter: { source: 'loop' } };

    const result = await consume(audited.list(baseConfig, listOpts));

    expect(result).toEqual(expected);
    expect(result[0]).toBe(expected[0]);
    expect(target.list).toHaveBeenCalledWith(baseConfig, listOpts);
    const events = await readEvents(paths, config);
    expect(events).toHaveLength(2);
  });

  it('records list generator errors and rethrows the exact error object', async () => {
    const { paths, config } = await initProject();
    const target = stubSaver();
    const error = Object.assign(new Error('list failed'), { code: 'E_LIST' });
    target.list.mockImplementationOnce(async function* () {
      yield tuple('cp_1');
      throw error;
    });
    const audited = wrap(target, { actorId: 'tester', configPath: paths.configPath });

    await expect(consume(audited.list(baseConfig))).rejects.toBe(error);

    const events = await readEvents(paths, config);
    expect(events.map((e) => e.audit_phase)).toEqual(['intent', 'result']);
    expect(events[1]?.outcome).toBe('handler_error');
    expect(events[1]?.error_code).toBe('E_LIST');
    expect(events[1]?.error_message).toBe('list failed');
  });

  it('rejects anonymous list iteration before calling the saver generator', async () => {
    const { paths, config } = await initProject();
    const target = stubSaver();
    const audited = wrap(target, { configPath: paths.configPath });

    await expect(consume(audited.list(baseConfig))).rejects.toBeInstanceOf(PsyConfigInvalid);

    expect(target.list).not.toHaveBeenCalled();
    const events = await readEvents(paths, config);
    expect(events.map((e) => e.audit_phase)).toEqual(['intent', 'result']);
    expect(events[1]?.outcome).toBe('rejected_by_anonymous_check');
  });

  it('uses latest checkpoint path when checkpoint_id is omitted', async () => {
    const { paths, config } = await initProject();
    const target = stubSaver();
    const audited = wrap(target, { actorId: 'tester', configPath: paths.configPath });
    const latestConfig: LangGraphRunnableConfig = {
      configurable: { thread_id: 't_latest', checkpoint_ns: '' },
    };

    await audited.get!(latestConfig);

    expect(target.getTuple).toHaveBeenCalledWith(latestConfig);
    const events = await readEvents(paths, config);
    expect(events[0]?.operation).toBe('view');
    expect(events[0]?.memory_path).toBe('langgraph://threads/t_latest/_/latest');
  });

  it('records zero pending writes as an explicit +0 path suffix', async () => {
    const { paths, config } = await initProject();
    const target = stubSaver();
    const audited = wrap(target, { actorId: 'tester', configPath: paths.configPath });

    await audited.putWrites(baseConfig, [], 'task_empty');

    const events = await readEvents(paths, config);
    expect(events[0]?.operation).toBe('insert');
    expect(events[0]?.memory_path).toBe('langgraph://threads/t1/_/cp_42/writes/task_empty+0');
  });

  it('uses checkpoint_ns when set instead of underscore', async () => {
    const { paths, config } = await initProject();
    const target = stubSaver();
    const audited = wrap(target, { actorId: 'tester', configPath: paths.configPath });

    await audited.getTuple({
      configurable: { thread_id: 't1', checkpoint_ns: 'my-ns', checkpoint_id: 'cp_x' },
    });

    const events = await readEvents(paths, config);
    expect(events[0]?.memory_path).toBe('langgraph://threads/t1/my-ns/cp_x');
  });

  it('passes through unwrapped methods', async () => {
    const { paths } = await initProject();
    const target = stubSaver();
    const audited = wrap(target, { actorId: 'tester', configPath: paths.configPath });

    const result = (audited as unknown as { unwrappedHelper: () => string }).unwrappedHelper();
    expect(result).toBe('passthrough-ok');
    expect(target.unwrappedHelper).toHaveBeenCalledOnce();
  });

  it('rejects anonymous calls', async () => {
    const { paths, config } = await initProject();
    const target = stubSaver();
    const audited = wrap(target, { configPath: paths.configPath });

    await expect(audited.deleteThread('t1')).rejects.toBeInstanceOf(PsyConfigInvalid);
    expect(target.deleteThread).not.toHaveBeenCalled();

    const events = await readEvents(paths, config);
    expect(events[1]?.outcome).toBe('rejected_by_anonymous_check');
  });

  it('records handler error on put failure and rethrows', async () => {
    const { paths, config } = await initProject();
    const target = stubSaver();
    target.put.mockRejectedValueOnce(new Error('saver offline'));
    const audited = wrap(target, { actorId: 'tester', configPath: paths.configPath });

    await expect(
      audited.put(baseConfig, checkpoint('cp_99'), { source: 'loop' }, {}),
    ).rejects.toThrow('saver offline');

    const events = await readEvents(paths, config);
    expect(events.at(-1)?.outcome).toBe('handler_error');
  });

  it('uses identity from runWithContext', async () => {
    const { paths, config } = await initProject();
    const target = stubSaver();
    const audited = wrap(target, { configPath: paths.configPath });

    await runWithContext({ actorId: 'ctx-actor' }, () => audited.getTuple(baseConfig));

    const events = await readEvents(paths, config);
    expect(events[0]?.actor_id).toBe('ctx-actor');
  });
});
