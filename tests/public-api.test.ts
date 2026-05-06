import path from 'node:path';
import { existsSync, rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { init, query, verify, wrap } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { Sealer } from '../src/seal.js';
import { PsyStore } from '../src/store.js';
import { draft, initProject, tempProject } from './helpers.js';

const SEAL_ENV = ['PSY_HEAD_PATH', 'PSY_SEAL_KEY_PATH', 'PSY_SEAL_KEY'] as const;

afterEach(() => {
  for (const key of SEAL_ENV) {
    delete process.env[key];
  }
});

describe('public API', () => {
  it('initializes the configured database path instead of only reporting it', async () => {
    const cwd = await tempProject();
    const result = await init({ cwd, dbPath: 'custom/audit.sqlite' });
    const { config, paths } = await loadConfig({ cwd });

    expect(result.databasePath).toBe(path.join(cwd, 'custom/audit.sqlite'));
    expect(config.sqlite_path).toBe('custom/audit.sqlite');
    expect(config.seal).toBe('required');
    expect(paths.sqlitePath).toBe(result.databasePath);
    expect(existsSync(result.databasePath)).toBe(true);
  });

  it('maps root wrap compatibility aliases onto the current identity fields', async () => {
    const { paths, config } = await initProject();
    const handlers = {
      view: async () => 'view-result',
      create: async () => 'create-result',
      str_replace: async () => 'str_replace-result',
      insert: async () => 'insert-result',
      delete: async () => 'delete-result',
      rename: async () => 'rename-result',
    };
    const audited = wrap(handlers, {
      actor: 'legacy-actor',
      runId: 'legacy-run',
      configPath: paths.configPath,
    });

    await audited.view({ command: 'view', path: '/memories/a.md' });

    const store = new PsyStore({ sqlitePath: paths.sqlitePath, archivesPath: paths.archivesPath, config });
    const events = store.allActiveEvents();
    store.close();
    expect(events[0]?.actor_id).toBe('legacy-actor');
    expect(events[0]?.session_id).toBe('legacy-run');
  });

  it('queries stored bare operations with bare or legacy memory-prefixed filters', async () => {
    const { paths, config } = await initProject();
    const store = new PsyStore({ sqlitePath: paths.sqlitePath, archivesPath: paths.archivesPath, config });
    store.append(draft({ event_id: 'evt-create', operation_id: 'op-create', operation: 'create' }));
    store.append(draft({ event_id: 'evt-view', operation_id: 'op-view', operation: 'view' }));
    store.append(draft({ event_id: 'evt-legacy-create', operation_id: 'op-legacy-create', operation: 'memory.create' }));
    store.close();

    const bare = await query({ configPath: paths.configPath, operation: 'create' });
    const legacyCaller = await query({ configPath: paths.configPath, operation: 'memory.create' });

    expect(bare.map((event) => event.event_id)).toEqual(['evt-create', 'evt-legacy-create']);
    expect(legacyCaller.map((event) => event.event_id)).toEqual(['evt-create', 'evt-legacy-create']);
  });

  it('paginates operation queries after matching both bare and legacy stored names', async () => {
    const { paths, config } = await initProject();
    const store = new PsyStore({ sqlitePath: paths.sqlitePath, archivesPath: paths.archivesPath, config });
    store.append(draft({ event_id: 'evt-create-1', operation_id: 'op-create-1', operation: 'create' }));
    store.append(draft({ event_id: 'evt-view', operation_id: 'op-view', operation: 'view' }));
    store.append(draft({ event_id: 'evt-create-2', operation_id: 'op-create-2', operation: 'memory.create' }));
    store.append(draft({ event_id: 'evt-create-3', operation_id: 'op-create-3', operation: 'create' }));
    store.close();

    const events = await query({
      configPath: paths.configPath,
      operation: 'memory.create',
      offset: 1,
      limit: 1,
    });

    expect(events.map((event) => event.event_id)).toEqual(['evt-create-2']);
  });

  it('loads a sealer with env-overridden paths and detects a forged tail truncation', async () => {
    const { cwd, paths, config } = await initProject();
    const store = new PsyStore({ sqlitePath: paths.sqlitePath, archivesPath: paths.archivesPath, config });
    store.append(draft({ event_id: 'evt-1', operation_id: 'op-1', operation: 'create', audit_phase: 'intent' }));
    const verifiedTail = store.append(draft({
      event_id: 'evt-2',
      operation_id: 'op-1',
      operation: 'create',
      audit_phase: 'result',
      tool_output_hash: 'b'.repeat(64),
    }));
    store.append(draft({ event_id: 'evt-3', operation_id: 'op-2', operation: 'delete', audit_phase: 'intent' }));
    const sealedTail = store.append(draft({
      event_id: 'evt-4',
      operation_id: 'op-2',
      operation: 'delete',
      audit_phase: 'result',
      tool_output_hash: 'c'.repeat(64),
    }));

    const headPath = path.join(cwd, 'seal-overrides', 'head.json');
    const keyPath = path.join(cwd, 'seal-overrides', 'seal-key');
    const { sealer } = Sealer.bootstrap({ headPath, keyPath });
    sealer.writeHead(sealedTail.seq, sealedTail.event_hash, sealedTail.timestamp);

    store.db.prepare('DELETE FROM events WHERE seq > 2').run();
    store.db.prepare("UPDATE meta SET value = ? WHERE key = 'last_seq'").run(String(verifiedTail.seq));
    store.db.prepare("UPDATE meta SET value = ? WHERE key = 'chain_head_hash'").run(verifiedTail.event_hash);
    store.close();

    process.env.PSY_HEAD_PATH = headPath;
    process.env.PSY_SEAL_KEY_PATH = keyPath;

    const result = await verify({ configPath: paths.configPath });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['seal_seq_mismatch', 'seal_hash_mismatch']),
    );
  });

  it('reports a missing required seal when head and key have been wiped', async () => {
    const { paths, config } = await initProject({ seal: 'required' });
    const store = new PsyStore({ sqlitePath: paths.sqlitePath, archivesPath: paths.archivesPath, config });
    store.append(draft({ event_id: 'evt-1', operation_id: 'op-1', operation: 'create', audit_phase: 'intent' }));
    store.append(draft({
      event_id: 'evt-2',
      operation_id: 'op-1',
      operation: 'create',
      audit_phase: 'result',
      tool_output_hash: 'b'.repeat(64),
    }));
    store.close();

    const result = await verify({ configPath: paths.configPath });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('seal_missing_required');
  });

  it('only skips seal enforcement when callers opt out explicitly', async () => {
    const { paths, config } = await initProject({ seal: 'required' });
    const store = new PsyStore({ sqlitePath: paths.sqlitePath, archivesPath: paths.archivesPath, config });
    store.append(draft({ event_id: 'evt-1', operation_id: 'op-1', operation: 'create', audit_phase: 'intent' }));
    const event = store.append(draft({
      event_id: 'evt-2',
      operation_id: 'op-1',
      operation: 'create',
      audit_phase: 'result',
      tool_output_hash: 'b'.repeat(64),
    }));
    const headPath = path.join(path.dirname(paths.sqlitePath), 'head.json');
    const keyPath = path.join(path.dirname(paths.sqlitePath), 'seal-key');
    Sealer.bootstrap({ headPath, keyPath }).sealer.writeHead(event.seq, event.event_hash, event.timestamp);
    store.close();

    process.env.PSY_HEAD_PATH = headPath;
    process.env.PSY_SEAL_KEY_PATH = keyPath;
    await expect(verify({ configPath: paths.configPath })).resolves.toMatchObject({ ok: true });

    rmSync(keyPath, { force: true });

    const enforced = await verify({ configPath: paths.configPath });
    const skipped = await verify({ configPath: paths.configPath, seal: false });

    expect(enforced.ok).toBe(false);
    expect(enforced.issues.map((issue) => issue.code)).toContain('seal_key_unavailable');
    expect(skipped.ok).toBe(true);
    expect(skipped.issues.map((issue) => issue.code)).not.toContain('seal_key_unavailable');
  });
});
