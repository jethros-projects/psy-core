# psy-core

> Verifiable receipts for agent memory.
> Audit what changed, who changed it, and whether the record still checks out.

[![npm version](https://img.shields.io/npm/v/psy-core.svg?color=cb3837)](https://www.npmjs.com/package/psy-core)
[![npm downloads](https://img.shields.io/npm/dm/psy-core.svg)](https://www.npmjs.com/package/psy-core)
[![license](https://img.shields.io/npm/l/psy-core.svg)](https://github.com/jethros-projects/psy-core/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/psy-core.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)

[npm](https://www.npmjs.com/package/psy-core) | [Hermes adapter](python/psy-core-hermes/README.md) ![psy-core-hermes downloads](https://static.pepy.tech/personalized-badge/psy-core-hermes?period=total&units=INTERNATIONAL_SYSTEM&left_color=GREY&right_color=GREEN&left_text=downloads) | [Hermes example](examples/hermes-agent/README.md) | [Issues](https://github.com/jethros-projects/psy-core/issues)

**psy-core is a tamper-evident audit layer for agents that remember.** Modern agents update user profiles, rewrite working memory, save checkpoints, curate skills, and carry facts across sessions. Those writes are not chat history; they are operational state. When that state changes, you need a trail that can be inspected later.

psy-core sits at the memory boundary. It wraps the memory SDK you already use, records a before-the-call `intent` row, records an after-the-call `result` row, and links each event into a local SQLite hash chain sealed by HMAC. You keep your existing memory provider. psy gives it receipts.

Use it while developing to see what your agent is learning. Use it in production to investigate drift, unexpected personalization, failed writes, memory poisoning, or suspicious truncation. Use `psy verify --all` when you need the chain to prove that the log still agrees with itself.

## Quick Install

```bash
npm install psy-core
npx psy init
```

`psy init` creates the project config, SQLite store, archive directory, and a local seal key. The sealed head pointer is written when the first audit event lands.

Then wrap the memory surface you already use:

```ts
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/anthropic-memory';

const auditedMemory = wrap(yourMemoryHandlers, { actorId: 'support-agent' });

await runWithContext({ actorId: 'user_123', tenantId: 'acme' }, async () => {
  // call your agent with auditedMemory
});
```

Watch and verify from another terminal:

```bash
psy tail
psy query --actor user_123
psy verify --all
```

## What It Captures

| Memory surface | Install | Import | Operations |
|---|---|---|---|
| Anthropic Memory Tool | `npm install @anthropic-ai/sdk` | `psy-core/anthropic-memory` | view, create, str_replace, insert, delete, rename |
| Letta blocks | `npm install @letta-ai/letta-client` | `psy-core/letta` | view, create, str_replace, delete |
| Mastra memory | `npm install @mastra/core @mastra/memory` | `psy-core/mastra` | view, create, str_replace, delete |
| Mem0 | `npm install mem0ai` | `psy-core/mem0` | view, create, str_replace, delete |
| LangChain chat history | `npm install @langchain/core` | `psy-core/langchain` | view, insert, delete |
| LangGraph checkpointers | `npm install @langchain/langgraph-checkpoint` | `psy-core/langgraph` | view, create, insert, delete |
| GBrain operations and BrainEngine | `bun link` / installed GBrain | `psy-core/gbrain` | view, create, str_replace, insert, delete, rename |
| Hermes Agent memory and skills | `pip install psy-core-hermes` | Python plugin | create, str_replace, delete |

The Node adapters write directly to the audit store. The Hermes adapter runs in Python and streams canonical JSONL into `psy ingest`, so it lands in the same chain and verifies with the same CLI.

## Getting Started

### 1. Initialize the Chain

```bash
npx psy init
```

The default store lives at `.psy/events.sqlite`. The default seal key lives at `.psy/seal-key` with mode `0600`. The config marker in `.psy.json` tells `psy verify` that a sealed tail is expected, so deleting `.psy/head.json` is treated as a possible downgrade instead of silently passing.

### 2. Wrap a Memory Provider

Anthropic Memory Tool:

```ts
import { betaMemoryTool } from '@anthropic-ai/sdk/helpers/beta/memory';
import { BetaLocalFilesystemMemoryTool } from '@anthropic-ai/sdk/tools/memory/node';
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/anthropic-memory';

const fsHandlers = await BetaLocalFilesystemMemoryTool.init('./memory');
const memory = betaMemoryTool(wrap(fsHandlers, { actorId: 'support-agent' }));

await runWithContext({ actorId: 'user_123', sessionId: 'thread_abc' }, async () => {
  // pass `memory` to the Anthropic SDK
});
```

LangChain chat history:

```ts
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/langchain';

const history = wrap(new InMemoryChatMessageHistory(), {
  actorId: 'user_123',
  sessionId: 'thread_abc',
});

await runWithContext({ actorId: 'user_123', sessionId: 'thread_abc' }, async () => {
  await history.addUserMessage('Remember that I prefer email.');
  await history.getMessages();
});
```

### 3. Inspect the Trail

```bash
psy tail --once
psy query --session thread_abc --json
psy verify --all
```

A successful verification means the active DB, rotated archives, hash chain, and sealed head agree.

## CLI Quick Reference

| Task | Command |
|---|---|
| Create config, store, archives, and seal key | `psy init` |
| Seal an existing unsealed DB tail | `psy init --migrate` |
| Watch current and future rows | `psy tail` |
| Emit machine-readable rows | `psy tail --json` |
| Query by identity or operation | `psy query --actor user_123 --operation str_replace` |
| Verify active DB, archives, and seal | `psy verify --all` |
| Skip seal verification explicitly | `psy verify --no-seal` |
| Export active rows | `psy export --format jsonl` |
| Append events from non-Node observers | `psy ingest` |

## Common Workflows

| Scenario | What to do |
|---|---|
| Debug a surprising memory | Run `psy query --actor <id>` and inspect the paired `intent` and `result` rows around the timestamp. |
| Watch an agent while developing | Run `psy tail` beside your local agent process. |
| Prove the log was not edited | Run `psy verify --all` in CI, deploy checks, or incident response. |
| Attribute writes in a multi-user app | Wrap calls in `runWithContext({ actorId, tenantId, sessionId })`. |
| Connect a Python observer | Send canonical envelopes to `psy ingest`; `psy-core-hermes` does this for Hermes Agent. |
| Limit stored content | Keep payload capture disabled or provide a custom redactor. |

## How the Chain Works

1. A wrapped method is called with an operation such as `create`, `view`, or `delete`.
2. psy resolves identity from wrapper options plus `runWithContext`.
3. psy writes an `intent` row before the memory provider runs.
4. The provider runs normally.
5. psy writes a `result` row with success or failure details.
6. The row is canonicalized, hashed, and chained to the previous row.
7. The latest tail `(seq, event_hash, timestamp)` is signed into the sealed head pointer.

This gives every call a durable pair of facts: what was attempted and what happened. If the process dies after intent but before result, verification flags the orphan instead of pretending the write never happened.

## Adapter Notes

### Anthropic Memory Tool

```bash
npm install @anthropic-ai/sdk
```

Use `psy-core/anthropic-memory` for filesystem-shaped memory handlers. The adapter validates memory paths and records view, create, replacement, insertion, deletion, and rename operations.

### Letta

```bash
npm install @letta-ai/letta-client
```

Wrap both `client.blocks` and `client.agents.blocks` if your app uses both. Wrapping only one leaves the other as an unaudited path.

```ts
import { Letta } from '@letta-ai/letta-client';
import { wrap } from 'psy-core/letta';

const client = new Letta({ token: process.env.LETTA_API_KEY });
const blocks = wrap(client.blocks, { actorId: 'user_123' });
const agentBlocks = wrap(client.agents.blocks, { actorId: 'user_123' });
```

### Mastra

```bash
npm install @mastra/core @mastra/memory
```

The Mastra adapter covers the public `Memory` class surface for working memory, thread/message memory, semantic recall, and observational memory. Use psy's wrapper as the audit source of truth when you need chain verification.

### Mem0

```bash
npm install mem0ai
```

The Mem0 adapter records the SDK call boundary. Mem0's `add` can semantically upsert multiple memories inside one call; psy records the auditable boundary and stores the SDK result preview when payload capture is enabled.

### LangChain

```bash
npm install @langchain/core
```

Wrap anything implementing `BaseChatMessageHistory`. Use `sessionId` so chat rows are grouped by conversation thread.

### LangGraph

```bash
npm install @langchain/langgraph-checkpoint
```

Wrap a `BaseCheckpointSaver` implementation such as memory, SQLite, or Postgres. psy records checkpoint reads, writes, partial writes, and thread deletion.

### GBrain

GBrain is TypeScript/Bun, so the adapter is a structural wrapper rather than a Python observer. Use `wrapOperations` around GBrain's exported `operations` array for MCP/CLI-facing calls, or `wrapEngine` around a `BrainEngine` instance for direct page/chunk/link/timeline writes.

```ts
import { operations } from 'gbrain/operations';
import { wrapEngine, wrapOperations } from 'psy-core/gbrain';

const auditedOps = wrapOperations(operations, { actorId: 'agent-1' });
const auditedEngine = wrapEngine(engine, { actorId: 'agent-1', brainId: 'host' });
```

`wrapEngine` also wraps transaction callback engines, so writes inside `engine.transaction(async tx => ...)` are still recorded. Search/query paths are hashed in `memory_path` to avoid leaking raw queries; set `auditReads: false` for high-volume read deployments.

| GBrain surface | psy operation | Notes |
|---|---|---|
| Page reads, lists, search, query, chunks, graph reads | `view` | Query text is hashed in `memory_path`. |
| Page writes, raw data writes, version reverts, link rewrites | `str_replace` | One audit pair per GBrain call boundary. |
| Tags, links, timeline entries, chunk deletes, version creates | `insert` / `delete` | Bulk calls are recorded once at the boundary, not once per row. |
| `updateSlug` | `rename` | Records both old and new page paths. |

| Surface | Captured? | Why |
|---|---:|---|
| Calls made through `wrapOperations` or `wrapEngine` | Yes | The host has applied the adapter. |
| Writes inside `engine.transaction(async tx => ...)` | Yes | The transaction callback engine is wrapped. |
| Raw SQL, config, migrations, jobs, eval/code capture, health/stats | No | These are infrastructure/admin surfaces; use `classifyOperation` or `classifyEngineMethod` to opt in explicitly. |
| A stock `gbrain serve` or `gbrain` CLI process | No | GBrain does not load psy automatically; the host must import and apply `psy-core/gbrain`. |
| Internal side effects inside one GBrain operation | One row | psy records the operation boundary, not every private engine call unless the host wraps the engine too. |
| Hermes/OpenClaw/MemoryProvider plugin activity | No | Use the dedicated plugin or adapter for that surface. |

For live adapter validation against a local GBrain checkout:

```bash
PSY_GBRAIN_REAL_REPO=/path/to/gbrain npm run test:gbrain:live
```

This runs the real PGLite `BrainEngine` through psy's SQLite-backed audit store, then uses Bun to invoke GBrain's real `operations.ts` boundary with an in-memory capture store. The split exists because GBrain's operation module uses Bun/WASM imports, while psy's SQLite store depends on Node `better-sqlite3`.

### Hermes Agent

```bash
pip install psy-core-hermes
psy-core-hermes init --actor-id you@example.com
```

Hermes writes to `MEMORY.md`, `USER.md`, and skills are observed from the Python process and streamed into `psy ingest`. See [`python/psy-core-hermes`](python/psy-core-hermes/README.md) and [`examples/hermes-agent`](examples/hermes-agent/README.md).

## Provider Discovery

Adapters self-register when their subpath is imported:

```ts
import { listProviders } from 'psy-core';
import 'psy-core/anthropic-memory';
import 'psy-core/letta';
import 'psy-core/mastra';
import 'psy-core/mem0';
import 'psy-core/langchain';
import 'psy-core/langgraph';
import 'psy-core/gbrain';

for (const provider of listProviders()) {
  console.log(provider.name, provider.capabilities, provider.memoryPathScheme);
}
```

The registry is stored on `globalThis`, so separately bundled adapter subpaths share one provider map inside a process.

## Configuration

Important `.psy.json` fields:

```json
{
  "sqlite_path": ".psy/events.sqlite",
  "archives_path": ".psy/archives",
  "payload_capture": {
    "enabled": false,
    "max_bytes": 512
  },
  "rotation": {
    "max_days": 30,
    "max_size_mb": 1024
  },
  "seal": "required"
}
```

Useful environment variables:

| Variable | Purpose |
|---|---|
| `PSY_AUDIT_DB_PATH` | Override the active SQLite path |
| `PSY_ARCHIVES_PATH` | Override rotated archive location |
| `PSY_HEAD_PATH` | Override the sealed head pointer path |
| `PSY_SEAL_KEY_PATH` | Override the HMAC seal key path |
| `PSY_SEAL_KEY` | Provide the seal key through the environment |

## Guarantees and Limits

**Tamper-evident, not tamper-proof.** psy detects row edits, row reordering, sequence gaps, broken hashes, meta-head mismatch, orphaned intent rows, archive mismatch, and sealed-tail mismatch. It does not stop an attacker from deleting all local files.

**Fail-closed wrapper path.** If psy cannot write the intent row, the wrapped handler does not run. If the result row cannot be written after the handler runs, verification can still flag the orphaned intent.

**Best-effort redaction.** Built-in redaction catches common OpenAI, Anthropic, AWS, Google, GitHub, Bearer, JWT, and PEM secret patterns. Treat previews as operational diagnostics, not a DLP boundary.

**Runtime assumptions.** psy-core is Node 20+ and ESM-only. `runWithContext` uses `AsyncLocalStorage` in normal Node async chains. Edge runtimes and worker threads are outside the current support scope.

## Docs by Goal

| Goal | Start here |
|---|---|
| Audit a TypeScript/Node agent | [Quick Install](#quick-install) and [Adapter Notes](#adapter-notes) |
| Audit GBrain | [GBrain](#gbrain) |
| Audit Hermes Agent | [`python/psy-core-hermes`](python/psy-core-hermes/README.md) |
| Try the Hermes integration end to end | [`examples/hermes-agent`](examples/hermes-agent/README.md) |
| Understand integrity checks | [How the Chain Works](#how-the-chain-works) and [Guarantees and Limits](#guarantees-and-limits) |
| Wire a non-Node observer | `psy ingest` in [CLI Quick Reference](#cli-quick-reference) |
| Inspect provider coverage | [Provider Discovery](#provider-discovery) |

## Repository Map

| Path | Purpose |
|---|---|
| `src/` | TypeScript audit engine, CLI, store, verifier, and Node adapters |
| `python/psy-core-hermes/` | Hermes Agent Python plugin |
| `examples/hermes-agent/` | Local walkthrough for Hermes plus psy |
| `.github/workflows/` | Node, Python, publish, and cross-language e2e workflows |

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

GBrain live validation expects a local GBrain checkout and Bun:

```bash
PSY_GBRAIN_REAL_REPO=/path/to/gbrain npm run test:gbrain:live
```

Python adapter tests live under [`python/psy-core-hermes`](python/psy-core-hermes/README.md).

## License

MIT
