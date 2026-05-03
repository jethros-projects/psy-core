import { randomUUID } from 'node:crypto';

import { Auditor, resolveIdentity, summarizeError } from '../../auditor.js';
import { sha256Hex } from '../../hash.js';
import type { AuditIdentityInput, MemoryPathSet, WrapOptions } from '../../types.js';

import {
  GBRAIN_PATH_PREFIX,
  type GBrainAuditClassification,
  type GBrainEngine,
  type GBrainOperation,
  type GBrainOperationContext,
  type GBrainWrapOptions,
} from './types.js';

const SKIP = Symbol('psy-gbrain-skip');

/**
 * Wrap a GBrain operations array while preserving each operation object's shape.
 *
 * This is the best boundary for MCP/CLI-facing GBrain hosts: the wrapper emits one
 * intent/result pair around the operation handler and keeps the original
 * handler's return value and thrown errors unchanged.
 */
export function wrapOperations<T extends readonly GBrainOperation[]>(
  operations: T,
  options: GBrainWrapOptions = {},
): T {
  return operations.map(op => wrapOperation(op, options)) as unknown as T;
}

/** Wrap one GBrain Operation object. */
export function wrapOperation<T extends GBrainOperation>(
  operation: T,
  options: GBrainWrapOptions = {},
): T {
  let auditorPromise: Promise<Auditor> | null = null;
  const getAuditor = () => (auditorPromise ??= Auditor.create(options));

  const original = operation.handler;
  return {
    ...operation,
    async handler(ctx: GBrainOperationContext, params: Record<string, unknown>) {
      const classification = operationClassification(operation, ctx, params, options);
      if (classification === SKIP) {
        return original.call(operation, ctx, params);
      }

      const auditor = await getAuditor();
      const dynamicIdentity =
        options.identityFromOperation?.(operation, ctx, params) ??
        defaultOperationIdentity(ctx);
      const dynamicPurpose =
        options.purposeFromOperation?.(operation, ctx, params) ??
        options.purpose;

      return runAudited(auditor, options, classification, {
        identity: dynamicIdentity,
        purpose: dynamicPurpose,
        run: () => original.call(operation, ctx, params),
      });
    },
  } as T;
}

/**
 * Wrap a GBrain BrainEngine instance.
 *
 * The proxy covers direct engine users and transaction callbacks. When callers
 * use `engine.transaction(async tx => ...)`, the `tx` passed to the callback is
 * also wrapped so page/chunk/link/timeline writes inside the transaction land
 * as granular audit events instead of disappearing behind a single transaction.
 */
export function wrapEngine<T extends GBrainEngine>(engine: T, options: GBrainWrapOptions = {}): T {
  let auditorPromise: Promise<Auditor> | null = null;
  const getAuditor = () => (auditorPromise ??= Auditor.create(options));
  return wrapEngineWithAuditor(engine, options, getAuditor) as T;
}

function wrapEngineWithAuditor<T extends GBrainEngine>(
  engine: T,
  options: GBrainWrapOptions,
  getAuditor: () => Promise<Auditor>,
): T {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;

      const method = String(prop);

      if (method === 'transaction') {
        return async (fn: unknown) => {
          if (typeof fn !== 'function') {
            return (value as Function).call(target, fn);
          }
          return (value as Function).call(target, (tx: GBrainEngine) =>
            (fn as Function)(wrapEngineWithAuditor(tx, options, getAuditor)),
          );
        };
      }

      if (method === 'withReservedConnection') {
        return async (fn: unknown) => {
          if (typeof fn !== 'function') {
            return (value as Function).call(target, fn);
          }
          return (value as Function).call(target, (conn: GBrainEngine) =>
            (fn as Function)(wrapReservedConnection(conn, options, getAuditor)),
          );
        };
      }

      return (...args: unknown[]) => {
        const classification = engineMethodClassification(method, args, target, options);
        if (classification === SKIP) {
          return (value as Function).apply(target, args);
        }

        return (async () => {
          const auditor = await getAuditor();
          const dynamicIdentity = options.identityFromEngine?.(method, args, target);
          const dynamicPurpose = options.purposeFromEngine?.(method, args, target) ?? options.purpose;

          return runAudited(auditor, options, classification, {
            identity: dynamicIdentity,
            purpose: dynamicPurpose,
            run: () => (value as Function).apply(target, args),
          });
        })();
      };
    },
  }) as T;
}

function wrapReservedConnection<T extends GBrainEngine>(
  conn: T,
  options: GBrainWrapOptions,
  getAuditor: () => Promise<Auditor>,
): T {
  return new Proxy(conn, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const method = String(prop);
      if (method !== 'executeRaw') return value.bind(target);

      return async (...args: unknown[]) => {
        const classification = engineMethodClassification('executeRaw', args, target, options);
        if (classification === SKIP) return value.apply(target, args);
        const auditor = await getAuditor();
        return runAudited(auditor, options, classification, {
          identity: options.identityFromEngine?.('executeRaw', args, target),
          purpose: options.purposeFromEngine?.('executeRaw', args, target) ?? options.purpose,
          run: () => value.apply(target, args),
        });
      };
    },
  }) as T;
}

interface AuditedCall<T> {
  identity?: AuditIdentityInput;
  purpose?: string | null;
  run: () => Promise<T>;
}

async function runAudited<T>(
  auditor: Auditor,
  baseOptions: WrapOptions,
  classification: GBrainAuditClassification,
  call: AuditedCall<T>,
): Promise<T> {
  const callId = baseOptions.callId?.() ?? randomUUID();
  const identityResolution = resolveIdentity({
    ...baseOptions,
    ...(call.identity === undefined ? {} : { identity: call.identity }),
  });
  const identity = identityResolution.identity;
  const paths = classification.paths ?? { path: classification.memoryPath };

  const base = {
    callId,
    command: classification.operation,
    identity,
    memoryPath: classification.memoryPath,
    paths,
    ...(call.purpose === undefined || call.purpose === null ? {} : { purpose: call.purpose }),
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

type MaybeClassification = GBrainAuditClassification | typeof SKIP;

function operationClassification(
  operation: GBrainOperation,
  ctx: GBrainOperationContext,
  params: Record<string, unknown>,
  options: GBrainWrapOptions,
): MaybeClassification {
  const override = options.classifyOperation?.(operation, ctx, params);
  if (override === null) return SKIP;
  if (override) return maybeSkipRead(override, operation.scope, options);

  const brainId = brainIdFrom(ctx.brainId, options.brainId);
  const name = operation.name;
  const c = classifyOperationByName(name, params, brainId);
  if (c) return maybeSkipRead(c, operation.scope, options);
  return SKIP;
}

function engineMethodClassification(
  method: string,
  args: unknown[],
  engine: GBrainEngine,
  options: GBrainWrapOptions,
): MaybeClassification {
  const override = options.classifyEngineMethod?.(method, args, engine);
  if (override === null) return SKIP;
  if (override) return maybeSkipRead(override, undefined, options);

  const c = classifyEngineMethodByName(method, args, brainIdFrom(options.brainId));
  if (!c) return SKIP;
  return maybeSkipRead(c, undefined, options);
}

function maybeSkipRead(
  c: GBrainAuditClassification,
  scope: GBrainOperation['scope'] | undefined,
  options: GBrainWrapOptions,
): MaybeClassification {
  if (c.operation !== 'view') return c;
  if (options.auditReads === false) return SKIP;
  if (scope === 'admin' && options.auditAdminReads === false) return SKIP;
  return c;
}

function defaultOperationIdentity(ctx: GBrainOperationContext): AuditIdentityInput | undefined {
  const actorId = typeof ctx.auth?.clientId === 'string' && ctx.auth.clientId.length > 0
    ? ctx.auth.clientId
    : undefined;
  const sessionId =
    typeof ctx.subagentId === 'number'
      ? `gbrain-subagent:${ctx.subagentId}`
      : typeof ctx.jobId === 'number'
        ? `gbrain-job:${ctx.jobId}`
        : undefined;
  if (!actorId && !sessionId) return undefined;
  return { actorId, sessionId };
}

function classifyOperationByName(
  name: string,
  p: Record<string, unknown>,
  brainId: string,
): GBrainAuditClassification | null {
  switch (name) {
    case 'get_page':
      return view(pagePath(brainId, p.slug));
    case 'put_page':
      return replace(pagePath(brainId, p.slug));
    case 'delete_page':
      return del(pagePath(brainId, p.slug));
    case 'list_pages':
      return view(`${brainPath(brainId)}/pages`);
    case 'search':
      return view(`${brainPath(brainId)}/search/keyword/${hashPart(p.query)}`);
    case 'query':
      return view(`${brainPath(brainId)}/search/hybrid/${hashPart(p.query)}`);
    case 'add_tag':
      return insert(tagPath(brainId, p.slug, p.tag));
    case 'remove_tag':
      return del(tagPath(brainId, p.slug, p.tag));
    case 'get_tags':
      return view(`${pagePath(brainId, p.slug)}/tags`);
    case 'add_link':
      return insert(linkPath(brainId, p.from, p.to, p.link_type));
    case 'remove_link':
      return del(linkPath(brainId, p.from, p.to));
    case 'get_links':
      return view(`${pagePath(brainId, p.slug)}/links/out`);
    case 'get_backlinks':
      return view(`${pagePath(brainId, p.slug)}/links/in`);
    case 'traverse_graph':
      return view(`${pagePath(brainId, p.slug)}/graph`);
    case 'add_timeline_entry':
      return insert(`${pagePath(brainId, p.slug)}/timeline/${segment(p.date)}`);
    case 'get_timeline':
      return view(`${pagePath(brainId, p.slug)}/timeline`);
    case 'get_versions':
      return view(`${pagePath(brainId, p.slug)}/versions`);
    case 'revert_version':
      return replace(`${pagePath(brainId, p.slug)}/versions/${segment(p.version_id)}`);
    case 'put_raw_data':
      return replace(`${pagePath(brainId, p.slug)}/raw-data/${segment(p.source)}`);
    case 'get_raw_data':
      return view(`${pagePath(brainId, p.slug)}/raw-data/${segment(p.source ?? 'all')}`);
    case 'resolve_slugs':
      return view(`${brainPath(brainId)}/resolve/${hashPart(p.partial ?? p.slug ?? '')}`);
    case 'get_chunks':
      return view(`${pagePath(brainId, p.slug)}/chunks`);
    case 'find_orphans':
      return view(`${brainPath(brainId)}/orphans`);
    default:
      return null;
  }
}

function classifyEngineMethodByName(
  method: string,
  args: unknown[],
  brainId: string,
): GBrainAuditClassification | null {
  switch (method) {
    // Lifecycle/transaction scaffolding is not memory access by itself.
    case 'connect':
    case 'disconnect':
    case 'initSchema':
    case 'transaction':
    case 'withReservedConnection':
      return null;

    // Pages
    case 'getPage':
      return view(pagePath(brainId, args[0]));
    case 'putPage':
      return replace(pagePath(brainId, args[0]));
    case 'deletePage':
      return del(pagePath(brainId, args[0]));
    case 'listPages':
      return view(`${brainPath(brainId)}/pages`);
    case 'resolveSlugs':
      return view(`${brainPath(brainId)}/resolve/${hashPart(args[0])}`);
    case 'getAllSlugs':
      return view(`${brainPath(brainId)}/pages/slugs`);

    // Search/chunks
    case 'searchKeyword':
      return view(`${brainPath(brainId)}/search/keyword/${hashPart(args[0])}`);
    case 'searchKeywordChunks':
      return view(`${brainPath(brainId)}/search/chunks/${hashPart(args[0])}`);
    case 'searchVector':
      return view(`${brainPath(brainId)}/search/vector`);
    case 'getEmbeddingsByChunkIds':
      return view(`${brainPath(brainId)}/chunks/embeddings`);
    case 'upsertChunks':
      return replace(`${pagePath(brainId, args[0])}/chunks`);
    case 'getChunks':
    case 'getChunksWithEmbeddings':
      return view(`${pagePath(brainId, args[0])}/chunks`);
    case 'countStaleChunks':
      return view(`${brainPath(brainId)}/chunks/stale/count`);
    case 'listStaleChunks':
      return view(`${brainPath(brainId)}/chunks/stale`);
    case 'deleteChunks':
      return del(`${pagePath(brainId, args[0])}/chunks`);

    // Links/graph
    case 'addLink':
      return insert(linkPath(brainId, args[0], args[1], args[3]));
    case 'addLinksBatch':
      return insert(`${brainPath(brainId)}/links/batch`);
    case 'removeLink':
      return del(linkPath(brainId, args[0], args[1], args[2]));
    case 'getLinks':
      return view(`${pagePath(brainId, args[0])}/links/out`);
    case 'getBacklinks':
      return view(`${pagePath(brainId, args[0])}/links/in`);
    case 'findByTitleFuzzy':
      return view(`${brainPath(brainId)}/resolve-title/${hashPart(args[0])}`);
    case 'traverseGraph':
    case 'traversePaths':
      return view(`${pagePath(brainId, args[0])}/graph`);
    case 'getBacklinkCounts':
      return view(`${brainPath(brainId)}/links/backlink-counts`);
    case 'findOrphanPages':
      return view(`${brainPath(brainId)}/orphans`);

    // Tags/timeline
    case 'addTag':
      return insert(tagPath(brainId, args[0], args[1]));
    case 'removeTag':
      return del(tagPath(brainId, args[0], args[1]));
    case 'getTags':
      return view(`${pagePath(brainId, args[0])}/tags`);
    case 'addTimelineEntry':
      return insert(`${pagePath(brainId, args[0])}/timeline/${timelineDate(args[1])}`);
    case 'addTimelineEntriesBatch':
      return insert(`${brainPath(brainId)}/timeline/batch`);
    case 'getTimeline':
      return view(`${pagePath(brainId, args[0])}/timeline`);

    // Raw data
    case 'putRawData':
      return replace(`${pagePath(brainId, args[0])}/raw-data/${segment(args[1])}`);
    case 'getRawData':
      return view(`${pagePath(brainId, args[0])}/raw-data/${segment(args[1] ?? 'all')}`);

    // Versions / graph maintenance
    case 'createVersion':
      return insert(`${pagePath(brainId, args[0])}/versions`);
    case 'getVersions':
      return view(`${pagePath(brainId, args[0])}/versions`);
    case 'revertToVersion':
      return replace(`${pagePath(brainId, args[0])}/versions/${segment(args[1])}`);
    case 'updateSlug': {
      const oldPath = pagePath(brainId, args[0]);
      const newPath = pagePath(brainId, args[1]);
      return { operation: 'rename', memoryPath: oldPath, paths: { old_path: oldPath, new_path: newPath } };
    }
    case 'rewriteLinks':
      return replace(`${brainPath(brainId)}/links/rewrite/${hashPart(`${args[0]}:${args[1]}`)}`);
    default:
      return null;
  }
}

function brainIdFrom(...values: Array<unknown>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return 'host';
}

function brainPath(brainId: string): string {
  return `${GBRAIN_PATH_PREFIX}brains/${segment(brainId)}`;
}

function pagePath(brainId: string, slug: unknown): string {
  return `${brainPath(brainId)}/pages/${slugPath(slug)}`;
}

function tagPath(brainId: string, slug: unknown, tag: unknown): string {
  return `${pagePath(brainId, slug)}/tags/${segment(tag ?? 'unknown')}`;
}

function linkPath(brainId: string, from: unknown, to: unknown, linkType?: unknown): string {
  const type = linkType === undefined || linkType === null || linkType === '' ? 'link' : linkType;
  return `${brainPath(brainId)}/links/${slugPath(from)}/${segment(type)}/${slugPath(to)}`;
}

function slugPath(value: unknown): string {
  const raw = typeof value === 'string' && value.length > 0 ? value : 'unknown';
  return raw.split('/').filter(Boolean).map(segment).join('/') || 'unknown';
}

function segment(value: unknown): string {
  const raw = String(value ?? 'unknown');
  return encodeURIComponent(raw.length > 0 ? raw : 'unknown');
}

function hashPart(value: unknown): string {
  return sha256Hex(String(value ?? '')).slice(0, 16);
}

function timelineDate(entry: unknown): string {
  if (entry && typeof entry === 'object' && 'date' in entry) {
    return segment((entry as { date?: unknown }).date);
  }
  return 'unknown-date';
}

function view(memoryPath: string): GBrainAuditClassification {
  return { operation: 'view', memoryPath };
}

function replace(memoryPath: string): GBrainAuditClassification {
  return { operation: 'str_replace', memoryPath };
}

function insert(memoryPath: string): GBrainAuditClassification {
  return { operation: 'insert', memoryPath };
}

function del(memoryPath: string): GBrainAuditClassification {
  return { operation: 'delete', memoryPath };
}
