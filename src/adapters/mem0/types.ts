/**
 * Structural types for the mem0ai v3.x SDK surface.
 *
 * mem0ai ships two concrete clients in one package:
 *   - `MemoryClient` (cloud) — default export of `mem0ai`
 *   - `Memory` (self-hosted) — `mem0ai/oss` subpath
 *
 * The adapter exposes a single `wrap()` that handles both via overloaded
 * signatures. A cloud client carries `update(id, body)` taking an object
 * and `add(messages, options)` returning `Promise<Memory[]>`; the OSS
 * `Memory` carries `update(id, text: string)` and `add(...)` returning a
 * `SearchResult`-shaped object. The adapter normalizes both into the same
 * audit-row shape.
 *
 * These are intentionally a duck-typed subset — psy does not import
 * `mem0ai` at compile time. Consumers install it themselves (declared as
 * an optional peer dependency).
 *
 * Caveat documented for users: mem0ai's own PostHog telemetry runs
 * regardless of psy. Server-side webhooks (MEMORY_ADDED / MEMORY_UPDATED /
 * MEMORY_DELETED / MEMORY_CATEGORIZED) also fire from the platform. psy's
 * audit log is the cryptographic provenance layer; the others are
 * observability channels.
 */

export interface Mem0Memory {
  id: string;
  memory?: string;
  user_id?: string | null;
  agent_id?: string | null;
  app_id?: string | null;
  run_id?: string | null;
  metadata?: Record<string, unknown> | null;
  categories?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
  /** Cloud `add` returns rows with `event: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP'`. */
  event?: string;
}

export interface Mem0EntityOptions {
  userId?: string;
  agentId?: string;
  appId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface Mem0AddOptions extends Mem0EntityOptions {
  infer?: boolean;
  customCategories?: string[];
  customInstructions?: string;
  timestamp?: string | number;
}

export interface Mem0SearchOptions {
  filters?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  topK?: number;
  threshold?: number;
  rerank?: boolean;
  fields?: string[];
  categories?: string[];
  [extra: string]: unknown;
}

export interface Mem0GetAllOptions extends Mem0EntityOptions {
  filters?: Record<string, unknown>;
  page?: number;
  pageSize?: number;
  startDate?: string;
  endDate?: string;
  categories?: string[];
}

export interface Mem0UpdateBody {
  text?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string | number;
  [extra: string]: unknown;
}

export interface Mem0SearchResult {
  results: Mem0Memory[];
  [extra: string]: unknown;
}

/**
 * Structural shape covering both `MemoryClient` (cloud) and `Memory` (OSS).
 *
 * The wrap dispatches on the runtime presence of `apiKey` / `_captureEvent`
 * vs the absence of a `host` field — both clients work, but cloud requires
 * `apiKey` at construction.
 */
export interface Mem0Client {
  add(
    messages: ReadonlyArray<unknown> | string,
    options?: Mem0AddOptions,
  ): Promise<Mem0Memory[] | Mem0SearchResult>;
  search(query: string, options?: Mem0SearchOptions): Promise<Mem0SearchResult>;
  get(memoryId: string): Promise<Mem0Memory>;
  getAll(options?: Mem0GetAllOptions): Promise<Mem0SearchResult | { memories: Mem0Memory[] }>;
  /**
   * Cloud signature: `update(id, body: object)`. OSS signature:
   * `update(id, body: string)`. The adapter accepts either.
   */
  update(memoryId: string, body: Mem0UpdateBody | string): Promise<Mem0Memory[] | Mem0Memory>;
  delete(memoryId: string): Promise<unknown>;
  history(memoryId: string): Promise<unknown>;
  [extra: string]: unknown;
}

export const MEM0_PATH_PREFIX = 'mem0://';
