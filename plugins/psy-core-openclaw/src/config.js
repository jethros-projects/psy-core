import os from "node:os";
import path from "node:path";

export const DEFAULT_PSY_CORE_VERSION = "0.5.0";
export const DEFAULT_PLUGIN_ID = "psy-core";
export const DEFAULT_AGENT_ID = "main";

export function normalizeConfig(rawConfig = {}, env = process.env) {
  const raw = isRecord(rawConfig) ? rawConfig : {};
  const configuredPsyVersion = readString(raw, "psyCoreVersion", "psy_core_version");
  const dbPath = resolveUserPath(
    readString(raw, "dbPath", "db_path") || env.PSY_AUDIT_DB_PATH || "~/.psy/audit.db",
    env,
  );
  const sealKeyPath = resolveUserPath(
    readString(raw, "sealKeyPath", "seal_key_path") ||
      env.PSY_SEAL_KEY_PATH ||
      "~/.psy/seal-key",
    env,
  );
  return {
    enabled: readBoolean(raw, true, "enabled"),
    actorId: readString(raw, "actorId", "actor_id") || env.PSY_ACTOR_ID || null,
    tenantId: readString(raw, "tenantId", "tenant_id") || env.PSY_TENANT_ID || null,
    purpose: readString(raw, "purpose") || null,
    dbPath,
    sealKeyPath,
    psyCoreVersion: isPinnedSemver(configuredPsyVersion)
      ? configuredPsyVersion
      : DEFAULT_PSY_CORE_VERSION,
    psyBinary: readString(raw, "psyBinary", "psy_binary") || null,
    payloadCapture: readBoolean(raw, false, "payloadCapture", "payload_capture"),
    dryRun: readBoolean(raw, false, "dryRun", "dry_run"),
    allowAnonymous: readBoolean(raw, false, "allowAnonymous", "allow_anonymous"),
    hookTimeoutMs: readPositiveInt(raw, 5_000, "hookTimeoutMs", "hook_timeout_ms"),
  };
}

export function formatActorRequiredError() {
  return [
    "psy-core-openclaw: actorId is required.",
    "  Why:    audit events must attribute the session to a principal.",
    "  Where:  openclaw.json -> plugins.entries.psy-core.config.actorId",
    "  Example:",
    '    "plugins": {',
    '      "entries": {',
    '        "psy-core": {',
    '          "enabled": true,',
    '          "config": { "actorId": "alice@example.com" }',
    "        }",
    "      }",
    "    }",
    "  Bypass: set allowAnonymous: true (not recommended in production).",
  ].join("\n");
}

export function identityBlock(config, sessionId) {
  const identity = {};
  if (config.actorId) identity.actor_id = config.actorId;
  if (config.tenantId) identity.tenant_id = config.tenantId;
  if (sessionId) identity.session_id = sessionId;
  return Object.keys(identity).length > 0 ? identity : undefined;
}

export function ingestEnv(config) {
  const dbDir = path.dirname(config.dbPath);
  return {
    PSY_AUDIT_DB_PATH: config.dbPath,
    PSY_ARCHIVES_PATH: path.join(dbDir, "archives"),
    PSY_SEAL_KEY_PATH: config.sealKeyPath,
    PSY_HEAD_PATH: path.join(path.dirname(config.sealKeyPath), "head.json"),
  };
}

export function resolveWorkspaceForEvent(appConfig, ctx = {}, env = process.env) {
  const agentId = normalizeAgentId(ctx.agentId || parseAgentIdFromSessionKey(ctx.sessionKey));
  const defaultAgentId = resolveDefaultAgentId(appConfig);
  const agentEntry = findAgentEntry(appConfig, agentId);
  const configured = trimString(agentEntry?.workspace);
  if (configured) return resolveUserPath(configured, env);

  const defaultWorkspace = trimString(appConfig?.agents?.defaults?.workspace);
  if (agentId === defaultAgentId) {
    return defaultWorkspace
      ? resolveUserPath(defaultWorkspace, env)
      : resolveDefaultWorkspaceDir(env);
  }
  if (defaultWorkspace) {
    return path.join(resolveUserPath(defaultWorkspace, env), agentId);
  }
  return path.join(resolveStateDir(env), `workspace-${agentId}`);
}

export function resolveStateDir(env = process.env) {
  const override = trimString(env.OPENCLAW_STATE_DIR);
  if (override) return resolveUserPath(override, env);
  return path.join(resolveHomeDir(env), ".openclaw");
}

export function resolveDefaultWorkspaceDir(env = process.env) {
  const profile = trimString(env.OPENCLAW_PROFILE);
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(resolveHomeDir(env), ".openclaw", `workspace-${profile}`);
  }
  return path.join(resolveHomeDir(env), ".openclaw", "workspace");
}

export function resolveUserPath(input, env = process.env) {
  const value = String(input || "");
  if (!value) return "";
  if (value === "~") return resolveHomeDir(env);
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(resolveHomeDir(env), value.slice(2));
  }
  return path.resolve(value);
}

export function normalizeAgentId(value) {
  const raw = trimString(value) || DEFAULT_AGENT_ID;
  const lower = raw.toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(raw)) return lower;
  return (
    lower
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

export function parseAgentIdFromSessionKey(sessionKey) {
  const raw = trimString(sessionKey)?.toLowerCase();
  if (!raw) return null;
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent") return null;
  return parts[1] || null;
}

function resolveDefaultAgentId(appConfig) {
  const entries = Array.isArray(appConfig?.agents?.list) ? appConfig.agents.list : [];
  const markedDefault = entries.find((entry) => isRecord(entry) && entry.default === true);
  return normalizeAgentId(markedDefault?.id || DEFAULT_AGENT_ID);
}

function findAgentEntry(appConfig, agentId) {
  const entries = Array.isArray(appConfig?.agents?.list) ? appConfig.agents.list : [];
  return entries.find((entry) => isRecord(entry) && normalizeAgentId(entry.id) === agentId);
}

function readString(record, ...keys) {
  for (const key of keys) {
    const value = record[key];
    const normalized = trimString(value);
    if (normalized) return normalized;
  }
  return null;
}

function readBoolean(record, fallback, ...keys) {
  for (const key of keys) {
    if (typeof record[key] === "boolean") return record[key];
  }
  return fallback;
}

function readPositiveInt(record, fallback, ...keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return fallback;
}

function resolveHomeDir(env) {
  return trimString(env.HOME) || os.homedir();
}

function trimString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isPinnedSemver(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
