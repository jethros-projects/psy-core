#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pluginRoot, "..", "..");
const candidates = [
  process.env.OPENCLAW_REPO,
  path.resolve(repoRoot, "..", "openclaw-official"),
  path.resolve(repoRoot, "..", "openclaw"),
].filter(Boolean);

const openClawRepo = candidates.find((candidate) =>
  fs.existsSync(path.join(candidate, "scripts", "run-vitest.mjs")) &&
  fs.existsSync(path.join(candidate, "src", "gateway", "test-helpers.e2e.ts")),
);

if (!openClawRepo) {
  throw new Error(
    [
      "OpenClaw gateway E2E requires an OpenClaw checkout.",
      `Tried: ${candidates.join(", ")}`,
      "Set OPENCLAW_REPO=/path/to/openclaw.",
    ].join("\n"),
  );
}

if (!fs.existsSync(path.join(openClawRepo, "node_modules"))) {
  throw new Error(
    `OpenClaw dependencies are missing at ${openClawRepo}. Run: pnpm --dir ${openClawRepo} install --frozen-lockfile`,
  );
}

const sourceTestFile = path.join(pluginRoot, "test", "openclaw-gateway.e2e.ts");
const wrapperDir = fs.mkdtempSync(path.join(openClawRepo, "test", ".psy-core-e2e-"));
const testFile = path.join(wrapperDir, "psy-core-openclaw.e2e.test.ts");
fs.writeFileSync(
  testFile,
  `import ${JSON.stringify(sourceTestFile)};\n`,
  "utf8",
);

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  fs.rmSync(wrapperDir, { recursive: true, force: true });
}

process.on("exit", cleanup);
function exitForSignal(signal) {
  cleanup();
  process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
}

process.on("SIGINT", () => exitForSignal("SIGINT"));
process.on("SIGTERM", () => exitForSignal("SIGTERM"));
const args = [
  path.join(openClawRepo, "scripts", "run-vitest.mjs"),
  "run",
  "--config",
  path.join(openClawRepo, "test", "vitest", "vitest.e2e.config.ts"),
  testFile,
  "--maxWorkers=1",
];

const child = spawn(process.execPath, args, {
  cwd: openClawRepo,
  env: {
    ...process.env,
    OPENCLAW_REPO: openClawRepo,
    PSY_CORE_REPO: repoRoot,
    OPENCLAW_VITEST_MAX_WORKERS: process.env.OPENCLAW_VITEST_MAX_WORKERS ?? "1",
    OPENCLAW_E2E_WORKERS: process.env.OPENCLAW_E2E_WORKERS ?? "1",
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  cleanup();
  if (signal) {
    exitForSignal(signal);
    return;
  }
  process.exit(code ?? 1);
});
