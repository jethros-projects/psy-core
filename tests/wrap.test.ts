import type { MemoryToolHandlers } from '@anthropic-ai/sdk/helpers/beta/memory';
import { describe, expect, it, vi } from 'vitest';

import { runWithContext } from '../src/context.js';
import { PsyConfigInvalid, PsyPathTraversal } from '../src/errors.js';
import { wrap } from '../src/adapters/anthropic-memory/wrap.js';
import { initProject } from './helpers.js';

function handlers() {
  return {
    view: vi.fn(async () => 'view result'),
    create: vi.fn(async () => 'create result'),
    str_replace: vi.fn(async () => 'replace result'),
    insert: vi.fn(async () => 'insert result'),
    delete: vi.fn(async () => 'delete result'),
    rename: vi.fn(async () => 'rename result'),
  } satisfies MemoryToolHandlers;
}

async function readEvents(paths: { sqlitePath: string; archivesPath: string }, config: unknown) {
  const { PsyStore } = await import('../src/store.js');
  const store = new PsyStore({ sqlitePath: paths.sqlitePath, archivesPath: paths.archivesPath, config: config as never });
  const events = store.allActiveEvents();
  store.close();
  return events;
}

describe('wrap', () => {
  it('writes intent/result and preserves handler this binding', async () => {
    const { paths } = await initProject();
    const base = handlers();
    const wrapped = wrap(base, { actorId: 'actor-1', configPath: paths.configPath });

    await expect(wrapped.create({ command: 'create', path: '/memories/a.md', file_text: 'hello' })).resolves.toBe('create result');

    const { PsyStore } = await import('../src/store.js');
    const { loadConfig } = await import('../src/config.js');
    const loaded = await loadConfig({ configPath: paths.configPath });
    const store = new PsyStore({ sqlitePath: loaded.paths.sqlitePath, archivesPath: loaded.paths.archivesPath, config: loaded.config });
    expect(store.allActiveEvents().map((event) => event.audit_phase)).toEqual(['intent', 'result']);
    expect(store.allActiveEvents()[1]?.actor_id).toBe('actor-1');
    store.close();
  });

  it('uses AsyncLocalStorage identity', async () => {
    const { paths, config } = await initProject();
    const wrapped = wrap(handlers(), { configPath: paths.configPath });
    await runWithContext({ tenantId: 'tenant-1' }, () =>
      wrapped.view({ command: 'view', path: '/memories' }),
    );

    const events = await readEvents(paths, config);
    expect(events[0]?.actor_id).toBeNull();
    expect(events[0]?.tenant_id).toBe('tenant-1');
  });

  it('rejects anonymous and unsafe paths without calling handler', async () => {
    const { paths } = await initProject();
    const base = handlers();
    await expect(wrap(base, { configPath: paths.configPath }).view({ command: 'view', path: '/memories' })).rejects.toBeInstanceOf(PsyConfigInvalid);

    const unsafe = wrap(base, { actorId: 'actor', configPath: paths.configPath });
    await expect(unsafe.delete({ command: 'delete', path: '/etc/passwd' })).rejects.toBeInstanceOf(PsyPathTraversal);
    expect(base.delete).not.toHaveBeenCalled();
  });

  it('captures redacted payload preview only when enabled', async () => {
    const { paths, config } = await initProject({
      payload_capture: { enabled: true, max_bytes: 512 },
    });
    const wrapped = wrap(handlers(), { actorId: 'actor', configPath: paths.configPath });
    await wrapped.create({ command: 'create', path: '/memories/a.md', file_text: 'sk-ant-abcdefghijklmnop' });

    const { PsyStore } = await import('../src/store.js');
    const store = new PsyStore({ sqlitePath: paths.sqlitePath, archivesPath: paths.archivesPath, config });
    const result = store.allActiveEvents()[1]!;
    expect(result.payload_preview).toContain('[REDACTED');
    expect(result.payload_redacted).toBe(true);
    store.close();
  });

  it('rejects an incomplete handler surface at wrap time', () => {
    const base: MemoryToolHandlers = handlers();
    delete (base as Partial<MemoryToolHandlers>).rename;

    expect(() => wrap(base)).toThrow(/MemoryToolHandlers\.rename/);
  });

  it('records rename path metadata and preserves content-block results', async () => {
    const { paths, config } = await initProject();
    const base: MemoryToolHandlers = handlers();
    const blocks = [{ type: 'text', text: 'renamed' }] as never;
    base.rename = vi.fn(async function (this: MemoryToolHandlers) {
      expect(this).toBe(base);
      return blocks;
    }) as MemoryToolHandlers['rename'];
    const wrapped = wrap(base, { actorId: 'actor-1', configPath: paths.configPath });

    await expect(
      wrapped.rename({
        command: 'rename',
        old_path: '/memories/old.md',
        new_path: '/memories/new.md',
      }),
    ).resolves.toBe(blocks);

    const events = await readEvents(paths, config);
    expect(events.map((e) => e.audit_phase)).toEqual(['intent', 'result']);
    expect(events[0]?.memory_path).toBe('/memories/old.md');
    const intentPayload = events[0]?.payload_preview ? JSON.parse(events[0].payload_preview) : null;
    expect(intentPayload?.__psy_audit?.paths).toEqual({
      old_path: '/memories/old.md',
      new_path: '/memories/new.md',
    });
    const resultPayload = events[1]?.payload_preview ? JSON.parse(events[1].payload_preview) : null;
    expect(resultPayload?.__psy_audit?.result).toEqual({
      kind: 'content_blocks',
      blockCount: 1,
    });
  });

  it('rethrows the exact handler error after recording it', async () => {
    const { paths, config } = await initProject();
    const base: MemoryToolHandlers = handlers();
    const error = Object.assign(new Error('insert exploded'), { code: 'E_INSERT' });
    base.insert = vi.fn(async () => {
      throw error;
    }) as MemoryToolHandlers['insert'];
    const wrapped = wrap(base, { actorId: 'actor-1', configPath: paths.configPath });

    await expect(
      wrapped.insert({
        command: 'insert',
        path: '/memories/a.md',
        insert_line: 1,
        insert_text: 'x',
      }),
    ).rejects.toBe(error);

    const events = await readEvents(paths, config);
    expect(events.at(-1)?.outcome).toBe('handler_error');
    expect(events.at(-1)?.error_code).toBe('E_INSERT');
    expect(events.at(-1)?.error_message).toBe('insert exploded');
  });
});
