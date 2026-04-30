import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { PsyConfigInvalid } from './errors.js';

export const CONFIG_FILE = '.psy.json';
export const SCHEMA_VERSION = '1.0.0';

const ConfigSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  sqlite_path: z.string().default('.psy/events.sqlite'),
  archives_path: z.string().default('.psy/archives'),
  payload_capture: z
    .object({
      enabled: z.boolean().default(false),
      max_bytes: z.number().int().positive().default(512),
    })
    .default({ enabled: false, max_bytes: 512 }),
  rotation: z
    .object({
      max_days: z.number().int().positive().default(30),
      max_size_mb: z.number().int().positive().default(1024),
    })
    .default({ max_days: 30, max_size_mb: 1024 }),
  chain_seed: z.object({
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    diagnostic: z
      .object({
        hostname: z.string(),
        platform: z.string(),
        arch: z.string(),
        init_at: z.string(),
      })
      .optional(),
  }),
  redactor: z
    .object({
      id: z.string().default('default-regex-v1'),
    })
    .default({ id: 'default-regex-v1' }),
  /**
   * Whether the sealed head pointer is required for verification to pass.
   *
   * `required` (the v0.2+ default for fresh installs) means `psy verify` must
   * find a valid head pointer with a matching seal key. If both `head.json`
   * and `seal-key` are wiped from `.psy/`, this marker (which lives at the
   * project root, above `.psy/`) preserves the "seal expected" signal so a
   * downgrade attack cannot silently bypass tamper detection.
   *
   * `optional` is for migration cases or when the user has explicitly opted
   * out via `psy init --seal=optional`. `psy verify` only runs the seal
   * check if a head pointer exists.
   */
  seal: z.enum(['required', 'optional']).default('optional'),
});

export type PsyConfig = z.infer<typeof ConfigSchema>;

export interface ConfigPaths {
  projectRoot: string;
  configPath: string;
  sqlitePath: string;
  archivesPath: string;
}

export interface ConfigOptions {
  cwd?: string;
  configPath?: string;
}

export async function initConfig(options: ConfigOptions = {}): Promise<{ config: PsyConfig; paths: ConfigPaths; created: boolean }> {
  const paths = resolveConfigPaths(options, false);
  const existing = existsSync(paths.configPath) ? await readConfig(paths.configPath) : undefined;
  const created = existing === undefined;
  const config = normalizeConfig(existing ?? {});

  await mkdir(path.dirname(paths.configPath), { recursive: true });
  await mkdir(path.dirname(resolvePath(paths.projectRoot, config.sqlite_path)), { recursive: true });
  await mkdir(resolvePath(paths.projectRoot, config.archives_path), { recursive: true });
  await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  return { config, paths: toConfigPaths(paths.projectRoot, paths.configPath, config), created };
}

export async function loadConfig(options: ConfigOptions = {}): Promise<{ config: PsyConfig; paths: ConfigPaths }> {
  const paths = resolveConfigPaths(options, true);
  let raw: string;
  try {
    raw = await readFile(paths.configPath, 'utf8');
  } catch (error) {
    const envSqlitePath = envAuditDbPath(options.cwd);
    if (envSqlitePath) {
      const projectRoot = path.dirname(envSqlitePath);
      const config = normalizeEnvConfig(
        envSqlitePath,
        envArchivesPath(projectRoot, options.cwd) ?? path.join(path.dirname(envSqlitePath), 'archives'),
      );
      return { config, paths: toConfigPaths(projectRoot, path.join(projectRoot, CONFIG_FILE), config) };
    }
    throw new PsyConfigInvalid(`Psy config not found at ${paths.configPath}`, {
      cause: error,
      details: { notFound: true, configPath: paths.configPath },
    });
  }
  const config = normalizeConfig(JSON.parse(raw) as Record<string, unknown>);
  return { config, paths: toConfigPaths(paths.projectRoot, paths.configPath, config) };
}

export function findConfigPath(cwd = process.cwd()): string | null {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveConfigPaths(options: ConfigOptions, mustExist: boolean): { projectRoot: string; configPath: string } {
  if (options.configPath) {
    const configPath = path.resolve(options.cwd ?? process.cwd(), options.configPath);
    return { projectRoot: path.dirname(configPath), configPath };
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const found = findConfigPath(cwd);
  if (found) return { projectRoot: path.dirname(found), configPath: found };
  if (mustExist) return { projectRoot: cwd, configPath: path.join(cwd, CONFIG_FILE) };
  return { projectRoot: cwd, configPath: path.join(cwd, CONFIG_FILE) };
}

function normalizeConfig(input: Record<string, unknown>): PsyConfig {
  const existingSeed = typeof input.chain_seed === 'object' && input.chain_seed !== null ? input.chain_seed : {};
  const nonce = typeof (existingSeed as { nonce?: unknown }).nonce === 'string'
    ? (existingSeed as { nonce: string }).nonce
    : randomBytes(32).toString('hex');

  const candidate = {
    ...input,
    schema_version: input.schema_version ?? SCHEMA_VERSION,
    chain_seed: {
      ...existingSeed,
      nonce,
      diagnostic: (existingSeed as { diagnostic?: unknown }).diagnostic ?? {
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        init_at: new Date().toISOString(),
      },
    },
  };

  const parsed = ConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PsyConfigInvalid('Invalid .psy.json configuration', {
      cause: parsed.error,
      details: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

function normalizeEnvConfig(sqlitePath: string, archivesPath: string): PsyConfig {
  const genesisNonce = readStoredGenesisNonce(sqlitePath);
  return normalizeConfig({
    sqlite_path: sqlitePath,
    archives_path: archivesPath,
    ...(genesisNonce ? { chain_seed: { nonce: genesisNonce } } : {}),
  });
}

async function readConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new PsyConfigInvalid(`Unable to read Psy config at ${configPath}`, {
      cause: error,
      details: { configPath },
    });
  }
}

function toConfigPaths(projectRoot: string, configPath: string, config: PsyConfig): ConfigPaths {
  const sqlitePath = envAuditDbPath(projectRoot) ?? resolvePath(projectRoot, config.sqlite_path);
  return {
    projectRoot,
    configPath,
    sqlitePath,
    archivesPath: envArchivesPath(projectRoot) ?? resolvePath(projectRoot, config.archives_path),
  };
}

function resolvePath(projectRoot: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(projectRoot, value);
}

function envAuditDbPath(cwd = process.cwd()): string | null {
  const raw = process.env.PSY_AUDIT_DB_PATH ?? process.env.PSY_DB_PATH;
  if (!raw) return null;
  return resolvePath(cwd, raw);
}

function envArchivesPath(projectRoot: string, cwd = projectRoot): string | null {
  const raw = process.env.PSY_ARCHIVES_PATH;
  if (!raw) return null;
  return resolvePath(cwd, raw);
}

function readStoredGenesisNonce(sqlitePath: string): string | null {
  if (!existsSync(sqlitePath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'genesis_nonce'").get() as { value?: unknown } | undefined;
    return typeof row?.value === 'string' && /^[a-f0-9]{64}$/u.test(row.value) ? row.value : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
