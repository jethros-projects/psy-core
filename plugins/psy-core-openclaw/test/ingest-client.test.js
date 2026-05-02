import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IngestClient, resolveSpawnPlan } from "../src/ingest-client.js";

test("adds no-startup to every ingest spawn plan", async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-bin-"));
  const psyPath = path.join(binDir, "psy");
  const npxPath = path.join(binDir, "npx");
  await fs.writeFile(psyPath, "#!/bin/sh\n", { mode: 0o755 });
  await fs.writeFile(npxPath, "#!/bin/sh\n", { mode: 0o755 });

  const withBinary = resolveSpawnPlan(
    { psyBinary: "/usr/local/bin/psy", psyCoreVersion: "0.4.0" },
    { PATH: "" },
  );
  assert.deepEqual(withBinary.args, ["ingest", "--no-startup"]);

  const withPath = resolveSpawnPlan(
    { psyBinary: null, psyCoreVersion: "0.4.0" },
    { PATH: binDir },
  );
  assert.deepEqual(withPath.args, ["ingest", "--no-startup"]);

  await fs.rm(psyPath);
  const withNpx = resolveSpawnPlan(
    { psyBinary: null, psyCoreVersion: "0.4.0" },
    { PATH: binDir },
  );
  assert.deepEqual(withNpx.args, ["-y", "psy-core@0.4.0", "psy", "ingest", "--no-startup"]);
});

test("drains ingest stdout and warns on rejected envelopes", () => {
  const warnings = [];
  const client = new IngestClient({
    config: {},
    logger: { warn: (message) => warnings.push(message), debug() {} },
  });

  client.consumeStdout('{"ok":true}\n{"ok":false,"error":{"code":"E","message":"bad"}}\n');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ingest rejected audit envelope/);
});
