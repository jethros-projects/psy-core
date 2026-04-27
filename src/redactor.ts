import { PsyRedactorFailed } from './errors.js';

export interface Redactor {
  id: string;
  redact(content: string): Promise<{
    content: string;
    redacted: boolean;
  }>;
}

const PATTERNS: Array<[RegExp, string]> = [
  // Anthropic must come before OpenAI: `sk-ant-...` would otherwise be matched
  // by the broader OpenAI pattern (`sk-...`) and mislabeled.
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED-anthropic-key]'],
  [/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{16,}\b/g, '[REDACTED-openai-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED-aws-access-key]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED-google-key]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED-github-pat]'],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED-github-token]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g, 'Bearer [REDACTED-token]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED-jwt]'],
  [/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED-pem-private-key]'],
  [
    /(["']?(?:api[_-]?key|secret|token|password|authorization)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
    '$1[REDACTED-secret]',
  ],
];

export const defaultRegexRedactor: Redactor = {
  id: 'default-regex-v1',
  async redact(content: string) {
    try {
      let next = content;
      for (const [pattern, replacement] of PATTERNS) {
        next = next.replace(pattern, replacement);
      }
      return { content: next, redacted: next !== content };
    } catch (error) {
      throw new PsyRedactorFailed('Default regex redactor failed', { cause: error });
    }
  },
};
