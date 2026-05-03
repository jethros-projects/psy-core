#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { wrapOperations } from '../src/adapters/gbrain/wrap.ts';
import type { GBrainEngine, GBrainOperation, GBrainOperationContext } from '../src/adapters/gbrain/types.ts';
import type { AuditEvent, DraftAuditEvent } from '../src/types.ts';

const repo = process.env.PSY_GBRAIN_REAL_REPO ?? '/tmp/codex-gbrain';
if (!existsSync(repo)) {
  throw new Error(`Missing GBrain repo at ${repo}. Set PSY_GBRAIN_REAL_REPO=/path/to/gbrain.`);
}

const liveHome = mkdtempSync(path.join(tmpdir(), 'psy-gbrain-live-'));
process.env.GBRAIN_HOME = liveHome;
delete process.env.GBRAIN_DATABASE_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

type GBrainOperationsModule = {
  operations: GBrainOperation[];
};

type GBrainEngineFactoryModule = {
  createEngine(config: { engine: 'pglite'; database_path?: string }): Promise<GBrainEngine>;
};

class CaptureStore {
  readonly events: AuditEvent[] = [];

  append(draft: DraftAuditEvent): AuditEvent {
    const prevHash = this.events.at(-1)?.event_hash ?? 'GENESIS';
    const seq = this.events.length + 1;
    const eventHash = createHash('sha256')
      .update(JSON.stringify({ seq, draft, prevHash }))
      .digest('hex');
    const event: AuditEvent = {
      ...draft,
      seq,
      prev_hash: prevHash,
      event_hash: eventHash,
    };
    this.events.push(event);
    return event;
  }

  lastEvent(): AuditEvent | null {
    return this.events.at(-1) ?? null;
  }

  meta(): { last_seq: number } {
    return { last_seq: this.events.length };
  }

  eventAfter(afterSeq: number, limit: number): AuditEvent[] {
    return this.events.filter(event => event.seq > afterSeq).slice(0, limit);
  }

  query(): AuditEvent[] {
    return [...this.events];
  }

  close(): void {
    // In-memory capture store; no resources to release.
  }
}

async function importFromRepo<T>(relative: string): Promise<T> {
  return import(pathToFileURL(path.join(repo, relative)).href) as Promise<T>;
}

function readGBrainVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function requireOp(ops: GBrainOperation[], name: string): GBrainOperation {
  const op = ops.find(candidate => candidate.name === name);
  if (!op) throw new Error(`GBrain operation not found: ${name}`);
  return op;
}

function assertPairs(events: AuditEvent[], expected: string[]): void {
  const actual = events.map(event => `${event.operation}:${event.audit_phase}`);
  const mismatchAt = expected.findIndex((value, index) => actual[index] !== value);
  if (mismatchAt !== -1 || actual.length !== expected.length) {
    throw new Error([
      'Unexpected audit sequence from live GBrain operations.',
      `Expected: ${JSON.stringify(expected)}`,
      `Actual:   ${JSON.stringify(actual)}`,
    ].join('\n'));
  }
}

function assertPath(events: AuditEvent[], index: number, expected: string | RegExp): void {
  const pathValue = events[index]?.memory_path;
  if (!pathValue) throw new Error(`Missing event at index ${index}`);
  if (typeof expected === 'string') {
    if (pathValue !== expected) {
      throw new Error(`Unexpected path at event ${index}: expected ${expected}, got ${pathValue}`);
    }
    return;
  }
  if (!expected.test(pathValue)) {
    throw new Error(`Unexpected path at event ${index}: expected ${expected}, got ${pathValue}`);
  }
}

async function main(): Promise<void> {
  const [{ operations }, { createEngine }] = await Promise.all([
    importFromRepo<GBrainOperationsModule>('src/core/operations.ts'),
    importFromRepo<GBrainEngineFactoryModule>('src/core/engine-factory.ts'),
  ]);

  const databasePath = path.join(liveHome, '.gbrain', 'live.pglite');
  const engine = await createEngine({ engine: 'pglite', database_path: databasePath });
  await (engine.connect as (config: { engine: 'pglite'; database_path: string }) => Promise<void>)({
    engine: 'pglite',
    database_path: databasePath,
  });
  await (engine.initSchema as () => Promise<void>)();

  const captureStore = new CaptureStore();
  const auditedOps = wrapOperations(operations, {
    actorId: 'psy-gbrain-live-ops',
    brainId: 'live-ops',
    store: captureStore as never,
  });

  const ctx: GBrainOperationContext = {
    engine,
    config: { engine: 'pglite', database_path: databasePath },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    dryRun: false,
    remote: false,
    brainId: 'live-ops',
  };

  try {
    await requireOp(auditedOps, 'put_page').handler(ctx, {
      slug: 'people/live-alice',
      content: [
        '---',
        'type: person',
        'title: Live Alice',
        '---',
        '',
        'Live Alice works with Acme Live.',
      ].join('\n'),
    });
    await requireOp(auditedOps, 'put_page').handler(ctx, {
      slug: 'companies/live-acme',
      content: [
        '---',
        'type: company',
        'title: Acme Live',
        '---',
        '',
        'Acme Live is a test company.',
      ].join('\n'),
    });
    await requireOp(auditedOps, 'get_page').handler(ctx, { slug: 'people/live-alice' });
    await requireOp(auditedOps, 'add_tag').handler(ctx, { slug: 'people/live-alice', tag: 'founder' });
    await requireOp(auditedOps, 'get_tags').handler(ctx, { slug: 'people/live-alice' });
    await requireOp(auditedOps, 'add_link').handler(ctx, {
      from: 'people/live-alice',
      to: 'companies/live-acme',
      link_type: 'works_at',
      context: 'live smoke',
    });
    await requireOp(auditedOps, 'get_links').handler(ctx, { slug: 'people/live-alice' });
    await requireOp(auditedOps, 'add_timeline_entry').handler(ctx, {
      slug: 'people/live-alice',
      date: '2026-05-03',
      source: 'psy-live',
      summary: 'Ran live psy-core operation boundary smoke',
      detail: '',
    });
    await requireOp(auditedOps, 'get_timeline').handler(ctx, { slug: 'people/live-alice' });
    await requireOp(auditedOps, 'put_raw_data').handler(ctx, {
      slug: 'people/live-alice',
      source: 'psy-live',
      data: { score: 1 },
    });
    await requireOp(auditedOps, 'get_raw_data').handler(ctx, {
      slug: 'people/live-alice',
      source: 'psy-live',
    });
    await requireOp(auditedOps, 'delete_page').handler(ctx, { slug: 'companies/live-acme' });

    assertPairs(captureStore.events, [
      'str_replace:intent', 'str_replace:result',
      'str_replace:intent', 'str_replace:result',
      'view:intent', 'view:result',
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

    assertPath(captureStore.events, 0, 'gbrain://brains/live-ops/pages/people/live-alice');
    assertPath(captureStore.events, 10, 'gbrain://brains/live-ops/links/people/live-alice/works_at/companies/live-acme');
    assertPath(captureStore.events, 14, 'gbrain://brains/live-ops/pages/people/live-alice/timeline/2026-05-03');
    assertPath(captureStore.events, 18, 'gbrain://brains/live-ops/pages/people/live-alice/raw-data/psy-live');

    console.log(JSON.stringify({
      ok: true,
      gbrainRepo: repo,
      gbrainVersion: readGBrainVersion(),
      gbrainOperationCount: operations.length,
      auditEventCount: captureStore.events.length,
      liveHome,
    }, null, 2));
  } finally {
    await (engine.disconnect as (() => Promise<void>) | undefined)?.();
    if (process.env.PSY_GBRAIN_KEEP_LIVE_HOME !== '1') {
      rmSync(liveHome, { recursive: true, force: true });
    }
  }
}

await main();

