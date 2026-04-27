/**
 * psy demo — three-turn customer-support agent
 *
 * A Claude agent answers three messages from the same user:
 *   1. Set a preference  → agent writes to memory
 *   2. Recall it          → agent reads from memory
 *   3. Update it          → agent reads then rewrites memory
 *
 * Each memory operation produces an `intent` row and a `result` row in the
 * psy audit log. Run `psy tail` in another terminal to watch them stream in
 * real time. This is the script the launch GIF is recorded against.
 *
 * Setup:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   npm install
 *   ./node_modules/.bin/psy init        # creates .psy.json + .psy/events.sqlite
 *   ./node_modules/.bin/psy tail        # second terminal
 *   npx tsx examples/claude-agent.ts    # first terminal
 */

import { mkdir, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import Anthropic from '@anthropic-ai/sdk';
import type { Message, TextBlock } from '@anthropic-ai/sdk/resources/messages';
import { betaMemoryTool } from '@anthropic-ai/sdk/helpers/beta/memory';
import { BetaLocalFilesystemMemoryTool } from '@anthropic-ai/sdk/tools/memory/node';

import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/anthropic-memory';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. export ANTHROPIC_API_KEY=sk-ant-... and retry.');
  process.exit(1);
}

// Reset the memory directory so the demo starts from a clean slate.
// In production, memory persists across runs.
await rm('./memory', { recursive: true, force: true });
await mkdir('./memory', { recursive: true });

const client = new Anthropic();
const fsHandlers = await BetaLocalFilesystemMemoryTool.init('./memory');

// Wrap once at app startup. Static config (purpose, default flags) lives here;
// per-request identity flows via runWithContext below.
const memory = betaMemoryTool(
  wrap(fsHandlers, {
    configPath: '.psy.json',
    purpose: 'customer-support',
    allowAnonymous: false,
  }),
);

const SYSTEM = `You are a customer support agent for Acme Corp. You have a persistent memory tool that survives across conversations.

Always:
1. Check memory at /memories/ before answering questions about user preferences or context.
2. Save important user preferences to /memories/ proactively when the user shares them.
3. Update existing memory entries when the user provides new information that contradicts what is stored.

Reply in at most two short sentences.`;

interface TurnArgs {
  userId: string;
  ticketId: string;
  message: string;
  label: string;
}

async function turn({ userId, ticketId, message, label }: TurnArgs): Promise<void> {
  console.log(`\n\x1b[1;36m─── ${label} ───\x1b[0m`);
  console.log(`\x1b[2muser:\x1b[0m ${message}`);

  const result = await runWithContext(
    { actorId: userId, tenantId: 'acme-corp', sessionId: ticketId },
    async () => {
      const runner = client.beta.messages.toolRunner({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        max_iterations: 8,
        system: SYSTEM,
        betas: ['context-management-2025-06-27'],
        tools: [memory],
        messages: [{ role: 'user', content: message }],
      });
      return (await runner.runUntilDone()) as Message;
    },
  );

  const reply = result.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (reply) {
    console.log(`\x1b[2magent:\x1b[0m ${reply}`);
  }

  // Brief pause between turns so the recorded GIF shows psy tail keeping pace.
  await sleep(1500);
}

await turn({
  userId: 'sarah@example.com',
  ticketId: 'ticket-12345',
  message: 'Please remember that I prefer email replies, not phone calls. I am in the EU timezone.',
  label: 'Turn 1 — set preferences',
});

await turn({
  userId: 'sarah@example.com',
  ticketId: 'ticket-12345',
  message: 'What did I tell you about my communication preferences?',
  label: 'Turn 2 — recall',
});

await turn({
  userId: 'sarah@example.com',
  ticketId: 'ticket-12345',
  message: 'Actually update your notes — I just moved to the US Pacific timezone.',
  label: 'Turn 3 — update',
});

console.log('\n\x1b[1;32m✓ demo complete\x1b[0m');
console.log('\x1b[2m  Inspect the audit log:\x1b[0m psy query --actor sarah@example.com');
console.log('\x1b[2m  Verify the chain:     \x1b[0m psy verify --all');
