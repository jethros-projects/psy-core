import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveUserPath } from "./config.js";

const ROOT_MEMORY_FILES = new Set(["MEMORY.md", "USER.md", "DREAMS.md", "dreams.md"]);

export function classifyTargetPath(inputPath, { workspaceDir, appConfig = {}, env = process.env } = {}) {
  return classifyTargetPathWithConfig(inputPath, { workspaceDir, appConfig, env });
}

export function classifyTargetPathWithConfig(
  inputPath,
  { workspaceDir, appConfig = {}, env = process.env } = {},
) {
  const absolutePath = resolveToolPath(inputPath, workspaceDir, env);
  if (!absolutePath) return null;
  const normalizedAbs = normalizePath(absolutePath);
  const workspace = normalizePath(workspaceDir);
  const home = normalizePath(env.HOME || "");

  const workspaceRel = workspace ? relativeIfInside(workspace, normalizedAbs) : null;
  if (workspaceRel) {
    const memory = classifyWorkspaceMemoryPath(workspaceRel);
    if (memory) return { ...memory, absolutePath: normalizedAbs, relativePath: workspaceRel };
    const skill = classifyWorkspaceSkillPath(workspaceRel);
    if (skill) return { ...skill, absolutePath: normalizedAbs, relativePath: workspaceRel };
  }

  const openClawSkillsRoot = home ? normalizePath(path.join(home, ".openclaw", "skills")) : null;
  const managedSkillRel = openClawSkillsRoot
    ? relativeIfInside(openClawSkillsRoot, normalizedAbs)
    : null;
  if (managedSkillRel) {
    return {
      kind: "skill",
      absolutePath: normalizedAbs,
      relativePath: managedSkillRel,
      memoryPath: `/managed-skills/${managedSkillRel}`,
    };
  }

  const personalAgentSkillsRoot = home ? normalizePath(path.join(home, ".agents", "skills")) : null;
  const personalSkillRel = personalAgentSkillsRoot
    ? relativeIfInside(personalAgentSkillsRoot, normalizedAbs)
    : null;
  if (personalSkillRel) {
    return {
      kind: "skill",
      absolutePath: normalizedAbs,
      relativePath: personalSkillRel,
      memoryPath: `/agent-skills/${personalSkillRel}`,
    };
  }

  const extraRoots = resolveExtraSkillRoots(appConfig, env);
  for (const root of extraRoots) {
    const extraSkillRel = relativeIfInside(root, normalizedAbs);
    if (!extraSkillRel) continue;
    return {
      kind: "skill",
      absolutePath: normalizedAbs,
      relativePath: extraSkillRel,
      memoryPath: `/extra-skills/${extraSkillRel}`,
    };
  }

  return null;
}

export function classifyWorkspaceMemoryPath(relativePath) {
  const rel = normalizeRelativePath(relativePath);
  const base = path.posix.basename(rel);
  if (ROOT_MEMORY_FILES.has(rel)) {
    return { kind: "memory", memoryPath: `/memories/${rel}` };
  }
  if (rel.startsWith("memory/") && base) {
    return { kind: "memory", memoryPath: `/memories/${rel}` };
  }
  return null;
}

export function classifyWorkspaceSkillPath(relativePath) {
  const rel = normalizeRelativePath(relativePath);
  if (rel.startsWith("skills/")) {
    return { kind: "skill", memoryPath: `/${rel}` };
  }
  if (rel.startsWith(".agents/skills/")) {
    return { kind: "skill", memoryPath: `/${rel}` };
  }
  return null;
}

export function operationForFileTool(toolName, target) {
  if (toolName === "edit") return "str_replace";
  if (toolName === "write") return operationForPathExistence(target.absolutePath);
  return null;
}

export function operationForPathExistence(absolutePath) {
  try {
    return fs.existsSync(absolutePath) ? "str_replace" : "create";
  } catch {
    return "create";
  }
}

export function resolveToolPath(inputPath, workspaceDir, env = process.env) {
  if (typeof inputPath !== "string" || !inputPath.trim()) return null;
  let value = inputPath.trim();
  if (value.startsWith("@")) value = value.slice(1);
  if (/^file:\/\//i.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      return null;
    }
  }
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    return resolveUserPath(value, env);
  }
  if (path.isAbsolute(value)) return path.resolve(value);
  return path.resolve(workspaceDir || process.cwd(), value);
}

function relativeIfInside(root, candidate) {
  if (!root) return null;
  const relative = normalizeRelativePath(path.relative(root, candidate));
  if (!relative || relative === ".") return null;
  if (relative.startsWith("../") || path.isAbsolute(relative)) return null;
  return relative;
}

function normalizePath(value) {
  return value ? path.resolve(value).replace(/\\/g, "/") : "";
}

function normalizeRelativePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function resolveExtraSkillRoots(appConfig, env) {
  const dirs = appConfig?.skills?.load?.extraDirs;
  if (!Array.isArray(dirs)) return [];
  return dirs
    .filter((dir) => typeof dir === "string" && dir.trim())
    .map((dir) => normalizePath(resolveUserPath(dir, env)))
    .filter(Boolean);
}
