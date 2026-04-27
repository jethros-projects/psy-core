import { randomUUID } from 'node:crypto';

import { Auditor, resolveIdentity, summarizeError } from '../../auditor.js';
import type { WrapOptions } from '../../types.js';

import {
  LETTA_AGENT_PATH_PREFIX,
  LETTA_GLOBAL_PATH_PREFIX,
  type AgentBlockRetrieveParams,
  type AgentBlockUpdateBody,
  type AgentBlocksResource,
  type AnyBlocksResource,
  type BlockCreateBody,
  type BlockResponse,
  type BlockUpdateBody,
  type BlocksResource,
} from './types.js';

/**
 * Wrap a Letta blocks resource — either the global `client.blocks` or the
 * agent-scoped `client.agents.blocks` — so every read/write produces a
 * tamper-evident audit row in the psy chain.
 *
 * Both surfaces must be wrapped if the consumer uses both, otherwise an agent
 * can mutate a block via the unwrapped path and bypass the audit log. The
 * function discriminates structurally: an agent-scoped resource exposes
 * `attach`, the global one does not.
 */
export function wrap<T extends BlocksResource>(resource: T, options?: WrapOptions): T;
export function wrap<T extends AgentBlocksResource>(resource: T, options?: WrapOptions): T;
export function wrap(resource: AnyBlocksResource, options: WrapOptions = {}): AnyBlocksResource {
  if (typeof (resource as AgentBlocksResource).attach === 'function') {
    return wrapAgentBlocks(resource as AgentBlocksResource, options);
  }
  return wrapBlocks(resource as BlocksResource, options);
}

function wrapBlocks(target: BlocksResource, options: WrapOptions): BlocksResource {
  let auditorPromise: Promise<Auditor> | null = null;
  const getAuditor = () => (auditorPromise ??= Auditor.create(options));

  const audited = {
    async create(body: BlockCreateBody, callOpts?: unknown): Promise<BlockResponse> {
      const auditor = await getAuditor();
      const result = await runAudited<BlockResponse>(auditor, options, {
        operation: 'create',
        memoryPath: globalPathFromCreate(body),
        run: () => target.create(body, callOpts),
      });
      return result;
    },
    async retrieve(blockId: string, callOpts?: unknown): Promise<BlockResponse> {
      const auditor = await getAuditor();
      return runAudited<BlockResponse>(auditor, options, {
        operation: 'view',
        memoryPath: globalPathFromId(blockId),
        run: () => target.retrieve(blockId, callOpts),
      });
    },
    async update(blockId: string, body: BlockUpdateBody, callOpts?: unknown): Promise<BlockResponse> {
      const auditor = await getAuditor();
      return runAudited<BlockResponse>(auditor, options, {
        operation: 'str_replace',
        memoryPath: globalPathFromId(blockId),
        run: () => target.update(blockId, body, callOpts),
      });
    },
    async delete(blockId: string, callOpts?: unknown): Promise<unknown> {
      const auditor = await getAuditor();
      return runAudited<unknown>(auditor, options, {
        operation: 'delete',
        memoryPath: globalPathFromId(blockId),
        run: () => target.delete(blockId, callOpts),
      });
    },
  };

  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop in audited) {
        return audited[prop as keyof typeof audited];
      }
      const value = Reflect.get(t, prop, receiver);
      return typeof value === 'function' ? (value as Function).bind(t) : value;
    },
  }) as BlocksResource;
}

function wrapAgentBlocks(target: AgentBlocksResource, options: WrapOptions): AgentBlocksResource {
  let auditorPromise: Promise<Auditor> | null = null;
  const getAuditor = () => (auditorPromise ??= Auditor.create(options));

  const audited = {
    async retrieve(blockLabel: string, params: AgentBlockRetrieveParams, callOpts?: unknown): Promise<BlockResponse> {
      const auditor = await getAuditor();
      return runAudited<BlockResponse>(auditor, options, {
        operation: 'view',
        memoryPath: agentPath(params.agent_id, blockLabel),
        run: () => target.retrieve(blockLabel, params, callOpts),
      });
    },
    async update(blockLabel: string, body: AgentBlockUpdateBody, callOpts?: unknown): Promise<BlockResponse> {
      const auditor = await getAuditor();
      return runAudited<BlockResponse>(auditor, options, {
        operation: 'str_replace',
        memoryPath: agentPath(body.agent_id, blockLabel),
        run: () => target.update(blockLabel, body, callOpts),
      });
    },
  };

  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop in audited) {
        return audited[prop as keyof typeof audited];
      }
      const value = Reflect.get(t, prop, receiver);
      return typeof value === 'function' ? (value as Function).bind(t) : value;
    },
  }) as AgentBlocksResource;
}

interface AuditedCall<T> {
  operation: 'view' | 'create' | 'str_replace' | 'delete';
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

function globalPathFromId(blockId: string): string {
  return `${LETTA_GLOBAL_PATH_PREFIX}${blockId}`;
}

function globalPathFromCreate(body: BlockCreateBody): string {
  // No id is known until the server responds; use the provided label so the
  // intent row carries a meaningful identifier. The result row records the
  // same path; consumers cross-reference via the call_id.
  return `${LETTA_GLOBAL_PATH_PREFIX}label:${body.label}`;
}

function agentPath(agentId: string, blockLabel: string): string {
  return `${LETTA_AGENT_PATH_PREFIX}${agentId}/blocks/${blockLabel}`;
}
