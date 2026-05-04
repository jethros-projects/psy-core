import crypto from "node:crypto";

import { identityBlock } from "./config.js";
import { TtlCache } from "./ttl-cache.js";
import { auditRecordsForToolCall } from "./tool-records.js";
export { auditRecordsForToolCall } from "./tool-records.js";

export class PsyOpenClawObserver {
  constructor({ config, logger = console, ingest = null, getAppConfig, env = process.env } = {}) {
    this.config = config;
    this.logger = logger;
    this.ingest = ingest;
    this.getAppConfig = getAppConfig || (() => ({}));
    this.env = env;
    this.dedupe = new TtlCache(60_000, 4096);
    this.pending = new TtlCache(60_000, 4096);
  }

  beforeToolCall(event, ctx = {}) {
    this.emitSafely("intent", event, ctx);
  }

  afterToolCall(event, ctx = {}) {
    this.emitSafely("result", event, ctx);
  }

  close() {
    this.ingest?.close?.();
  }

  emitForToolCall(kind, event, ctx) {
    const baseCallId = callIdForEvent(event, ctx);
    const appConfig = this.getAppConfig();
    const currentRecords = auditRecordsForToolCall({
      event,
      ctx,
      appConfig,
      env: this.env,
    });
    const pendingRecords = kind === "result" ? this.pending.take(baseCallId) : null;
    const records =
      kind === "result"
        ? resultRecords({ currentRecords, pendingRecords })
        : currentRecords;
    if (records.length === 0) return;

    if (kind === "intent") {
      this.pending.set(baseCallId, records);
    }

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const callId = records.length === 1 ? baseCallId : `${baseCallId}:${index + 1}`;
      const dedupeKey = `${kind}|${callId}|${event.toolName}|${hashJson(event.params)}`;
      if (this.dedupe.remember(dedupeKey)) continue;
      const envelope = this.buildEnvelope(kind, record, callId, event, ctx);
      if (this.config.dryRun) {
        this.logger.info?.(`psy-core-openclaw dry-run ${kind}: ${JSON.stringify(envelope)}`);
        continue;
      }
      this.ingest?.send?.(envelope);
    }
  }

  emitSafely(kind, event, ctx) {
    try {
      this.emitForToolCall(kind, event, ctx);
    } catch (error) {
      this.logger.error?.(`psy-core-openclaw: ${kind} observer failed: ${formatError(error)}`);
    }
  }

  buildEnvelope(kind, record, callId, event, ctx) {
    const envelope = {
      type: kind,
      operation: record.operation,
      call_id: callId,
      memory_path: record.memoryPath,
      source: "psy-core-openclaw",
    };
    const sessionId = ctx.sessionId || event.runId || ctx.runId || ctx.sessionKey;
    const identity = identityBlock(this.config, sessionId);
    if (identity) envelope.identity = identity;
    if (this.config.purpose) envelope.purpose = this.config.purpose;
    if (this.config.payloadCapture) {
      envelope.payload = payloadFor(kind, record, event);
      envelope.redact_payload = true;
    }
    if (kind === "result") {
      if (event.error) {
        envelope.outcome = "handler_error";
      } else if (record.outcome) {
        envelope.outcome = record.outcome;
      }
    }
    return envelope;
  }
}

function resultRecords({ currentRecords, pendingRecords }) {
  if (!pendingRecords) {
    return currentRecords.map((record) => ({ outcome: "unattributed", ...record }));
  }
  if (currentRecords.length === pendingRecords.length && currentRecords.length > 0) {
    return currentRecords.map((record, index) => ({
      ...record,
      operation: pendingRecords[index].operation,
    }));
  }
  return pendingRecords;
}

function payloadFor(kind, record, event) {
  const payload = {
    tool: event.toolName,
    target: {
      kind: record.kind,
      memoryPath: record.memoryPath,
      relativePath: record.relativePath,
    },
    params: event.params,
  };
  if (kind === "result") {
    payload.result = summarizeResult(event.result);
    if (event.error) payload.error = event.error;
    if (typeof event.durationMs === "number") payload.durationMs = event.durationMs;
  }
  return payload;
}

function summarizeResult(result) {
  if (result === undefined || result === null) return null;
  if (typeof result === "string") return truncate(result, 1024);
  if (Array.isArray(result)) return result.slice(0, 20);
  if (typeof result === "object") {
    const out = {};
    for (const [key, value] of Object.entries(result)) {
      if (key === "content" && Array.isArray(value)) {
        out.content = value.slice(0, 10);
      } else if (key === "details") {
        out.details = value;
      }
    }
    return Object.keys(out).length > 0 ? out : { type: result.constructor?.name || "object" };
  }
  return String(result);
}

function callIdForEvent(event, ctx) {
  return (
    event.toolCallId ||
    ctx.toolCallId ||
    event.runId ||
    ctx.runId ||
    `call-${hashJson({ toolName: event.toolName, params: event.params })}`
  );
}

function hashJson(value) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")
    .slice(0, 16);
}

function stableStringify(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
    .join(",")}}`;
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
