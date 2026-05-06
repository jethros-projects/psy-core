import Database from 'better-sqlite3';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { Sealer } from '../src/seal.js';
import { openStore } from '../src/store.js';
import { verifyStore } from '../src/verify.js';
// @ts-expect-error OpenClaw plugin runtime is deliberately plain JavaScript.
import { IngestClient } from '../plugins/psy-core-openclaw/src/ingest-client.js';

describe('OpenClaw ingest compatibility', () => {
  it('writes a database that root verifyStore can verify', async () => {
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
