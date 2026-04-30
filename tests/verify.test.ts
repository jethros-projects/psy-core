import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { verifyStore } from '../src/verify.js';
import { draft, openTempStore } from './helpers.js';

describe('verifyStore', () => {
  it('detects tampering and orphaned intents', async () => {
    const { store } = await openTempStore();
    store.append(draft({ event_id: 'evt-1', operation_id: 'op-1', audit_phase: 'intent' }));
    store.append(draft({ event_id: 'evt-2', operation_id: 'op-1', audit_phase: 'result', tool_output_hash: 'b'.repeat(64) }));
    store.db.prepare("UPDATE events SET operation = 'delete' WHERE seq = 2").run();

    const tampered = verifyStore(store);
    assert.equal(tampered.ok, false);
    assert.equal(tampered.issues.map((issue) => issue.code).includes('event_hash_mismatch'), true);

    const { store: orphanStore } = await openTempStore();
    orphanStore.append(draft({ event_id: 'evt-3', operation_id: 'op-orphan', audit_phase: 'intent' }));
    assert.equal(verifyStore(orphanStore).issues.map((issue) => issue.code).includes('orphaned_intent'), true);
    store.close();
    orphanStore.close();
  });

  it('allows explicitly unattributed result rows without paired intents', async () => {
    const { store } = await openTempStore();
    try {
      store.append(draft({
        event_id: 'evt-unattr',
        operation_id: 'manual-edit',
        audit_phase: 'result',
        outcome: 'unattributed',
        tool_output_hash: 'c'.repeat(64),
      }));
      const result = verifyStore(store);
      assert.equal(result.ok, true);
    } finally {
      store.close();
    }
  });
});
