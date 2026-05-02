# psy

> Tamper-evident memory audit logs for AI agents.
> See what your agent remembered — and why.

[![npm version](https://img.shields.io/npm/v/psy-core.svg?color=cb3837)](https://www.npmjs.com/package/psy-core)
[![npm downloads](https://img.shields.io/npm/dm/psy-core.svg)](https://www.npmjs.com/package/psy-core)
[![license](https://img.shields.io/npm/l/psy-core.svg)](https://github.com/jethros-projects/psy-core/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/psy-core.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)

`psy-core` wraps the memory APIs of six leading AI agent frameworks and writes every read, write, and update into a **hash-chained, HMAC-sealed SQLite log on disk**. Inspect with `psy tail`, query with `psy query`, verify chain integrity with `psy verify`. One install, drop-in wrappers, zero application code changes.

## Install

```bash
npm install psy-core
npx psy init     # creates .psy.json + .psy/events.sqlite + sealed key
```

Then install the SDK for the framework you use, and import the matching adapter subpath ([table below](#supported-memory-frameworks)).

## Quickstart — Anthropic Memory Tool

```bash
npm install @anthropic-ai/sdk
```

```ts
import { betaMemoryTool } from '@anthropic-ai/sdk/helpers/beta/memory';
import { BetaLocalFilesystemMemoryTool } from '@anthropic-ai/sdk/tools/memory/node';
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/anthropic-memory';

const fsHandlers = await BetaLocalFilesystemMemoryTool.init('./memory');
const memory = betaMemoryTool(wrap(fsHandlers, { actorId: 'support-agent' }));

await runWithContext({ actorId: 'user_123', tenantId: 'acme' }, async () => {
  // call Anthropic with `tools: [memory]`
});
```

In another terminal, watch the audit trail in real time:

```bash
psy tail                          # live-stream every memory op
psy query --actor user_123        # filter by identity
psy verify --all                  # check chain integrity
```

## Supported memory frameworks

| Framework | Subpath import | Audited operations |
|---|---|---|
| **Anthropic Memory Tool** | `psy-core/anthropic-memory` | view, create, str_replace, insert, delete, rename |
| **Letta** blocks | `psy-core/letta` | view, create, str_replace, delete |
| **Mastra** | `psy-core/mastra` | view, create, str_replace, delete |
| **Mem0** | `psy-core/mem0` | view, create, str_replace, delete |
| **LangChain** chat history | `psy-core/langchain` | view, insert, delete |
| **LangGraph** checkpoints | `psy-core/langgraph` | view, create, insert, delete |
| **Hermes Agent** memory + skills | `pip install psy-core-hermes` | create, str_replace, delete (MEMORY.md, USER.md, skills) |
| **OpenClaw** memory + skills | local plugin: `plugins/psy-core-openclaw` | view, create, str_replace, delete (MEMORY.md, USER.md, memory/**, DREAMS.md, skills, skill_workshop, memory-lancedb, memory-wiki) |

Per-framework setup examples are [further down](#per-framework-setup). Hermes Agent runs in a separate Python process; see [`python/psy-core-hermes/README.md`](python/psy-core-hermes/README.md) and [`examples/hermes-agent/`](examples/hermes-agent/). The local OpenClaw plugin is documented in [`plugins/psy-core-openclaw/README.md`](plugins/psy-core-openclaw/README.md).

## What you get

- **Hash-chained SQLite log.** Every memory op writes a paired `intent` + `result` row. Each row is hashed; each hash chains to the previous. Rotates at 1 GB or 30 days into archived JSONL.
- **HMAC-sealed tail.** The last `(seq, hash, ts)` is signed with a per-deployment key (`.psy/seal-key`, mode 0600). Tail truncation is detectable.
- **Two-phase audit.** `intent` is written *before* the handler runs; `result` *after*. Failed handlers, anonymous calls, redactor errors, and timeouts all record explicit outcome states.
- **Identity propagation.** `actorId` / `tenantId` / `sessionId` flow through async boundaries via `AsyncLocalStorage`. Per-request identity without threading args through every call.
- **Secret redaction.** OpenAI, Anthropic, AWS, Google, GitHub, Bearer, JWT, and PEM patterns are redacted from payload previews by default. Pluggable redactor interface for custom rules.
- **Provider discovery.** `listProviders()` enumerates which adapters are wired, with declared capabilities and schema versions. Schema mismatches fail loud at registration time.

## CLI

```bash
psy init                    # idempotent project setup
psy tail                    # live colorized stream of memory writes
psy tail --json             # NDJSON for piping into jq / log shippers
psy query --actor user_123 --since 2026-04-25T00:00:00Z --limit 100
psy verify --all            # full chain integrity check + sealed-tail verify
psy verify --no-seal        # skip seal check (debugging only)
psy export --format jsonl   # canonical NDJSON dump of the active log
psy ingest                  # append events from JSONL on stdin (used by language-side observers)
```

All commands respect `PSY_AUDIT_DB_PATH` (default `.psy/events.sqlite`) and the project's `.psy.json` config.

## Per-framework setup

### Letta blocks

```bash
npm install @letta-ai/letta-client
```

```ts
import { Letta } from '@letta-ai/letta-client';
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/letta';

const client = new Letta({ token: process.env.LETTA_API_KEY });

const blocks = wrap(client.blocks, { actorId: 'user_123' });
const agentBlocks = wrap(client.agents.blocks, { actorId: 'user_123' });

await runWithContext({ actorId: 'user_123' }, async () => {
  await blocks.create({ label: 'human', value: 'Sarah, EU timezone, prefers email.' });
  await agentBlocks.update('persona', { agent_id: 'agent_1', value: 'You are helpful.' });
});
```

Wrap both `client.blocks` and `client.agents.blocks` if your code uses both, otherwise an unwrapped path can bypass the audit.

### Mastra

```bash
npm install @mastra/core @mastra/memory
```

```ts
import { Memory } from '@mastra/memory';
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/mastra';

const memory = wrap(new Memory({ /* your Mastra config */ }), { actorId: 'user_123' });

await runWithContext({ actorId: 'user_123' }, async () => {
  await memory.updateWorkingMemory({ threadId: 't1', workingMemory: '...' });
  await memory.saveMessages({ messages: [/* ... */] });
});
```

Use psy's `wrap` OR Mastra's `wrapMastra` observability layer, not both. psy's chain is the source of truth for the audit guarantee.

### Mem0

```bash
npm install mem0ai
```

```ts
import MemoryClient from 'mem0ai';
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/mem0';

const client = new MemoryClient({ apiKey: process.env.MEM0_API_KEY });
const audited = wrap(client, { actorId: 'user_123' });

await runWithContext({ actorId: 'user_123' }, async () => {
  await audited.add([{ role: 'user', content: 'I prefer email replies.' }], { userId: 'user_123' });
  const recent = await audited.search('communication preferences', { userId: 'user_123' });
});
```

The OSS self-hosted client (`Memory` from `mem0ai/oss`) works the same way. mem0ai ships its own PostHog telemetry independent of psy; the two are complementary.

### LangChain chat history

```bash
npm install @langchain/core
```

```ts
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/langchain';

const history = new InMemoryChatMessageHistory();
const audited = wrap(history, { actorId: 'user_123', sessionId: 'thread_abc' });

await runWithContext({ actorId: 'user_123', sessionId: 'thread_abc' }, async () => {
  await audited.addUserMessage('Hello.');
  await audited.addAIMessage('Hi back!');
  const all = await audited.getMessages();
});
```

Wraps any backend that implements `BaseChatMessageHistory` from `@langchain/core/chat_history` (every store under `@langchain/community/stores/message/*` qualifies — Postgres, Redis, DynamoDB, Firestore, etc.). Pass `sessionId` per `RunnableConfig.configurable.sessionId`.

### LangGraph checkpointer

```bash
npm install @langchain/langgraph-checkpoint
```

```ts
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/langgraph';

const saver = wrap(new MemorySaver(), { actorId: 'user_123' });

// Pass `saver` into a LangGraph workflow's `checkpointer` slot. Every
// state save / load / partial-write produces an audit row.
await runWithContext({ actorId: 'user_123' }, async () => {
  await saver.put(
    { configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: 'cp_1' } },
    { id: 'cp_1', channel_values: { /* ... */ } },
    { source: 'loop', step: 0 },
    {},
  );
});
```

Wraps the abstract `BaseCheckpointSaver` so every concrete saver (`MemorySaver`, `SqliteSaver`, `PostgresSaver`) is audited the same way.

## Provider discovery

Adapters self-register on subpath import. Code that needs to know which memory frameworks are wired up at runtime can ask the registry:

```ts
import { listProviders, getProvider } from 'psy-core';
import 'psy-core/anthropic-memory';
import 'psy-core/letta';
import 'psy-core/mastra';
import 'psy-core/mem0';
import 'psy-core/langchain';
import 'psy-core/langgraph';

console.log(listProviders().map((p) => `${p.name}: ${p.capabilities.join(', ')}`));
// → ['anthropic-memory: view, create, str_replace, insert, delete, rename',
//    'langchain: view, insert, delete',
//    'langgraph: view, create, insert, delete',
//    'letta: view, create, str_replace, delete',
//    'mastra: view, create, str_replace, delete',
//    'mem0: view, create, str_replace, delete']
```

The registry is shared via `globalThis` so every bundle in a process talks to the same Map.

## Guarantees

- **Tamper-evident, not tamper-proof.** `psy verify` detects mid-chain edits, row reordering, sequence gaps, meta-head mismatch, orphaned intent rows, and tail truncation via the HMAC-sealed head pointer at `.psy/head.json`.
- **Sealed tail.** The chain's last `(seq, event_hash, timestamp)` is signed with a per-deployment HMAC key (`.psy/seal-key`, mode 0600). An attacker who truncates the tail leaves an invalid seal. Fresh installs are marked `seal: 'required'` so deletion of the key is a config violation, not a missing optional file.
- **Two-phase audit gap.** psy writes intent before the handler runs and result after it returns. If the result write fails or the process exits, the handler may have already executed. `psy verify` flags the orphaned intent so this state is detectable, but closing the gap fully (audit DB + memory store sharing one transaction) is outside psy-core's current scope.
- **Payload preview privacy.** Payload capture is off by default. When enabled, psy redacts common secrets (OpenAI, Anthropic, AWS, Google, GitHub, Bearer, JWT, PEM) before storing previews. Best-effort, not a DLP product.
- **Runtime support.** Node 20+, ESM only. `runWithContext` uses `AsyncLocalStorage` and works in normal Node async chains and Express / Fastify / Hono / Next Node route handlers. Edge runtimes and worker threads are not supported.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## License

MIT
