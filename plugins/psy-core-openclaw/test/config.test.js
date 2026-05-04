import assert from "node:assert/strict";
import test from "node:test";

import {
  identityBlock,
  ingestEnv,
  normalizeConfig,
  normalizeAgentId,
  parseAgentIdFromSessionKey,
  resolveDefaultWorkspaceDir,
  resolveStateDir,
  resolveWorkspaceForEvent,
} from "../src/config.js";

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
  assert.equal(floating.psyCoreVersion, "0.5.1");
  assert.equal(pinned.psyCoreVersion, "0.4.1-beta.1");
});

test("uses environment fallbacks and ignores non-boolean toggles", () => {
  const env = {
    HOME: "/home/alice",
    PATH: "",
    PSY_ACTOR_ID: "env-actor",
    PSY_TENANT_ID: "env-tenant",
    PSY_AUDIT_DB_PATH: "~/audit/env.db",
    PSY_SEAL_KEY_PATH: "~/audit/seal-key",
  };

  const envBacked = normalizeConfig({}, env);
  assert.equal(envBacked.actorId, "env-actor");
  assert.equal(envBacked.tenantId, "env-tenant");
  assert.equal(envBacked.dbPath, "/home/alice/audit/env.db");
  assert.equal(envBacked.sealKeyPath, "/home/alice/audit/seal-key");

  const cfg = normalizeConfig(
    {
      actorId: "config-actor",
      enabled: false,
      dryRun: "true",
      payloadCapture: "true",
      allowAnonymous: true,
      hookTimeoutMs: 9.8,
    },
    env,
  );
  assert.equal(cfg.actorId, "config-actor");
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.dryRun, false);
  assert.equal(cfg.payloadCapture, false);
  assert.equal(cfg.allowAnonymous, true);
  assert.equal(cfg.hookTimeoutMs, 9);
});

test("builds identity and ingest env blocks only from present values", () => {
  const cfg = normalizeConfig(
    {
      actorId: "alice@example.com",
      tenantId: "acme",
      purpose: "memory-audit",
      dbPath: "/var/lib/psy/audit.db",
      sealKeyPath: "/var/lib/psy/seals/head.key",
    },
    { HOME: "/home/alice", PATH: "" },
  );

  assert.deepEqual(identityBlock(cfg, "session-1"), {
    actor_id: "alice@example.com",
    tenant_id: "acme",
    session_id: "session-1",
  });
  assert.equal(identityBlock({ actorId: null, tenantId: null }, null), undefined);
  assert.deepEqual(ingestEnv(cfg), {
    PSY_AUDIT_DB_PATH: "/var/lib/psy/audit.db",
    PSY_ARCHIVES_PATH: "/var/lib/psy/archives",
    PSY_SEAL_KEY_PATH: "/var/lib/psy/seals/head.key",
    PSY_HEAD_PATH: "/var/lib/psy/seals/head.json",
  });
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

test("resolves profile, state-dir, and sanitized agent workspace fallbacks", () => {
  const env = {
    HOME: "/home/alice",
    OPENCLAW_PROFILE: "lab",
    OPENCLAW_STATE_DIR: "~/state",
  };

  assert.equal(resolveStateDir(env), "/home/alice/state");
  assert.equal(resolveDefaultWorkspaceDir(env), "/home/alice/.openclaw/workspace-lab");
  assert.equal(parseAgentIdFromSessionKey("agent:Data Science!:main"), "data science!");
  assert.equal(normalizeAgentId("Data Science!"), "data-science");
  assert.equal(
    resolveWorkspaceForEvent({}, { sessionKey: "agent:Data Science!:main" }, env),
    "/home/alice/state/workspace-data-science",
  );
});

test("explicit hook agent id wins over session key when choosing workspace", () => {
  const env = { HOME: "/home/alice" };
  const appConfig = {
    agents: {
      list: [
        { id: "main", workspace: "~/main-workspace" },
        { id: "ops", workspace: "~/ops-workspace" },
      ],
    },
  };

  assert.equal(
    resolveWorkspaceForEvent(
      appConfig,
      { agentId: "ops", sessionKey: "agent:main:main" },
      env,
    ),
    "/home/alice/ops-workspace",
  );
});
