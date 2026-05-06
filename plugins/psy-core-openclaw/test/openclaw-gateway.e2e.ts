import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const OPENCLAW_REPO = requiredEnv("OPENCLAW_REPO");
const PSY_CORE_REPO = requiredEnv("PSY_CORE_REPO");
const PSY_PLUGIN_DIR = path.join(PSY_CORE_REPO, "plugins", "psy-core-openclaw");
const GATEWAY_E2E_TIMEOUT_MS = 90_000;
const ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
] as const;

type OpenClawModules = {
  startGatewayServer: (
    port: number,
    options: {
      bind: "loopback";
      auth: { mode: "token"; token: string };
      controlUiEnabled: false;
    },
  ) => Promise<{ close: (params?: { reason?: string }) => Promise<void> }>;
  getFreeGatewayPort: () => Promise<number>;
  resetRuntime: () => void;
};

type OpenClawHookRunner = {
  hasHooks: (hookName: "before_tool_call") => boolean;
  runBeforeToolCall: (
    event: {
      toolName: string;
      params: Record<string, unknown>;
      toolCallId?: string;
    },
    ctx: {
      agentId?: string;
      sessionKey?: string;
    },
  ) => Promise<unknown>;
};

let modulesPromise: Promise<OpenClawModules> | null = null;

async function importOpenClaw<T>(relativePath: string): Promise<T> {
  return await import(pathToFileURL(path.join(OPENCLAW_REPO, relativePath)).href) as T;
}

async function loadModules(): Promise<OpenClawModules> {
  modulesPromise ??= (async () => {
    const [
      gatewayServer,
      gatewayHelpers,
      config,
      sessionStore,
      agentEvents,
      bootstrapCache,
      pluginRuntime,
    ] = await Promise.all([
      importOpenClaw<{ startGatewayServer: OpenClawModules["startGatewayServer"] }>(
        "src/gateway/server.ts",
      ),
      importOpenClaw<{
        getFreeGatewayPort: OpenClawModules["getFreeGatewayPort"];
      }>("src/gateway/test-helpers.e2e.ts"),
      importOpenClaw<{ clearConfigCache: () => void; clearRuntimeConfigSnapshot: () => void }>(
        "src/config/config.ts",
      ),
      importOpenClaw<{ clearSessionStoreCacheForTest: () => void }>("src/config/sessions/store.ts"),
      importOpenClaw<{ resetAgentRunContextForTest: () => void }>("src/infra/agent-events.ts"),
      importOpenClaw<{ clearAllBootstrapSnapshots: () => void }>("src/agents/bootstrap-cache.ts"),
      importOpenClaw<{ clearGatewaySubagentRuntime: () => void }>("src/plugins/runtime/index.ts"),
    ]);

    const resetRuntime = () => {
      config.clearRuntimeConfigSnapshot();
      config.clearConfigCache();
      sessionStore.clearSessionStoreCacheForTest();
      agentEvents.resetAgentRunContextForTest();
      bootstrapCache.clearAllBootstrapSnapshots();
      pluginRuntime.clearGatewaySubagentRuntime();
    };

    return {
      startGatewayServer: gatewayServer.startGatewayServer,
      getFreeGatewayPort: gatewayHelpers.getFreeGatewayPort,
      resetRuntime,
    };
  })();
  return modulesPromise;
}

function snapshotEnv() {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  return {
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

async function setupGatewayHome(prefix: string) {
  const envSnapshot = snapshotEnv();
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.HOME = tempHome;
  process.env.OPENCLAW_STATE_DIR = path.join(tempHome, ".openclaw");
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
  process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
  process.env.OPENCLAW_SKIP_PROVIDERS = "1";
  const bundledPluginsDir = path.join(tempHome, "empty-bundled-plugins");
  await fs.mkdir(bundledPluginsDir, { recursive: true });
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
  process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
  delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  await fs.mkdir(process.env.OPENCLAW_STATE_DIR, { recursive: true });
  const workspaceDir = path.join(tempHome, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  return { envSnapshot, tempHome, workspaceDir };
}

function nextId(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function debugStep(message: string) {
  if (process.env.PSY_OPENCLAW_E2E_DEBUG === "1") {
    console.error(`[psy-openclaw-e2e] ${message}`);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readEvents(dbPath: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(
      `SELECT seq, audit_phase, operation, tool_call_id, actor_id, session_id, memory_path, outcome, payload_redacted
       FROM events
       ORDER BY seq`,
    ).all();
  } finally {
    db.close();
  }
}

async function pollEvents(dbPath: string, predicate: (rows: Array<Record<string, unknown>>) => boolean) {
  let lastRows: Array<Record<string, unknown>> = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      lastRows = readEvents(dbPath);
      if (predicate(lastRows)) return lastRows;
    } catch {
      // The gateway opens the psy database lazily when the first observed tool call runs.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return lastRows;
}

describe("psy-core OpenClaw gateway E2E", () => {
  beforeEach(async () => {
    (await loadModules()).resetRuntime();
  });

  afterEach(async () => {
    (await loadModules()).resetRuntime();
  });

  it(
    "loads the plugin in a real gateway process and records a memory read intent through gateway hooks",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const modules = await loadModules();
      debugStep("loaded OpenClaw test modules");
      const { envSnapshot, tempHome, workspaceDir } = await setupGatewayHome("psy-openclaw-gateway-e2e-");
      debugStep(`prepared gateway home at ${tempHome}`);
      const token = nextId("psy-token");
      process.env.OPENCLAW_GATEWAY_TOKEN = token;

      const configDir = path.join(tempHome, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const psyDir = path.join(tempHome, "psy");
      const dbPath = path.join(psyDir, "events.sqlite");
      const sealKeyPath = path.join(psyDir, "seal-key");
      const memoryText = `nonceA=${nextId("a")} nonceB=${nextId("b")}\n`;
      await fs.mkdir(configDir, { recursive: true });
      await fs.mkdir(psyDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memoryText, "utf8");

      const cfg = {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
          list: [{ id: "main", default: true }],
        },
        plugins: {
          load: { paths: [PSY_PLUGIN_DIR] },
          allow: ["psy-core"],
          entries: {
            "psy-core": {
              enabled: true,
              config: {
                actorId: "psy-e2e@example.test",
                dbPath,
                sealKeyPath,
                payloadCapture: true,
                hookTimeoutMs: 5000,
              },
            },
          },
        },
        gateway: { auth: { token } },
      };

      await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      const port = await modules.getFreeGatewayPort();
      const server = await modules.startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      debugStep("started gateway server");

      try {
        const sessionKey = "agent:main:psy-core-openclaw-e2e";
        const { getGlobalHookRunner } = await importOpenClaw<{
          getGlobalHookRunner: () => OpenClawHookRunner | null;
        }>("src/plugins/hook-runner-global.ts");
        const hookRunner = getGlobalHookRunner();
        expect(hookRunner?.hasHooks("before_tool_call")).toBe(true);
        await hookRunner?.runBeforeToolCall(
          {
            toolName: "read",
            params: { path: "MEMORY.md" },
            toolCallId: nextId("tool"),
          },
          { agentId: "main", sessionKey },
        );

        const rows = await pollEvents(dbPath, (events) => events.length >= 1);
        expect(rows).toHaveLength(1);
        expect(rows.map((row) => `${row.operation}:${row.audit_phase}`)).toEqual([
          "view:intent",
        ]);
        expect(rows[0]).toMatchObject({
          actor_id: "psy-e2e@example.test",
          session_id: sessionKey,
          memory_path: "/memories/MEMORY.md",
          payload_redacted: 1,
        });
        expect(rows[0].tool_call_id).toBeTruthy();

        const head = JSON.parse(await fs.readFile(path.join(psyDir, "head.json"), "utf8")) as {
          seq?: unknown;
          event_hash?: unknown;
        };
        expect(head.seq).toBe(1);
        expect(typeof head.event_hash).toBe("string");
        await expect(fs.stat(sealKeyPath)).resolves.toBeTruthy();
      } finally {
        await server.close({ reason: "psy-core OpenClaw gateway E2E complete" });
        envSnapshot.restore();
        await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    },
  );
});
