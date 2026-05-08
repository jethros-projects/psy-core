import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeConfig } from "../src/config.js";
import { OpenClawDreamCatcher } from "../src/dream-catcher.js";

function buildCatcher({ workspaceDir, config: overrides = {} }) {
  const sent = [];
  const config = normalizeConfig(
    {
      actorId: "alice",
      tenantId: "acme",
      payloadCapture: true,
      dreamCatcherIntervalMs: 1000,
      ...overrides,
    },
    { HOME: os.homedir() },
  );
  const appConfig = { agents: { defaults: { workspace: workspaceDir } } };
  const catcher = new OpenClawDreamCatcher({
    config,
    logger: { info() {}, error() {} },
    ingest: { send: (envelope) => sent.push(envelope) },
    getAppConfig: () => appConfig,
    env: { HOME: os.homedir() },
  });
  return { catcher, sent, appConfig };
}

test("captures background writes to DREAMS.md", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-dreams-"));
  const { catcher, sent } = buildCatcher({ workspaceDir });

  await catcher.scanNow();
  await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), "night synthesis", "utf8");
  await catcher.scanNow();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "result");
  assert.equal(sent[0].operation, "create");
  assert.equal(sent[0].outcome, "unattributed");
  assert.equal(sent[0].memory_path, "/memories/DREAMS.md");
  assert.equal(sent[0].source, "psy-core-openclaw-dream-catcher");
  assert.equal(sent[0].identity.actor_id, "alice");
  assert.equal(sent[0].identity.tenant_id, "acme");
  assert.equal(sent[0].payload.target.relativePath, "DREAMS.md");
  assert.equal(sent[0].payload.content_hash.length, 64);
});

test("captures nested human dream artifacts and later deletes", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-dreams-"));
  const { catcher, sent } = buildCatcher({ workspaceDir });
  const target = path.join(workspaceDir, "memory", "dreaming", "rem", "2026-05-07.md");

  await catcher.scanNow();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "candidate memory", "utf8");
  await catcher.scanNow();
  await fs.writeFile(target, "refined candidate memory", "utf8");
  await catcher.scanNow();
  await fs.unlink(target);
  await catcher.scanNow();

  assert.deepEqual(
    sent.map((envelope) => [envelope.operation, envelope.memory_path]),
    [
      ["create", "/memories/memory/dreaming/rem/2026-05-07.md"],
      ["str_replace", "/memories/memory/dreaming/rem/2026-05-07.md"],
      ["delete", "/memories/memory/dreaming/rem/2026-05-07.md"],
    ],
  );
  assert.equal(sent[2].payload.deleted, true);
});

test("ignores OpenClaw machine dream state unless explicitly enabled", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-dreams-"));
  const machineState = path.join(workspaceDir, "memory", ".dreams", "state.json");
  await fs.mkdir(path.dirname(machineState), { recursive: true });

  const defaultCatcher = buildCatcher({ workspaceDir });
  await defaultCatcher.catcher.scanNow();
  await fs.writeFile(machineState, '{"phase":"rem"}', "utf8");
  await defaultCatcher.catcher.scanNow();
  assert.equal(defaultCatcher.sent.length, 0);

  const enabledCatcher = buildCatcher({
    workspaceDir,
    config: { dreamCatcherIncludeMachineState: true },
  });
  await enabledCatcher.catcher.scanNow({ emitInitial: true });
  assert.equal(enabledCatcher.sent.length, 1);
  assert.equal(enabledCatcher.sent[0].memory_path, "/memories/memory/.dreams/state.json");
});

test("tool-observed dream writes update the catcher baseline", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-dreams-"));
  const { catcher, sent, appConfig } = buildCatcher({ workspaceDir });
  const dreamsPath = path.join(workspaceDir, "DREAMS.md");

  await catcher.scanNow();
  await fs.writeFile(dreamsPath, "already audited by the file tool", "utf8");
  catcher.noteObservedRecord(
    {
      absolutePath: dreamsPath,
      relativePath: "DREAMS.md",
      memoryPath: "/memories/DREAMS.md",
    },
    { appConfig },
  );
  await catcher.scanNow();

  assert.equal(sent.length, 0);
});
