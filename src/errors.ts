export type PsyErrorCode =
  | 'E_AUDIT_TIMEOUT'
  | 'E_CHAIN_BROKEN'
  | 'E_PATH_TRAVERSAL'
  | 'E_PATH_ENCODED'
  | 'E_CONFIG_INVALID'
  | 'E_CONFIG_NOT_FOUND'
  | 'E_SCHEMA_MIGRATION_REQUIRED'
  | 'E_REDACTOR_FAILED'
  | 'E_HANDLER_ERROR'
  | 'E_AUDIT_ERROR';

export interface PsyErrorOptions {
  cause?: unknown;
  eventId?: string | null;
  operationId?: string | null;
  details?: Record<string, unknown>;
}

export class PsyError extends Error {
  readonly code: PsyErrorCode;
  readonly eventId: string | null;
  readonly operationId: string | null;
  readonly details?: Record<string, unknown>;

  constructor(code: PsyErrorCode, message: string, options: PsyErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.eventId = options.eventId ?? null;
    this.operationId = options.operationId ?? null;
    this.details = options.details;
  }
}

export class PsyAuditTimeout extends PsyError {
  constructor(message = 'Audit write exceeded the timeout budget', options: PsyErrorOptions = {}) {
    super('E_AUDIT_TIMEOUT', message, options);
  }
}

export class PsyChainBroken extends PsyError {
  constructor(message: string, options: PsyErrorOptions = {}) {
    super('E_CHAIN_BROKEN', message, options);
  }
}

export class PsyPathTraversal extends PsyError {
  constructor(message: string, options: PsyErrorOptions = {}) {
    super(options.details?.encoded === true ? 'E_PATH_ENCODED' : 'E_PATH_TRAVERSAL', message, options);
  }
}

export class PsyConfigInvalid extends PsyError {
  constructor(message: string, options: PsyErrorOptions = {}) {
    super(options.details?.notFound === true ? 'E_CONFIG_NOT_FOUND' : 'E_CONFIG_INVALID', message, options);
  }
}

export class PsySchemaMigrationRequired extends PsyError {
  constructor(message: string, options: PsyErrorOptions = {}) {
    super('E_SCHEMA_MIGRATION_REQUIRED', message, options);
  }
}

export class PsyRedactorFailed extends PsyError {
  constructor(message: string, options: PsyErrorOptions = {}) {
    super('E_REDACTOR_FAILED', message, options);
  }
}

export function isPsyError(error: unknown): error is PsyError {
  return error instanceof PsyError;
}

export function errorCodeFor(error: unknown): PsyErrorCode {
  return isPsyError(error) ? error.code : 'E_AUDIT_ERROR';
}

export function truncateMessage(message: string, maxLength = 256): string {
  return message.length <= maxLength ? message : `${message.slice(0, maxLength - 1)}…`;
}
