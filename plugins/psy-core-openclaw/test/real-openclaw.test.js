import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { auditRecordsForToolCall } from "../src/observer.js";
import { classifyTargetPath } from "../src/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PSY_REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function openClawRepo(t) {
  const candidates = [
    process.env.OPENCLAW_REPO,
    path.resolve(PSY_REPO_ROOT, "..", "openclaw-official"),
    path.resolve(PSY_REPO_ROOT, "..", "openclaw"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, "package.json")) &&
      fs.existsSync(path.join(candidate, "src", "plugins", "hook-types.ts"))
    ) {
      return candidate;
    }
  }

  const message = "set OPENCLAW_REPO or keep ../openclaw-official beside the psy-core worktree";
  if (process.env.CI || process.env.OPENCLAW_REPO_REQUIRED === "1") {
    assert.fail(message);
  }
  t.skip(message);
  return null;
}

function readRepoFile(repo, relativePath) {
  return fs.readFileSync(path.join(repo, relativePath), "utf8");
}

function assertSourceContains(source, snippets) {
  for (const snippet of snippets) {
    assert.ok(source.includes(snippet), `missing upstream snippet: ${snippet}`);
  }
}

test("real OpenClaw hook contract still exposes before/after tool call hooks", (t) => {
  const repo = openClawRepo(t);
  if (!repo) return;

  const hookTypes = readRepoFile(repo, "src/plugins/hook-types.ts");
  const hookRunner = readRepoFile(repo, "src/plugins/hooks.ts");

  assertSourceContains(hookTypes, [
    '| "before_tool_call"',
    '| "after_tool_call"',
    "export type PluginHookBeforeToolCallEvent = {",
    "toolName: string;",
    "params: Record<string, unknown>;",
    "toolCallId?: string;",
    "export type PluginHookAfterToolCallEvent = {",
    "result?: unknown;",
    "error?: string;",
  ]);
  assert.match(hookRunner, /runBeforeToolCall[\s\S]+runModifyingHook<"before_tool_call"/);
  assert.match(hookRunner, /runAfterToolCall[\s\S]+runVoidHook\("after_tool_call"/);
});

test("real OpenClaw hook context still carries attribution and result timing fields", (t) => {
  const repo = openClawRepo(t);
  if (!repo) return;

  const hookTypes = readRepoFile(repo, "src/plugins/hook-types.ts");
  assertSourceContains(hookTypes, [
    "export type PluginHookToolContext = {",
    "agentId?: string;",
    "sessionKey?: string;",
    "sessionId?: string;",
    "runId?: string;",
    "durationMs?: number;",
  ]);
});

test("real OpenClaw file-backed memory paths are covered", async (t) => {
  const repo = openClawRepo(t);
  if (!repo) return;

  const memoryHost = readRepoFile(repo, "packages/memory-host-sdk/src/host/internal.ts");
  assertSourceContains(memoryHost, [
    "normalized === CANONICAL_ROOT_MEMORY_FILENAME",
    'normalized.toLowerCase() === "dreams.md"',
    'normalized.startsWith("memory/")',
  ]);

  const workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-real-memory-"));
  const env = { HOME: os.homedir() };
  const appConfig = { agents: { defaults: { workspace: workspaceDir } } };
  const cases = [
    ["MEMORY.md", "/memories/MEMORY.md"],
    ["USER.md", "/memories/USER.md"],
    ["DREAMS.md", "/memories/DREAMS.md"],
    ["dreams.md", "/memories/dreams.md"],
    ["memory/2026-05-02.md", "/memories/memory/2026-05-02.md"],
    ["memory/dreaming/rem/2026-05-02.md", "/memories/memory/dreaming/rem/2026-05-02.md"],
    ["memory/multimodal/screenshot.png", "/memories/memory/multimodal/screenshot.png"],
  ];

  for (const [input, expectedPath] of cases) {
    assert.equal(
      classifyTargetPath(input, { workspaceDir, appConfig, env })?.memoryPath,
      expectedPath,
      input,
    );
  }
  assert.equal(classifyTargetPath("memory.md", { workspaceDir, appConfig, env }), null);

  const readRecord = auditRecordsForToolCall({
    event: { toolName: "read", params: { path: "memory/2026-05-02.md" } },
    ctx: { sessionKey: "agent:main:main" },
    appConfig,
    env,
  })[0];
  assert.equal(readRecord.operation, "view");
  assert.equal(readRecord.memoryPath, "/memories/memory/2026-05-02.md");
});

test("real OpenClaw memory plugin tools are captured", async (t) => {
  const repo = openClawRepo(t);
  if (!repo) return;

  assertSourceContains(readRepoFile(repo, "extensions/memory-core/index.ts"), [
    'names: ["memory_search"]',
    'names: ["memory_get"]',
  ]);
  assertSourceContains(readRepoFile(repo, "extensions/memory-lancedb/index.ts"), [
    '{ name: "memory_recall" }',
    '{ name: "memory_store" }',
    '{ name: "memory_forget" }',
  ]);
  assertSourceContains(readRepoFile(repo, "extensions/memory-wiki/index.ts"), [
    '{ name: "wiki_status" }',
    '{ name: "wiki_lint" }',
    '{ name: "wiki_apply" }',
    '{ name: "wiki_search" }',
    '{ name: "wiki_get" }',
  ]);
  assertSourceContains(readRepoFile(repo, "extensions/memory-wiki/src/lint.ts"), [
    "const compileResult = await compileMemoryWikiVault(config);",
    'path.join(rootDir, "reports", "lint.md")',
    "await appendMemoryWikiLog(config.vault.path",
  ]);

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-real-home-"));
  const workspaceDir = path.join(home, ".openclaw", "workspace");
  const wikiVault = path.join(home, "wiki-vault");
  const env = { HOME: home };
  const appConfig = {
    agents: { defaults: { workspace: workspaceDir } },
    plugins: { entries: { "memory-wiki": { config: { vault: { path: wikiVault } } } } },
  };
  const captures = [
    {
      event: { toolName: "memory_search", params: { query: "ship", corpus: "all" } },
      operation: "view",
      memoryPath: "/memories/search/all",
    },
    {
      event: { toolName: "memory_get", params: { path: "MEMORY.md" } },
      operation: "view",
      memoryPath: "/memories/MEMORY.md",
    },
    {
      event: { toolName: "memory_recall", params: { query: "ship" } },
      operation: "view",
      memoryPath: "/memory-lancedb/recall",
    },
    {
      event: { toolName: "memory_store", params: { text: "ship it", category: "decision" } },
      operation: "create",
      memoryPath: "/memory-lancedb/decision",
    },
    {
      event: { toolName: "memory_forget", params: { memoryId: "mem_123" } },
      operation: "delete",
      memoryPath: "/memory-lancedb/mem_123",
    },
    {
      event: { toolName: "wiki_apply", params: { op: "create_synthesis", lookup: "Roadmap" } },
      operation: "create",
      memoryPath: "/memory-wiki/Roadmap",
    },
    {
      event: { toolName: "wiki_apply", params: { op: "update_metadata", lookup: "Team/Roadmap" } },
      operation: "str_replace",
      memoryPath: "/memory-wiki/Team-Roadmap",
    },
    {
      event: { toolName: "wiki_status", params: {} },
      operation: "view",
      memoryPath: "/memory-wiki/status",
    },
    {
      event: { toolName: "wiki_search", params: { query: "roadmap" } },
      operation: "view",
      memoryPath: "/memory-wiki/search",
    },
    {
      event: { toolName: "wiki_get", params: { lookup: "Team/Roadmap" } },
      operation: "view",
      memoryPath: "/memory-wiki/Team-Roadmap",
    },
  ];

  for (const item of captures) {
    const records = auditRecordsForToolCall({
      event: item.event,
      ctx: { sessionKey: "agent:main:main" },
      appConfig,
      env,
    });
    assert.equal(records.length, 1, item.event.toolName);
    assert.equal(records[0].operation, item.operation);
    assert.equal(records[0].memoryPath, item.memoryPath);
  }

  const lintRecords = auditRecordsForToolCall({
    event: { toolName: "wiki_lint", params: {} },
    appConfig,
    env,
  });
  assert.deepEqual(
    lintRecords.map((record) => [record.operation, record.memoryPath]),
    [
      ["view", "/memory-wiki"],
      ["create", "/memory-wiki/reports/lint.md"],
    ],
  );
  assert.equal(lintRecords[1].absolutePath, path.join(wikiVault, "reports", "lint.md"));
});

test("real OpenClaw memory tool result details remain attributable", (t) => {
  const repo = openClawRepo(t);
  if (!repo) return;

  assertSourceContains(readRepoFile(repo, "extensions/memory-lancedb/index.ts"), [
    'details: { action: "created", id: entry.id }',
    'details: { action: "deleted", id: memoryId }',
    'details: { action: "deleted", id: results[0].entry.id }',
  ]);
  assertSourceContains(readRepoFile(repo, "extensions/memory-wiki/src/tool.ts"), [
    "const result = await applyMemoryWikiMutation({ config, mutation });",
    "text: `${action} ${result.pagePath} via ${result.operation}. ${compileSummary}`",
    "details: result",
  ]);
  assertSourceContains(readRepoFile(repo, "extensions/memory-wiki/src/apply.ts"), [
    "operation: params.mutation.op",
    "pagePath: result.pagePath",
  ]);
});

test("real OpenClaw skill roots and skill_workshop direct writes are covered", async (t) => {
  const repo = openClawRepo(t);
  if (!repo) return;

  assertSourceContains(readRepoFile(repo, "docs/tools/skills.md"), [
    "<workspace>/skills",
    "<workspace>/.agents/skills",
    "~/.agents/skills",
    "~/.openclaw/skills",
    "skills.load.extraDirs",
  ]);
  assertSourceContains(readRepoFile(repo, "src/agents/skills/workspace.ts"), [
    'path.resolve(workspaceDir, "skills")',
    'path.resolve(workspaceDir, ".agents", "skills")',
    'path.resolve(osHomeDir, ".agents", "skills")',
    'path.join(CONFIG_DIR, "skills")',
    "config?.skills?.load?.extraDirs",
  ]);
  assertSourceContains(readRepoFile(repo, "extensions/skill-workshop/src/tool.ts"), [
    'name: "skill_workshop"',
    'action === "write_support_file"',
    "skillPath: applied.skillPath",
  ]);

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-real-home-"));
  const workspaceDir = path.join(home, ".openclaw", "workspace");
  const extraDir = path.join(home, "extra-skills");
  const env = { HOME: home };
  const appConfig = {
    agents: { defaults: { workspace: workspaceDir } },
    skills: { load: { extraDirs: [extraDir] } },
  };

  const skillCases = [
    ["skills/deploy/SKILL.md", "/skills/deploy/SKILL.md"],
    [".agents/skills/review/SKILL.md", "/.agents/skills/review/SKILL.md"],
    [path.join(home, ".openclaw", "skills", "managed", "SKILL.md"), "/managed-skills/managed/SKILL.md"],
    [path.join(home, ".agents", "skills", "personal", "SKILL.md"), "/agent-skills/personal/SKILL.md"],
    [path.join(extraDir, "shared", "SKILL.md"), "/extra-skills/shared/SKILL.md"],
  ];

  for (const [input, expectedPath] of skillCases) {
    assert.equal(
      classifyTargetPath(input, { workspaceDir, appConfig, env })?.memoryPath,
      expectedPath,
      input,
    );
  }

  const suggest = auditRecordsForToolCall({
    event: {
      toolName: "skill_workshop",
      params: { action: "suggest", skillName: "QA Workflow", body: "Run smoke tests.", apply: true },
    },
    ctx: { sessionKey: "agent:main:main" },
    appConfig,
    env,
  });
  assert.equal(suggest[0].operation, "create");
  assert.equal(suggest[0].memoryPath, "/skills/qa-workflow/SKILL.md");

  const support = auditRecordsForToolCall({
    event: {
      toolName: "skill_workshop",
      params: {
        action: "write_support_file",
        skillName: "qa-workflow",
        relativePath: "references/checklist.md",
        body: "- smoke",
      },
    },
    ctx: { sessionKey: "agent:main:main" },
    appConfig,
    env,
  });
  assert.equal(support[0].operation, "create");
  assert.equal(support[0].memoryPath, "/skills/qa-workflow/references/checklist.md");

  const readRecord = auditRecordsForToolCall({
    event: { toolName: "read", params: { path: "skills/deploy/SKILL.md" } },
    ctx: { sessionKey: "agent:main:main" },
    appConfig,
    env,
  })[0];
  assert.equal(readRecord.operation, "view");
  assert.equal(readRecord.memoryPath, "/skills/deploy/SKILL.md");
});

test("real OpenClaw skill_workshop result shapes remain attributable", (t) => {
  const repo = openClawRepo(t);
  if (!repo) return;

  assertSourceContains(readRepoFile(repo, "extensions/skill-workshop/src/tool.ts"), [
    'name: "skill_workshop"',
    '"write_support_file"',
    'return jsonResult({ status: "written", filePath });',
    'return jsonResult({ status: "applied", skillPath: applied.skillPath, proposal: updated });',
  ]);
  assertSourceContains(readRepoFile(repo, "docs/plugins/skill-workshop.md"), [
    "Allowed top-level support directories:",
    "- `references/`",
    "- `templates/`",
    "- `scripts/`",
    "- `assets/`",
  ]);
});
