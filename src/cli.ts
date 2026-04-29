import { Command, CommanderError, InvalidArgumentError } from 'commander';
import pc from 'picocolors';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

import { canonicalJson } from './canonical.js';
import { initConfig, loadConfig } from './config.js';
import { SCHEMA_VERSION } from './config.js';
import { isPsyError } from './errors.js';
import {
  INGEST_PROTOCOL_VERSION,
  appendFromEnvelope,
  ingestStartupLine,
  parseIngestLine,
} from './ingest.js';
import { Sealer, defaultSealPaths } from './seal.js';
import { PsyStore } from './store.js';
import type { AuditEvent, QueryFilters } from './types.js';
import { verifyStore } from './verify.js';

export const PSY_CLI_VERSION = '0.4.0';

interface IO {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

export function createProgram(io: IO = { stdout: process.stdout, stderr: process.stderr }): Command {
  const program = new Command();
  program.name('psy').description('Tamper-evident memory event log').version(PSY_CLI_VERSION).exitOverride();

  program
    .command('init')
    .option('--migrate', 'seal current DB tail (v0.1 → v0.2 upgrade)')
    .option('--config <path>', 'path to .psy.json')
    .option('--no-color', 'disable color')
    .action(async (opts: { migrate?: boolean; config?: string; color?: boolean }) => {
      const { paths, created } = await initConfig({ configPath: opts.config });
      const { config } = await loadConfig({ configPath: opts.config });
      const store = new PsyStore({ sqlitePath: paths.sqlitePath, archivesPath: paths.archivesPath, config });
      const sealPaths = defaultSealPaths(paths.sqlitePath);
      const { sealer, keyCreated } = Sealer.bootstrap({
        ...sealPaths,
        envKey: process.env.PSY_SEAL_KEY,
      });
      const c = pc.createColors(opts.color !== false);

      const meta = store.meta();
      const tailSeq = Number(meta.last_seq ?? 0);
      const tailHash = meta.chain_head_hash ?? null;
      const existingHead = sealer.readHead();

      if (opts.migrate) {
        if (tailSeq === 0 || !tailHash) {
          io.stdout.write(`${c.yellow('warn')} no events to seal yet; head will be written on first audit event\n`);
        } else {
          sealer.writeHead(tailSeq, tailHash);
          io.stdout.write(`${c.green('ok')} sealed head at seq=${tailSeq}\n`);
          io.stderr.write(
            `${c.dim('note: any pre-migration truncation cannot be detected (no prior witness existed)')}\n`,
          );
        }
      } else if (!existingHead && tailSeq > 0 && tailHash) {
        // Auto-migrate on init when DB has rows but no head exists.
        sealer.writeHead(tailSeq, tailHash);
        io.stderr.write(
          `${c.dim(`note: existing DB had ${tailSeq} events with no seal; sealed current tail (run 'psy init --migrate' to make this explicit)`)}\n`,
        );
      }

      // Fresh v0.2 install or first-time seal: mark seal as required in
      // .psy.json. The marker lives at the project root (above .psy/) so a
      // `rm -rf .psy/` does not silently downgrade verification — verify
      // will fail with seal_missing_required if config says required but
      // head.json is gone. (Wiping .psy.json too is detectable by anything
      // that depends on the config; that threat model is documented.)
      const markRequired = (created || keyCreated) && config.seal !== 'required';
      if (markRequired) {
        const updated = { ...config, seal: 'required' as const };
        writeFileSync(paths.configPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
      }

      store.close();
      // Emit messages in chronological / dependency order: store first, then
      // the seal-key bootstrap, then the config marker. Reading top-to-bottom
      // matches the actual sequence of operations.
      io.stdout.write(`${c.green('ok')} psy store ${created ? 'created' : 'ready'} ${paths.sqlitePath}\n`);
      if (keyCreated) {
        io.stdout.write(`${c.green('ok')} seal key created ${sealPaths.keyPath} (mode 0600)\n`);
      }
      if (markRequired) {
        io.stdout.write(`${c.green('ok')} seal marked required in ${paths.configPath}\n`);
      }
    });

  program
    .command('tail')
    .option('--json', 'emit NDJSON')
    .option('--no-color', 'disable color')
    .option('--once', 'print current rows and exit')
    .action(async (opts: { json?: boolean; color?: boolean; once?: boolean }) => {
      const store = await openStore();
      let lastSeq = 0;
      const print = (events: AuditEvent[]) => {
        for (const event of events) {
          lastSeq = Math.max(lastSeq, event.seq);
          io.stdout.write(opts.json ? `${canonicalJson(event)}\n` : formatEvent(event, opts.color !== false));
        }
      };
      print(store.eventAfter(0, 500));
      if (opts.once || !process.stdout.isTTY) {
        store.close();
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => print(store.eventAfter(lastSeq, 500)), 1000);
        process.once('SIGINT', () => {
          clearInterval(timer);
          store.close();
          resolve();
        });
      });
    });

  program
    .command('query')
    .option('--actor <actor>')
    .option('--tenant <tenant>')
    .option('--session <session>')
    .option('--operation <operation>')
    .option('--since <since>')
    .option('--limit <n>', 'row limit', parsePositiveInteger)
    .option('--offset <n>', 'row offset', parseNonNegativeInteger)
    .option('--json', 'emit JSON')
    .option('--no-color', 'disable color')
    .action(async (opts: QueryFilters & { since?: string; json?: boolean; color?: boolean }) => {
      const store = await openStore();
      const events = store.query({ ...opts, since: opts.since ? parseSince(opts.since) : undefined });
      if (opts.json) io.stdout.write(`${canonicalJson(events)}\n`);
      else if (events.length === 0) io.stdout.write('No events matched.\n');
      else events.forEach((event) => io.stdout.write(formatEvent(event, opts.color !== false)));
      store.close();
    });

  program
    .command('verify')
    .option('--all', 'include rotated archives')
    .option('--no-seal', 'skip the sealed head pointer check')
    .option('--no-color', 'disable color')
    .action(async (opts: { all?: boolean; seal?: boolean; color?: boolean }) => {
      const { store, sqlitePath, config } = await openStoreWithPaths();
      const c = pc.createColors(opts.color !== false);

      let sealer: Sealer | null = null;
      let keyUnavailable = false;
      if (opts.seal !== false) {
        const loaded = loadSealerForStore(sqlitePath);
        sealer = loaded.sealer;
        keyUnavailable = loaded.keyUnavailable;
      }

      const result = verifyStore(store, { includeArchives: opts.all, sealer });

      // Downgrade-attack defense: if .psy.json says seal is required (set by
      // `psy init` on fresh v0.2 installs) but neither sealer nor key are
      // available, the head pointer was wiped. Fail loudly. The marker lives
      // at the project root and survives `rm -rf .psy/`; an attacker would
      // need to also wipe .psy.json itself to bypass this.
      if (opts.seal !== false && config.seal === 'required' && !sealer && !keyUnavailable) {
        result.issues.push({
          seq: null,
          event_id: null,
          operation_id: null,
          code: 'seal_missing_required',
          message: 'Config marks seal as required but no head pointer was found. Possible downgrade attack. Run `psy init --migrate` to re-seal the current tail (and investigate why .psy/head.json was removed).',
        });
        result.ok = false;
      }

      // If a head pointer exists but the key is unreadable, verification
      // cannot proceed. Treat as a failure so an env-key-only deployment that
      // forgets to set PSY_SEAL_KEY does not silently pass.
      if (keyUnavailable) {
        result.issues.push({
          seq: null,
          event_id: null,
          operation_id: null,
          code: 'seal_key_unavailable',
          message: 'Head pointer exists but seal key cannot be read. Set PSY_SEAL_KEY or check .psy/seal-key permissions, or pass --no-seal to skip explicitly.',
        });
        result.ok = false;
      }

      if (result.ok) {
        io.stdout.write(`${c.green('ok')} verification passed checked=${result.checkedRows}\n`);
      } else {
        io.stdout.write(`${c.red('error')} verification failed checked=${result.checkedRows}\n`);
        for (const issue of result.issues) {
          io.stdout.write(`  ${issue.seq ?? issue.operation_id ?? 'meta'} ${issue.code}: ${issue.message}\n`);
        }
        process.exitCode = 1;
      }
      store.close();
    });

  program
    .command('export')
    .requiredOption('--format <format>', 'export format: jsonl')
    .action(async (opts: { format: string }) => {
      if (opts.format !== 'jsonl') throw new InvalidArgumentError('format must be jsonl');
      const store = await openStore();
      for (const event of store.allActiveEvents()) io.stdout.write(`${canonicalJson(event)}\n`);
      store.close();
    });

  program
    .command('ingest')
    .description('append audit events from JSONL on stdin (used by language-side observer adapters)')
    .option('--no-redact', 'skip server-side payload redaction (still redacted upstream by adapter)')
    .option('--no-startup', 'suppress the protocol-handshake startup line')
    .option('--no-seal', 'skip HMAC seal updates (debugging only — leaves tail unsealed)')
    .action(async (opts: { redact?: boolean; startup?: boolean; seal?: boolean }) => {
      const { store, sqlitePath } = await openStoreWithPaths();
      let sealer: Sealer | null = null;
      if (opts.seal !== false && sqlitePath !== ':memory:') {
        const sealPaths = defaultSealPaths(sqlitePath);
        sealer = Sealer.bootstrap({ ...sealPaths, envKey: process.env.PSY_SEAL_KEY }).sealer;
      }
      try {
        if (opts.startup !== false) {
          io.stdout.write(ingestStartupLine(PSY_CLI_VERSION, SCHEMA_VERSION));
        }
        const rl = readline.createInterface({ input: process.stdin, terminal: false });
        for await (const rawLine of rl) {
          if (rawLine.length === 0) continue;
          const parsed = parseIngestLine(rawLine);
          if (!parsed.ok) {
            io.stdout.write(`${JSON.stringify({ ok: false, error: parsed.error })}\n`);
            continue;
          }
          const ack = await appendFromEnvelope(store, parsed.envelope, {
            redactor: opts.redact === false ? null : undefined,
            sealer,
          });
          io.stdout.write(`${JSON.stringify(ack)}\n`);
        }
      } finally {
        store.close();
      }
    });

  return program;
}

export async function runCli(argv = process.argv, io?: IO): Promise<number> {
  try {
    await createProgram(io).parseAsync(argv, { from: 'node' });
    const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
    return exitCode > 0 ? exitCode : 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    const stderr = io?.stderr ?? process.stderr;
    stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    if (isPsyError(error)) {
      if (error.code === 'E_CONFIG_INVALID' || error.code === 'E_CONFIG_NOT_FOUND') return 2;
      if (error.code === 'E_AUDIT_TIMEOUT') return 3;
      if (error.code === 'E_CHAIN_BROKEN') return 1;
    }
    return 1;
  }
}

async function openStore(): Promise<PsyStore> {
  return (await openStoreWithPaths()).store;
}

async function openStoreWithPaths(): Promise<{ store: PsyStore; sqlitePath: string; config: import('./config.js').PsyConfig }> {
  const { config, paths } = await loadConfig();
  const store = new PsyStore({ sqlitePath: paths.sqlitePath, archivesPath: paths.archivesPath, config });
  return { store, sqlitePath: paths.sqlitePath, config };
}

interface LoadedSealer {
  sealer: Sealer | null;
  /** Set when a head pointer exists on disk but no key is available — verify must fail. */
  keyUnavailable: boolean;
}

function loadSealerForStore(sqlitePath: string): LoadedSealer {
  if (!sqlitePath) return { sealer: null, keyUnavailable: false };
  const sealPaths = defaultSealPaths(sqlitePath);
  try {
    return {
      sealer: Sealer.load({
        ...sealPaths,
        envKey: process.env.PSY_SEAL_KEY,
      }),
      keyUnavailable: false,
    };
  } catch {
    // Differentiate: head.json exists but key is missing → verification can't
    // proceed and must fail loudly. Otherwise (no head + no key), assume a
    // pre-v0.2 install or env-only deployment with seal disabled this run.
    return { sealer: null, keyUnavailable: existsSync(sealPaths.headPath) };
  }
}

function formatEvent(event: AuditEvent, color: boolean): string {
  const c = pc.createColors(color);
  return [
    c.dim(event.timestamp),
    c.cyan(`#${event.seq}`),
    event.audit_phase,
    event.outcome === 'success' ? c.green(event.outcome) : c.yellow(event.outcome),
    event.actor_id ? `actor=${event.actor_id}` : null,
    event.tenant_id ? `tenant=${event.tenant_id}` : null,
    c.bold(event.operation),
    event.memory_path,
    c.dim(event.event_hash.slice(0, 12)),
  ]
    .filter(Boolean)
    .join(' ') + '\n';
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError('must be a positive integer');
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new InvalidArgumentError('must be a non-negative integer');
  return parsed;
}

function parseSince(value: string): Date {
  const relative = /^(\d+)([dhm])$/.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const multiplier = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
    return new Date(Date.now() - amount * multiplier);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new InvalidArgumentError('since must be ISO timestamp or duration like 7d');
  return date;
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
}

if (isDirectRun()) {
  void runCli(process.argv).then((code) => {
    process.exitCode = code;
  });
}
