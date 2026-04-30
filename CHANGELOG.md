# Changelog

All notable changes to `psy-core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The audit event `schema_version` evolves independently from the package version.
A schema bump only happens when the event row shape changes incompatibly.

## [Unreleased]

## [0.4.0] - 2026-04-29

### Added

- **`psy ingest` CLI subcommand.** Reads JSONL envelopes on stdin and
  appends them to the audit chain as paired intent/result rows. Used by
  language-side observer adapters (the first being `psy-core-hermes`, the
  Hermes Agent plugin published separately on PyPI) that cannot speak
  the on-disk schema directly. Emits a one-line protocol handshake on
  startup (`{"ok":true,"version":...,"schema_version":...}`) and one
  ACK per envelope. The HMAC seal is advanced after each successful
  append, mirroring the in-process `Auditor`. TypeScript remains the
  sole writer; no Python re-implementation of canonicalization, hashing,
  or sealing was added.
- **`PsyStore.appendIntent` / `appendResult` extended** to accept an
  optional `identity` (actorId/tenantId/sessionId), `memoryPath`,
  `purpose`, and `outcome` so the ingest envelope can thread observer-
  side identity into the row without going through the in-process
  `Auditor` layer.
- **Hermes Agent adapter.** `psy-core-hermes` (PyPI sibling, published
  separately from this repo at `python/psy-core-hermes/`) is a plain Hermes
  plugin that subscribes to `pre_tool_call` (filtered to the `memory`
  and `skill_manage` tools) plus a filesystem watcher on
  `~/.hermes/memories/MEMORY.md` and `~/.hermes/memories/USER.md`. It
  forwards JSONL to a long-lived `psy ingest` subprocess (PATH first,
  `npx -y psy-core@<exact>` fallback). Memory operations only — tool,
  LLM, and session-lifecycle telemetry are explicitly out of scope to
  keep the brand crisp.
- **Public types**: `IngestEnvelope`, `IntentEnvelope`, `ResultEnvelope`,
  `IngestAck`, `IngestStartup`, `IngestOptions`, `INGEST_PROTOCOL_VERSION`,
  plus the runtime helpers `parseIngestLine`, `parseIngestLineOrThrow`,
  `appendFromEnvelope`, and `ingestStartupLine`.

### Changed

- The `IngestEnvelopeSchema` accepts intents and results as a discriminated
  union on `type`. The wire format is documented in
  `python/psy-core-hermes/README.md` but is not a public spec for third-party
  implementations — TypeScript is the reference.

## [0.3.3] - 2026-04-27

Initial public release of `psy-core`.

### Added

- **Six framework adapters**, each available as a subpath import:
  - `psy-core/anthropic-memory` wraps Anthropic's `MemoryToolHandlers`.
  - `psy-core/letta` wraps Letta `client.blocks` and `client.agents.blocks`.
  - `psy-core/mastra` wraps the Mastra `Memory` class across working
    memory, threads, messages, and semantic recall.
  - `psy-core/mem0` wraps `mem0ai >= 3 < 4` (cloud `MemoryClient` and
    OSS `Memory` from the `mem0ai/oss` subpath).
  - `psy-core/langchain` wraps `BaseChatMessageHistory` from
    `@langchain/core/chat_history`.
  - `psy-core/langgraph` wraps `BaseCheckpointSaver` from
    `@langchain/langgraph-checkpoint >= 1 < 2`.
- **Hash-chained SQLite audit log** with HMAC-sealed tail. Every memory
  op writes paired `intent` + `result` rows; the chain's last
  `(seq, event_hash, timestamp)` is signed with a per-deployment HMAC
  key (`.psy/seal-key`, mode `0600`, or `PSY_SEAL_KEY` env var) so tail
  truncation, mid-chain mutation, reordering, and whole-DB substitution
  are all detected by `psy verify`.
- **Two-phase audit** (intent → handler → result) with explicit outcome
  states for handler errors, anonymous calls, redactor errors, audit
  timeouts, and path-guard rejections.
- **Identity propagation** via Node `AsyncLocalStorage`. `runWithContext`
  flows `actorId` / `tenantId` / `sessionId` through async boundaries on
  Express / Fastify / Hono / Next Node route handlers without threading
  args through every call.
- **Default secret redactor** covering OpenAI, Anthropic, AWS, Google,
  GitHub, Bearer, JWT, and PEM patterns. Pluggable `Redactor` interface
  for custom rules.
- **Provider discovery API** (`registerProvider`, `getProvider`,
  `listProviders`) with declared `auditSchemaVersion`,
  `compatibleProviderVersions`, `capabilities`, and `memoryPathScheme`
  per adapter. Schema-mismatch fails loud at registration time.
- **CLI**: `psy init`, `psy tail`, `psy query`, `psy verify`, `psy export`.
- **SLSA build provenance** via OIDC. Every published artifact links
  back cryptographically to the source commit + workflow run.
- **Comprehensive testing bench** (`scripts/bench.sh`) covering all six
  adapters with full method coverage, real-SDK structural shape checks,
  real-instance integration tests for LangChain + LangGraph, sealed-tail
  tamper detection, fail-closed proofs, CLI surface, and a perf
  microbench with a configurable p95 threshold.
- **Documentation**: README quickstarts per framework, `SECURITY.md`
  with scope and threat model, `CONTRIBUTING.md`, `RELEASING.md`,
  CI matrix on Ubuntu and macOS across Node 20 LTS and 22 LTS.

### Known limitations (see `SECURITY.md` for the full threat model)

- Cross-tenant chain isolation is not provided; deployments needing
  per-tenant integrity boundaries should run a separate `psy-core`
  instance per tenant.
- The result side of a two-phase audit can fail after the memory
  operation already executed; `psy verify` flags the orphaned `intent`
  but closing the gap fully (audit DB + memory store sharing one
  transaction) is outside `psy-core`'s current scope.
- Payload previews can contain sensitive data if `payload_capture.enabled`
  is `true` and a custom or `null` redactor is supplied.
- Windows path-guard support is not currently provided; the seal
  infrastructure works cross-platform.

[Unreleased]: https://github.com/jethros-projects/psy-core/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/jethros-projects/psy-core/releases/tag/v0.4.0
[0.3.3]: https://github.com/jethros-projects/psy-core/releases/tag/v0.3.3
