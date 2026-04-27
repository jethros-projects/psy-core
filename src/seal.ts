import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { canonicalJson } from './canonical.js';
import { PsyChainBroken, PsyConfigInvalid } from './errors.js';

export const HEAD_SCHEMA_VERSION = '1.0.0';
export const SEAL_KEY_BYTES = 32;
export const SEAL_KEY_HEX_LENGTH = 64;
const SEAL_KEY_PATTERN = /^[a-f0-9]{64}$/i;

export interface HeadPointer {
  schema_version: string;
  seq: number;
  event_hash: string;
  timestamp: string;
  hmac: string;
}

export interface SealPaths {
  headPath: string;
  keyPath: string;
}

export interface SealerOptions extends SealPaths {
  envKey?: string | null | undefined;
}

export interface BootstrapResult {
  sealer: Sealer;
  keyCreated: boolean;
}

/**
 * Sealer maintains the HMAC-sealed head pointer that detects tail truncation
 * and whole-DB substitution attacks.
 *
 * Threat model: defends against an attacker who can write to events.sqlite
 * but does NOT have read access to the seal key (PSY_SEAL_KEY env var or the
 * seal-key file). For a full tamper-proof story (key in OS keychain / HSM),
 * see the roadmap — not yet shipped.
 */
export class Sealer {
  private readonly headPath: string;
  private readonly keyPath: string;
  private readonly key: Buffer;

  private constructor(headPath: string, keyPath: string, key: Buffer) {
    this.headPath = headPath;
    this.keyPath = keyPath;
    this.key = key;
  }

  /**
   * Load an existing sealer. Throws PsyConfigInvalid if no seal key is found.
   * Use `bootstrap` to create one if it might not exist.
   */
  static load(opts: SealerOptions): Sealer {
    const key = resolveKey(opts);
    return new Sealer(opts.headPath, opts.keyPath, key);
  }

  /**
   * Load existing sealer or generate a fresh seal key on disk.
   * Used by `psy init`. If `PSY_SEAL_KEY` env var is set, it overrides any
   * file-based key and `keyCreated` is false (env-supplied keys are never
   * persisted).
   */
  static bootstrap(opts: SealerOptions): BootstrapResult {
    const envKey = trimmedEnvKey(opts.envKey);
    if (envKey) {
      validateHexKey(envKey, 'PSY_SEAL_KEY');
      return {
        sealer: new Sealer(opts.headPath, opts.keyPath, Buffer.from(envKey, 'hex')),
        keyCreated: false,
      };
    }
    if (existsSync(opts.keyPath)) {
      return { sealer: Sealer.load(opts), keyCreated: false };
    }
    const key = randomBytes(SEAL_KEY_BYTES);
    mkdirSync(path.dirname(opts.keyPath), { recursive: true });
    writeKeyFile(opts.keyPath, key);
    return { sealer: new Sealer(opts.headPath, opts.keyPath, key), keyCreated: true };
  }

  /** Returns the on-disk paths the sealer is configured for. */
  paths(): SealPaths {
    return { headPath: this.headPath, keyPath: this.keyPath };
  }

  /**
   * Read and validate the head pointer from disk. Returns null if the file
   * does not exist (fresh install or pre-seal v0.1 DB awaiting migration).
   * Throws PsyChainBroken if the file exists but the HMAC does not match.
   */
  readHead(): HeadPointer | null {
    if (!existsSync(this.headPath)) {
      return null;
    }
    let raw: string;
    try {
      raw = readFileSync(this.headPath, 'utf8');
    } catch (error) {
      throw new PsyChainBroken(`Unable to read head pointer at ${this.headPath}`, {
        cause: error,
        details: { headPath: this.headPath },
      });
    }
    const parsed = parseHead(raw, this.headPath);
    this.assertHmac(parsed);
    return parsed;
  }

  /**
   * Sign and atomically write a new head pointer pointing at (seq, eventHash).
   *
   * Monotonic guarantee: refuses to overwrite an existing head whose seq is
   * higher than ours. This prevents the multi-process race where two writers
   * both append (SQLite serializes that part), then race on rename — without
   * this guard the older writer's rename could clobber the newer writer's
   * head pointer. With this guard, the head can only move forward.
   *
   * Returns the head that ended up on disk: either the newly-written one, or
   * the existing head (if it was already at or beyond the requested seq).
   */
  writeHead(seq: number, eventHash: string, timestamp: string = new Date().toISOString()): HeadPointer {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new PsyConfigInvalid(`Sealed head seq must be a non-negative integer, got ${seq}`);
    }
    if (typeof eventHash !== 'string' || eventHash.length === 0) {
      throw new PsyConfigInvalid('Sealed head event_hash must be a non-empty string');
    }
    const existing = this.readHead();
    if (existing) {
      if (existing.seq > seq) {
        // Disk already advanced beyond our request (another writer raced
        // ahead). No-op: the higher head stays. Caller's append still
        // succeeded; the post-commit assertSealMatchesTail on the next op
        // will validate.
        return existing;
      }
      if (existing.seq === seq) {
        // Same seq must mean same chain — a different event_hash at the same
        // seq is a fork or a tampering signal, never an idempotent retry.
        if (existing.event_hash !== eventHash) {
          throw new PsyChainBroken(
            `Sealed head at seq=${seq} already has a different event_hash — possible chain fork or tampering`,
            {
              details: {
                seq,
                existing_event_hash: existing.event_hash,
                attempted_event_hash: eventHash,
              },
            },
          );
        }
        // Same seq, same hash → idempotent no-op. Return existing.
        return existing;
      }
    }
    const payload = {
      schema_version: HEAD_SCHEMA_VERSION,
      seq,
      event_hash: eventHash,
      timestamp,
    };
    const hmac = computeHmac(this.key, payload);
    const head: HeadPointer = { ...payload, hmac };
    atomicWriteJson(this.headPath, head);
    return head;
  }

  /** Throws PsyChainBroken if the head's HMAC does not match the loaded key. */
  assertHmac(head: HeadPointer): void {
    if (head.schema_version !== HEAD_SCHEMA_VERSION) {
      throw new PsyChainBroken(
        `Head pointer schema_version ${head.schema_version} not supported (expected ${HEAD_SCHEMA_VERSION})`,
        { details: { found: head.schema_version, expected: HEAD_SCHEMA_VERSION } },
      );
    }
    const expected = computeHmac(this.key, {
      schema_version: head.schema_version,
      seq: head.seq,
      event_hash: head.event_hash,
      timestamp: head.timestamp,
    });
    const expBuf = Buffer.from(expected, 'hex');
    const actBuf = Buffer.from(head.hmac, 'hex');
    if (expBuf.length !== actBuf.length || !timingSafeEqual(expBuf, actBuf)) {
      throw new PsyChainBroken(
        'Head pointer HMAC does not match seal key — possible tampering or wrong key',
        { details: { headPath: this.headPath } },
      );
    }
  }
}

/**
 * Default seal paths derived from the audit DB location.
 * Co-locates head pointer + seal key in the same directory as events.sqlite.
 */
export function defaultSealPaths(sqlitePath: string): SealPaths {
  const dir = path.dirname(sqlitePath);
  return {
    headPath: path.join(dir, 'head.json'),
    keyPath: path.join(dir, 'seal-key'),
  };
}

function trimmedEnvKey(envKey: string | null | undefined): string | null {
  if (typeof envKey !== 'string') return null;
  const trimmed = envKey.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function validateHexKey(value: string, source: string): void {
  if (!SEAL_KEY_PATTERN.test(value)) {
    throw new PsyConfigInvalid(
      `${source} must be ${SEAL_KEY_HEX_LENGTH} hex characters (${SEAL_KEY_BYTES} bytes), got length ${value.length}`,
    );
  }
}

function resolveKey(opts: SealerOptions): Buffer {
  const envKey = trimmedEnvKey(opts.envKey);
  if (envKey) {
    validateHexKey(envKey, 'PSY_SEAL_KEY');
    return Buffer.from(envKey, 'hex');
  }
  if (!existsSync(opts.keyPath)) {
    throw new PsyConfigInvalid(
      `Seal key not found at ${opts.keyPath}. Run 'psy init' to bootstrap, or set PSY_SEAL_KEY env var.`,
      { details: { keyPath: opts.keyPath, notFound: true } },
    );
  }
  let raw: Buffer;
  try {
    raw = readFileSync(opts.keyPath);
  } catch (error) {
    throw new PsyConfigInvalid(`Unable to read seal key at ${opts.keyPath}`, {
      cause: error,
      details: { keyPath: opts.keyPath },
    });
  }
  const trimmed = raw.toString('utf8').trim();
  if (SEAL_KEY_PATTERN.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  if (raw.length === SEAL_KEY_BYTES) {
    return raw;
  }
  throw new PsyConfigInvalid(
    `Seal key at ${opts.keyPath} is malformed (expected ${SEAL_KEY_BYTES} raw bytes or ${SEAL_KEY_HEX_LENGTH} hex chars)`,
    { details: { keyPath: opts.keyPath, byteLength: raw.length } },
  );
}

function writeKeyFile(keyPath: string, key: Buffer): void {
  const tmp = `${keyPath}.tmp.${process.pid}`;
  // O_CREAT|O_EXCL: atomic exclusive create. If a temp from a crashed prior
  // process exists, openSync will throw EEXIST — we unlink and retry once.
  let fd: number;
  try {
    fd = openSync(tmp, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        unlinkSync(tmp);
      } catch {
        // ignore
      }
      fd = openSync(tmp, 'wx', 0o600);
    } else {
      throw error;
    }
  }
  try {
    const buf = Buffer.from(`${key.toString('hex')}\n`, 'utf8');
    let offset = 0;
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset, null);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Defense-in-depth: ensure mode 0600 even if umask interfered with O_CREAT.
  chmodSync(tmp, 0o600);
  renameSync(tmp, keyPath);
  chmodSync(keyPath, 0o600);
  fsyncDir(path.dirname(keyPath));
}

function fsyncDir(dirPath: string): void {
  // Durably persist a rename: POSIX atomic rename only guarantees the rename
  // ITSELF is indivisible, not that the directory entry is on stable storage.
  // Without this fsync, a power loss after rename can lose the rename.
  // (On Windows this is a no-op since directory fsync isn't required.)
  if (process.platform === 'win32') return;
  let fd: number | undefined;
  try {
    fd = openSync(dirPath, 'r');
    fsyncSync(fd);
  } catch {
    // Some filesystems don't allow fsync on dirs; best-effort.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function computeHmac(
  key: Buffer,
  payload: Pick<HeadPointer, 'schema_version' | 'seq' | 'event_hash' | 'timestamp'>,
): string {
  // Canonical JSON ensures the byte representation is identical across
  // implementations (sorted keys, NFC strings) — required for cross-impl
  // verification compatibility.
  const canonical = canonicalJson(payload);
  return createHmac('sha256', key).update(canonical).digest('hex');
}

function parseHead(raw: string, headPath: string): HeadPointer {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (error) {
    throw new PsyChainBroken(`Head pointer JSON is malformed at ${headPath}`, {
      cause: error,
      details: { headPath },
    });
  }
  if (!isHeadPointer(obj)) {
    throw new PsyChainBroken(`Head pointer schema invalid at ${headPath}`, {
      details: { headPath },
    });
  }
  return obj;
}

function isHeadPointer(obj: unknown): obj is HeadPointer {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.schema_version === 'string' &&
    typeof o.seq === 'number' &&
    Number.isInteger(o.seq) &&
    o.seq >= 0 &&
    typeof o.event_hash === 'string' &&
    o.event_hash.length > 0 &&
    typeof o.timestamp === 'string' &&
    typeof o.hmac === 'string' &&
    o.hmac.length > 0
  );
}

function atomicWriteJson(target: string, obj: unknown): void {
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = `${target}.tmp.${process.pid}`;
  const data = `${JSON.stringify(obj, null, 2)}\n`;
  // Open + writeSync + fsync(fd) + close + rename + fsync(parent_dir).
  // POSIX rename is atomic for the file replacement. The directory fsync
  // ensures the rename itself is durable across power loss; without it, a
  // crash right after rename could resurrect the previous file on some
  // filesystems.
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'w', 0o644);
    const buf = Buffer.from(data, 'utf8');
    let offset = 0;
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset, null);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
    fsyncDir(dir);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // ignore — tmp may not exist if open failed
    }
    throw error;
  }
}
