import { randomUUID } from 'node:crypto';

import { Auditor, resolveIdentity, summarizeError } from '../../auditor.js';
import type { WrapOptions } from '../../types.js';

import {
  MEM0_PATH_PREFIX,
  type Mem0AddOptions,
  type Mem0Client,
  type Mem0EntityOptions,
  type Mem0GetAllOptions,
  type Mem0Memory,
  type Mem0SearchOptions,
  type Mem0SearchResult,
  type Mem0UpdateBody,
} from './types.js';

type Mem0Operation = 'view' | 'create' | 'str_replace' | 'delete';

/**
 * Wrap a mem0ai client (cloud `MemoryClient` or OSS `Memory`) so every
 * memory CRUD call produces a tamper-evident audit row in the psy chain.
 *
 * Coverage (v0.3):
 *   - add        : create  (note: mem0 add can dedupe via LLM extraction;
 *                  one call may return N memories with mixed events)
 *   - search     : view
 *   - get        : view
 *   - getAll     : view
 *   - history    : view
 *   - update     : str_replace
 *   - delete     : delete
 *
 * `insert` and `rename` are absent: mem0 has no positional insert (memories
 * are atomic) and no rename (IDs are server-issued UUIDs).
 *
 * Bulk and admin endpoints (`deleteAll`, `batchUpdate`, `batchDelete`,
 * `reset`, `users`, `feedback`, `createMemoryExport`, `getWebhooks`, etc.)
 * pass through unaudited — they are not memory CRUD ops in the canonical
 * sense. Consumers who need them audited can call them and emit explicit
 * events via the lower-level Auditor API.
 *
 * Path scheme:
 *   - Identified ops:  mem0://<scope>/<memoryId>
 *   - add (no id yet): mem0://<scope>/pending  (the id appears in the result)
 *
 * Scope resolves to the first defined of:
 *   userId  → users/<id>
 *   agentId → agents/<id>
 *   runId   → runs/<id>
 *   appId   → apps/<id>
 *   none    → unscoped
 */
export function wrap<T extends Mem0Client>(client: T, options: WrapOptions = {}): T {
  let auditorPromise: Promise<Auditor> | null = null;
  const getAuditor = () => (auditorPromise ??= Auditor.create(options));

  const audited = {
    async add(messages: ReadonlyArray<unknown> | string, opts?: Mem0AddOptions) {
      const auditor = await getAuditor();
      return runAudited<Mem0Memory[] | Mem0SearchResult>(auditor, options, {
        operation: 'create',
        memoryPath: `${MEM0_PATH_PREFIX}${entityScope(opts ?? {})}/pending`,
        run: () => client.add(messages, opts),
      });
    },
    async search(query: string, opts?: Mem0SearchOptions) {
      const auditor = await getAuditor();
      return runAudited<Mem0SearchResult>(auditor, options, {
        operation: 'view',
        memoryPath: `${MEM0_PATH_PREFIX}search/${entityScope(opts ?? {})}`,
        run: () => client.search(query, opts),
      });
    },
    async get(memoryId: string) {
      const auditor = await getAuditor();
      return runAudited<Mem0Memory>(auditor, options, {
        operation: 'view',
        memoryPath: `${MEM0_PATH_PREFIX}memories/${memoryId}`,
        run: () => client.get(memoryId),
      });
    },
    async getAll(opts?: Mem0GetAllOptions) {
      const auditor = await getAuditor();
      return runAudited<Mem0SearchResult | { memories: Mem0Memory[] }>(auditor, options, {
        operation: 'view',
        memoryPath: `${MEM0_PATH_PREFIX}all/${entityScope(opts ?? {})}`,
        run: () => client.getAll(opts),
      });
    },
    async history(memoryId: string) {
      const auditor = await getAuditor();
      return runAudited<unknown>(auditor, options, {
        operation: 'view',
        memoryPath: `${MEM0_PATH_PREFIX}memories/${memoryId}/history`,
        run: () => client.history(memoryId),
      });
    },
    async update(memoryId: string, body: Mem0UpdateBody | string) {
      const auditor = await getAuditor();
      return runAudited<Mem0Memory[] | Mem0Memory>(auditor, options, {
        operation: 'str_replace',
        memoryPath: `${MEM0_PATH_PREFIX}memories/${memoryId}`,
        run: () => client.update(memoryId, body),
      });
    },
    async delete(memoryId: string) {
      const auditor = await getAuditor();
      return runAudited<unknown>(auditor, options, {
        operation: 'delete',
        memoryPath: `${MEM0_PATH_PREFIX}memories/${memoryId}`,
        run: () => client.delete(memoryId),
      });
    },
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop in audited) {
        return (audited as Record<string, unknown>)[prop as string];
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as Function).bind(target) : value;
    },
  }) as T;
}

interface AuditedCall<T> {
  operation: Mem0Operation;
  memoryPath: string;
  run: () => Promise<T>;
}

async function runAudited<T>(auditor: Auditor, options: WrapOptions, call: AuditedCall<T>): Promise<T> {
  const callId = options.callId?.() ?? randomUUID();
  const identityResolution = resolveIdentity(options);
  const identity = identityResolution.identity;

  const base = {
    callId,
    command: call.operation,
    identity,
    memoryPath: call.memoryPath,
    paths: { path: call.memoryPath },
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
  } as const;

  auditor.record({ phase: 'intent', status: 'pending', ...base });

  if (identityResolution.error) {
    auditor.record({
      phase: 'result',
      status: 'validation_error',
      ...base,
      error: summarizeError(identityResolution.error),
    });
    throw identityResolution.error;
  }

  let result: T;
  try {
    result = await call.run();
  } catch (error) {
    auditor.record({
      phase: 'result',
      status: 'error',
      ...base,
      error: summarizeError(error),
    });
    throw error;
  }

  auditor.record({
    phase: 'result',
    status: 'ok',
    ...base,
    result: { kind: 'unknown' },
  });

  return result;
}

function entityScope(opts: Mem0EntityOptions & Record<string, unknown>): string {
  // Codex review [P2]: accept both camelCase (typed SDK option name) and
  // snake_case (raw API field name). Users in practice often pass the
  // snake_case form when constructing options dictionaries from JSON or
  // when copying examples from the upstream HTTP docs. Without this,
  // scoped audits silently fall through to "unscoped".
  const userId = opts.userId ?? opts.user_id;
  const agentId = opts.agentId ?? opts.agent_id;
  const runId = opts.runId ?? opts.run_id;
  const appId = opts.appId ?? opts.app_id;
  if (typeof userId === 'string' && userId.length > 0) return `users/${userId}`;
  if (typeof agentId === 'string' && agentId.length > 0) return `agents/${agentId}`;
  if (typeof runId === 'string' && runId.length > 0) return `runs/${runId}`;
  if (typeof appId === 'string' && appId.length > 0) return `apps/${appId}`;
  return 'unscoped';
}
