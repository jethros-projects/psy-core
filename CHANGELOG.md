# Changelog

All notable changes to `psy-core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The audit event `schema_version` evolves independently from the package version.
A schema bump only happens when the event row shape changes incompatibly.

## [Unreleased]

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

[Unreleased]: https://github.com/jethros-projects/psy-core/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/jethros-projects/psy-core/releases/tag/v0.3.3
