import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runCli } from '../src/cli.js';

class Capture {
  chunks: string[] = [];
  write(chunk: string) {
    this.chunks.push(chunk);
  }
  toString() {
    return this.chunks.join('');
  }
}

const REPO_ROOT = path.resolve(new URL('../', import.meta.url).pathname);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runIngestSubprocess(cwd: string, lines: string[]): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(
      'npx',
      ['tsx', path.join(REPO_ROOT, 'src/cli.ts'), 'ingest'],
      {
        cwd,
        env: { ...process.env, PSY_AUDIT_DB_PATH: undefined },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });

    const payload = lines.map((line) => `${line}\n`).join('');
    child.stdin.write(payload);
    child.stdin.end();
  });
}

describe('psy ingest CLI subcommand', () => {
  it('initializes a fresh project then accepts an intent + result on stdin', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'psy-cli-ingest-'));
    const stdout = new Capture();
    const stderr = new Capture();
    const initCwd = process.cwd();
    process.chdir(cwd);
    try {
      const initCode = await runCli(['node', 'psy', 'init', '--no-color'], { stdout, stderr });
      expect(initCode).toBe(0);

      const intent = JSON.stringify({
        type: 'intent',
        operation: 'create',
        call_id: 'call-cli-1',
        identity: { actor_id: 'alice', tenant_id: 'acme', session_id: 's1' },
        memory_path: '/memories/MEMORY.md',
        payload: { content: 'hello' },
      });
      const result = JSON.stringify({
        type: 'result',
        operation: 'create',
        call_id: 'call-cli-1',
        identity: { actor_id: 'alice', tenant_id: 'acme', session_id: 's1' },
        memory_path: '/memories/MEMORY.md',
        payload: { ok: true },
      });

      const run = await runIngestSubprocess(cwd, [intent, result]);
      expect(run.code).toBe(0);
      const lines = run.stdout.trim().split('\n');
      // First line is the handshake; then one ACK per envelope.
      expect(lines).toHaveLength(3);
      const startup = JSON.parse(lines[0]!);
      expect(startup.ok).toBe(true);
      expect(typeof startup.version).toBe('string');
      expect(typeof startup.schema_version).toBe('string');
      const ackIntent = JSON.parse(lines[1]!);
      const ackResult = JSON.parse(lines[2]!);
      expect(ackIntent.ok).toBe(true);
      expect(ackIntent.type).toBe('intent');
      expect(ackIntent.seq).toBe(1);
      expect(ackResult.ok).toBe(true);
      expect(ackResult.type).toBe('result');
      expect(ackResult.seq).toBe(2);

      // Verify the chain.
      const verifyOut = new Capture();
      const verifyErr = new Capture();
      const verifyCode = await runCli(['node', 'psy', 'verify', '--no-color'], {
        stdout: verifyOut,
        stderr: verifyErr,
      });
      expect(verifyCode).toBe(0);
      expect(verifyOut.toString()).toContain('verification passed');
    } finally {
      process.chdir(initCwd);
    }
  }, 30_000);
});
