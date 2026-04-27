import { AsyncLocalStorage } from 'node:async_hooks';

import { describe, expect, it } from 'vitest';

import { getCurrentContext, runWithContext } from '../src/context.js';

describe('context', () => {
  it('carries actor, tenant, and session across async boundaries', async () => {
    await runWithContext({ actorId: 'actor', tenantId: 'tenant', sessionId: 'session' }, async () => {
      await Promise.resolve();
      expect(getCurrentContext()).toEqual({ actorId: 'actor', tenantId: 'tenant', sessionId: 'session' });
    });
  });

  // Regression: ISSUE-004 — AsyncLocalStorage was module-scoped, so each tsup
  // subpath bundle had its own ALS instance and contexts set via psy-core
  // never reached wraps imported from psy-core/letta or psy-core/mastra.
  // Found by scripts/bench.sh on 2026-04-26.
  it('stores ALS on globalThis under Symbol.for so subpath bundles share state', () => {
    const slot = (globalThis as Record<symbol, unknown>)[Symbol.for('psy.context.storage.v1')];
    expect(slot).toBeInstanceOf(AsyncLocalStorage);
  });
});
