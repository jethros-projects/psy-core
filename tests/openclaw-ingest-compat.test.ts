import Database from 'better-sqlite3';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { Sealer } from '../src/seal.js';
import { openStore } from '../src/store.js';
import { verifyStore } from '../src/verify.js';

async function hasNodeSqlite(): Promise<boolean> {
  const sqliteSpecifier: string = 'node:sqlite';
  try {
    await import(sqliteSpecifier);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    if (code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
      return false;
    }
    if (error instanceof Error && error.message.includes('No such built-in module: node:sqlite')) {
      return false;
    }
    throw error;
  }
}

async function loadIngestClient(): Promise<{
  IngestClient: new (options: {
    config: { dbPath: string; sealKeyPath: string };
    logger: { error(): void; warn(): void };
  }) => {
    close(): void;
    send(envelope: unknown): boolean;
  };
}> {
  const ingestClientPath: string = '../plugins/psy-core-openclaw/src/ingest-client.js';
  return import(ingestClientPath);
}

const describeIfNodeSqlite = await hasNodeSqlite() ? describe : describe.skip;

describeIfNodeSqlite('OpenClaw ingest compatibility', () => {
  it('writes a database that root verifyStore can verify', async () => {
    const { IngestClient } = await loadIngestClient();
    const dir = await mkdtemp(path.join(tmpdir(), 'psy-openclaw-root-verify-'));
    const config = {
      dbPath: path.join(dir, 'audit.db'),
      sealKeyPath: path.join(dir, 'seal-key'),
    };
    const client = new IngestClient({ config, logger: { error() {}, warn() {} } });

    expect(client.send({
      type: 'intent',
      operation: 'view',
      call_id: 'call-1',
      memory_path: '/memories/MEMORY.md',
      identity: { actor_id: 'alice@example.com' },
      payload: { token: 'sk-' + 'a'.repeat(32) },
      redact_payload: true,
      source: 'psy-core-openclaw',
    })).toBe(true);
    expect(client.send({
      type: 'result',
      operation: 'view',
      call_id: 'call-1',
      memory_path: '/memories/MEMORY.md',
      identity: { actor_id: 'alice@example.com' },
      outcome: 'success',
      payload: { ok: true },
      redact_payload: true,
      source: 'psy-core-openclaw',
    })).toBe(true);
    client.close();

    const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'genesis_nonce'").get() as { value: string };
    db.close();

    const store = openStore(config.dbPath, {
      archivesPath: path.join(dir, 'archives'),
      genesisNonce: row.value,
    });
    try {
      const sealer = Sealer.load({
        headPath: path.join(dir, 'head.json'),
        keyPath: config.sealKeyPath,
      });
      const result = verifyStore(store, { sealer });
      const events = store.allActiveEvents();
      const payload = events[0]?.payload_preview ? JSON.parse(events[0].payload_preview) : null;

      expect(result.ok).toBe(true);
      expect(events[0]?.redactor_id).toBe('default-regex-v1');
      expect(payload?.__psy_ingest).toEqual({ source: 'psy-core-openclaw' });
    } finally {
      store.close();
    }
  });
});
