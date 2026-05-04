import { describe, expect, it } from 'vitest';

import {
  appendFromEnvelope,
  ingestStartupLine,
  parseIngestLine,
  parseIngestLineOrThrow,
  type IngestEnvelope,
} from '../src/ingest.js';
import { openTempStore } from './helpers.js';

describe('parseIngestLine', () => {
  it('parses a minimal intent envelope', () => {
    const result = parseIngestLine(
      JSON.stringify({ type: 'intent', operation: 'create', call_id: 'call-1' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.envelope.type).toBe('intent');
    expect(result.envelope.call_id).toBe('call-1');
  });

  it('parses a full result envelope with identity, payload, outcome', () => {
    const envelope = parseIngestLineOrThrow(
      JSON.stringify({
        type: 'result',
        operation: 'str_replace',
        call_id: 'call-9',
        timestamp: '2026-04-29T12:00:00.000Z',
        identity: {
          actor_id: 'alice@acme.com',
          tenant_id: 'acme',
          session_id: 'sess-1',
        },
        memory_path: '/memories/MEMORY.md',
        purpose: 'production-debug',
        payload: { content_hash: 'abc' },
        outcome: 'success',
      }),
    );
    expect(envelope.type).toBe('result');
    expect((envelope as Extract<IngestEnvelope, { type: 'result' }>).outcome).toBe('success');
  });

  it('rejects non-JSON input', () => {
    const result = parseIngestLine('not json');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('E_INGEST_BAD_JSON');
  });

  it('rejects empty lines', () => {
    const result = parseIngestLine('');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('E_INGEST_EMPTY_LINE');
  });

  it('rejects unknown envelope types', () => {
    const result = parseIngestLine(JSON.stringify({ type: 'foo', operation: 'x', call_id: 'c' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('E_INGEST_BAD_ENVELOPE');
  });

  it('rejects envelopes missing required fields', () => {
    const result = parseIngestLine(JSON.stringify({ type: 'intent', operation: 'create' }));
    expect(result.ok).toBe(false);
  });

  it('rejects envelopes with unknown extra keys', () => {
    const result = parseIngestLine(
      JSON.stringify({ type: 'intent', operation: 'create', call_id: 'x', extra: true }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('E_INGEST_BAD_ENVELOPE');
  });
});

describe('appendFromEnvelope', () => {
  it('appends a paired intent + result with shared call_id', async () => {
    const { store } = await openTempStore();
    try {
      const intent = await appendFromEnvelope(store, {
        type: 'intent',
        operation: 'create',
        call_id: 'call-pair',
        identity: { actor_id: 'alice', tenant_id: 'acme', session_id: 's1' },
        memory_path: '/memories/MEMORY.md',
        payload: { content: 'first note' },
      });
      const result = await appendFromEnvelope(store, {
        type: 'result',
        operation: 'create',
        call_id: 'call-pair',
        identity: { actor_id: 'alice' },
        memory_path: '/memories/MEMORY.md',
        payload: { ok: true },
      });
      expect(intent.ok).toBe(true);
      expect(result.ok).toBe(true);
      expect(intent.seq).toBe(1);
      expect(result.seq).toBe(2);

      const events = store.query({ actor: 'alice' });
      expect(events).toHaveLength(2);
      expect(events[0]?.audit_phase).toBe('intent');
      expect(events[1]?.audit_phase).toBe('result');
      expect(events[0]?.tenant_id).toBe('acme');
      expect(events[0]?.memory_path).toBe('/memories/MEMORY.md');
    } finally {
      store.close();
    }
  });

  it('redacts string payload fields server-side by default', async () => {
    const { store } = await openTempStore();
    try {
      await appendFromEnvelope(store, {
        type: 'intent',
        operation: 'create',
        call_id: 'call-redact',
        identity: { actor_id: 'bob' },
        memory_path: '/memories/USER.md',
        payload: { secret: 'sk-ant-' + 'A'.repeat(40) },
      });
      const events = store.query({ actor: 'bob' });
      expect(events).toHaveLength(1);
      expect(events[0]?.payload_preview).toContain('REDACTED-anthropic-key');
    } finally {
      store.close();
    }
  });

  it('skips redaction when redact_payload: false', async () => {
    const { store } = await openTempStore();
    try {
      const sentinel = 'sk-ant-' + 'B'.repeat(40);
      await appendFromEnvelope(store, {
        type: 'intent',
        operation: 'create',
        call_id: 'call-noredact',
        identity: { actor_id: 'carol' },
        memory_path: '/memories/USER.md',
        payload: { secret: sentinel },
        redact_payload: false,
      });
      const events = store.query({ actor: 'carol' });
      expect(events[0]?.payload_preview).toContain(sentinel);
    } finally {
      store.close();
    }
  });

  it('reports E_INGEST_APPEND_FAILED when result has no matching intent', async () => {
    const { store } = await openTempStore();
    try {
      const ack = await appendFromEnvelope(store, {
        type: 'result',
        operation: 'create',
        call_id: 'orphan-call',
      });
      expect(ack.ok).toBe(false);
      expect(ack.error?.code).toBe('E_INGEST_APPEND_FAILED');
    } finally {
      store.close();
    }
  });

  it('records unattributed results without requiring a matching intent', async () => {
    const { store } = await openTempStore();
    try {
      const ack = await appendFromEnvelope(store, {
        type: 'result',
        operation: 'create',
        call_id: 'call-unattr',
        identity: { actor_id: 'alice' },
        memory_path: '/memories/MEMORY.md',
        outcome: 'unattributed',
      });
      expect(ack.ok).toBe(true);
      const events = store.query({ actor: 'alice' });
      expect(events).toHaveLength(1);
      expect(events[0]?.outcome).toBe('unattributed');
      expect(events[0]?.audit_phase).toBe('result');
    } finally {
      store.close();
    }
  });
});

describe('ingestStartupLine', () => {
  it('emits a single newline-terminated handshake line', () => {
    const line = ingestStartupLine('0.5.1', '1.0.0');
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.trim());
    expect(parsed).toEqual({ ok: true, version: '0.5.1', schema_version: '1.0.0' });
  });
});
