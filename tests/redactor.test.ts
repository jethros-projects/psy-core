import { describe, expect, it } from 'vitest';

import { defaultRegexRedactor } from '../src/redactor.js';

describe('redactor', () => {
  it('redacts common secrets and reports whether content changed', async () => {
    const result = await defaultRegexRedactor.redact('token=abc123456789012345 Bearer abc123456789012345 sk-ant-abcdefghijklmnop');
    expect(result.redacted).toBe(true);
    expect(result.content).not.toContain('abc123456789012345');
  });

  it('leaves ordinary content untouched', async () => {
    await expect(defaultRegexRedactor.redact('normal memory')).resolves.toEqual({
      content: 'normal memory',
      redacted: false,
    });
  });
});
