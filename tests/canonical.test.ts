import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson, canonicalize, normalizeJsonStrings } from '../src/canonical.js';

describe('canonicalJson', () => {
  it('sorts keys and normalizes strings to NFC', () => {
    assert.equal(canonicalJson({ z: 1, a: 'e\u0301' }), '{"a":"é","z":1}');
  });

  it('normalizes object keys recursively', () => {
    assert.deepEqual(normalizeJsonStrings({ 'cafe\u0301': ['e\u0301'] }), { café: ['é'] });
    assert.equal(canonicalize({ nested: { b: 2, a: 1 } }), '{"nested":{"a":1,"b":2}}');
  });

  it('rejects values outside the JSON data model', () => {
    assert.throws(() => canonicalJson({ value: undefined }), /not a JSON value/u);
    assert.throws(() => canonicalJson(Number.NaN), /finite JSON number/u);
  });
});
