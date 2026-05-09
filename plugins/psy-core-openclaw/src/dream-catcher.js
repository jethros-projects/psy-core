import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { identityBlock, resolveKnownWorkspaceDirs } from "./config.js";
import { classifyTargetPathWithConfig } from "./paths.js";

const ROOT_DREAM_FILES = new Set(["DREAMS.md", "dreams.md"]);
const HUMAN_DREAM_DIRS = ["memory/dreaming"];
const MACHINE_DREAM_DIRS = ["memory/.dreams"];

export class OpenClawDreamCatcher {
  constructor({ config, logger = console, ingest = null, getAppConfig, env = process.env } = {}) {
    this.config = config;
    this.logger = logger;
    this.ingest = ingest;
    this.getAppConfig = getAppConfig || (() => ({}));
    this.env = env;
    this.snapshots = new Map();
    this.timer = null;
    this.scannedOnce = false;
  }

  start() {
    if (this.timer || !this.config.dreamCatcherEnabled) return;
    void this.scanSafely();
    this.timer = setInterval(() => {
      void this.scanSafely();
    }, this.config.dreamCatcherIntervalMs);
    this.timer.unref?.();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scanSafely(options = {}) {
    try {
      await this.scanNow(options);
    } catch (error) {
      this.logger.error?.(`psy-core-openclaw dream catcher failed: ${formatError(error)}`);
    }
  }

  async scanNow({ emitInitial = false } = {}) {
    if (!this.config.dreamCatcherEnabled) return;
    const appConfig = this.getAppConfig();
    const workspaceDirs = resolveKnownWorkspaceDirs(appConfig, this.env);
    const emitNew = emitInitial || this.scannedOnce;

    for (const workspaceDir of workspaceDirs) {
      await this.scanWorkspace(workspaceDir, appConfig, emitNew);
    }

    this.scannedOnce = true;
  }

  noteObservedRecord(record, { appConfig = this.getAppConfig() } = {}) {
    if (!record?.absolutePath) return;
    const absolutePath = normalizeFsPath(record.absolutePath);
    const workspaceDir = this.workspaceForPath(absolutePath, appConfig);
    if (!workspaceDir || !this.isDreamPath(absolutePath, workspaceDir)) return;
    const snapshot = snapshotFileSync(absolutePath);
    this.snapshots.set(absolutePath, {
      ...snapshot,
      workspaceDir: normalizeFsPath(workspaceDir),
      relativePath: relativePathForWorkspace(workspaceDir, absolutePath),
    });
  }

  async scanWorkspace(workspaceDir, appConfig, emitNew) {
    const workspace = normalizeFsPath(workspaceDir);
    const candidates = await this.candidatePathsForWorkspace(workspace);
    const physicalFiles = new Set();
    for (const absolutePath of candidates) {
      const physicalKey = await physicalKeyForPath(absolutePath);
      if (physicalKey) {
        if (physicalFiles.has(physicalKey)) continue;
        physicalFiles.add(physicalKey);
      }
      await this.inspectPath(absolutePath, workspace, appConfig, emitNew);
    }
  }

  async candidatePathsForWorkspace(workspaceDir) {
    const candidates = new Set();
    for (const name of ROOT_DREAM_FILES) {
      candidates.add(normalizeFsPath(path.join(workspaceDir, name)));
    }

    for (const dir of this.dreamDirs()) {
      const root = path.join(workspaceDir, dir);
      for (const file of await walkFiles(root)) {
        candidates.add(normalizeFsPath(file));
      }
    }

    for (const absolutePath of this.snapshots.keys()) {
      if (isInside(workspaceDir, absolutePath) && this.isDreamPath(absolutePath, workspaceDir)) {
        candidates.add(absolutePath);
      }
    }

    return candidates;
  }

  async inspectPath(absolutePath, workspaceDir, appConfig, emitNew) {
    if (!this.isDreamPath(absolutePath, workspaceDir)) return;
    const target = classifyTargetPathWithConfig(absolutePath, {
      workspaceDir,
      appConfig,
      env: this.env,
    });
    if (!target) return;

    const current = {
      ...(await snapshotFile(absolutePath)),
      workspaceDir: normalizeFsPath(workspaceDir),
      relativePath: target.relativePath,
    };
    const previous = this.snapshots.get(absolutePath);

    if (!previous) {
      this.snapshots.set(absolutePath, current);
      if (current.exists && emitNew) {
        await this.emitChange("create", target, current);
      }
      return;
    }

    if (previous.exists === current.exists && previous.digest === current.digest) {
      this.snapshots.set(absolutePath, current);
      return;
    }

    this.snapshots.set(absolutePath, current);
    const operation = !current.exists ? "delete" : previous.exists ? "str_replace" : "create";
    await this.emitChange(operation, target, current);
  }

  async emitChange(operation, target, snapshot) {
    const envelope = {
      type: "result",
      operation,
      call_id: `dream-catcher-${crypto.randomUUID()}`,
      memory_path: target.memoryPath,
      source: "psy-core-openclaw-dream-catcher",
      outcome: "unattributed",
    };
    const identity = identityBlock(this.config, null);
    if (identity) envelope.identity = identity;
    if (this.config.purpose) envelope.purpose = this.config.purpose;
    if (this.config.payloadCapture) {
      envelope.payload = payloadForSnapshot(target, snapshot, operation);
      envelope.redact_payload = true;
    }

    if (this.config.dryRun) {
      this.logger.info?.(`psy-core-openclaw dream catcher dry-run: ${JSON.stringify(envelope)}`);
      return;
    }
    await Promise.resolve(this.ingest?.send?.(envelope));
  }

  workspaceForPath(absolutePath, appConfig) {
    const workspaces = resolveKnownWorkspaceDirs(appConfig, this.env);
    return workspaces.find((workspaceDir) => isInside(workspaceDir, absolutePath)) || null;
  }

  isDreamPath(absolutePath, workspaceDir) {
    const relativePath = relativePathForWorkspace(workspaceDir, absolutePath);
    if (!relativePath) return false;
    if (ROOT_DREAM_FILES.has(relativePath)) return true;
    for (const dir of HUMAN_DREAM_DIRS) {
      if (relativePath.startsWith(`${dir}/`)) return true;
    }
    if (this.config.dreamCatcherIncludeMachineState) {
      for (const dir of MACHINE_DREAM_DIRS) {
        if (relativePath.startsWith(`${dir}/`)) return true;
      }
    }
    return false;
  }

  dreamDirs() {
    return this.config.dreamCatcherIncludeMachineState
      ? [...HUMAN_DREAM_DIRS, ...MACHINE_DREAM_DIRS]
      : HUMAN_DREAM_DIRS;
  }
}

async function walkFiles(root) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(child)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(child);
    }
  }
  return files;
}

async function snapshotFile(absolutePath) {
  try {
    const stat = await fsp.stat(absolutePath);
    if (!stat.isFile()) return missingSnapshot();
    const digest = await hashFile(absolutePath);
    return {
      exists: true,
      digest,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      absolutePath,
    };
  } catch {
    return missingSnapshot(absolutePath);
  }
}

async function physicalKeyForPath(absolutePath) {
  try {
    const stat = await fsp.stat(absolutePath);
    if (!stat.isFile()) return null;
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

function snapshotFileSync(absolutePath) {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return missingSnapshot(absolutePath);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
    return {
      exists: true,
      digest,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      absolutePath,
    };
  } catch {
    return missingSnapshot(absolutePath);
  }
}

async function hashFile(absolutePath) {
  return crypto.createHash("sha256").update(await fsp.readFile(absolutePath)).digest("hex");
}

function missingSnapshot(absolutePath = null) {
  return {
    exists: false,
    digest: null,
    size: 0,
    mtimeMs: 0,
    absolutePath,
  };
}

function payloadForSnapshot(target, snapshot, operation) {
  const payload = {
    target: {
      kind: target.kind,
      memoryPath: target.memoryPath,
      relativePath: target.relativePath,
    },
    path: snapshot.absolutePath,
    size: snapshot.size,
    mtimeMs: snapshot.mtimeMs,
  };
  if (snapshot.digest) payload.content_hash = snapshot.digest;
  if (operation === "delete") payload.deleted = true;
  return payload;
}

function relativePathForWorkspace(workspaceDir, absolutePath) {
  const relativePath = path.relative(normalizeFsPath(workspaceDir), normalizeFsPath(absolutePath));
  if (!relativePath || relativePath === ".") return null;
  if (relativePath === ".." || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    return null;
  }
  return relativePath.replace(/\\/g, "/");
}

function isInside(root, candidate) {
  return relativePathForWorkspace(root, candidate) !== null;
}

function normalizeFsPath(value) {
  return path.resolve(String(value || "")).replace(/\\/g, "/");
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
