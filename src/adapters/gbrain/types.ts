import type { AuditIdentityInput, MemoryPathSet, WrapOptions } from '../../types.js';
import type { MemoryOperation } from '../../provider.js';

/**
 * Structural GBrain operation types.
 *
 * GBrain is a Bun/TypeScript package, but psy keeps this adapter dependency-free:
 * consumers pass the real `operations` array, individual operations, or
 * `BrainEngine` instance from their installed GBrain build.
 */

export const GBRAIN_PATH_PREFIX = 'gbrain://';

export type GBrainAuditOperation = MemoryOperation;

export interface GBrainAuthInfo {
  token?: string;
  clientId?: string;
  scopes?: string[];
  expiresAt?: number;
  [extra: string]: unknown;
}

export interface GBrainLogger {
  info?(msg: string): void;
  warn?(msg: string): void;
  error?(msg: string): void;
}

export interface GBrainOperationContext {
  engine?: GBrainEngine;
  config?: unknown;
  logger?: GBrainLogger;
  dryRun?: boolean;
  auth?: GBrainAuthInfo;
  remote?: boolean;
  jobId?: number;
  subagentId?: number;
  viaSubagent?: boolean;
  allowedSlugPrefixes?: string[];
  brainId?: string;
  [extra: string]: unknown;
}

export interface GBrainOperation<P extends Record<string, unknown> = Record<string, unknown>, R = unknown> {
  name: string;
  description?: string;
  params?: Record<string, unknown>;
  handler(ctx: GBrainOperationContext, params: P): Promise<R>;
  mutating?: boolean;
  scope?: 'read' | 'write' | 'admin';
  localOnly?: boolean;
  cliHints?: {
    name?: string;
    positional?: string[];
    stdin?: string;
    hidden?: boolean;
  };
  [extra: string]: unknown;
}

export interface GBrainEngine {
  readonly kind?: 'postgres' | 'pglite' | string;
  [method: string]: unknown;
}

export interface GBrainAuditClassification {
  operation: GBrainAuditOperation;
  memoryPath: string;
  paths?: MemoryPathSet;
}

export interface GBrainWrapOptions extends WrapOptions {
  /**
   * Brain id used in synthesized paths when no OperationContext.brainId exists.
   * GBrain's default local brain is conventionally `host`.
   */
  brainId?: string;
  /**
   * Audit read/query/list operations. Defaults to true to match the read
   * coverage of the other psy adapters; set false for high-volume query paths.
   */
  auditReads?: boolean;
  /**
   * Audit admin-scope read operations such as stats/health/config reads.
   * Defaults to true when auditReads is true.
   */
  auditAdminReads?: boolean;
  /**
   * Override operation classification. Return null to intentionally skip a
   * specific GBrain operation.
   */
  classifyOperation?: (
    operation: GBrainOperation,
    ctx: GBrainOperationContext,
    params: Record<string, unknown>,
  ) => GBrainAuditClassification | null | undefined;
  /**
   * Override engine method classification. Return null to intentionally skip a
   * specific engine method call.
   */
  classifyEngineMethod?: (
    method: string,
    args: unknown[],
    engine: GBrainEngine,
  ) => GBrainAuditClassification | null | undefined;
  /**
   * Supply per-call identity from GBrain operation context. Defaults to
   * OAuth client id as actor and job/subagent ids as session ids when present.
   */
  identityFromOperation?: (
    operation: GBrainOperation,
    ctx: GBrainOperationContext,
    params: Record<string, unknown>,
  ) => AuditIdentityInput | undefined;
  /** Supply per-call identity for engine method calls. */
  identityFromEngine?: (
    method: string,
    args: unknown[],
    engine: GBrainEngine,
  ) => AuditIdentityInput | undefined;
  /** Optional per-operation purpose override. */
  purposeFromOperation?: (
    operation: GBrainOperation,
    ctx: GBrainOperationContext,
    params: Record<string, unknown>,
  ) => string | null | undefined;
  /** Optional per-engine-method purpose override. */
  purposeFromEngine?: (
    method: string,
    args: unknown[],
    engine: GBrainEngine,
  ) => string | null | undefined;
}
