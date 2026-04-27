import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeEventHash, eventHash, genesisHash, isSha256Hex, sha256Hex } from '../src/hash.js';
import { EVENT_MATERIAL_VERSION, type EventHashMaterial } from '../src/store.js';

describe('hash utilities', () => {
  it('computes sha256 and event hashes', () => {
    assert.equal(sha256Hex('psy'), 'ec151eba3295d50ac4bd5d6c3a9a0926a60a816ae7718dc48d29138aa60f8a85');
    assert.match(genesisHash('a'.repeat(64)), /^[a-f0-9]{64}$/u);
    assert.equal(
      computeEventHash({ seq: 1, prev_hash: 'x', event_hash: 'ignored' }),
      computeEventHash({ seq: 1, prev_hash: 'x' }),
    );
  });

  it('chains event hashes through previous hash material', () => {
    const first: EventHashMaterial = {
      version: EVENT_MATERIAL_VERSION,
      seq: 1,
      timestamp: '2026-04-25T12:00:00.000Z',
      phase: 'intent',
      operation: 'memory.create',
      callId: 'call-1',
      intentSeq: null,
      payload: { text: 'remember this' },
      prevHash: genesisHash('nonce'),
      segmentId: 1,
    };
    const firstHash = eventHash(first);
    const secondHash = eventHash({ ...first, seq: 2, phase: 'result', intentSeq: 1, prevHash: firstHash });

    assert.equal(isSha256Hex(firstHash), true);
    assert.equal(isSha256Hex(secondHash), true);
    assert.notEqual(secondHash, firstHash);
  });
});
