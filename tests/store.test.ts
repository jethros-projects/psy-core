import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { verifyStore } from '../src/verify.js';
import { draft, openTempStore } from './helpers.js';

describe('PsyStore', () => {
  it('appends events atomically as a hash chain', async () => {
    const { store } = await openTempStore();
    const first = store.append(draft({ event_id: 'evt-1', operation_id: 'op-1', audit_phase: 'intent' }));
    const second = store.append(draft({ event_id: 'evt-2', operation_id: 'op-1', audit_phase: 'result', tool_output_hash: 'b'.repeat(64) }));

    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(second.prev_hash, first.event_hash);
    assert.equal(verifyStore(store).ok, true);
    store.close();
  });

  it('queries filters and pagination', async () => {
    const { store } = await openTempStore();
    store.append(draft({ event_id: 'evt-1', actor_id: 'alice', operation: 'create' }));
    store.append(draft({ event_id: 'evt-2', operation_id: 'op-2', actor_id: 'bob', operation: 'view' }));

    assert.deepEqual(store.query({ actor: 'alice' }).map((event) => event.event_id), ['evt-1']);
    assert.deepEqual(store.query({ limit: 1, offset: 1 }).map((event) => event.event_id), ['evt-2']);
    store.close();
  });

  it('queries one or more operation names without disturbing pagination order', async () => {
    const { store } = await openTempStore();
    store.append(draft({ event_id: 'evt-1', operation_id: 'op-1', operation: 'create' }));
    store.append(draft({ event_id: 'evt-2', operation_id: 'op-2', operation: 'view' }));
    store.append(draft({ event_id: 'evt-3', operation_id: 'op-3', operation: 'memory.create' }));
    store.append(draft({ event_id: 'evt-4', operation_id: 'op-4', operation: 'delete' }));

    assert.deepEqual(store.query({ operation: 'view' }).map((event) => event.event_id), ['evt-2']);
    assert.deepEqual(
      store.query({ operation: ['create', 'memory.create'], limit: 1, offset: 1 }).map((event) => event.event_id),
      ['evt-3'],
    );
    store.close();
  });

  it('offers intent/result compatibility helpers over the audit row store', async () => {
    const { store } = await openTempStore();
    const intent = store.appendIntent({
      operation: 'memory.create',
      callId: 'call-1',
      payload: { z: 'e\u0301', a: 1 },
      timestamp: '2026-04-25T12:00:00.000Z',
    });
    const result = store.appendResult({
      operation: 'memory.create',
      callId: 'call-1',
      payload: { ok: true },
      timestamp: '2026-04-25T12:00:01.000Z',
    });

    assert.equal(intent.seq, 1);
    assert.equal(result.intentSeq, 1);
    assert.equal(result.prevHash, intent.hash);
    assert.deepEqual(store.tail(10).map((event) => event.seq), [1, 2]);
    store.close();
  });
});
