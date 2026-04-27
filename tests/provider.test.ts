import { describe, expect, it, beforeEach } from 'vitest';

import {
  CURRENT_AUDIT_SCHEMA_VERSION,
  clearProviders,
  getProvider,
  listProviders,
  registerProvider,
  unregisterProvider,
  type MemoryProvider,
} from '../src/provider.js';
import { PsyConfigInvalid } from '../src/errors.js';

beforeEach(() => {
  clearProviders();
});

function makeStubProvider(overrides: Partial<MemoryProvider<unknown>> = {}): MemoryProvider<unknown> {
  return {
    name: 'stub',
    auditSchemaVersion: '>=1.0 <2',
    compatibleProviderVersions: '>=1.0 <2',
    capabilities: ['view', 'create'],
    memoryPathScheme: 'stub://',
    wrap: (h) => h,
    ...overrides,
  };
}

describe('registerProvider', () => {
  it('registers a provider whose audit-schema range satisfies CURRENT_AUDIT_SCHEMA_VERSION', () => {
    const p = makeStubProvider();
    registerProvider(p);
    expect(getProvider('stub')).toBe(p);
    expect(listProviders()).toHaveLength(1);
  });

  it('rejects when the audit-schema range does not satisfy core', () => {
    expect(() =>
      registerProvider(makeStubProvider({ auditSchemaVersion: '>=2.0 <3' })),
    ).toThrow(PsyConfigInvalid);
  });

  it('rejects malformed version-range strings (auditSchemaVersion)', () => {
    expect(() =>
      registerProvider(makeStubProvider({ auditSchemaVersion: 'not-a-range' })),
    ).toThrow(PsyConfigInvalid);
  });

  it('rejects malformed version-range strings (compatibleProviderVersions)', () => {
    expect(() =>
      registerProvider(makeStubProvider({ compatibleProviderVersions: 'banana' })),
    ).toThrow(PsyConfigInvalid);
  });

  it('rejects empty or non-string names', () => {
    expect(() =>
      registerProvider(makeStubProvider({ name: '' })),
    ).toThrow(PsyConfigInvalid);
    // @ts-expect-error — intentionally bad
    expect(() => registerProvider(makeStubProvider({ name: 123 }))).toThrow(PsyConfigInvalid);
  });

  it('is idempotent when re-registering the same instance', () => {
    const p = makeStubProvider();
    registerProvider(p);
    expect(() => registerProvider(p)).not.toThrow();
    expect(listProviders()).toHaveLength(1);
  });

  it('rejects re-registration of a different instance with the same name', () => {
    const a = makeStubProvider({ name: 'shared' });
    const b = makeStubProvider({ name: 'shared' });
    registerProvider(a);
    expect(() => registerProvider(b)).toThrow(PsyConfigInvalid);
  });

  it('error message names the adapter and the schema mismatch', () => {
    try {
      registerProvider(makeStubProvider({ name: 'far-future', auditSchemaVersion: '>=99 <100' }));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PsyConfigInvalid);
      expect((error as Error).message).toContain('far-future');
      expect((error as Error).message).toContain(CURRENT_AUDIT_SCHEMA_VERSION);
    }
  });
});

describe('registry helpers', () => {
  it('getProvider returns null for unknown names', () => {
    expect(getProvider('does-not-exist')).toBeNull();
  });

  it('listProviders is empty after clearProviders', () => {
    registerProvider(makeStubProvider());
    expect(listProviders()).toHaveLength(1);
    clearProviders();
    expect(listProviders()).toHaveLength(0);
  });

  it('unregisterProvider removes by name and returns true', () => {
    registerProvider(makeStubProvider());
    expect(unregisterProvider('stub')).toBe(true);
    expect(unregisterProvider('stub')).toBe(false);
  });
});

describe('CURRENT_AUDIT_SCHEMA_VERSION', () => {
  it('is a valid semver string that adapter ranges can match against', () => {
    // Sanity check: known patterns satisfy or don't satisfy as expected.
    const provider = makeStubProvider({ auditSchemaVersion: '^1.0.0' });
    expect(() => registerProvider(provider)).not.toThrow();
    clearProviders();

    const wrong = makeStubProvider({ auditSchemaVersion: '^0.5.0' });
    expect(() => registerProvider(wrong)).toThrow(PsyConfigInvalid);
  });
});

// Regression: ISSUE-001 — registry was duplicated across psy-core and
// psy-core/anthropic-memory bundles, so auto-registration in the subpath
// silently wrote to a different Map than the one listProviders() read from.
// Found by /qa on 2026-04-26.
// Report: .gstack/qa-reports/qa-report-psy-2026-04-26.md
describe('cross-bundle registry sharing', () => {
  it('stores REGISTRY on globalThis under Symbol.for so subpath bundles share state', () => {
    const slot = (globalThis as Record<symbol, unknown>)[Symbol.for('psy.provider.registry.v1')];
    expect(slot).toBeInstanceOf(Map);

    const p = makeStubProvider({ name: 'cross-bundle-stub' });
    registerProvider(p);
    expect((slot as Map<string, unknown>).get('cross-bundle-stub')).toBe(p);
  });
});
