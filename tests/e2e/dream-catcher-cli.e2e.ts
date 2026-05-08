import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const psyCli = path.join(repoRoot, 'dist', 'cli.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runPsy(cwd: string, args: string[], input = ''): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [psyCli, ...args], {
      cwd,
      env: {
        ...process.env,
        PSY_AUDIT_DB_PATH: undefined,
        PSY_DB_PATH: undefined,
        PSY_ARCHIVES_PATH: undefined,
        PSY_SEAL_KEY_PATH: undefined,
        PSY_HEAD_PATH: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.stdin.end(input);
  });
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('built psy dream-catcher CLI E2E', () => {
  it('summarizes ingested dream artifacts and durable memory promotions', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'psy-dream-catcher-e2e-'));
    const init = await runPsy(cwd, ['init', '--no-color']);
    expect(init.code, init.stderr).toBe(0);

    const ingestInput = [
      {
        type: 'result',
        operation: 'create',
        call_id: 'dream-catcher-e2e-1',
        timestamp: '2026-05-08T07:00:00.000Z',
        identity: { actor_id: 'openclaw-e2e' },
        memory_path: '/memories/DREAMS.md',
        source: 'psy-core-openclaw-dream-catcher',
        outcome: 'unattributed',
        payload: {
          target: { relativePath: 'DREAMS.md' },
          content_hash: 'a'.repeat(64),
        },
        redact_payload: true,
      },
      {
        type: 'intent',
        operation: 'str_replace',
        call_id: 'memory-promotion-e2e-1',
        timestamp: '2026-05-08T07:05:00.000Z',
        identity: { actor_id: 'openclaw-e2e', session_id: 'agent:main:nightly' },
        memory_path: '/memories/MEMORY.md',
      },
      {
        type: 'result',
        operation: 'str_replace',
        call_id: 'memory-promotion-e2e-1',
        timestamp: '2026-05-08T07:05:05.000Z',
        identity: { actor_id: 'openclaw-e2e', session_id: 'agent:main:nightly' },
        memory_path: '/memories/MEMORY.md',
      },
      {
        type: 'result',
        operation: 'str_replace',
        call_id: 'skill-noise-e2e-1',
        timestamp: '2026-05-08T07:10:00.000Z',
        identity: { actor_id: 'openclaw-e2e' },
        memory_path: '/skills/noise/SKILL.md',
        outcome: 'unattributed',
      },
      {
        type: 'result',
        operation: 'create',
        call_id: 'old-dream-e2e-1',
        timestamp: '2026-05-01T07:00:00.000Z',
        identity: { actor_id: 'openclaw-e2e' },
        memory_path: '/memories/dreaming/old.md',
        outcome: 'unattributed',
      },
    ].map(jsonLine).join('');

    const ingest = await runPsy(cwd, ['ingest'], ingestInput);
    expect(ingest.code, ingest.stderr).toBe(0);
    const acks = ingest.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(acks).toHaveLength(6);
    expect(acks.slice(1).every((ack: { ok?: unknown }) => ack.ok === true)).toBe(true);

    const jsonReport = await runPsy(cwd, [
      'dream-catcher',
      '--since',
      '2026-05-08T00:00:00.000Z',
      '--json',
    ]);
    expect(jsonReport.code, jsonReport.stderr).toBe(0);
    const report = JSON.parse(jsonReport.stdout) as {
      counts: { dream_changes: number; durable_memory_changes: number; total: number };
      dream_changes: Array<{ memory_path: string; outcome: string }>;
      durable_memory_changes: Array<{ memory_path: string; session_id: string | null }>;
    };
    expect(report.counts).toEqual({
      dream_changes: 1,
      durable_memory_changes: 1,
      total: 2,
    });
    expect(report.dream_changes).toMatchObject([
      { memory_path: '/memories/DREAMS.md', outcome: 'unattributed' },
    ]);
    expect(report.durable_memory_changes).toMatchObject([
      { memory_path: '/memories/MEMORY.md', session_id: 'agent:main:nightly' },
    ]);

    const textReport = await runPsy(cwd, ['dream-catcher', '--since', '2026-05-08T00:00:00.000Z']);
    expect(textReport.code, textReport.stderr).toBe(0);
    expect(textReport.stdout).toContain('Dream Catcher Report');
    expect(textReport.stdout).toContain('/memories/DREAMS.md');
    expect(textReport.stdout).toContain('/memories/MEMORY.md');
    expect(textReport.stdout).not.toContain('/skills/noise/SKILL.md');
    expect(textReport.stdout).not.toContain('/memories/dreaming/old.md');

    const verify = await runPsy(cwd, ['verify', '--all', '--no-color']);
    expect(verify.code, verify.stderr).toBe(0);
    expect(verify.stdout).toContain('verification passed');
  }, 30_000);
});
