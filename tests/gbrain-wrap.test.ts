import { describe, expect, it, vi } from 'vitest';

import { runWithContext } from '../src/context.js';
import { PsyConfigInvalid } from '../src/errors.js';
import { wrapEngine, wrapOperation, wrapOperations } from '../src/adapters/gbrain/wrap.js';
import type { GBrainEngine, GBrainOperation } from '../src/adapters/gbrain/types.js';
import { initProject } from './helpers.js';

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

type OperationOpts = {
  scope?: GBrainOperation['scope'];
  mutating?: boolean;
};

function operation(
  name: string,
  handler: ReturnType<typeof vi.fn> = vi.fn(async () => ({ ok: true })),
  opts: OperationOpts = {},
): GBrainOperation & {
  handler: ReturnType<typeof vi.fn>;
} {
  const op: GBrainOperation & { handler: ReturnType<typeof vi.fn> } = {
    name,
    scope: opts.scope ?? (name.startsWith('get') || name === 'query' ? 'read' : 'write'),
    mutating: opts.mutating ?? !(name.startsWith('get') || name === 'query'),
    handler,
  } as GBrainOperation & { handler: ReturnType<typeof vi.fn> };
  return op;
}

function stubEngine() {
  const tx = {
    putPage: vi.fn(async (slug: string, _page?: unknown) => ({ slug })),
    addLink: vi.fn(async (
      _from: string,
      _to: string,
      _context?: string,
      _linkType?: string,
    ) => undefined),
  };
  const engine = {
    kind: 'pglite',
    getPage: vi.fn(async (slug: string) => ({ slug })),
    putPage: vi.fn(async (slug: string, _page?: unknown) => ({ slug })),
    addLink: vi.fn(async (
      _from: string,
      _to: string,
      _context?: string,
      _linkType?: string,
    ) => undefined),
    deletePage: vi.fn(async (_slug: string) => undefined),
    updateSlug: vi.fn(async (_oldSlug: string, _newSlug: string) => undefined),
    upsertChunks: vi.fn(async (_slug: string, _chunks?: unknown[]) => undefined),
    addTimelineEntry: vi.fn(async (_slug: string, _entry?: unknown) => undefined),
    getChunks: vi.fn(async (_slug: string) => []),
    getChunksWithEmbeddings: vi.fn(async (_slug: string) => []),
    deleteChunks: vi.fn(async (_slug: string) => undefined),
    createVersion: vi.fn(async (_slug: string) => undefined),
    revertToVersion: vi.fn(async (_slug: string, _versionId: number) => undefined),
    rewriteLinks: vi.fn(async (_oldSlug: string, _newSlug: string) => undefined),
    setConfig: vi.fn(async (_key: string, _value: string) => undefined),
    executeRaw: vi.fn(async (_sql: string, _params?: unknown[]) => []),
    transaction: vi.fn(async (fn: (txEngine: typeof tx) => Promise<unknown>) => fn(tx)),
    withReservedConnection: vi.fn(async (fn: (conn: { executeRaw: typeof engine.executeRaw }) => Promise<unknown>) =>
      fn({ executeRaw: engine.executeRaw }),
    ),
    helper: vi.fn(() => 'passthrough-ok'),
  };
  return { engine, tx };
}

function intentEvents(events: Awaited<ReturnType<typeof readEvents>>) {
  return events.filter(e => e.audit_phase === 'intent');
}

describe('gbrain operations wrap', () => {
  it('audits operation handlers with GBrain paths and default context identity', async () => {
    const { paths, config } = await initProject();
    const ops = wrapOperations([
      operation('put_page'),
      operation('add_link'),
      operation('delete_page'),
      operation('query'),
    ], { configPath: paths.configPath });

    await ops[0].handler(
      { auth: { clientId: 'oauth-client' }, brainId: 'vc-brain', jobId: 12 },
      { slug: 'people/alice', content: 'hello' },
    );
    await ops[1].handler(
      { auth: { clientId: 'oauth-client' }, brainId: 'vc-brain' },
      { from: 'people/alice', to: 'companies/acme', link_type: 'works_at' },
    );
    await ops[2].handler(
      { auth: { clientId: 'oauth-client' }, brainId: 'vc-brain' },
      { slug: 'people/alice' },
    );
    await ops[3].handler(
      { auth: { clientId: 'oauth-client' }, brainId: 'vc-brain' },
      { query: 'sensitive question' },
    );

    const events = await readEvents(paths, config);
    expect(events.map(e => `${e.operation}:${e.audit_phase}`)).toEqual([
      'str_replace:intent', 'str_replace:result',
      'insert:intent', 'insert:result',
      'delete:intent', 'delete:result',
      'view:intent', 'view:result',
    ]);
    expect(events[0]?.actor_id).toBe('oauth-client');
    expect(events[0]?.session_id).toBe('gbrain-job:12');
    expect(events[0]?.memory_path).toBe('gbrain://brains/vc-brain/pages/people/alice');
    expect(events[2]?.memory_path).toBe('gbrain://brains/vc-brain/links/people/alice/works_at/companies/acme');
    expect(events[4]?.memory_path).toBe('gbrain://brains/vc-brain/pages/people/alice');
    expect(events[6]?.memory_path).toMatch(/^gbrain:\/\/brains\/vc-brain\/search\/hybrid\/[a-f0-9]{16}$/);
    expect(events[6]?.memory_path).not.toContain('sensitive');
  });

  it('preserves operation handler return values and this binding', async () => {
    const { paths, config } = await initProject();
    const expected = { ok: true, rows: [{ slug: 'people/alice' }] };
    let seenThis: unknown;
    const handler = vi.fn(async function (this: GBrainOperation) {
      seenThis = this;
      return expected;
    });
    const [wrapped] = wrapOperations([operation('put_page', handler)], {
      actorId: 'tester',
      configPath: paths.configPath,
    });

    const result = await wrapped.handler({ brainId: 'host' }, { slug: 'people/alice' });

    expect(result).toBe(expected);
    expect(seenThis).toMatchObject({ name: 'put_page' });
    const events = await readEvents(paths, config);
    const payload = events[1]?.payload_preview ? JSON.parse(events[1].payload_preview) : null;
    expect(payload?.__psy_audit?.result).toEqual({ kind: 'unknown' });
  });

  it('prefers subagent identity over job identity for operation sessions', async () => {
    const { paths, config } = await initProject();
    const [wrapped] = wrapOperations([operation('get_page', undefined, { scope: 'read', mutating: false })], {
      configPath: paths.configPath,
    });

    await wrapped.handler(
      {
        auth: { clientId: 'oauth-client' },
        brainId: 'host',
        subagentId: 7,
        jobId: 12,
      },
      { slug: 'people/alice' },
    );

    const events = await readEvents(paths, config);
    expect(events[0]?.actor_id).toBe('oauth-client');
    expect(events[0]?.session_id).toBe('gbrain-subagent:7');
  });

  it('uses the configured brainId when an operation context omits one', async () => {
    const { paths, config } = await initProject();
    const [wrapped] = wrapOperations([operation('get_page', undefined, { scope: 'read', mutating: false })], {
      actorId: 'tester',
      brainId: 'configured-brain',
      configPath: paths.configPath,
    });

    await wrapped.handler({}, { slug: 'people/alice' });

    const events = await readEvents(paths, config);
    expect(events[0]?.memory_path).toBe('gbrain://brains/configured-brain/pages/people/alice');
  });

  it('encodes operation path segments and defaults blank link_type to link', async () => {
    const { paths, config } = await initProject();
    const [wrapped] = wrapOperations([operation('add_link')], {
      actorId: 'tester',
      configPath: paths.configPath,
    });

    await wrapped.handler(
      { brainId: 'brain space' },
      {
        from: '/people/Alice Smith/',
        to: 'companies/Acme & Sons',
        link_type: '',
      },
    );

    const events = await readEvents(paths, config);
    expect(events[0]?.memory_path).toBe(
      'gbrain://brains/brain%20space/links/people/Alice%20Smith/link/companies/Acme%20%26%20Sons',
    );
  });

  it('can skip read auditing without requiring identity', async () => {
    const { paths, config } = await initProject();
    const getPage = operation('get_page');
    const [wrapped] = wrapOperations([getPage], {
      configPath: paths.configPath,
      auditReads: false,
    });

    await wrapped.handler({}, { slug: 'people/alice' });

    expect(getPage.handler).toHaveBeenCalledOnce();
    const events = await readEvents(paths, config);
    expect(events).toHaveLength(0);
  });

  it('records operation handler errors and rethrows', async () => {
    const { paths, config } = await initProject();
    const error = Object.assign(new Error('gbrain write failed'), { code: 'E_GBRAIN_WRITE' });
    const boom = operation('put_page', vi.fn(async () => {
      throw error;
    }));
    const [wrapped] = wrapOperations([boom], {
      actorId: 'tester',
      configPath: paths.configPath,
    });

    await expect(wrapped.handler({}, { slug: 'people/alice' })).rejects.toBe(error);

    const events = await readEvents(paths, config);
    expect(events.at(-1)?.outcome).toBe('handler_error');
    expect(events.at(-1)?.error_code).toBe('E_GBRAIN_WRITE');
    expect(events.at(-1)?.error_message).toBe('gbrain write failed');
  });

  it('maps a broad set of GBrain operations onto canonical audit paths', async () => {
    const { paths, config } = await initProject();
    const cases: Array<{
      name: string;
      params: Record<string, unknown>;
      scope?: GBrainOperation['scope'];
      mutating?: boolean;
      expectedOperation: string;
      expectedPath: string | RegExp;
    }> = [
      { name: 'list_pages', params: {}, scope: 'read', mutating: false, expectedOperation: 'view', expectedPath: 'gbrain://brains/host/pages' },
      { name: 'search', params: { query: 'board secrets' }, scope: 'read', mutating: false, expectedOperation: 'view', expectedPath: /^gbrain:\/\/brains\/host\/search\/keyword\/[a-f0-9]{16}$/ },
      { name: 'add_tag', params: { slug: 'people/alice', tag: 'founder' }, expectedOperation: 'insert', expectedPath: 'gbrain://brains/host/pages/people/alice/tags/founder' },
      { name: 'remove_tag', params: { slug: 'people/alice', tag: 'founder' }, expectedOperation: 'delete', expectedPath: 'gbrain://brains/host/pages/people/alice/tags/founder' },
      { name: 'get_tags', params: { slug: 'people/alice' }, scope: 'read', mutating: false, expectedOperation: 'view', expectedPath: 'gbrain://brains/host/pages/people/alice/tags' },
      { name: 'add_timeline_entry', params: { slug: 'people/alice', date: '2026-05-03' }, expectedOperation: 'insert', expectedPath: 'gbrain://brains/host/pages/people/alice/timeline/2026-05-03' },
      { name: 'get_timeline', params: { slug: 'people/alice' }, scope: 'read', mutating: false, expectedOperation: 'view', expectedPath: 'gbrain://brains/host/pages/people/alice/timeline' },
      { name: 'get_versions', params: { slug: 'people/alice' }, scope: 'read', mutating: false, expectedOperation: 'view', expectedPath: 'gbrain://brains/host/pages/people/alice/versions' },
      { name: 'revert_version', params: { slug: 'people/alice', version_id: 7 }, expectedOperation: 'str_replace', expectedPath: 'gbrain://brains/host/pages/people/alice/versions/7' },
      { name: 'put_raw_data', params: { slug: 'people/alice', source: 'crm' }, expectedOperation: 'str_replace', expectedPath: 'gbrain://brains/host/pages/people/alice/raw-data/crm' },
      { name: 'get_raw_data', params: { slug: 'people/alice', source: 'crm' }, scope: 'read', mutating: false, expectedOperation: 'view', expectedPath: 'gbrain://brains/host/pages/people/alice/raw-data/crm' },
      { name: 'resolve_slugs', params: { partial: 'ali' }, scope: 'read', mutating: false, expectedOperation: 'view', expectedPath: /^gbrain:\/\/brains\/host\/resolve\/[a-f0-9]{16}$/ },
      { name: 'get_chunks', params: { slug: 'people/alice' }, scope: 'read', mutating: false, expectedOperation: 'view', expectedPath: 'gbrain://brains/host/pages/people/alice/chunks' },
      { name: 'remove_link', params: { from: 'people/alice', to: 'companies/acme' }, expectedOperation: 'delete', expectedPath: 'gbrain://brains/host/links/people/alice/link/companies/acme' },
      { name: 'get_backlinks', params: { slug: 'people/alice' }, scope: 'read', mutating: false, expectedOperation: 'view', expectedPath: 'gbrain://brains/host/pages/people/alice/links/in' },
      { name: 'traverse_graph', params: { slug: 'people/alice' }, scope: 'read', mutating: false, expectedOperation: 'view', expectedPath: 'gbrain://brains/host/pages/people/alice/graph' },
      { name: 'find_orphans', params: {}, scope: 'read', mutating: false, expectedOperation: 'view', expectedPath: 'gbrain://brains/host/orphans' },
    ];
    const ops = wrapOperations(
      cases.map(c => operation(c.name, undefined, { scope: c.scope, mutating: c.mutating })),
      { actorId: 'tester', configPath: paths.configPath },
    );

    for (let i = 0; i < cases.length; i++) {
      await ops[i].handler({ brainId: 'host' }, cases[i].params);
    }

    const intents = intentEvents(await readEvents(paths, config));
    expect(intents).toHaveLength(cases.length);
    for (let i = 0; i < cases.length; i++) {
      expect(intents[i]?.operation).toBe(cases[i].expectedOperation);
      if (typeof cases[i].expectedPath === 'string') {
        expect(intents[i]?.memory_path).toBe(cases[i].expectedPath);
      } else {
        expect(intents[i]?.memory_path).toMatch(cases[i].expectedPath);
      }
    }
    expect(intents.find(e => e.memory_path.includes('search/keyword'))?.memory_path).not.toContain('board');
  });

  it('skips non-memory GBrain operations by default', async () => {
    const { paths, config } = await initProject();
    const names = [
      'get_stats',
      'get_health',
      'sync_brain',
      'log_ingest',
      'file_upload',
      'submit_job',
      'cancel_job',
      'send_job_message',
      'create_thing',
      'add_thing',
      'delete_thing',
    ];
    const ops = wrapOperations(
      names.map(name => operation(name, undefined, { scope: 'admin', mutating: true })),
      { actorId: 'tester', configPath: paths.configPath },
    );

    for (const op of ops) {
      await op.handler({ brainId: 'host' }, {});
    }

    expect(await readEvents(paths, config)).toHaveLength(0);
  });

  it('supports custom operation classification, identity, purpose, and explicit skip', async () => {
    const { paths, config } = await initProject();
    const custom = wrapOperation(operation('bespoke'), {
      configPath: paths.configPath,
      classifyOperation: (op) =>
        op.name === 'bespoke'
          ? { operation: 'insert', memoryPath: 'gbrain://brains/custom/events/bespoke' }
          : undefined,
      identityFromOperation: () => ({ actorId: 'dynamic-actor', tenantId: 'dyn-tenant' }),
      purposeFromOperation: () => 'gbrain-custom-op',
    });
    const skippedHandler = vi.fn(async () => ({ skipped: true }));
    const skipped = wrapOperation(operation('skip_me', skippedHandler), {
      configPath: paths.configPath,
      classifyOperation: () => null,
    });

    await custom.handler({}, {});
    await skipped.handler({}, {});

    const events = await readEvents(paths, config);
    expect(events).toHaveLength(2);
    expect(events[0]?.operation).toBe('insert');
    expect(events[0]?.memory_path).toBe('gbrain://brains/custom/events/bespoke');
    expect(events[0]?.actor_id).toBe('dynamic-actor');
    expect(events[0]?.tenant_id).toBe('dyn-tenant');
    expect(events[0]?.purpose).toBe('gbrain-custom-op');
    expect(skippedHandler).toHaveBeenCalledOnce();
  });

  it('can suppress custom admin-scope read operations without requiring identity', async () => {
    const { paths, config } = await initProject();
    const op = wrapOperation(operation('get_stats', undefined, {
      scope: 'admin',
      mutating: false,
    }), {
      configPath: paths.configPath,
      classifyOperation: () => ({ operation: 'view', memoryPath: 'gbrain://brains/host/admin/stats' }),
      auditAdminReads: false,
    });

    await op.handler({}, {});

    expect(await readEvents(paths, config)).toHaveLength(0);
  });
});

describe('gbrain engine wrap', () => {
  it('audits direct BrainEngine page/link methods and preserves passthrough methods', async () => {
    const { paths, config } = await initProject();
    const { engine } = stubEngine();
    const audited = wrapEngine(engine as unknown as GBrainEngine, {
      actorId: 'tester',
      brainId: 'host',
      configPath: paths.configPath,
    }) as unknown as typeof engine;

    await audited.getPage('people/alice');
    await audited.putPage('people/alice');
    await audited.addLink('people/alice', 'companies/acme', 'context', 'works_at');
    await audited.deletePage('people/alice');
    const helperResult = audited.helper();

    expect(helperResult).toBe('passthrough-ok');
    expect(engine.helper).toHaveBeenCalledOnce();

    const events = await readEvents(paths, config);
    expect(events.map(e => `${e.operation}:${e.audit_phase}`)).toEqual([
      'view:intent', 'view:result',
      'str_replace:intent', 'str_replace:result',
      'insert:intent', 'insert:result',
      'delete:intent', 'delete:result',
    ]);
    expect(events[0]?.memory_path).toBe('gbrain://brains/host/pages/people/alice');
    expect(events[4]?.memory_path).toBe('gbrain://brains/host/links/people/alice/works_at/companies/acme');
  });

  it('preserves exact engine method results', async () => {
    const { paths, config } = await initProject();
    const { engine } = stubEngine();
    const expected = { slug: 'people/exact', title: 'Exact Page' };
    engine.getPage.mockResolvedValueOnce(expected);
    const audited = wrapEngine(engine as unknown as GBrainEngine, {
      actorId: 'tester',
      brainId: 'host',
      configPath: paths.configPath,
    }) as unknown as typeof engine;

    const result = await audited.getPage('people/exact');

    expect(result).toBe(expected);
    const events = await readEvents(paths, config);
    const payload = events[1]?.payload_preview ? JSON.parse(events[1].payload_preview) : null;
    expect(payload?.__psy_audit?.result).toEqual({ kind: 'unknown' });
  });

  it('can skip engine read auditing without requiring identity', async () => {
    const { paths, config } = await initProject();
    const { engine } = stubEngine();
    const audited = wrapEngine(engine as unknown as GBrainEngine, {
      auditReads: false,
      configPath: paths.configPath,
    }) as unknown as typeof engine;

    await audited.getPage('people/alice');

    expect(engine.getPage).toHaveBeenCalledOnce();
    expect(await readEvents(paths, config)).toHaveLength(0);
  });

  it('wraps transaction callback engines so inner writes are audited', async () => {
    const { paths, config } = await initProject();
    const { engine, tx } = stubEngine();
    const audited = wrapEngine(engine as unknown as GBrainEngine, {
      actorId: 'tester',
      configPath: paths.configPath,
    }) as unknown as typeof engine;

    await audited.transaction(async (txEngine) => {
      await txEngine.putPage('companies/acme');
      await txEngine.addLink('people/alice', 'companies/acme', 'context', 'works_at');
    });

    expect(tx.putPage).toHaveBeenCalledOnce();
    expect(tx.addLink).toHaveBeenCalledOnce();

    const events = await readEvents(paths, config);
    expect(events.map(e => `${e.operation}:${e.audit_phase}`)).toEqual([
      'str_replace:intent', 'str_replace:result',
      'insert:intent', 'insert:result',
    ]);
    expect(events[0]?.memory_path).toBe('gbrain://brains/host/pages/companies/acme');
  });

  it('records rename paths for updateSlug', async () => {
    const { paths, config } = await initProject();
    const { engine } = stubEngine();
    const audited = wrapEngine(engine as unknown as GBrainEngine, {
      actorId: 'tester',
      configPath: paths.configPath,
    }) as unknown as typeof engine;

    await audited.updateSlug('people/alice-old', 'people/alice');

    const events = await readEvents(paths, config);
    expect(events[0]?.operation).toBe('rename');
    expect(events[0]?.memory_path).toBe('gbrain://brains/host/pages/people/alice-old');
    const payload = events[0]?.payload_preview ? JSON.parse(events[0].payload_preview) : null;
    expect(payload?.__psy_audit?.paths).toEqual({
      old_path: 'gbrain://brains/host/pages/people/alice-old',
      new_path: 'gbrain://brains/host/pages/people/alice',
    });
  });

  it('rejects anonymous engine calls before invoking the method', async () => {
    const { paths, config } = await initProject();
    const { engine } = stubEngine();
    const audited = wrapEngine(engine as unknown as GBrainEngine, {
      configPath: paths.configPath,
    }) as unknown as typeof engine;

    await expect(audited.putPage('people/alice')).rejects.toBeInstanceOf(PsyConfigInvalid);
    expect(engine.putPage).not.toHaveBeenCalled();

    const events = await readEvents(paths, config);
    expect(events[1]?.outcome).toBe('rejected_by_anonymous_check');
  });

  it('uses identity from runWithContext for engine calls', async () => {
    const { paths, config } = await initProject();
    const { engine } = stubEngine();
    const audited = wrapEngine(engine as unknown as GBrainEngine, {
      configPath: paths.configPath,
    }) as unknown as typeof engine;

    await runWithContext({ actorId: 'ctx-actor', tenantId: 'tenant' }, () =>
      audited.getPage('people/alice'),
    );

    const events = await readEvents(paths, config);
    expect(events[0]?.actor_id).toBe('ctx-actor');
    expect(events[0]?.tenant_id).toBe('tenant');
  });

  it('maps a broad set of memory BrainEngine methods onto canonical audit paths', async () => {
    const { paths, config } = await initProject();
    const { engine } = stubEngine();
    const audited = wrapEngine(engine as unknown as GBrainEngine, {
      actorId: 'tester',
      brainId: 'b2',
      configPath: paths.configPath,
    }) as unknown as typeof engine;

    await audited.upsertChunks('people/alice', []);
    await audited.getChunks('people/alice');
    await audited.deleteChunks('people/alice');
    await audited.addTimelineEntry('people/alice', { date: '2026-05-03' });
    await audited.createVersion('people/alice');
    await audited.revertToVersion('people/alice', 7);
    await audited.rewriteLinks('people/alice-old', 'people/alice');

    const intents = intentEvents(await readEvents(paths, config));
    expect(intents.map(e => `${e.operation}:${e.memory_path}`)).toEqual([
      'str_replace:gbrain://brains/b2/pages/people/alice/chunks',
      'view:gbrain://brains/b2/pages/people/alice/chunks',
      'delete:gbrain://brains/b2/pages/people/alice/chunks',
      'insert:gbrain://brains/b2/pages/people/alice/timeline/2026-05-03',
      'insert:gbrain://brains/b2/pages/people/alice/versions',
      'str_replace:gbrain://brains/b2/pages/people/alice/versions/7',
      expect.stringMatching(/^str_replace:gbrain:\/\/brains\/b2\/links\/rewrite\/[a-f0-9]{16}$/),
    ]);
  });

  it('skips raw SQL and other non-memory engine methods by default', async () => {
    const { paths, config } = await initProject();
    const { engine } = stubEngine();
    const audited = wrapEngine(engine as unknown as GBrainEngine, {
      actorId: 'tester',
      configPath: paths.configPath,
    }) as unknown as typeof engine;

    await audited.setConfig('writer.auto_link', 'true');
    await audited.executeRaw('UPDATE pages SET title=$1 WHERE slug=$2', ['Alice', 'people/alice']);
    await audited.withReservedConnection(async (conn) => {
      await conn.executeRaw('SELECT 1');
      await conn.executeRaw('INSERT INTO ingest_log DEFAULT VALUES');
    });

    expect(engine.setConfig).toHaveBeenCalledOnce();
    expect(engine.executeRaw).toHaveBeenCalledTimes(3);
    expect(intentEvents(await readEvents(paths, config))).toHaveLength(0);
  });

  it('supports opt-in custom classification for reserved SQL connections', async () => {
    const { paths, config } = await initProject();
    const { engine } = stubEngine();
    const audited = wrapEngine(engine as unknown as GBrainEngine, {
      actorId: 'tester',
      configPath: paths.configPath,
      classifyEngineMethod: (method, args) => {
        if (method !== 'executeRaw') return undefined;
        const sql = String(args[0] ?? '');
        return {
          operation: sql.trim().toLowerCase().startsWith('select') ? 'view' : 'str_replace',
          memoryPath: `gbrain://brains/host/sql/custom-${sql.length}`,
        };
      },
    }) as unknown as typeof engine;

    await audited.withReservedConnection(async (conn) => {
      await conn.executeRaw('SELECT 1');
      await conn.executeRaw('INSERT INTO ingest_log DEFAULT VALUES');
    });

    const intents = intentEvents(await readEvents(paths, config));
    expect(intents.map(e => `${e.operation}:${e.memory_path}`)).toEqual([
      'view:gbrain://brains/host/sql/custom-8',
      'str_replace:gbrain://brains/host/sql/custom-37',
    ]);
  });

  it('supports custom engine classification and explicit skip', async () => {
    const { paths, config } = await initProject();
    const { engine } = stubEngine();
    const audited = wrapEngine(engine as unknown as GBrainEngine, {
      actorId: 'tester',
      configPath: paths.configPath,
      classifyEngineMethod: (method) => {
        if (method === 'helper') return null;
        if (method === 'putPage') {
          return { operation: 'create', memoryPath: 'gbrain://brains/custom/pages/override' };
        }
        return undefined;
      },
      purposeFromEngine: (method) => `engine:${method}`,
    }) as unknown as typeof engine;

    expect(audited.helper()).toBe('passthrough-ok');
    await audited.putPage('people/alice');

    const events = await readEvents(paths, config);
    expect(events).toHaveLength(2);
    expect(events[0]?.operation).toBe('create');
    expect(events[0]?.memory_path).toBe('gbrain://brains/custom/pages/override');
    expect(events[0]?.purpose).toBe('engine:putPage');
  });

  it('records engine method errors and rethrows', async () => {
    const { paths, config } = await initProject();
    const { engine } = stubEngine();
    const error = Object.assign(new Error('link failed'), { code: 'E_LINK' });
    engine.addLink.mockRejectedValueOnce(error);
    const audited = wrapEngine(engine as unknown as GBrainEngine, {
      actorId: 'tester',
      configPath: paths.configPath,
    }) as unknown as typeof engine;

    await expect(
      audited.addLink('people/alice', 'companies/acme'),
    ).rejects.toBe(error);

    const events = await readEvents(paths, config);
    expect(events.at(-1)?.outcome).toBe('handler_error');
    expect(events.at(-1)?.error_code).toBe('E_LINK');
    expect(events.at(-1)?.error_message).toBe('link failed');
  });
});
