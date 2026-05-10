import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(read(relativePath)) as T;
}

function capture(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`Missing ${label}`);
  return match[1];
}

describe('release metadata', () => {
  it('keeps root npm package, CLI version, lockfile, and changelog aligned', () => {
    const pkg = readJson<{ version: string; files: string[] }>('package.json');
    const lock = readJson<{ version: string; packages: Record<string, { version?: string }> }>(
      'package-lock.json',
    );
    const cli = read('src/cli.ts');
    const changelog = read('CHANGELOG.md');

    expect(pkg.version).toBe('0.6.0');
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.version).toBe(pkg.version);
    expect(capture(cli, /PSY_CLI_VERSION = '([^']+)'/, 'CLI version')).toBe(pkg.version);
    expect(changelog).toContain(`## [${pkg.version}] - 2026-05-09`);
    expect(changelog).toContain(
      `[Unreleased]: https://github.com/jethros-projects/psy-core/compare/v${pkg.version}...HEAD`,
    );
    expect(pkg.files).toContain('plugins/psy-core-openclaw/DREAM_CATCHER.md');
  });

  it('keeps OpenClaw package metadata, manifest defaults, docs, and tests aligned', () => {
    const rootPkg = readJson<{ version: string }>('package.json');
    const openClawPkg = readJson<{
      version: string;
      files: string[];
      openclaw: { install: { npmSpec: string } };
    }>('plugins/psy-core-openclaw/package.json');
    const manifest = readJson<{ configSchema: { properties: Record<string, { default?: string }> } }>(
      'plugins/psy-core-openclaw/openclaw.plugin.json',
    );
    const config = read('plugins/psy-core-openclaw/src/config.js');
    const readme = read('plugins/psy-core-openclaw/README.md');
    const guide = read('plugins/psy-core-openclaw/AGENT_INSTALL.md');
    const skill = read('plugins/psy-core-openclaw/skills/psy-core-openclaw/SKILL.md');
    const dreamPage = read('plugins/psy-core-openclaw/DREAM_CATCHER.md');

    expect(openClawPkg.version).toBe('0.2.0');
    expect(openClawPkg.openclaw.install.npmSpec).toBe(`psy-core-openclaw@${openClawPkg.version}`);
    expect(openClawPkg.files).toContain('DREAM_CATCHER.md');
    expect(manifest.configSchema.properties.psyCoreVersion.default).toBe(rootPkg.version);
    expect(
      capture(config, /DEFAULT_PSY_CORE_VERSION = "([^"]+)"/, 'OpenClaw default psy-core version'),
    ).toBe(rootPkg.version);
    expect(readme).toContain(`psy-core-openclaw ${openClawPkg.version}`);
    expect(readme).toContain(`psy-core ${rootPkg.version}`);
    expect(guide).toContain(`psy-core@${rootPkg.version}`);
    expect(skill).toContain(`psy-core@${rootPkg.version}`);
    expect(dreamPage).toMatch(/^# Dream Catcher\n/);
    expect(dreamPage).not.toContain('Psy Dream-Catcher');
  });

  it('keeps Hermes PyPI metadata, Node pin, examples, and docs aligned', () => {
    const rootPkg = readJson<{ version: string }>('package.json');
    const pyproject = read('python/psy-core-hermes/pyproject.toml');
    const versionPy = read('python/psy-core-hermes/src/psy_core/hermes/_version.py');
    const readme = read('python/psy-core-hermes/README.md');
    const trustLayer = read('python/psy-core-hermes/src/psy_core/hermes/trust_layer.py');
    const exampleConfig = read('examples/hermes-agent/hermes-config.yaml');

    const hermesVersion = capture(pyproject, /^version = "([^"]+)"/m, 'Hermes pyproject version');
    expect(hermesVersion).toBe('0.2.0');
    expect(capture(versionPy, /PSY_CORE_HERMES_VERSION: str = "([^"]+)"/, 'Hermes version pin')).toBe(
      hermesVersion,
    );
    expect(capture(versionPy, /PSY_CORE_VERSION: str = "([^"]+)"/, 'Hermes psy-core pin')).toBe(
      rootPkg.version,
    );
    expect(readme).toContain(`psy-core-hermes ${hermesVersion}`);
    expect(readme).toContain(`psy-core ${rootPkg.version}`);
    expect(trustLayer).toContain(`psy_core_version: "${rootPkg.version}"`);
    expect(exampleConfig).toContain(`psy_core_version: ${rootPkg.version}`);
  });
});
