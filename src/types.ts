import type { MemoryToolHandlers as AnthropicMemoryToolHandlers } from '@anthropic-ai/sdk/helpers/beta/memory';
import type { BetaMemoryTool20250818Command, BetaToolResultContentBlockParam } from '@anthropic-ai/sdk/resources/beta';

import type { PsyConfig } from './config.js';
import type { Redactor } from './redactor.js';
import type { PsyStore } from './store.js';
export type { JsonObject, JsonPrimitive, JsonValue } from './canonical.js';

export type MemoryCommand = BetaMemoryTool20250818Command;
export type MemoryToolCommand = MemoryCommand;
export type MemoryViewCommand = Extract<MemoryCommand, { command: 'view' }>;
export type MemoryCreateCommand = Extract<MemoryCommand, { command: 'create' }>;
export type MemoryStrReplaceCommand = Extract<MemoryCommand, { command: 'str_replace' }>;
export type MemoryInsertCommand = Extract<MemoryCommand, { command: 'insert' }>;
export type MemoryDeleteCommand = Extract<MemoryCommand, { command: 'delete' }>;
export type MemoryRenameCommand = Extract<MemoryCommand, { command: 'rename' }>;
export type MemoryToolResult = string | Array<BetaToolResultContentBlockParam>;
export type MemoryOperation = MemoryCommand['command'];
export type MemoryCommandName = MemoryOperation;
export type MemoryToolHandlers = AnthropicMemoryToolHandlers;
export type Promisable<T> = T | Promise<T>;
export type PayloadRedactor = Redactor;
export type AuditPhase = 'intent' | 'result';
export type AuditEventPhase = AuditPhase;
export type AuditStatus =
  | 'pending'
  | 'ok'
  | 'error'
  | 'validation_error'
  | 'redactor_failed';
export type AuditOutcome =
  | 'success'
  | 'handler_error'
  | 'handler_timeout'
  | 'audit_error'
  | 'audit_timeout'
  | 'rejected_by_path_guard'
  | 'rejected_by_anonymous_check'
  | 'redactor_failed'
  | 'unattributed';

export interface WrapOptions {
  actorId?: string;
  tenantId?: string;
  sessionId?: string;
  purpose?: string;
  allowAnonymous?: boolean;
  redactor?: Redactor | null;
  configPath?: string;
  config?: PsyConfig;
  auditor?: AuditSink;
  dbPath?: string;
  store?: PsyStore;
  identity?: AuditIdentityInput;
  includePayloadPreview?: boolean;
  previewPayloads?: boolean;
  payloadPreviewMaxChars?: number;
  callId?: () => string;
  now?: () => Date | string;
}

export interface AuditIdentity {
  actorId: string | null;
  tenantId: string | null;
  sessionId: string | null;
}

export type AuditIdentityInput = string | Partial<AuditIdentity>;

export interface MemoryPathSet {
  path?: string;
  old_path?: string;
  new_path?: string;
}

export interface AuditErrorSummary {
  name: string;
  message: string;
  code?: string;
}

export interface AuditResultSummary {
  kind: 'string' | 'content_blocks' | 'unknown';
  blockCount?: number;
}

export type PayloadPreviewField = 'file_text' | 'insert_text' | 'new_str';
export type PayloadPreview = Partial<Record<PayloadPreviewField, string>>;

export interface PayloadRedactionContext {
  command: MemoryCommandName;
  callId: string;
  identity: AuditIdentity;
  paths: MemoryPathSet;
  purpose?: string;
}

export interface AuditEventInput {
  phase: AuditPhase;
  status: AuditStatus;
  callId: string;
  command: MemoryCommandName;
  identity: AuditIdentity;
  memoryPath?: string;
  paths?: MemoryPathSet;
  payloadPreview?: PayloadPreview;
  payloadRedacted?: boolean;
  redactorId?: string | null;
  redactorError?: string | null;
  error?: AuditErrorSummary;
  result?: AuditResultSummary;
  timestamp?: string;
  eventId?: string;
  purpose?: string;
}

export interface AuditRecord extends AuditEventInput {
  schemaVersion: 1;
  sequence: number;
  eventId: string;
  timestamp: string;
  prevHash: string;
  hash: string;
}

export interface AuditSink {
  record(event: AuditEventInput): AuditRecord | Promise<AuditRecord>;
}

export interface AuditorOptions {
  dbPath?: string;
  store?: PsyStore;
  now?: () => Date | string;
}

export interface AuditQuery {
  callId?: string;
  command?: MemoryCommandName;
  phase?: AuditPhase;
  status?: AuditStatus;
  since?: string | Date;
  until?: string | Date;
  limit?: number;
}

export interface InternalVerifyIssue {
  sequence?: number;
  message: string;
}

export interface InternalVerifyResult {
  ok: boolean;
  checked: number;
  head?: string;
  issues: InternalVerifyIssue[];
}

export interface AuditEvent {
  schema_version: string;
  seq: number;
  event_id: string;
  operation_id: string;
  timestamp: string;
  operation: string;
  audit_phase: AuditPhase;
  tool_call_id: string | null;
  actor_id: string | null;
  tenant_id: string | null;
  session_id: string | null;
  memory_path: string;
  purpose: string | null;
  payload_preview: string | null;
  payload_redacted: boolean;
  redactor_id: string | null;
  redactor_error: string | null;
  tool_input_hash: string;
  tool_output_hash: string | null;
  prev_hash: string;
  event_hash: string;
  outcome: AuditOutcome;
  error_code: string | null;
  error_type: string | null;
  error_message: string | null;
  policy_result: 'allow';
}

export type DraftAuditEvent = Omit<AuditEvent, 'seq' | 'prev_hash' | 'event_hash'>;

export interface QueryFilters {
  actor?: string;
  tenant?: string;
  session?: string;
  operation?: string | string[];
  since?: Date;
  limit?: number;
  offset?: number;
}

export interface VerifyIssue {
  seq: number | null;
  event_id: string | null;
  operation_id: string | null;
  code: string;
  message: string;
}

export interface VerifyResult {
  ok: boolean;
  checkedRows: number;
  issues: VerifyIssue[];
}

export type AuditEventStatus = AuditOutcome | AuditStatus;
export type ExportFormat = 'jsonl';
export interface QueryResult {
  events: AuditEvent[];
}
export type VerificationResult = VerifyResult | InternalVerifyResult;
