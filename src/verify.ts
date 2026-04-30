import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { computeEventHash, genesisHash, sha256Hex } from './hash.js';
import { isPsyError, PsyChainBroken } from './errors.js';
import type { Sealer } from './seal.js';
import type { PsyStore } from './store.js';
import { rowToEvent } from './store.js';
import type { AuditEvent, VerifyIssue, VerifyResult } from './types.js';

export interface VerifyStoreOptions {
  includeArchives?: boolean;
  /**
   * Optional sealer. When provided, verify also checks that the on-disk head
   * pointer's HMAC validates AND that its (seq, event_hash) match the DB tail.
   * Detects tail truncation, whole-DB substitution, and HMAC tampering.
   */
  sealer?: Sealer | null;
}

export function verifyStore(store: PsyStore, options: VerifyStoreOptions = {}): VerifyResult {
  const issues: VerifyIssue[] = [];
  const rows = options.includeArchives ? archivedEvents(store, issues).concat(store.allActiveEvents()) : store.allActiveEvents();
  let expectedSeq = 1;
  let expectedPrev = genesisHash(store.config.chain_seed.nonce);
  const meta = store.meta();

  if (meta.genesis_hash && meta.genesis_hash !== genesisHash(meta.genesis_nonce ?? store.config.chain_seed.nonce)) {
    issues.push({ seq: null, event_id: null, operation_id: null, code: 'genesis_mismatch', message: 'Genesis hash does not match genesis nonce' });
  }

  if (!options.includeArchives) {
    const segments = store.rotationSegments();
    const lastSegment = segments.at(-1);
    if (lastSegment) {
      expectedSeq = lastSegment.end_seq + 1;
      expectedPrev = lastSegment.end_hash;
    }
  }

  const seen = new Map<string, { phases: Set<string>; outcomes: Set<string> }>();
  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      issues.push(issue(row, 'seq_gap', `Expected seq ${expectedSeq}, got ${row.seq}`));
      expectedSeq = row.seq;
    }
    if (row.prev_hash !== expectedPrev) {
      issues.push(issue(row, 'prev_hash_mismatch', `Expected prev_hash ${expectedPrev}, got ${row.prev_hash}`));
    }
    const actual = computeEventHash({ ...row, event_hash: undefined });
    if (actual !== row.event_hash) {
      issues.push(issue(row, 'event_hash_mismatch', `Expected event_hash ${actual}, got ${row.event_hash}`));
    }
    const entry = seen.get(row.operation_id) ?? { phases: new Set<string>(), outcomes: new Set<string>() };
    entry.phases.add(row.audit_phase);
    entry.outcomes.add(row.outcome);
    seen.set(row.operation_id, entry);
    expectedSeq = row.seq + 1;
    expectedPrev = row.event_hash;
  }

  for (const [operationId, { phases, outcomes }] of seen) {
    if (phases.has('intent') && !phases.has('result')) {
      issues.push({ seq: null, event_id: null, operation_id: operationId, code: 'orphaned_intent', message: 'Intent row has no matching result row' });
    }
    if (phases.has('result') && !phases.has('intent') && !outcomes.has('unattributed')) {
      issues.push({ seq: null, event_id: null, operation_id: operationId, code: 'result_without_intent', message: 'Result row has no matching intent row' });
    }
  }

  if ((meta.chain_head_hash ?? genesisHash(store.config.chain_seed.nonce)) !== expectedPrev) {
    issues.push({ seq: null, event_id: null, operation_id: null, code: 'meta_head_mismatch', message: 'Meta chain head does not match verified head' });
  }
  if (Number(meta.last_seq ?? 0) !== expectedSeq - 1) {
    issues.push({ seq: null, event_id: null, operation_id: null, code: 'meta_seq_mismatch', message: 'Meta last_seq does not match verified sequence' });
  }

  verifyRotationContinuity(store, issues);
  if (options.sealer) {
    // Pass the tail of the verified row set so includeArchives works:
    // when all rows are rotated out, store.lastEvent() returns null but the
    // sealed head correctly points at the highest archived seq. The walked
    // set is the truth.
    const verifiedTail = rows.length > 0 ? rows[rows.length - 1] ?? null : null;
    verifySeal(options.sealer, verifiedTail, issues);
  }

  return { ok: issues.length === 0, checkedRows: rows.length, issues };
}

/**
 * Verify the sealed head pointer. Adds issues for:
 *   - missing head when rows exist (run `psy init --migrate`)
 *   - HMAC mismatch (key rotated, head tampered, or wrong key supplied)
 *   - seq mismatch (DB truncated or head stale)
 *   - event_hash mismatch (different chain than what was sealed)
 */
function verifySeal(sealer: Sealer, verifiedTail: AuditEvent | null, issues: VerifyIssue[]): void {
  let head;
  try {
    head = sealer.readHead();
  } catch (error) {
    if (isPsyError(error) && error instanceof PsyChainBroken) {
      issues.push({
        seq: null,
        event_id: null,
        operation_id: null,
        code: 'seal_hmac_invalid',
        message: error.message,
      });
      return;
    }
    throw error;
  }

  // Use the verified row set's tail, threaded in by the caller: this is the
  // truth, not the meta cache. Direct-DB tampering may leave meta pointing
  // at a row that no longer exists. When `includeArchives` is on, the tail
  // is the last archived row (if active is empty); when off, it's the last
  // active row. The chain walk already covered meta divergence separately.
  const tailSeq = verifiedTail?.seq ?? 0;
  const tailHash = verifiedTail?.event_hash ?? null;

  if (!head) {
    if (tailSeq > 0) {
      issues.push({
        seq: null,
        event_id: null,
        operation_id: null,
        code: 'seal_missing',
        message: 'No sealed head pointer found despite events in the DB. Run `psy init --migrate` to seal the current tail.',
      });
    }
    return;
  }

  if (head.seq !== tailSeq) {
    issues.push({
      seq: null,
      event_id: null,
      operation_id: null,
      code: 'seal_seq_mismatch',
      message: `Sealed head says seq=${head.seq}, DB tail seq=${tailSeq} — possible truncation`,
    });
  }
  if (head.event_hash !== tailHash) {
    issues.push({
      seq: null,
      event_id: null,
      operation_id: null,
      code: 'seal_hash_mismatch',
      message: `Sealed head event_hash does not match DB tail event_hash`,
    });
  }
}

export function archivedEvents(store: PsyStore, issues: VerifyIssue[] = []): AuditEvent[] {
  const rows: AuditEvent[] = [];
  for (const segment of store.rotationSegments()) {
    const archiveBuffer = readFileSync(segment.archive_path);
    const actualArchiveHash = sha256Hex(archiveBuffer);
    if (segment.archive_sha256 && segment.archive_sha256 !== actualArchiveHash) {
      issues.push({ seq: segment.start_seq, event_id: null, operation_id: null, code: 'archive_hash_mismatch', message: 'Archive SHA-256 does not match rotation segment metadata' });
    }
    const jsonl = gunzipSync(archiveBuffer).toString('utf8');
    const parsed = jsonl
      .split('\n')
      .filter(Boolean)
      .map((line) => rowToEvent(JSON.parse(line)));
    rows.push(...parsed);
  }
  return rows;
}

function verifyRotationContinuity(store: PsyStore, issues: VerifyIssue[]): void {
  let expectedStart = 1;
  let expectedPrev = genesisHash(store.config.chain_seed.nonce);
  for (const segment of store.rotationSegments()) {
    if (segment.start_seq !== expectedStart) {
      issues.push({ seq: segment.start_seq, event_id: null, operation_id: null, code: 'rotation_seq_gap', message: 'Rotation segment sequence is not contiguous' });
    }
    if (segment.start_hash !== expectedPrev) {
      issues.push({ seq: segment.start_seq, event_id: null, operation_id: null, code: 'rotation_hash_gap', message: 'Rotation segment start hash does not match previous head' });
    }
    expectedStart = segment.end_seq + 1;
    expectedPrev = segment.end_hash;
  }

  const active = store.allActiveEvents()[0];
  if (active && active.seq !== expectedStart) {
    issues.push(issue(active, 'active_rotation_seq_gap', `Expected active seq to start at ${expectedStart}`));
  }
  if (active && active.prev_hash !== expectedPrev) {
    issues.push(issue(active, 'active_rotation_hash_gap', 'Active chain does not continue from last rotation segment'));
  }
}

function issue(row: AuditEvent, code: string, message: string): VerifyIssue {
  return { seq: row.seq, event_id: row.event_id, operation_id: row.operation_id, code, message };
}
