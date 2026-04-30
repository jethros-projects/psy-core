import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { initConfig, loadConfig } from '../src/config.js';
import { PsyConfigInvalid } from '../src/errors.js';
import { tempProject } from './helpers.js';

describe('config', () => {
  it('creates .psy.json and preserves nonce on re-init', async () => {
    const cwd = await tempProject();
    const first = await initConfig({ cwd });
    const second = await initConfig({ cwd });

    expect(first.config.chain_seed.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(second.config.chain_seed.nonce).toBe(first.config.chain_seed.nonce);
    expect(await readFile(first.paths.configPath, 'utf8')).toContain('"payload_capture"');
  });

  it('loads by walking up from child directories', async () => {
    const cwd = await tempProject();
    await initConfig({ cwd });
    const child = `${cwd}/a/b`;
    await import('node:fs/promises').then((fs) => fs.mkdir(child, { recursive: true }));

    const { paths } = await loadConfig({ cwd: child });
    expect(paths.projectRoot).toBe(cwd);
  });

  it('throws stable config errors', async () => {
    await expect(loadConfig({ cwd: await tempProject() })).rejects.toBeInstanceOf(PsyConfigInvalid);
  });

  it('can load from PSY_AUDIT_DB_PATH without a .psy.json file', async () => {
    const cwd = await tempProject();
    const previousDb = process.env.PSY_AUDIT_DB_PATH;
    const previousArchives = process.env.PSY_ARCHIVES_PATH;
    process.env.PSY_AUDIT_DB_PATH = `${cwd}/hermes/audit.db`;
    process.env.PSY_ARCHIVES_PATH = `${cwd}/hermes/archives`;
    try {
      const { paths } = await loadConfig({ cwd });
      expect(paths.sqlitePath).toBe(`${cwd}/hermes/audit.db`);
      expect(paths.archivesPath).toBe(`${cwd}/hermes/archives`);
    } finally {
      if (previousDb === undefined) delete process.env.PSY_AUDIT_DB_PATH;
      else process.env.PSY_AUDIT_DB_PATH = previousDb;
      if (previousArchives === undefined) delete process.env.PSY_ARCHIVES_PATH;
      else process.env.PSY_ARCHIVES_PATH = previousArchives;
    }
  });
});
