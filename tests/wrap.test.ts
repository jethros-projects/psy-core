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
    const { paths } = await initProject();
    const wrapped = wrap(handlers(), { configPath: paths.configPath });
    await runWithContext({ tenantId: 'tenant-1' }, () =>
      wrapped.view({ command: 'view', path: '/memories' }),
    );
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
});
