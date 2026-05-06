import { existsSync, writeFileSync } from 'node:fs';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { draft, openTempStore } from './helpers.js';
import { verifyStore } from '../src/verify.js';

describe('rotation', () => {
  it('archives active rows and continues the hash chain', async () => {
    const { store } = await openTempStore({ rotation: { max_days: 30, max_size_mb: 1 } });
    store.append(draft({ event_id: 'evt-1', operation_id: 'op-1', audit_phase: 'intent' }));
    const head = store.append(draft({ event_id: 'evt-2', operation_id: 'op-1', audit_phase: 'result', tool_output_hash: 'b'.repeat(64) }));

    store.config.rotation.max_size_mb = 0.000001;
    const next = store.append(draft({ event_id: 'evt-3', operation_id: 'op-2', audit_phase: 'intent' }));
    const segment = store.rotationSegments()[0];

    assert.notEqual(segment, undefined);
    assert.equal(existsSync(segment!.archive_path), true);
    assert.equal(next.seq, 3);
    assert.equal(next.prev_hash, head.event_hash);
    assert.equal(verifyStore(store, { includeArchives: true }).ok, false);
    store.append(draft({ event_id: 'evt-4', operation_id: 'op-2', audit_phase: 'result', tool_output_hash: 'c'.repeat(64) }));
    assert.equal(verifyStore(store, { includeArchives: true }).ok, true);
    store.close();
  });

  it('reports unreadable archive payloads as verification issues instead of throwing', async () => {
    const { store } = await openTempStore({ rotation: { max_days: 30, max_size_mb: 1 } });
    try {
      store.append(draft({ event_id: 'evt-archive-1', operation_id: 'op-1', audit_phase: 'intent' }));
      store.append(draft({
        event_id: 'evt-archive-2',
        operation_id: 'op-1',
        audit_phase: 'result',
        tool_output_hash: 'b'.repeat(64),
      }));
      store.rotateActiveSegment({ archivePath: `${store.archivesPath}/bad.jsonl.gz` });
      const segment = store.rotationSegments()[0];
      assert.notEqual(segment, undefined);
      writeFileSync(segment!.archive_path, 'not gzip', 'utf8');

      const result = verifyStore(store, { includeArchives: true });

      assert.equal(result.ok, false);
      assert.equal(result.issues.map((issue) => issue.code).includes('archive_hash_mismatch'), true);
      assert.equal(result.issues.map((issue) => issue.code).includes('archive_decode_failed'), true);
    } finally {
      store.close();
    }
  });
});
