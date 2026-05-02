import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ingestEnv } from "./config.js";

export class IngestClient {
  constructor({ config, logger = console, env = process.env } = {}) {
    this.config = config;
    this.logger = logger;
    this.env = env;
    this.child = null;
    this.closed = false;
    this.spawnFailed = false;
    this.stdoutBuffer = "";
  }

  send(envelope) {
    if (this.closed) return false;
    const child = this.ensureChild();
    if (!child?.stdin?.writable) return false;
    const line = `${JSON.stringify(envelope)}\n`;
    try {
      return child.stdin.write(line);
    } catch (error) {
      this.logger.warn?.(`psy-core-openclaw: failed to write audit envelope: ${formatError(error)}`);
      return false;
    }
  }

  close() {
    this.closed = true;
    if (!this.child) return;
    try {
      this.child.stdin?.end();
    } catch {}
    this.child = null;
  }

  ensureChild() {
    if (this.child || this.spawnFailed) return this.child;
    const plan = resolveSpawnPlan(this.config, this.env);
    try {
      this.child = spawn(plan.command, plan.args, {
        env: {
          ...this.env,
          ...ingestEnv(this.config),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.spawnFailed = true;
      this.logger.error?.(`psy-core-openclaw: failed to start psy ingest: ${formatError(error)}`);
      return null;
    }

    this.child.once("error", (error) => {
      this.spawnFailed = true;
      this.logger.error?.(`psy-core-openclaw: psy ingest process error: ${formatError(error)}`);
    });
    this.child.once("exit", (code, signal) => {
      if (!this.closed && code !== 0) {
        this.logger.warn?.(
          `psy-core-openclaw: psy ingest exited code=${code ?? "null"} signal=${signal ?? "null"}`,
        );
      }
      this.child = null;
    });
    this.child.stderr?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.logger.warn?.(`psy ingest stderr: ${text}`);
    });
    this.child.stdout?.on("data", (chunk) => {
      this.consumeStdout(String(chunk));
    });
    return this.child;
  }

  consumeStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.handleAckLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  handleAckLine(line) {
    try {
      const ack = JSON.parse(line);
      if (ack?.ok === false) {
        this.logger.warn?.(`psy-core-openclaw: ingest rejected audit envelope: ${line}`);
      }
    } catch {
      this.logger.debug?.(`psy-core-openclaw: ingest stdout: ${line}`);
    }
  }
}

export function resolveSpawnPlan(config, env = process.env) {
  if (config.psyBinary) {
    return { command: config.psyBinary, args: ["ingest", "--no-startup"], source: "psyBinary" };
  }
  const psy = which("psy", env);
  if (psy) return { command: psy, args: ["ingest", "--no-startup"], source: "PATH" };
  const npx = which("npx", env);
  if (npx) {
    return {
      command: npx,
      args: ["-y", `psy-core@${config.psyCoreVersion}`, "psy", "ingest", "--no-startup"],
      source: "npx",
    };
  }
  throw new Error("could not find `psy` or `npx` on PATH");
}

function which(bin, env) {
  const pathValue = env.PATH || "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
