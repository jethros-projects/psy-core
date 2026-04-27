import { AsyncLocalStorage } from 'node:async_hooks';

export interface PsyContext {
  actorId?: string;
  tenantId?: string;
  sessionId?: string;
}

/**
 * AsyncLocalStorage instance shared across all bundles in the process.
 *
 * Why: tsup builds each subpath entry as an independent bundle, which
 * duplicates `context.ts` once per entry. A naive module-scoped
 * `new AsyncLocalStorage()` would give every subpath its own private ALS
 * instance, so a context set via `psy-core` (`runWithContext(...)`) would
 * be invisible to a wrap imported from `psy-core/letta` or
 * `psy-core/mastra`. The `Symbol.for` key resolves to the same global
 * symbol across realms and bundles, so every copy of this module shares
 * one ALS.
 *
 * Same pattern as the provider registry singleton in src/provider.ts.
 */
const STORAGE_KEY = Symbol.for('psy.context.storage.v1');
const globalSlot = globalThis as Record<symbol, unknown>;
if (!(globalSlot[STORAGE_KEY] instanceof AsyncLocalStorage)) {
  globalSlot[STORAGE_KEY] = new AsyncLocalStorage<PsyContext>();
}
const storage = globalSlot[STORAGE_KEY] as AsyncLocalStorage<PsyContext>;

export function runWithContext<T>(context: PsyContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getCurrentContext(): PsyContext | undefined {
  return storage.getStore();
}

export const maybeGetContext = getCurrentContext;
