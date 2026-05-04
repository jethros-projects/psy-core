import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { IngestClient, resolveIngestTarget } from "../src/ingest-client.js";

test("writes paired envelopes directly to a psy-compatible SQLite store", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-ingest-"));
  const config = {
    dbPath: path.join(dir, "audit.db"),
    sealKeyPath: path.join(dir, "seal-key"),
  };
  const client = new IngestClient({ config, logger: { error() {}, warn() {} } });

  assert.equal(
    client.send({
      type: "intent",
      operation: "view",
      call_id: "call-1",
      memory_path: "/memories/MEMORY.md",
      identity: { actor_id: "alice@example.com", tenant_id: "acme", session_id: "s1" },
      payload: { token: "sk-abcdefghijklmnopqrstuvwxyz" },
      redact_payload: true,
      source: "psy-core-openclaw",
    }),
    true,
  );
  assert.equal(
    client.send({
      type: "result",
      operation: "view",
      call_id: "call-1",
      memory_path: "/memories/MEMORY.md",
      identity: { actor_id: "alice@example.com", tenant_id: "acme", session_id: "s1" },
      outcome: "success",
      payload: { result: "ok" },
      redact_payload: true,
      source: "psy-core-openclaw",
    }),
    true,
  );
  client.close();

  const db = new DatabaseSync(config.dbPath);
  const rows = db.prepare("SELECT * FROM events ORDER BY seq").all();
  const metaRows = db.prepare("SELECT key, value FROM meta").all();
  db.close();

  assert.equal(rows.length, 2);
  assert.equal(rows[0].audit_phase, "intent");
  assert.equal(rows[1].audit_phase, "result");
  assert.equal(rows[0].actor_id, "alice@example.com");
  assert.equal(rows[0].tenant_id, "acme");
  assert.equal(rows[0].session_id, "s1");
  assert.equal(rows[0].memory_path, "/memories/MEMORY.md");
  assert.match(rows[0].payload_preview, /REDACTED-openai-key/);
  assert.equal(rows[1].prev_hash, rows[0].event_hash);

  const meta = Object.fromEntries(metaRows.map((row) => [row.key, row.value]));
  assert.equal(meta.last_seq, "2");
  assert.equal(meta.chain_head_hash, rows[1].event_hash);

  const head = JSON.parse(await fs.readFile(path.join(dir, "head.json"), "utf8"));
  assert.equal(head.seq, 2);
  assert.equal(head.event_hash, rows[1].event_hash);
  assert.equal((await fs.stat(config.sealKeyPath)).mode & 0o777, 0o600);
});

test("rejects unattributed results without a matching intent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-ingest-"));
  const warnings = [];
  const client = new IngestClient({
    config: {
      dbPath: path.join(dir, "audit.db"),
      sealKeyPath: path.join(dir, "seal-key"),
    },
    logger: { warn: (message) => warnings.push(message), error() {} },
  });

  assert.equal(
    client.send({
      type: "result",
      operation: "view",
      call_id: "missing-intent",
      memory_path: "/memories/MEMORY.md",
    }),
    false,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ingest rejected audit envelope/);
  client.close();
});

test("rotates old active rows into a psy-compatible archive segment", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-ingest-"));
  const config = {
    dbPath: path.join(dir, "audit.db"),
    sealKeyPath: path.join(dir, "seal-key"),
  };
  const client = new IngestClient({ config, logger: { error() {}, warn() {} } });

  assert.equal(
    client.send({
      type: "intent",
      operation: "view",
      call_id: "old-call",
      timestamp: "2024-01-01T00:00:00.000Z",
      memory_path: "/memories/OLD.md",
    }),
    true,
  );
  assert.equal(
    client.send({
      type: "intent",
      operation: "view",
      call_id: "fresh-call",
      memory_path: "/memories/FRESH.md",
    }),
    true,
  );
  client.close();

  const db = new DatabaseSync(config.dbPath);
  const activeRows = db.prepare("SELECT * FROM events ORDER BY seq").all();
  const rotations = db.prepare("SELECT * FROM rotation_segments ORDER BY id").all();
  db.close();

  assert.equal(activeRows.length, 1);
  assert.equal(activeRows[0].operation_id, "fresh-call");
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0].start_seq, 1);
  assert.equal(rotations[0].end_seq, 1);
  assert.equal(rotations[0].row_count, 1);
  await fs.access(rotations[0].archive_path);
});

test("resolves audit, archive, and seal paths from plugin config", () => {
  assert.deepEqual(
    resolveIngestTarget({
      dbPath: "/var/lib/psy/audit.db",
      sealKeyPath: "/var/lib/psy/seal-key",
    }),
    {
      dbPath: "/var/lib/psy/audit.db",
      archivesPath: "/var/lib/psy/archives",
      sealKeyPath: "/var/lib/psy/seal-key",
      headPath: "/var/lib/psy/head.json",
    },
  );
});
