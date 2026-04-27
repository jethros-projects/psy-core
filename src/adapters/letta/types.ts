/**
 * Structural types for the @letta-ai/letta-client v1.10+ memory-block surface.
 *
 * These are intentionally a duck-typed subset — psy does not import the real
 * Letta SDK at compile time. End users install `@letta-ai/letta-client`
 * themselves (declared as an optional peer dependency) and pass their actual
 * client resources to `wrap`. The structural compatibility check is enough
 * because every Letta version in the supported range exposes the same shape.
 *
 * If a future Letta version reshuffles these methods, the adapter's
 * `compatibleProviderVersions` range (declared on the MemoryProvider) is the
 * place to bump; consumers will get a registration-time error instead of a
 * silent type mismatch.
 */

export interface BlockResponse {
  id: string;
  label: string | null;
  value: string;
  description?: string | null;
  limit?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface BlockCreateBody {
  label: string;
  value: string;
  description?: string;
  limit?: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
  [extra: string]: unknown;
}

export interface BlockUpdateBody {
  label?: string | null;
  value?: string;
  description?: string;
  limit?: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
  [extra: string]: unknown;
}

export interface AgentBlockUpdateBody extends BlockUpdateBody {
  agent_id: string;
}

export interface AgentBlockRetrieveParams {
  agent_id: string;
}

/**
 * The global blocks resource: `client.blocks`. Identifies blocks by id.
 *
 * Wrapped methods only — pagination (`list`) and the agents-by-block
 * sub-namespace (`client.blocks.agents`) pass through the proxy unchanged.
 */
export interface BlocksResource {
  create(body: BlockCreateBody, options?: unknown): Promise<BlockResponse>;
  retrieve(blockId: string, options?: unknown): Promise<BlockResponse>;
  update(blockId: string, body: BlockUpdateBody, options?: unknown): Promise<BlockResponse>;
  delete(blockId: string, options?: unknown): Promise<unknown>;
  [extra: string]: unknown;
}

/**
 * The agent-scoped blocks resource: `client.agents.blocks`. Identifies blocks
 * by label string scoped to an agent_id.
 *
 * The `attach` method is the structural marker that distinguishes this from
 * the global BlocksResource — the wrap() overload uses it to dispatch.
 */
export interface AgentBlocksResource {
  retrieve(blockLabel: string, params: AgentBlockRetrieveParams, options?: unknown): Promise<BlockResponse>;
  update(blockLabel: string, body: AgentBlockUpdateBody, options?: unknown): Promise<BlockResponse>;
  attach(blockId: string, params: { agent_id: string }, options?: unknown): Promise<unknown>;
  detach?(blockId: string, params: { agent_id: string }, options?: unknown): Promise<unknown>;
  [extra: string]: unknown;
}

export type AnyBlocksResource = BlocksResource | AgentBlocksResource;

export const LETTA_GLOBAL_PATH_PREFIX = 'letta://blocks/';
export const LETTA_AGENT_PATH_PREFIX = 'letta://agents/';
