import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';

import { runCli } from '../src/cli.js';
import { Sealer, defaultSealPaths } from '../src/seal.js';
import { PsyStore } from '../src/store.js';
import { draft, initProject } from './helpers.js';

class Capture {
  chunks: string[] = [];
  write(chunk: string) {
    this.chunks.push(chunk);
  }
  toString() {
    return this.chunks.join('');
  }
}

describe('CLI', () => {
  it('initializes and verifies an empty store', async () => {
    const cwd = process.cwd();
    const project = await initProject();
    process.chdir(project.cwd);
    try {
      const stdout = new Capture();
      const stderr = new Capture();
      const code = await runCli(['node', 'psy', 'verify', '--no-color'], { stdout, stderr });
      expect(code).toBe(0);
      expect(stdout.toString()).toContain('verification passed');
      expect(stderr.toString()).toBe('');
    } finally {
      process.chdir(cwd);
    }
  });

  it('queries JSON rows with operation filtering through the configured store', async () => {
    const cwd = process.cwd();
    const project = await initProject();
    const store = new PsyStore({
      sqlitePath: project.paths.sqlitePath,
      archivesPath: project.paths.archivesPath,
      config: project.config,
    });
    store.append(draft({ event_id: 'evt-create', operation_id: 'op-create', operation: 'create' }));
    store.append(draft({ event_id: 'evt-legacy-create', operation_id: 'op-legacy-create', operation: 'memory.create' }));
    store.append(draft({ event_id: 'evt-view', operation_id: 'op-view', operation: 'view' }));
    store.close();

    process.chdir(project.cwd);
    try {
      const stdout = new Capture();
      const stderr = new Capture();
      const code = await runCli(['node', 'psy', 'query', '--operation', 'create', '--json', '--no-color'], { stdout, stderr });
      const events = JSON.parse(stdout.toString());

      expect(code).toBe(0);
      expect(stderr.toString()).toBe('');
      expect(events.map((event: { event_id: string }) => event.event_id)).toEqual([
        'evt-create',
        'evt-legacy-create',
      ]);
    } finally {
      process.chdir(cwd);
    }
  });

  it('prints a nightly dream brief for dream and durable memory changes', async () => {
    const cwd = process.cwd();
    const project = await initProject();
    const store = new PsyStore({
      sqlitePath: project.paths.sqlitePath,
      archivesPath: project.paths.archivesPath,
      config: project.config,
    });
    store.append(
      draft({
        event_id: 'evt-dream',
        operation_id: 'dream-catcher-1',
        operation: 'create',
        audit_phase: 'result',
        memory_path: '/memories/DREAMS.md',
        outcome: 'unattributed',
        timestamp: '2026-05-08T07:00:00.000Z',
        tool_output_hash: 'b'.repeat(64),
      }),
    );
    store.append(
      draft({
        event_id: 'evt-memory',
        operation_id: 'memory-promote-1',
        operation: 'str_replace',
        audit_phase: 'result',
        memory_path: '/memories/MEMORY.md',
        timestamp: '2026-05-08T07:05:00.000Z',
        tool_output_hash: 'c'.repeat(64),
      }),
    );
    store.append(
      draft({
        event_id: 'evt-skill',
        operation_id: 'skill-1',
        operation: 'str_replace',
        audit_phase: 'result',
        memory_path: '/skills/demo/SKILL.md',
        timestamp: '2026-05-08T07:10:00.000Z',
        tool_output_hash: 'd'.repeat(64),
      }),
    );
    store.close();

    process.chdir(project.cwd);
    try {
      const stdout = new Capture();
      const stderr = new Capture();
      const code = await runCli(
        ['node', 'psy', 'dream-catcher', '--since', '2026-05-08T00:00:00.000Z'],
        { stdout, stderr },
      );
      const output = stdout.toString();

      expect(code).toBe(0);
      expect(stderr.toString()).toBe('');
      expect(output).toContain('Dream Catcher Brief');
      expect(output).toContain('/memories/DREAMS.md');
      expect(output).toContain('/memories/MEMORY.md');
      expect(output).not.toContain('/skills/demo/SKILL.md');
    } finally {
      process.chdir(cwd);
    }
  });

  it('honors --no-seal as the only way to bypass an unreadable seal key', async () => {
    const cwd = process.cwd();
    const project = await initProject();
    const store = new PsyStore({
      sqlitePath: project.paths.sqlitePath,
      archivesPath: project.paths.archivesPath,
      config: project.config,
    });
    store.append(draft({ event_id: 'evt-1', operation_id: 'op-1', operation: 'create', audit_phase: 'intent' }));
    const tail = store.append(draft({
      event_id: 'evt-2',
      operation_id: 'op-1',
      operation: 'create',
      audit_phase: 'result',
      tool_output_hash: 'b'.repeat(64),
    }));
    const sealPaths = defaultSealPaths(project.paths.sqlitePath);
    Sealer.bootstrap(sealPaths).sealer.writeHead(tail.seq, tail.event_hash, tail.timestamp);
    store.close();
    rmSync(sealPaths.keyPath, { force: true });

    process.chdir(project.cwd);
    try {
      process.exitCode = undefined;
      const noSealOut = new Capture();
      const noSealErr = new Capture();
      const noSealCode = await runCli(['node', 'psy', 'verify', '--no-seal', '--no-color'], {
        stdout: noSealOut,
        stderr: noSealErr,
      });
      expect(noSealCode).toBe(0);
      expect(noSealOut.toString()).toContain('verification passed');

      process.exitCode = undefined;
      const enforcedOut = new Capture();
      const enforcedErr = new Capture();
      const enforcedCode = await runCli(['node', 'psy', 'verify', '--no-color'], {
        stdout: enforcedOut,
        stderr: enforcedErr,
      });
      expect(enforcedCode).toBe(1);
      expect(enforcedOut.toString()).toContain('seal_key_unavailable');
    } finally {
      process.exitCode = undefined;
      process.chdir(cwd);
    }
  });

  it('does not leak a failed command exit code into the next runCli call', async () => {
    const cwd = process.cwd();
    const project = await initProject();
    process.chdir(project.cwd);
    try {
      const failedOut = new Capture();
      const failedErr = new Capture();
      const failed = await runCli(['node', 'psy', 'query', '--limit', '0'], {
        stdout: failedOut,
        stderr: failedErr,
      });
      expect(failed).toBe(1);

      const okOut = new Capture();
      const okErr = new Capture();
      const ok = await runCli(['node', 'psy', 'verify', '--no-color'], {
        stdout: okOut,
        stderr: okErr,
      });
      expect(ok).toBe(0);
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = undefined;
      process.chdir(cwd);
    }
  });
});
