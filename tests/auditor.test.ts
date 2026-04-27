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
});
