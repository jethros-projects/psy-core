import { PsyPathTraversal } from '../../errors.js';
import type { MemoryOperation } from '../../provider.js';

export type { MemoryOperation };

export const MEMORY_ROOT = '/memories';
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function validateMemoryPath(pathValue: string, operation: MemoryOperation): string {
  const path = pathValue.normalize('NFC');

  if (path === MEMORY_ROOT) {
    if (operation === 'view') return path;
    throw new PsyPathTraversal('/memories is view-only', { details: { path } });
  }

  if (path === `${MEMORY_ROOT}/`) {
    throw new PsyPathTraversal('/memories/ is not a valid memory file path', { details: { path } });
  }

  if (path.includes('%')) {
    throw new PsyPathTraversal('Percent-encoded memory paths are rejected in v0.1', {
      details: { path, encoded: true },
    });
  }

  if (path.includes('\\')) {
    throw new PsyPathTraversal('Backslashes are not allowed in memory paths', { details: { path } });
  }

  if (!isAscii(path)) {
    throw new PsyPathTraversal('Only ASCII memory paths are supported in v0.1', { details: { path } });
  }

  if (!path.startsWith(`${MEMORY_ROOT}/`)) {
    throw new PsyPathTraversal('Memory path must start with /memories/', { details: { path } });
  }

  const segments = path.slice(MEMORY_ROOT.length + 1).split('/');
  if (segments.some((segment) => segment.length === 0)) {
    throw new PsyPathTraversal('Empty memory path segments are not allowed', { details: { path } });
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new PsyPathTraversal('Relative memory path segments are not allowed', { details: { path } });
    }
    if (!SEGMENT.test(segment)) {
      throw new PsyPathTraversal('Memory path segment contains unsupported characters', {
        details: { path, segment },
      });
    }
  }

  return path;
}

export function validateMemoryCommandPaths(command: { command: MemoryOperation; path?: string; old_path?: string; new_path?: string }): string {
  if (command.command === 'rename') {
    if (!command.old_path || !command.new_path) {
      throw new PsyPathTraversal('Rename requires old_path and new_path', { details: { command } });
    }
    const oldPath = validateMemoryPath(command.old_path, 'rename');
    const newPath = validateMemoryPath(command.new_path, 'rename');
    return `${oldPath} -> ${newPath}`;
  }

  if (!command.path) {
    throw new PsyPathTraversal('Memory command requires path', { details: { command } });
  }
  return validateMemoryPath(command.path, command.command);
}

function isAscii(value: string): boolean {
  return /^[\x00-\x7F]*$/.test(value);
}
