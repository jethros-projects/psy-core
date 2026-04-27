import { describe, expect, it } from 'vitest';

import { PsyPathTraversal } from '../src/errors.js';
import { validateMemoryPath } from '../src/adapters/anthropic-memory/path-guard.js';

describe('memory path guard', () => {
  it('accepts /memories for view only', () => {
    expect(validateMemoryPath('/memories', 'view')).toBe('/memories');
    expect(() => validateMemoryPath('/memories', 'delete')).toThrow(PsyPathTraversal);
  });

  it('accepts safe ASCII child paths', () => {
    expect(validateMemoryPath('/memories/project-1/notes.v1_md', 'create')).toBe('/memories/project-1/notes.v1_md');
  });

  it('rejects traversal, encoding, backslashes, empty segments, spaces, and unicode', () => {
    for (const value of ['/memories/', '/memories//x', '/memories/../x', '/memories/%2e%2e', '/memories\\x', '/memories/with space', '/memories/café']) {
      expect(() => validateMemoryPath(value, 'view')).toThrow(PsyPathTraversal);
    }
  });
});
