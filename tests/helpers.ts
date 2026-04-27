import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { initConfig, loadConfig, type PsyConfig } from '../src/config.js';
import { PsyStore } from '../src/store.js';
import type { DraftAuditEvent } from '../src/types.js';

export async function tempProject(prefix = 'psy-test-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function initProject(overrides: Partial<PsyConfig> = {}) {
  const cwd = await tempProject();
  const initialized = await initConfig({ cwd });
  if (Object.keys(overrides).length > 0) {
    const config = { ...initialized.config, ...overrides };
    await writeFile(initialized.paths.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
  const loaded = await loadConfig({ cwd });
  return { cwd, ...loaded };
}

export async function openTempStore(overrides: Partial<PsyConfig> = {}): Promise<{
  cwd: string;
  store: PsyStore;
  config: PsyConfig;
}> {
  const { cwd, config, paths } = await initProject(overrides);
  return { cwd, config, store: new PsyStore({ sqlitePath: paths.sqlitePath, archivesPath: paths.archivesPath, config }) };
}

export function draft(overrides: Partial<DraftAuditEvent> = {}): DraftAuditEvent {
  return {
    schema_version: '1.0.0',
    event_id: crypto.randomUUID(),
    operation_id: 'op-1',
    timestamp: '2026-04-25T12:00:00.000Z',
    operation: 'create',
    audit_phase: 'intent',
    tool_call_id: null,
    actor_id: 'actor-1',
    tenant_id: null,
    session_id: null,
    memory_path: '/memories/a.md',
    purpose: null,
    payload_preview: null,
    payload_redacted: false,
    redactor_id: null,
    redactor_error: null,
    tool_input_hash: 'a'.repeat(64),
    tool_output_hash: null,
    outcome: 'success',
    error_code: null,
    error_type: null,
    error_message: null,
    policy_result: 'allow',
    ...overrides,
  };
}

export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}
