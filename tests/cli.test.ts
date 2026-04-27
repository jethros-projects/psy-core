import { describe, expect, it } from 'vitest';

import { runCli } from '../src/cli.js';
import { initProject } from './helpers.js';

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
});
