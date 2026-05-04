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

test("maps memory tool fallback paths without filesystem classification", () => {
  const memorySearch = auditRecordsForToolCall({
    event: { toolName: "memory_search", params: { query: "ship" } },
  });
  const wikiSearch = auditRecordsForToolCall({
    event: { toolName: "memory_search", params: { query: "ship", corpus: "wiki" } },
  });
  const wikiGet = auditRecordsForToolCall({
    event: { toolName: "memory_get", params: { path: "Team/Road Map.md", corpus: "wiki" } },
  });
  const memoryCorpusGet = auditRecordsForToolCall({
    event: { toolName: "wiki_get", params: { lookup: "memory/2026-05-01", corpus: "memory" } },
  });

  assert.equal(memorySearch[0].memoryPath, "/memories/search");
  assert.equal(wikiSearch[0].memoryPath, "/memory-wiki/search");
  assert.equal(wikiGet[0].memoryPath, "/memory-wiki/Team-Road-Map-md");
  assert.equal(memoryCorpusGet[0].memoryPath, "/memories/get/memory-2026-05-01");
});

test("prefers memory tool result details over speculative parameters", () => {
  const forget = auditRecordsForToolCall({
    event: {
      toolName: "memory_forget",
      params: { memoryId: "old-id" },
      result: { details: { id: "new/id" } },
    },
  });
  const wikiGet = auditRecordsForToolCall({
    event: {
      toolName: "wiki_get",
      params: { lookup: "Team/Roadmap" },
      result: { details: { path: "entities/Alpha Beta.md" } },
    },
  });
  const wikiApply = auditRecordsForToolCall({
    event: {
      toolName: "wiki_apply",
      params: { op: "create_synthesis", title: "Alpha" },
      result: { details: { operation: "update_metadata", pagePath: "../entities/Alpha.md" } },
    },
  });

  assert.equal(forget[0].memoryPath, "/memory-lancedb/new-id");
  assert.equal(wikiGet[0].memoryPath, "/memory-wiki/entities/Alpha-Beta.md");
  assert.deepEqual(
    wikiApply.map((record) => [record.operation, record.memoryPath]),
    [["str_replace", "/memory-wiki/unknown/entities/Alpha.md"]],
  );
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

test("captures skill_workshop suggestions as replacements for existing skills", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-"));
  await fs.mkdir(path.join(workspaceDir, "skills", "qa-workflow"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "skills", "qa-workflow", "SKILL.md"), "old", "utf8");

  const records = auditRecordsForToolCall({
    event: {
      toolName: "skill_workshop",
      params: {
        action: "suggest",
        skillName: "qa-workflow",
        oldText: "old",
        newText: "new",
        apply: true,
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

test("ignores skill_workshop support-file traversal attempts", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-"));

  const records = auditRecordsForToolCall({
    event: {
      toolName: "skill_workshop",
      params: {
        action: "write_support_file",
        skillName: "qa-workflow",
        relativePath: "../secrets.txt",
        body: "nope",
      },
    },
    ctx: { sessionKey: "agent:main:main" },
    appConfig: { agents: { defaults: { workspace: workspaceDir } } },
    env: { HOME: os.homedir() },
  });

  assert.deepEqual(records, []);
});

test("captures skill_workshop result filePath for support-file writes", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-"));
  const supportPath = path.join(workspaceDir, "skills", "qa-workflow", "references", "checklist.md");

  const records = auditRecordsForToolCall({
    event: {
      toolName: "skill_workshop",
      params: { action: "write_support_file", skillName: "qa-workflow" },
      result: { details: { status: "written", filePath: supportPath } },
    },
    ctx: { sessionKey: "agent:main:main" },
    appConfig: { agents: { defaults: { workspace: workspaceDir } } },
    env: { HOME: os.homedir() },
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].operation, "create");
  assert.equal(records[0].memoryPath, "/skills/qa-workflow/references/checklist.md");
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

test("builds observer envelopes with identity, purpose, and captured result payloads", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-"));
  const sent = [];
  const observer = new PsyOpenClawObserver({
    config: {
      actorId: "alice@example.com",
      tenantId: "acme",
      purpose: "memory-audit",
      dryRun: false,
      payloadCapture: true,
    },
    ingest: { send: (envelope) => sent.push(envelope) },
    getAppConfig: () => ({ agents: { defaults: { workspace: workspaceDir } } }),
    env: { HOME: os.homedir() },
  });
  const event = {
    toolName: "read",
    toolCallId: "read-1",
    params: { path: "MEMORY.md" },
  };

  observer.beforeToolCall(event, { sessionId: "session-1" });
  observer.afterToolCall(
    {
      ...event,
      durationMs: 42,
      result: {
        content: Array.from({ length: 12 }, (_unused, index) => ({
          type: "text",
          text: `line ${index}`,
        })),
        details: { bytes: 128 },
      },
    },
    { sessionId: "session-1" },
  );

  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].identity, {
    actor_id: "alice@example.com",
    tenant_id: "acme",
    session_id: "session-1",
  });
  assert.equal(sent[0].purpose, "memory-audit");
  assert.equal(sent[0].redact_payload, true);
  assert.equal(sent[0].payload.tool, "read");
  assert.deepEqual(sent[0].payload.target, {
    kind: "memory",
    memoryPath: "/memories/MEMORY.md",
    relativePath: "MEMORY.md",
  });
  assert.equal(sent[1].payload.result.content.length, 10);
  assert.deepEqual(sent[1].payload.result.details, { bytes: 128 });
  assert.equal(sent[1].payload.durationMs, 42);
});

test("marks result envelopes with tool handler errors", async () => {
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

  observer.afterToolCall({
    toolName: "read",
    toolCallId: "read-error",
    params: { path: "MEMORY.md" },
    error: "permission denied",
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "result");
  assert.equal(sent[0].outcome, "handler_error");
  assert.equal(sent[0].payload.error, "permission denied");
});

test("deduplicates repeated hook callbacks for the same tool call", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-"));
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
  const event = {
    toolName: "read",
    toolCallId: "dupe-1",
    params: { path: "MEMORY.md" },
  };

  observer.beforeToolCall(event);
  observer.beforeToolCall(event);
  observer.afterToolCall({ ...event, result: "ok" });
  observer.afterToolCall({ ...event, result: "ok" });

  assert.deepEqual(
    sent.map((envelope) => [envelope.type, envelope.call_id]),
    [
      ["intent", "dupe-1"],
      ["result", "dupe-1"],
    ],
  );
});

test("suffixes multi-target apply_patch envelope call ids", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "psy-openclaw-"));
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
  const patch = [
    "*** Begin Patch",
    "*** Add File: memory/2026-05-01.md",
    "+daily",
    "*** Update File: skills/demo/SKILL.md",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");
  const event = {
    toolName: "apply_patch",
    toolCallId: "patch-1",
    params: { input: patch },
  };

  observer.beforeToolCall(event);
  observer.afterToolCall({ ...event, result: "ok" });

  assert.deepEqual(
    sent.map((envelope) => [envelope.type, envelope.call_id, envelope.operation, envelope.memory_path]),
    [
      ["intent", "patch-1:1", "create", "/memories/memory/2026-05-01.md"],
      ["intent", "patch-1:2", "str_replace", "/skills/demo/SKILL.md"],
      ["result", "patch-1:1", "create", "/memories/memory/2026-05-01.md"],
      ["result", "patch-1:2", "str_replace", "/skills/demo/SKILL.md"],
    ],
  );
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
