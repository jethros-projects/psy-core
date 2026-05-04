import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { IngestClient, resolveIngestTarget } from "../src/ingest-client.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runSealRaceWorker(preloadPath, dbPath, sealKeyPath) {
  const workerScript = `
import { readFileSync } from "node:fs";
import { IngestClient } from "./src/ingest-client.js";

const [dbPath, sealKeyPath] = process.argv.slice(1);
const client = new IngestClient({
  config: { dbPath, sealKeyPath },
  logger: { error() {}, warn() {} },
});
const store = client.ensureStore();
if (!store) throw new Error("store did not open");
console.log(JSON.stringify({
  keyHex: store.sealKey.toString("hex"),
  diskKey: readFileSync(sealKeyPath, "utf8").trim()
}));
client.close();
`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(preloadPath).href, "--input-type=module", "-e", workerScript, dbPath, sealKeyPath],
      {
        cwd: pluginRoot,
        env: { ...process.env, PSY_RACE_KEY_PATH: sealKeyPath, PSY_SEAL_KEY: "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`openclaw race worker exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      try {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch (error) {
        reject(new Error(`openclaw race worker did not emit JSON\nstdout:\n${stdout}\nstderr:\n${stderr}\nerror:${String(error)}`));
      }
    });
  });
}

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
  assert.equal(rows[0].payload_redacted, 1);
  assert.equal(rows[1].payload_redacted, 1);
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

test("seal bootstrap re-reads the on-disk key when concurrent creators race", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-ingest-"));
  const sealKeyPath = path.join(dir, "seal-key");
  const preloadPath = path.join(dir, "hide-first-key-exists.mjs");
  await fs.writeFile(
    preloadPath,
    `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const keyPath = process.env.PSY_RACE_KEY_PATH;
const originalExistsSync = fs.existsSync.bind(fs);
let hidKeyPath = false;

fs.existsSync = function existsSyncOnce(pathLike) {
  const actualPath = typeof pathLike === "string" ? pathLike : pathLike?.toString?.();
  if (keyPath && actualPath === keyPath && !hidKeyPath) {
    hidKeyPath = true;
    return false;
  }
  return originalExistsSync(pathLike);
};

syncBuiltinESMExports();
`,
  );

  const results = await Promise.all(
    Array.from({ length: 6 }, (_unused, index) =>
      runSealRaceWorker(preloadPath, path.join(dir, `worker-${index}`, "audit.db"), sealKeyPath),
    ),
  );
  const diskKey = (await fs.readFile(sealKeyPath, "utf8")).trim();

  assert.equal(new Set(results.map((result) => result.keyHex)).size, 1);
  assert.deepEqual(results.map((result) => result.diskKey), Array(results.length).fill(diskKey));
  assert.deepEqual([...new Set(results.map((result) => result.keyHex))], [diskKey]);
});

test("seal bootstrap uses PSY_SEAL_KEY without persisting a file key", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-ingest-"));
  const envKey = "a".repeat(64);
  const sealKeyPath = path.join(dir, "seal-key");
  const client = new IngestClient({
    config: { dbPath: path.join(dir, "audit.db"), sealKeyPath },
    env: { PSY_SEAL_KEY: envKey },
    logger: { error() {}, warn() {} },
  });
  const store = client.ensureStore();

  assert.ok(store);
  assert.equal(store.sealKey.toString("hex"), envKey);
  await assert.rejects(fs.access(sealKeyPath), { code: "ENOENT" });
  client.close();
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

test("rejects malformed envelopes without appending rows", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-ingest-"));
  const warnings = [];
  const config = {
    dbPath: path.join(dir, "audit.db"),
    sealKeyPath: path.join(dir, "seal-key"),
  };
  const client = new IngestClient({
    config,
    logger: { warn: (message) => warnings.push(message), error() {} },
  });

  assert.equal(
    client.send({
      type: "intent",
      operation: "",
      call_id: "bad-envelope",
      memory_path: "/memories/MEMORY.md",
    }),
    false,
  );
  client.close();

  const db = new DatabaseSync(config.dbPath);
  const rows = db.prepare("SELECT * FROM events").all();
  db.close();

  assert.equal(rows.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /E_INGEST_BAD_ENVELOPE/);
});

test("redact_payload false stores captured payloads verbatim", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-ingest-"));
  const sentinel = "sk-abcdefghijklmnopqrstuvwxyz";
  const config = {
    dbPath: path.join(dir, "audit.db"),
    sealKeyPath: path.join(dir, "seal-key"),
  };
  const client = new IngestClient({ config, logger: { error() {}, warn() {} } });

  assert.equal(
    client.send({
      type: "intent",
      operation: "view",
      call_id: "raw-payload",
      memory_path: "/memories/MEMORY.md",
      payload: { nested: { token: sentinel } },
      redact_payload: false,
    }),
    true,
  );
  client.close();

  const db = new DatabaseSync(config.dbPath);
  const row = db.prepare("SELECT payload_preview, payload_redacted FROM events").get();
  db.close();

  assert.ok(row.payload_preview.includes(sentinel));
  assert.equal(row.payload_redacted, 0);
});

test("invalid PSY_SEAL_KEY prevents store bootstrap without throwing from send", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-ingest-"));
  const errors = [];
  const client = new IngestClient({
    config: {
      dbPath: path.join(dir, "audit.db"),
      sealKeyPath: path.join(dir, "seal-key"),
    },
    env: { PSY_SEAL_KEY: "not-a-hex-key" },
    logger: { error: (message) => errors.push(message), warn() {} },
  });

  assert.equal(
    client.send({
      type: "intent",
      operation: "view",
      call_id: "bad-key",
      memory_path: "/memories/MEMORY.md",
    }),
    false,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /PSY_SEAL_KEY must be 64 hex characters/);
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

test("rejects appends when the sealed head HMAC is tampered", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-ingest-"));
  const warnings = [];
  const config = {
    dbPath: path.join(dir, "audit.db"),
    sealKeyPath: path.join(dir, "seal-key"),
  };
  const client = new IngestClient({
    config,
    logger: { warn: (message) => warnings.push(message), error() {} },
  });

  assert.equal(
    client.send({
      type: "intent",
      operation: "view",
      call_id: "first",
      memory_path: "/memories/MEMORY.md",
    }),
    true,
  );
  const headPath = path.join(dir, "head.json");
  const head = JSON.parse(await fs.readFile(headPath, "utf8"));
  await fs.writeFile(headPath, `${JSON.stringify({ ...head, hmac: "0".repeat(64) }, null, 2)}\n`);

  assert.equal(
    client.send({
      type: "intent",
      operation: "view",
      call_id: "second",
      memory_path: "/memories/OTHER.md",
    }),
    false,
  );
  client.close();

  const db = new DatabaseSync(config.dbPath);
  const rows = db.prepare("SELECT * FROM events ORDER BY seq").all();
  db.close();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].operation_id, "first");
  assert.match(warnings.at(-1), /Head pointer HMAC does not match seal key/);
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
