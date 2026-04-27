import { describe, expect, it } from 'vitest';

import { defaultRegexRedactor } from '../src/redactor.js';

// Regression: ISSUE-001 — Anthropic API keys (sk-ant-...) were mislabeled as
// [REDACTED-openai-key] because the OpenAI regex (\bsk-[A-Za-z0-9]...) appeared
// before the Anthropic regex in PATTERNS and matched first. Reordering the
// patterns so Anthropic checks before OpenAI fixes the label.
//
// Found by /qa on 2026-04-25
// Report: .gstack/qa-reports/qa-report-psy-2026-04-25.md
describe('redactor regression — Anthropic key labeling', () => {
  it('labels sk-ant-... as anthropic, not openai', async () => {
    const result = await defaultRegexRedactor.redact(
      'use sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa for billing',
    );
    expect(result.redacted).toBe(true);
    expect(result.content).toContain('[REDACTED-anthropic-key]');
    expect(result.content).not.toContain('[REDACTED-openai-key]');
    expect(result.content).not.toContain('sk-ant-');
  });

  it('still labels true OpenAI keys as openai (regression must not break original)', async () => {
    const result = await defaultRegexRedactor.redact(
      'My key is sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 and please use it',
    );
    expect(result.redacted).toBe(true);
    expect(result.content).toContain('[REDACTED-openai-key]');
    expect(result.content).not.toContain('[REDACTED-anthropic-key]');
    expect(result.content).not.toContain('sk-proj-');
  });

  it('handles both keys in the same string with correct labels', async () => {
    const result = await defaultRegexRedactor.redact(
      'anthropic=sk-ant-aaaaaaaaaaaaaaaaaaaa openai=sk-proj-bbbbbbbbbbbbbbbbbbbb',
    );
    expect(result.redacted).toBe(true);
    expect(result.content).toContain('[REDACTED-anthropic-key]');
    expect(result.content).toContain('[REDACTED-openai-key]');
    expect(result.content).not.toContain('sk-ant-');
    expect(result.content).not.toContain('sk-proj-');
  });

  it('labels short anthropic-shaped keys correctly (boundary case)', async () => {
    // Exactly 16 chars after sk-ant- — minimum match length per regex
    const result = await defaultRegexRedactor.redact('use sk-ant-1234567890123456 here');
    expect(result.content).toContain('[REDACTED-anthropic-key]');
  });
});
