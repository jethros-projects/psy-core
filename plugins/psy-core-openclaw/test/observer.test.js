import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PsyOpenClawObserver, auditRecordsForToolCall } from "../src/observer.js";

test("pairs write intent/result with the pre-call create operation", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-"));
  const sent = [];
  const observer = new PsyOpenClawObserver({
    config: {
      actorId: "alice",
      tenantId: null,
      purpose: null,
      dryRun: false,
      payloadCapture: true,
    },
    ingest: { send: (envelope) => sent.push(envelope) },
    getAppConfig: () => ({ agents: { defaults: { workspace: workspaceDir } } }),
    env: { HOME: os.homedir() },
  });

  const event = {
    toolName: "write",
    toolCallId: "call-1",
    params: { path: "MEMORY.md", content: "remember this" },
  };
  observer.beforeToolCall(event, { sessionKey: "agent:main:main" });
  await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "remember this", "utf8");
  observer.afterToolCall(
    { ...event, result: { content: [{ type: "text", text: "wrote MEMORY.md" }] } },
    { sessionKey: "agent:main:main" },
  );

  assert.equal(sent.length, 2);
  assert.equal(sent[0].type, "intent");
  assert.equal(sent[0].operation, "create");
  assert.equal(sent[1].type, "result");
  assert.equal(sent[1].operation, "create");
  assert.equal(sent[1].memory_path, "/memories/MEMORY.md");
});

test("detects skill edit calls", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-"));
  await fs.mkdir(path.join(workspaceDir, "skills", "demo"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "skills", "demo", "SKILL.md"), "old", "utf8");

  const records = auditRecordsForToolCall({
    event: {
      toolName: "edit",
      params: {
        path: "skills/demo/SKILL.md",
        edits: [{ oldText: "old", newText: "new" }],
      },
    },
    ctx: { sessionKey: "agent:main:main" },
    appConfig: { agents: { defaults: { workspace: workspaceDir } } },
    env: { HOME: os.homedir() },
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].operation, "str_replace");
  assert.equal(records[0].memoryPath, "/skills/demo/SKILL.md");
});

test("maps classified file reads to view operations", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-"));
  await fs.mkdir(path.join(workspaceDir, "skills", "demo"), { recursive: true });

  const appConfig = { agents: { defaults: { workspace: workspaceDir } } };
  const env = { HOME: os.homedir() };
  const memoryRead = auditRecordsForToolCall({
    event: { toolName: "read", params: { path: "MEMORY.md" } },
    ctx: { sessionKey: "agent:main:main" },
    appConfig,
    env,
  });
  const skillRead = auditRecordsForToolCall({
    event: { toolName: "read", params: { path: "skills/demo/SKILL.md" } },
    ctx: { sessionKey: "agent:main:main" },
    appConfig,
    env,
  });

  assert.equal(memoryRead[0].operation, "view");
  assert.equal(memoryRead[0].memoryPath, "/memories/MEMORY.md");
  assert.equal(skillRead[0].operation, "view");
  assert.equal(skillRead[0].memoryPath, "/skills/demo/SKILL.md");
});

test("emits one record per relevant apply_patch target", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-"));
  const patch = [
    "*** Begin Patch",
    "*** Add File: memory/2026-05-01.md",
    "+daily",
    "*** Update File: src/not-memory.ts",
    "@@",
    "-old",
    "+new",
    "*** Delete File: skills/old/SKILL.md",
    "*** End Patch",
  ].join("\n");

  const records = auditRecordsForToolCall({
    event: { toolName: "apply_patch", params: { input: patch } },
    ctx: { sessionKey: "agent:main:main" },
    appConfig: { agents: { defaults: { workspace: workspaceDir } } },
    env: { HOME: os.homedir() },
  });

  assert.deepEqual(
    records.map((record) => [record.operation, record.memoryPath]),
    [
      ["create", "/memories/memory/2026-05-01.md"],
      ["delete", "/skills/old/SKILL.md"],
    ],
  );
});

test("maps OpenClaw memory plugin tools", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-home-"));
  const wikiVault = path.join(home, "wiki");
  const appConfig = {
    agents: { defaults: { workspace: workspaceDir } },
    plugins: { entries: { "memory-wiki": { config: { vault: { path: wikiVault } } } } },
  };
  const env = { HOME: home };

  const search = auditRecordsForToolCall({
    event: { toolName: "memory_search", params: { query: "ship", corpus: "all" } },
  });
  const get = auditRecordsForToolCall({
    event: { toolName: "memory_get", params: { path: "MEMORY.md" } },
    ctx: { sessionKey: "agent:main:main" },
    appConfig,
    env,
  });
  const recall = auditRecordsForToolCall({
    event: { toolName: "memory_recall", params: { query: "ship" } },
  });
  const store = auditRecordsForToolCall({
    event: { toolName: "memory_store", params: { text: "ship it", category: "decision" } },
  });
  const forget = auditRecordsForToolCall({
    event: { toolName: "memory_forget", params: { memoryId: "mem_123" } },
  });
  const wiki = auditRecordsForToolCall({
    event: { toolName: "wiki_apply", params: { op: "create_synthesis", title: "Roadmap" } },
  });
  const wikiStatus = auditRecordsForToolCall({
    event: { toolName: "wiki_status", params: {} },
  });
  const wikiLint = auditRecordsForToolCall({
    event: { toolName: "wiki_lint", params: {} },
    appConfig,
    env,
  });
  const wikiSearch = auditRecordsForToolCall({
    event: { toolName: "wiki_search", params: { query: "roadmap", corpus: "wiki" } },
  });
  const wikiGet = auditRecordsForToolCall({
    event: { toolName: "wiki_get", params: { lookup: "Team/Roadmap" } },
  });

  assert.equal(search[0].operation, "view");
  assert.equal(search[0].memoryPath, "/memories/search/all");
  assert.equal(get[0].operation, "view");
  assert.equal(get[0].memoryPath, "/memories/MEMORY.md");
  assert.equal(recall[0].operation, "view");
  assert.equal(recall[0].memoryPath, "/memory-lancedb/recall");
  assert.equal(store[0].operation, "create");
  assert.equal(store[0].memoryPath, "/memory-lancedb/decision");
  assert.equal(forget[0].operation, "delete");
  assert.equal(forget[0].memoryPath, "/memory-lancedb/mem_123");
  assert.equal(wiki[0].operation, "create");
  assert.equal(wiki[0].memoryPath, "/memory-wiki/Roadmap");
  assert.deepEqual(
    wikiLint.map((record) => [record.operation, record.memoryPath]),
    [
      ["view", "/memory-wiki"],
      ["create", "/memory-wiki/reports/lint.md"],
    ],
  );
  assert.equal(wikiLint[1].absolutePath, path.join(wikiVault, "reports", "lint.md"));
  assert.equal(wikiStatus[0].operation, "view");
  assert.equal(wikiStatus[0].memoryPath, "/memory-wiki/status");
  assert.equal(wikiSearch[0].operation, "view");
  assert.equal(wikiSearch[0].memoryPath, "/memory-wiki/search/wiki");
  assert.equal(wikiGet[0].operation, "view");
  assert.equal(wikiGet[0].memoryPath, "/memory-wiki/Team-Roadmap");
});

test("uses result details for concrete OpenClaw memory tool paths", async () => {
  const sent = [];
  const observer = new PsyOpenClawObserver({
    config: {
      actorId: "alice",
      tenantId: null,
      purpose: null,
      dryRun: false,
      payloadCapture: false,
    },
    ingest: { send: (envelope) => sent.push(envelope) },
    getAppConfig: () => ({}),
  });

  const storeEvent = {
    toolName: "memory_store",
    toolCallId: "store-1",
    params: { text: "ship it", category: "decision" },
  };
  observer.beforeToolCall(storeEvent);
  observer.afterToolCall({
    ...storeEvent,
    result: { details: { action: "created", id: "mem_123" } },
  });

  const wikiEvent = {
    toolName: "wiki_apply",
    toolCallId: "wiki-1",
    params: { op: "create_synthesis", title: "Roadmap" },
  };
  observer.beforeToolCall(wikiEvent);
  observer.afterToolCall({
    ...wikiEvent,
    result: { details: { changed: true, operation: "create_synthesis", pagePath: "syntheses/roadmap.md" } },
  });

  assert.equal(sent[0].memory_path, "/memory-lancedb/decision");
  assert.equal(sent[1].memory_path, "/memory-lancedb/mem_123");
  assert.equal(sent[2].memory_path, "/memory-wiki/Roadmap");
  assert.equal(sent[3].memory_path, "/memory-wiki/syntheses/roadmap.md");
});

test("captures skill_workshop direct workspace skill writes", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-"));
  const suggest = auditRecordsForToolCall({
    event: {
      toolName: "skill_workshop",
      params: {
        action: "suggest",
        skillName: "GIF Workflow!",
        body: "verify frames",
        apply: true,
      },
    },
    ctx: { sessionKey: "agent:main:main" },
    appConfig: { agents: { defaults: { workspace: workspaceDir } } },
    env: { HOME: os.homedir() },
  });
  assert.equal(suggest.length, 1);
  assert.equal(suggest[0].operation, "create");
  assert.equal(suggest[0].memoryPath, "/skills/gif-workflow/SKILL.md");

  await fs.mkdir(path.join(workspaceDir, "skills", "gif-workflow"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "skills", "gif-workflow", "SKILL.md"), "old", "utf8");

  const support = auditRecordsForToolCall({
    event: {
      toolName: "skill_workshop",
      params: {
        action: "write_support_file",
        skillName: "gif-workflow",
        relativePath: "scripts/check.sh",
        body: "#!/bin/sh\n",
      },
    },
    ctx: { sessionKey: "agent:main:main" },
    appConfig: { agents: { defaults: { workspace: workspaceDir } } },
    env: { HOME: os.homedir() },
  });
  assert.equal(support.length, 1);
  assert.equal(support[0].operation, "create");
  assert.equal(support[0].memoryPath, "/skills/gif-workflow/scripts/check.sh");
});

test("captures skill_workshop confirmed apply results when pre-call target is not knowable", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-"));
  const skillPath = path.join(workspaceDir, "skills", "qa-workflow", "SKILL.md");
  const records = auditRecordsForToolCall({
    event: {
      toolName: "skill_workshop",
      params: { action: "apply", id: "proposal-1" },
      result: {
        content: [{ type: "text", text: "{}" }],
        details: {
          status: "applied",
          skillPath,
          proposal: {
            change: { kind: "replace", oldText: "old", newText: "new" },
          },
        },
      },
    },
    ctx: { sessionKey: "agent:main:main" },
    appConfig: { agents: { defaults: { workspace: workspaceDir } } },
    env: { HOME: os.homedir() },
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].operation, "str_replace");
  assert.equal(records[0].memoryPath, "/skills/qa-workflow/SKILL.md");
});

test("marks result-only skill_workshop apply envelopes as unattributed", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-"));
  const skillPath = path.join(workspaceDir, "skills", "qa-workflow", "SKILL.md");
  const sent = [];
  const observer = new PsyOpenClawObserver({
    config: {
      actorId: "alice",
      tenantId: null,
      purpose: null,
      dryRun: false,
      payloadCapture: false,
    },
    ingest: { send: (envelope) => sent.push(envelope) },
    getAppConfig: () => ({ agents: { defaults: { workspace: workspaceDir } } }),
    env: { HOME: os.homedir() },
  });

  observer.afterToolCall({
    toolName: "skill_workshop",
    toolCallId: "apply-1",
    params: { action: "apply", id: "proposal-1" },
    result: {
      details: {
        status: "applied",
        skillPath,
        proposal: { change: { kind: "replace", oldText: "old", newText: "new" } },
      },
    },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "result");
  assert.equal(sent[0].operation, "str_replace");
  assert.equal(sent[0].outcome, "unattributed");
  assert.equal(sent[0].memory_path, "/skills/qa-workflow/SKILL.md");
});

test("observer errors are logged and do not escape into OpenClaw hooks", () => {
  const logger = { errors: [], error(message) { this.errors.push(message); } };
  const observer = new PsyOpenClawObserver({
    config: {
      actorId: "alice",
      tenantId: null,
      purpose: null,
      dryRun: false,
      payloadCapture: true,
    },
    ingest: { send: () => { throw new Error("boom"); } },
    logger,
    getAppConfig: () => ({ agents: { defaults: { workspace: os.tmpdir() } } }),
    env: { HOME: os.homedir() },
  });

  assert.doesNotThrow(() => {
    observer.beforeToolCall({
      toolName: "write",
      toolCallId: "explode",
      params: { path: "MEMORY.md", content: "x" },
    });
  });
  assert.match(logger.errors[0], /observer failed: boom/);
});
