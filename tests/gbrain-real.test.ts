import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { wrapEngine } from '../src/adapters/gbrain/wrap.js';
import type { GBrainEngine } from '../src/adapters/gbrain/types.js';
import { PsyStore } from '../src/store.js';
import { verifyStore } from '../src/verify.js';
import { initProject } from './helpers.js';

const realRepo = process.env.PSY_GBRAIN_REAL_REPO;

// GBrain's operations module currently imports Bun-supported WASM assets that
// Node cannot load. This opt-in test exercises the real PGLite BrainEngine,
// which is the state boundary those operations call.

interface RealHarness {
  engine: GBrainEngine & Record<string, (...args: unknown[]) => Promise<unknown>>;
  audited: GBrainEngine & Record<string, (...args: unknown[]) => Promise<unknown>>;
  paths: { sqlitePath: string; archivesPath: string; configPath: string };
  config: unknown;
}

let harness: RealHarness | null = null;

async function importFromRepo<T>(relative: string): Promise<T> {
  if (!realRepo) throw new Error('PSY_GBRAIN_REAL_REPO is not set');
  const url = pathToFileURL(path.join(realRepo, relative)).href;
  return import(url) as Promise<T>;
}

describe.skipIf(!realRepo)('gbrain adapter against a real GBrain PGLite engine', () => {
  beforeAll(async () => {
    const { createEngine } = await importFromRepo<{
      createEngine(config: { engine: 'pglite' }): Promise<RealHarness['engine']>;
    }>('src/core/engine-factory.ts');
    const { paths, config } = await initProject();
    const engine = await createEngine({ engine: 'pglite' });
    await engine.connect({ engine: 'pglite' });
    await engine.initSchema();
    const audited = wrapEngine(engine, {
      actorId: 'real-gbrain-test',
      brainId: 'real',
      configPath: paths.configPath,
    }) as RealHarness['audited'];
    harness = { engine, audited, paths, config };
  }, 60_000);

  afterAll(async () => {
    await harness?.engine.disconnect?.();
    harness = null;
  });

  it('audits real page, tag, link, timeline, raw data, and delete calls', async () => {
    if (!harness) throw new Error('missing harness');
    const { audited } = harness;

    await audited.putPage('people/alice-real', {
      type: 'person',
      title: 'Alice Real',
      compiled_truth: 'Alice Real works with Acme Real.',
      timeline: '',
      frontmatter: {},
      content_hash: 'alice-v1',
    });
    await audited.putPage('companies/acme-real', {
      type: 'company',
      title: 'Acme Real',
      compiled_truth: 'Acme Real is a company.',
      timeline: '',
      frontmatter: {},
      content_hash: 'acme-v1',
    });
    await audited.addTag('people/alice-real', 'founder');
    await audited.getTags('people/alice-real');
    await audited.addLink('people/alice-real', 'companies/acme-real', 'works together', 'works_at');
    await audited.getLinks('people/alice-real');
    await audited.addTimelineEntry('people/alice-real', {
      date: '2026-05-03',
      source: 'real-test',
      summary: 'Met with Acme Real',
      detail: '',
    });
    await audited.getTimeline('people/alice-real');
    await audited.putRawData('people/alice-real', 'crm', { score: 10 });
    await audited.getRawData('people/alice-real', 'crm');
    await audited.deletePage('companies/acme-real');

    const store = new PsyStore({
      sqlitePath: harness.paths.sqlitePath,
      archivesPath: harness.paths.archivesPath,
      config: harness.config as never,
    });
    try {
      const events = store.allActiveEvents();
      expect(events.map(e => `${e.operation}:${e.audit_phase}`)).toEqual([
        'str_replace:intent', 'str_replace:result',
        'str_replace:intent', 'str_replace:result',
        'insert:intent', 'insert:result',
        'view:intent', 'view:result',
        'insert:intent', 'insert:result',
        'view:intent', 'view:result',
        'insert:intent', 'insert:result',
        'view:intent', 'view:result',
        'str_replace:intent', 'str_replace:result',
        'view:intent', 'view:result',
        'delete:intent', 'delete:result',
      ]);
      expect(events[0]?.memory_path).toBe('gbrain://brains/real/pages/people/alice-real');
      expect(events[8]?.memory_path).toBe('gbrain://brains/real/links/people/alice-real/works_at/companies/acme-real');
      expect(events[12]?.memory_path).toBe('gbrain://brains/real/pages/people/alice-real/timeline/2026-05-03');
      expect(events[16]?.memory_path).toBe('gbrain://brains/real/pages/people/alice-real/raw-data/crm');
      expect(verifyStore(store).ok).toBe(true);
    } finally {
      store.close();
    }
  }, 60_000);

  it('records real GBrain engine failures without swallowing them', async () => {
    if (!harness) throw new Error('missing harness');

    await expect(
      harness.audited.addTimelineEntry('people/missing-real', {
        date: '2026-05-03',
        source: 'real-test',
        summary: 'This page does not exist',
        detail: '',
      }),
    ).rejects.toThrow();

    const store = new PsyStore({
      sqlitePath: harness.paths.sqlitePath,
      archivesPath: harness.paths.archivesPath,
      config: harness.config as never,
    });
    try {
      const last = store.allActiveEvents().at(-1);
      expect(last?.audit_phase).toBe('result');
      expect(last?.outcome).toBe('handler_error');
      expect(last?.memory_path).toBe('gbrain://brains/real/pages/people/missing-real/timeline/2026-05-03');
      expect(verifyStore(store).ok).toBe(true);
    } finally {
      store.close();
    }
  }, 60_000);
});

describe.skipIf(Boolean(realRepo))('gbrain real integration opt-in guard', () => {
  it('skips real GBrain integration unless PSY_GBRAIN_REAL_REPO is set', () => {
    expect(realRepo).toBeUndefined();
  });
});
