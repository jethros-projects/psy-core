import { describe, expect, it } from 'vitest';

import { Auditor } from '../src/auditor.js';
import { openTempStore } from './helpers.js';

describe('Auditor', () => {
  it('appends intent/result rows into the shared tamper-evident store', async () => {
    const { store } = await openTempStore();
    const auditor = new Auditor({ store });

    const intent = auditor.record({
      phase: 'intent',
      status: 'pending',
      callId: 'call-1',
      command: 'create',
      identity: { actorId: 'actor-1', tenantId: null, sessionId: null },
      memoryPath: '/memories/a.md',
      paths: { path: '/memories/a.md' },
      payloadPreview: { file_text: 'hello' },
    });
    const result = auditor.record({
      phase: 'result',
      status: 'ok',
      callId: 'call-1',
      command: 'create',
      identity: { actorId: 'actor-1', tenantId: null, sessionId: null },
      memoryPath: '/memories/a.md',
      paths: { path: '/memories/a.md' },
      result: { kind: 'string' },
    });

    expect(intent.prevHash).not.toBe(result.prevHash);
    expect(result.prevHash).toBe(intent.hash);
    expect(auditor.verify()).toMatchObject({ ok: true, checked: 2, issues: [] });
    expect(store.allActiveEvents().map((event) => event.audit_phase)).toEqual(['intent', 'result']);
    store.close();
  });

  it('reports verification issues after tampering', async () => {
    const { store } = await openTempStore();
    const auditor = new Auditor({ store });

    auditor.record({
      phase: 'intent',
      status: 'pending',
      callId: 'call-1',
      command: 'delete',
      identity: { actorId: 'actor-1', tenantId: null, sessionId: null },
      memoryPath: '/memories/a.md',
      paths: { path: '/memories/a.md' },
    });

    store.db.prepare('UPDATE events SET memory_path = ? WHERE seq = 1').run('/memories/tampered.md');

    expect(auditor.verify().ok).toBe(false);
    expect(auditor.verify().issues.some((issue) => issue.message.includes('event_hash'))).toBe(true);
    store.close();
  });

  it('returns stored result, error, paths, and redactor metadata accepted by record', async () => {
    const { store } = await openTempStore();
    const auditor = new Auditor({ store });

    const result = auditor.record({
      phase: 'result',
      status: 'ok',
      callId: 'call-rename',
      command: 'rename',
      identity: { actorId: 'actor-1', tenantId: 'tenant-1', sessionId: null },
      memoryPath: '/memories/old.md',
      paths: { old_path: '/memories/old.md', new_path: '/memories/new.md' },
      result: { kind: 'content_blocks', blockCount: 2 },
      payloadRedacted: true,
      redactorId: 'unit-redactor',
      redactorError: 'partial redaction failure',
    });

    const error = auditor.record({
      phase: 'result',
      status: 'error',
      callId: 'call-delete',
      command: 'delete',
      identity: { actorId: 'actor-1', tenantId: 'tenant-1', sessionId: null },
      memoryPath: '/memories/new.md',
      paths: { path: '/memories/new.md' },
      error: { name: 'TypeError', message: 'delete failed', code: 'E_DELETE' },
    });

    expect(result).toMatchObject({
      paths: { old_path: '/memories/old.md', new_path: '/memories/new.md' },
      result: { kind: 'content_blocks', blockCount: 2 },
      payloadRedacted: true,
      redactorId: 'unit-redactor',
      redactorError: 'partial redaction failure',
    });
    expect(error.error).toEqual({ name: 'TypeError', message: 'delete failed', code: 'E_DELETE' });

    expect(auditor.query({ command: 'rename' })[0]).toMatchObject({
      paths: { old_path: '/memories/old.md', new_path: '/memories/new.md' },
      result: { kind: 'content_blocks', blockCount: 2 },
      payloadRedacted: true,
      redactorId: 'unit-redactor',
      redactorError: 'partial redaction failure',
    });
    expect(auditor.query({ command: 'delete' })[0]?.error).toEqual({
      name: 'TypeError',
      message: 'delete failed',
      code: 'E_DELETE',
    });
    store.close();
  });

  it('keeps payload previews when result metadata needs the compatibility envelope', async () => {
    const { store } = await openTempStore();
    const auditor = new Auditor({ store });

    const event = auditor.record({
      phase: 'result',
      status: 'ok',
      callId: 'call-preview-result',
      command: 'create',
      identity: { actorId: 'actor-1', tenantId: null, sessionId: null },
      memoryPath: '/memories/a.md',
      paths: { path: '/memories/a.md' },
      payloadPreview: { file_text: 'redacted body' },
      result: { kind: 'string' },
    });

    const stored = store.allActiveEvents()[0];
    const payload = stored?.payload_preview ? JSON.parse(stored.payload_preview) : null;

    expect(event).toMatchObject({
      payloadPreview: { file_text: 'redacted body' },
      result: { kind: 'string' },
    });
    expect(payload).toMatchObject({
      file_text: 'redacted body',
      __psy_audit: {
        payloadPreview: { file_text: 'redacted body' },
        result: { kind: 'string' },
      },
    });
    expect(auditor.query({ callId: 'call-preview-result' })[0]).toMatchObject({
      payloadPreview: { file_text: 'redacted body' },
      result: { kind: 'string' },
    });
    store.close();
  });
});
