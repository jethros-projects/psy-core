import assert from "node:assert/strict";
import test from "node:test";

import { normalizeConfig, resolveWorkspaceForEvent } from "../src/config.js";

test("normalizes snake_case and camelCase config fields", () => {
  const cfg = normalizeConfig(
    {
      actor_id: "alice",
      tenantId: "acme",
      db_path: "~/audit.db",
      sealKeyPath: "~/seal-key",
      payload_capture: false,
      dryRun: true,
      hook_timeout_ms: 2500,
    },
    { HOME: "/tmp/home", PATH: "" },
  );

  assert.equal(cfg.actorId, "alice");
  assert.equal(cfg.tenantId, "acme");
  assert.equal(cfg.dbPath, "/tmp/home/audit.db");
  assert.equal(cfg.sealKeyPath, "/tmp/home/seal-key");
  assert.equal(cfg.payloadCapture, false);
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.hookTimeoutMs, 2500);
});

test("defaults payload capture off and only accepts pinned psy-core versions", () => {
  const defaults = normalizeConfig({ actorId: "alice" }, { HOME: "/tmp/home", PATH: "" });
  const floating = normalizeConfig(
    { actorId: "alice", psyCoreVersion: "latest" },
    { HOME: "/tmp/home", PATH: "" },
  );
  const pinned = normalizeConfig(
    { actorId: "alice", psy_core_version: "0.4.1-beta.1" },
    { HOME: "/tmp/home", PATH: "" },
  );

  assert.equal(defaults.payloadCapture, false);
  assert.equal(floating.psyCoreVersion, "0.5.0");
  assert.equal(pinned.psyCoreVersion, "0.4.1-beta.1");
});

test("resolves default and per-agent OpenClaw workspaces", () => {
  const env = { HOME: "/home/alice" };
  const appConfig = {
    agents: {
      defaults: { workspace: "~/openclaw-workspace" },
      list: [
        { id: "main", default: true },
        { id: "ops", workspace: "~/ops-workspace" },
      ],
    },
  };

  assert.equal(
    resolveWorkspaceForEvent(appConfig, { sessionKey: "agent:main:main" }, env),
    "/home/alice/openclaw-workspace",
  );
  assert.equal(
    resolveWorkspaceForEvent(appConfig, { sessionKey: "agent:ops:main" }, env),
    "/home/alice/ops-workspace",
  );
  assert.equal(
    resolveWorkspaceForEvent(appConfig, { sessionKey: "agent:research:main" }, env),
    "/home/alice/openclaw-workspace/research",
  );
});
