# psy-core

Your AI agent is smart. Its memory is mutable. psy-core gives every durable memory change a receipt.

Packages: `psy-core` for Node SDKs and the CLI, `psy-core-hermes` for Hermes Agent, and `psy-core-openclaw` for OpenClaw.

Docs: [psy-core npm](https://www.npmjs.com/package/psy-core), [Hermes plugin](python/psy-core-hermes/README.md), [Hermes example](examples/hermes-agent/README.md), [OpenClaw plugin](plugins/psy-core-openclaw/README.md), [OpenClaw agent install](plugins/psy-core-openclaw/AGENT_INSTALL.md), [OpenClaw npm](https://www.npmjs.com/package/psy-core-openclaw), [AGENTS.md](AGENTS.md), [llms.txt](llms.txt), [Issues](https://github.com/jethros-projects/psy-core/issues).

Agents do not just answer questions anymore. They update user profiles, rewrite working memory, create skills, save checkpoints, sync semantic stores, and carry facts from one session into the next. That is not chat history. That is operational state.

If memory can change the next action your agent takes, the write deserves a trail.

**psy-core is that trail.** It sits at the memory boundary, wraps the SDK or agent surface you already use, records an `intent` row before the call, records a `result` row after the call, links every row into a local SQLite hash chain, and seals the tail with HMAC. You keep Anthropic Memory, Letta, Mastra, Mem0, LangChain, LangGraph, GBrain, Hermes, or OpenClaw. psy-core gives the write path receipts.

Use it while developing to see what your agent is learning. Use it in production to investigate drift, unexpected personalization, failed writes, memory poisoning, suspicious truncation, or skill churn. Run `psy verify --all` when the chain needs to prove it still agrees with itself.

> **Two minutes to first receipts.** Install, initialize the chain, wrap the memory surface, then watch rows land with `psy tail`.

## Who This Is For

- **Agent builders** who need memory observability without changing providers.
- **Teams shipping personalization** who need to explain why an agent remembered, forgot, or rewrote something.
- **Operators of GBrain, Hermes, and OpenClaw** who want durable agent memory to stay inspectable.
- **Security and compliance-minded engineers** who need tamper-evident local logs before they make larger governance claims.

## Quick Install

```bash
npm install psy-core
npx psy init
```

`psy init` creates `.psy.json`, the SQLite store, archive directory, local seal key, and the sealed-head marker. The first audit event advances the sealed head pointer.

Then wrap the memory surface you already use:

```ts
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/anthropic-memory';

const auditedMemory = wrap(yourMemoryHandlers, { actorId: 'support-agent' });

await runWithContext({ actorId: 'user_123', tenantId: 'acme' }, async () => {
  // Call your agent with auditedMemory.
});
```

Watch the chain from another terminal:

```bash
psy tail
psy query --actor user_123
psy verify --all
```

Stop there. You will know if your agent's memory path is visible enough.

## Agent Integrations

psy-core has two first-class agent plugins for systems that already manage memory and skills:

| Agent | Install | What psy-core sees | Start here |
|---|---|---|---|
| Hermes Agent | `pip install psy-core-hermes` | `MEMORY.md`, `USER.md`, and `skill_manage` writes streamed through `psy ingest` | [Hermes plugin](python/psy-core-hermes/README.md) and [Hermes example](examples/hermes-agent/README.md) |
| OpenClaw | `openclaw plugins install psy-core-openclaw` | `MEMORY.md`, `USER.md`, `DREAMS.md`, `memory/**`, skills, Skill Workshop, LanceDB memory, and memory-wiki | [OpenClaw plugin](plugins/psy-core-openclaw/README.md) and [agent install guide](plugins/psy-core-openclaw/AGENT_INSTALL.md) |

Both keep the host agent's normal memory workflow. psy-core only adds the receipt layer: paired `intent` / `result` rows, hash-chain verification, and a sealed tail.

## See It Work

```text
Agent: remember that Alice prefers concise incident summaries.

psy:   intent  seq=101 operation=create actor=user_123 path=memory/preferences

SDK:   provider writes to memory normally

psy:   result  seq=102 status=success hash=... prev_hash=...

You:   psy query --actor user_123 --operation create

psy:   shows the attempted write, confirmed result, provider surface,
       session id, timestamp, redacted preview, and chain position

You:   psy verify --all

psy:   active DB, archives, hashes, sequence, orphan checks, and sealed
       tail all agree
```

The agent keeps its memory. You get the receipts.

## What It Captures

| Memory surface | Install | Import | Operations |
|---|---|---|---|
| Anthropic Memory Tool | `npm install @anthropic-ai/sdk` | `psy-core/anthropic-memory` | view, create, str_replace, insert, delete, rename |
| Letta blocks | `npm install @letta-ai/letta-client` | `psy-core/letta` | view, create, str_replace, delete |
| Mastra memory | `npm install @mastra/core @mastra/memory` | `psy-core/mastra` | view, create, str_replace, delete |
| Mem0 | `npm install mem0ai` | `psy-core/mem0` | view, create, str_replace, delete |
| LangChain chat history | `npm install @langchain/core` | `psy-core/langchain` | view, insert, delete |
| LangGraph checkpointers | `npm install @langchain/langgraph-checkpoint` | `psy-core/langgraph` | view, create, insert, delete |
| GBrain operations and BrainEngine | `bun link` or installed GBrain | `psy-core/gbrain` | view, create, str_replace, insert, delete, rename |
| Hermes Agent memory and skills | `pip install psy-core-hermes` | Python plugin | create, str_replace, delete |
| OpenClaw memory and skills | `openclaw plugins install psy-core-openclaw` | OpenClaw plugin | view, create, str_replace, delete |

The Node adapters write directly to the audit store. The Hermes plugin runs in Python and streams canonical JSONL into `psy ingest`, so it lands in the same chain and verifies with the same CLI. The OpenClaw plugin observes memory and skill tool calls from OpenClaw plugin hooks and writes psy-compatible audit envelopes in-process.

## The Audit Loop

psy-core is a process, not a dashboard bolted on after the fact:

```text
Memory call starts
  -> psy resolves actor, tenant, session, provider, and path
  -> intent row is written before the provider runs
  -> provider runs normally
  -> result row records success or failure
  -> row JSON is canonicalized
  -> event hash links to prev_hash
  -> sealed head stores the latest seq + event_hash
  -> psy verify walks active DB, archives, and seal
```

Every audited call gets a durable pair of facts: what was attempted and what happened. If the process dies after intent but before result, verification flags the orphan instead of pretending the write never happened.

## Adapter Notes

### Anthropic Memory Tool

```bash
npm install @anthropic-ai/sdk
```

Use `psy-core/anthropic-memory` for filesystem-shaped memory handlers. The adapter validates memory paths and records view, create, replacement, insertion, deletion, and rename operations.

```ts
import { betaMemoryTool } from '@anthropic-ai/sdk/helpers/beta/memory';
import { BetaLocalFilesystemMemoryTool } from '@anthropic-ai/sdk/tools/memory/node';
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/anthropic-memory';

const fsHandlers = await BetaLocalFilesystemMemoryTool.init('./memory');
const memory = betaMemoryTool(wrap(fsHandlers, { actorId: 'support-agent' }));

await runWithContext({ actorId: 'user_123', sessionId: 'thread_abc' }, async () => {
  // Pass memory to the Anthropic SDK.
});
```

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

The Mastra adapter covers the public `Memory` class surface for working memory, thread/message memory, semantic recall, and observational memory. Use psy-core's wrapper as the audit source of truth when you need chain verification.

### Mem0

```bash
npm install mem0ai
```

The Mem0 adapter records the SDK call boundary. Mem0's `add` can semantically upsert multiple memories inside one call; psy-core records the auditable boundary and stores the SDK result preview when payload capture is enabled.

### LangChain

```bash
npm install @langchain/core
```

Wrap anything implementing `BaseChatMessageHistory`. Use `sessionId` so chat rows are grouped by conversation thread.

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

### LangGraph

```bash
npm install @langchain/langgraph-checkpoint
```

Wrap a `BaseCheckpointSaver` implementation such as memory, SQLite, or Postgres. psy-core records checkpoint reads, writes, partial writes, and thread deletion.

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
| Tags, links, timeline entries, chunk deletes, version creates | `insert` or `delete` | Bulk calls are recorded once at the boundary, not once per row. |
| `updateSlug` | `rename` | Records both old and new page paths. |

| Surface | Captured? | Why |
|---|---:|---|
| Calls made through `wrapOperations` or `wrapEngine` | Yes | The host has applied the adapter. |
| Writes inside `engine.transaction(async tx => ...)` | Yes | The transaction callback engine is wrapped. |
| Raw SQL, config, migrations, jobs, eval/code capture, health/stats | No | These are infrastructure/admin surfaces; use `classifyOperation` or `classifyEngineMethod` to opt in explicitly. |
| A stock `gbrain serve` or `gbrain` CLI process | No | GBrain does not load psy-core automatically; the host must import and apply `psy-core/gbrain`. |
| Internal side effects inside one GBrain operation | One row | psy-core records the operation boundary, not every private engine call unless the host wraps the engine too. |
| Hermes/OpenClaw/MemoryProvider plugin activity | No | Use the dedicated plugin or adapter for that surface. |

For live adapter validation against a local GBrain checkout:

```bash
PSY_GBRAIN_REAL_REPO=/path/to/gbrain npm run test:gbrain:live
```

### Hermes Agent

Hermes writes to `MEMORY.md`, `USER.md`, and skills are observed from the Python process and streamed into `psy ingest`.

```bash
pip install psy-core-hermes
psy-core-hermes trust-layer --actor-id you@example.com
```

See [python/psy-core-hermes](python/psy-core-hermes/README.md) and [examples/hermes-agent](examples/hermes-agent/README.md).

### OpenClaw

The OpenClaw plugin observes tool calls that touch `MEMORY.md`, `USER.md`, `DREAMS.md`, `memory/**`, skills, `skill_workshop`, `memory-lancedb`, and `memory-wiki` surfaces.

```bash
openclaw plugins install psy-core-openclaw
openclaw config set plugins.entries.psy-core.enabled true
openclaw config set plugins.entries.psy-core.config.actorId "you@example.com"
openclaw gateway restart
```

See [plugins/psy-core-openclaw](plugins/psy-core-openclaw/README.md).

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

**Tamper-evident, not tamper-proof.** psy-core detects row edits, row reordering, sequence gaps, broken hashes, meta-head mismatch, orphaned intent rows, archive mismatch, and sealed-tail mismatch. It does not stop an attacker from deleting all local files.

**Fail-closed wrapper path.** If psy-core cannot write the intent row, the wrapped handler does not run. If the result row cannot be written after the handler runs, verification can still flag the orphaned intent.

**Best-effort redaction.** Built-in redaction catches common OpenAI, Anthropic, AWS, Google, GitHub, Bearer, JWT, and PEM secret patterns. Treat previews as operational diagnostics, not a DLP boundary.

**Runtime assumptions.** psy-core is Node 20+ and ESM-only. `runWithContext` uses `AsyncLocalStorage` in normal Node async chains. Edge runtimes and worker threads are outside the current support scope.

For the full threat model, use [SECURITY.md](SECURITY.md).

## Docs by Goal

| Goal | Start here |
|---|---|
| Audit a TypeScript/Node agent | [Quick Install](#quick-install) and [Adapter Notes](#adapter-notes) |
| Audit GBrain | [GBrain](#gbrain) |
| Audit Hermes Agent | [python/psy-core-hermes](python/psy-core-hermes/README.md) |
| Audit OpenClaw | [plugins/psy-core-openclaw](plugins/psy-core-openclaw/README.md) |
| Try the Hermes integration end to end | [examples/hermes-agent](examples/hermes-agent/README.md) |
| Understand integrity checks | [The Audit Loop](#the-audit-loop) and [Guarantees and Limits](#guarantees-and-limits) |
| Wire a non-Node observer | `psy ingest` in [CLI Quick Reference](#cli-quick-reference) |
| Inspect provider coverage | [Provider Discovery](#provider-discovery) |
| Give an agent repo context | [AGENTS.md](AGENTS.md) |
| Give an LLM the doc map | [llms.txt](llms.txt) |

## Repository Map

| Path | Purpose |
|---|---|
| `src/` | TypeScript audit engine, CLI, store, verifier, and Node adapters |
| `python/psy-core-hermes/` | Hermes Agent Python plugin |
| `plugins/psy-core-openclaw/` | OpenClaw plugin for memory and skill audit hooks |
| `examples/hermes-agent/` | Local walkthrough for Hermes plus psy-core |
| `.github/workflows/` | Node, Python, publish, and cross-language e2e workflows |
| `AGENTS.md` | Agent-facing contributor instructions |
| `llms.txt` | Compact LLM documentation map |

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

Hermes plugin tests live under [python/psy-core-hermes](python/psy-core-hermes/README.md).

## License

MIT
