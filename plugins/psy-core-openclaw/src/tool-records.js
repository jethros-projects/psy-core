import path from "node:path";

import { resolveUserPath, resolveWorkspaceForEvent } from "./config.js";
import {
  classifyTargetPathWithConfig,
  operationForFileTool,
  operationForPathExistence,
} from "./paths.js";
import { extractPatchTargets } from "./patch-parser.js";

const FILE_MUTATION_TOOLS = new Set(["write", "edit"]);
const FILE_VIEW_TOOLS = new Set(["read"]);
const SKILL_WORKSHOP_TOOL = "skill_workshop";

const MEMORY_TOOL_HANDLERS = {
  memory_search: (params) => [memoryRecord("view", memorySearchPath(params))],
  memory_get: memoryGetRecords,
  memory_recall: () => [memoryRecord("view", "/memory-lancedb/recall")],
  memory_store: memoryStoreRecords,
  memory_forget: memoryForgetRecords,
  wiki_status: () => [memoryRecord("view", "/memory-wiki/status")],
  wiki_lint: wikiLintRecords,
  wiki_apply: wikiApplyRecords,
  wiki_search: wikiSearchRecords,
  wiki_get: wikiGetRecords,
};

export function auditRecordsForToolCall({
  event,
  ctx = {},
  appConfig = {},
  env = process.env,
}) {
  const toolName = normalizeToolName(event?.toolName);
  const params = isRecord(event?.params) ? event.params : {};
  if (!toolName) return [];

  if (FILE_MUTATION_TOOLS.has(toolName)) {
    const target = classifyOpenClawToolPath(params.path, { appConfig, ctx, env });
    if (!target) return [];
    const operation = operationForFileTool(toolName, target);
    return operation ? [{ operation, ...target }] : [];
  }

  if (FILE_VIEW_TOOLS.has(toolName)) {
    const target = classifyOpenClawToolPath(params.path, { appConfig, ctx, env });
    return target ? [{ operation: "view", ...target }] : [];
  }

  if (toolName === "apply_patch") {
    const input = typeof params.input === "string" ? params.input : "";
    return extractPatchTargets(input)
      .map((target) => {
        const classified = classifyOpenClawToolPath(target.path, { appConfig, ctx, env });
        return classified ? { operation: target.operation, ...classified } : null;
      })
      .filter(Boolean);
  }

  const memoryHandler = MEMORY_TOOL_HANDLERS[toolName];
  if (memoryHandler) return memoryHandler(params, { event, appConfig, ctx, env });

  if (toolName === SKILL_WORKSHOP_TOOL) {
    return skillWorkshopRecords({ event, params, ctx, appConfig, env });
  }

  return [];
}

function classifyOpenClawToolPath(pathParam, { appConfig, ctx, env }) {
  if (typeof pathParam !== "string") return null;
  const workspaceDir = resolveWorkspaceForEvent(appConfig, ctx, env);
  return classifyTargetPathWithConfig(pathParam, { workspaceDir, appConfig, env });
}

function memoryGetRecords(params, { appConfig, ctx, env }) {
  const target = classifyOpenClawToolPath(params.path, { appConfig, ctx, env });
  if (target) return [{ operation: "view", ...target }];

  const rawPath = trimmedString(params.path) || "unknown";
  const prefix = params.corpus === "wiki" ? "/memory-wiki" : "/memories/get";
  return [memoryRecord("view", `${prefix}/${slugPathSegment(rawPath)}`)];
}

function memoryStoreRecords(params, { event }) {
  const details = resultDetails(event.result);
  const id = trimmedString(details?.id);
  if (id) return [memoryRecord("create", `/memory-lancedb/${slugPathSegment(id)}`)];

  const category = trimmedString(params.category) || "other";
  return [memoryRecord("create", `/memory-lancedb/${slugPathSegment(category)}`)];
}

function memoryForgetRecords(params, { event }) {
  const details = resultDetails(event.result);
  const id = trimmedString(details?.id) || trimmedString(params.memoryId) || "query";
  return [memoryRecord("delete", `/memory-lancedb/${slugPathSegment(id)}`)];
}

function wikiLintRecords(_params, { appConfig, env }) {
  const vaultDir = resolveMemoryWikiVaultDir(appConfig, env);
  const reportPath = path.join(vaultDir, "reports", "lint.md");
  return [
    memoryRecord("view", "/memory-wiki"),
    memoryRecord(operationForPathExistence(reportPath), "/memory-wiki/reports/lint.md", {
      absolutePath: reportPath,
      relativePath: "reports/lint.md",
    }),
  ];
}

function wikiApplyRecords(params, { event }) {
  const details = resultDetails(event.result);
  const op = trimmedString(details?.operation) || trimmedString(params.op);
  const operation = op === "create_synthesis" ? "create" : "str_replace";
  const pagePath = trimmedString(details?.pagePath);
  if (pagePath) return [memoryRecord(operation, `/memory-wiki/${safeRelativePath(pagePath)}`)];

  const page = trimmedString(params.lookup) || trimmedString(params.title) || "unknown";
  return [memoryRecord(operation, `/memory-wiki/${slugPathSegment(page)}`)];
}

function wikiSearchRecords(params) {
  const corpus = trimmedString(params.corpus);
  const suffix = corpus ? `/${slugPathSegment(corpus)}` : "";
  return [memoryRecord("view", `/memory-wiki/search${suffix}`)];
}

function wikiGetRecords(params, { event }) {
  const details = resultDetails(event.result);
  const pagePath = trimmedString(details?.path);
  if (pagePath) return [memoryRecord("view", `/memory-wiki/${safeRelativePath(pagePath)}`)];

  const lookup = trimmedString(params.lookup) || "unknown";
  const prefix = params.corpus === "memory" ? "/memories/get" : "/memory-wiki";
  return [memoryRecord("view", `${prefix}/${slugPathSegment(lookup)}`)];
}

function memorySearchPath(params) {
  const corpus = trimmedString(params.corpus) || "memory";
  if (corpus === "wiki") return "/memory-wiki/search";
  return corpus === "memory" ? "/memories/search" : `/memories/search/${slugPathSegment(corpus)}`;
}

function memoryRecord(operation, memoryPath, extra = {}) {
  return { operation, kind: "memory", memoryPath, ...extra };
}

function resolveMemoryWikiVaultDir(appConfig, env) {
  const configured =
    appConfig?.plugins?.entries?.["memory-wiki"]?.config?.vault?.path ??
    appConfig?.plugins?.entries?.memoryWiki?.config?.vault?.path ??
    appConfig?.["memory-wiki"]?.vault?.path;
  return trimmedString(configured)
    ? resolveUserPath(configured, env)
    : path.join(resolveUserPath("~", env), ".openclaw", "wiki", "main");
}

function skillWorkshopRecords({ event, params, ctx = {}, appConfig = {}, env = process.env }) {
  const workspaceDir = resolveWorkspaceForEvent(appConfig, ctx, env);
  const resultRecord = skillWorkshopResultRecord(skillWorkshopResultDetails(event.result), {
    workspaceDir,
    appConfig,
    env,
    params,
  });
  if (resultRecord) return [resultRecord];
  return skillWorkshopIntentRecords({ params, workspaceDir, appConfig, env });
}

function skillWorkshopIntentRecords({ params, workspaceDir, appConfig, env }) {
  const action = trimmedString(params.action) || "status";
  if (action === "write_support_file") {
    const targetPath = skillWorkshopSupportPath(workspaceDir, params);
    if (!targetPath) return [];
    const target = classifyTargetPathWithConfig(targetPath, { workspaceDir, appConfig, env });
    return target ? [{ operation: operationForSkillWorkshopPath(target), ...target }] : [];
  }
  if (action === "suggest" && params.apply === true) {
    const targetPath = skillWorkshopMainPath(workspaceDir, params);
    if (!targetPath) return [];
    const target = classifyTargetPathWithConfig(targetPath, { workspaceDir, appConfig, env });
    return target
      ? [{ operation: operationForSkillWorkshopSuggestion(params, target), ...target }]
      : [];
  }
  return [];
}

function skillWorkshopResultRecord(details, { workspaceDir, appConfig, env, params }) {
  if (!isRecord(details)) return null;
  const targetPath = trimmedString(details.skillPath) || trimmedString(details.filePath);
  if (!targetPath) return null;
  const target = classifyTargetPathWithConfig(targetPath, { workspaceDir, appConfig, env });
  if (!target) return null;
  return {
    operation: operationForSkillWorkshopResult(details, params, target),
    ...target,
  };
}

function operationForSkillWorkshopResult(details, params, target) {
  const change = isRecord(details.proposal) ? details.proposal.change : null;
  const kind = isRecord(change) ? trimmedString(change.kind) : null;
  if (kind === "replace" || kind === "append") return "str_replace";
  if (kind === "create") return "create";
  if (params.action === "write_support_file") return operationForSkillWorkshopPath(target);
  return "str_replace";
}

function operationForSkillWorkshopSuggestion(params, target) {
  if (params.oldText !== undefined || params.newText !== undefined) return "str_replace";
  return operationForSkillWorkshopPath(target);
}

function operationForSkillWorkshopPath(target) {
  return operationForPathExistence(target.absolutePath);
}

function skillWorkshopMainPath(workspaceDir, params) {
  const name = normalizeSkillName(params.skillName);
  if (!name) return null;
  return path.join(workspaceDir, "skills", name, "SKILL.md");
}

function skillWorkshopSupportPath(workspaceDir, params) {
  const name = normalizeSkillName(params.skillName);
  const relative = typeof params.relativePath === "string" ? params.relativePath : "";
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  if (!name || parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    return null;
  }
  return path.join(workspaceDir, "skills", name, ...parts);
}

function normalizeSkillName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, 80);
}

function skillWorkshopResultDetails(result) {
  if (isRecord(result) && isRecord(result.details)) return result.details;
  if (isRecord(result) && typeof result.status === "string") return result;
  return null;
}

function normalizeToolName(value) {
  return trimmedString(value)?.toLowerCase() || null;
}

function resultDetails(result) {
  return isRecord(result) && isRecord(result.details) ? result.details : null;
}

function safeRelativePath(value) {
  const parts = value
    .split(/[\\/]+/)
    .map((part) => safeFileSegment(part))
    .filter(Boolean);
  return parts.length > 0 ? parts.join("/") : "unknown";
}

function safeFileSegment(value) {
  const segment = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return !segment || /^\.+$/.test(segment) ? "unknown" : segment;
}

function slugPathSegment(value) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function trimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
