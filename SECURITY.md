# Security Policy

psy-core is a local receipt layer, not a vault. It makes memory tampering visible under a clear local threat model: the audit rows are hash-chained, the tail is HMAC-sealed, and `psy verify --all` walks the active DB, archives, orphaned intents, and sealed head.

The promise is intentionally narrow: detect edits, reordering, gaps, truncation, and substitution when the seal key is still trusted. Do not use psy-core docs to imply tamper-proof storage or regulatory compliance.

Report vulnerabilities privately through GitHub Security Advisories on this repository. We aim for a 90-day coordinated-disclosure window from confirmed report to fix; for low-severity issues we'll engage with you on the timeline.

## Fast Threat Model

| Question | Short answer |
|---|---|
| Can psy-core stop an attacker from deleting files? | No. It is tamper-evident, not tamper-proof. |
| Can it catch edited or reordered rows? | Yes. Hash linkage breaks during verification. |
| Can it catch tail truncation? | Yes, if the seal key was not also compromised. |
| Can it prove a memory write happened after the provider succeeded but the result row failed? | It can flag the orphaned `intent`; it cannot make the provider and audit DB one transaction. |
| Can it isolate tenants inside one chain? | No. Use separate psy-core instances when per-tenant integrity boundaries matter. |

## Scope

In scope:
- psy-core's audit-chain construction, hash linkage, and `psy verify` semantics
- Seal-key handling (`PSY_SEAL_KEY` env var, `.psy/seal-key` file, sealed head pointer)
- Default redactor regression (false negatives in secret-shape matching)
- CLI argument parsing (`psy init`, `psy tail`, `psy query`, `psy verify`, `psy export`, `psy ingest`)
- Memory-path validation in the Anthropic adapter
- `psy ingest` envelope validation (rejects malformed envelopes; never writes a row that fails Zod validation)

Out of scope (report upstream):
- Vulnerabilities in npm dependencies (use `npm audit` and the dependency project's reporting channel)
- Vulnerabilities in upstream framework SDKs (`@anthropic-ai/sdk`, `@letta-ai/letta-client`, `@mastra/core`, `mem0ai`, `@langchain/core`, etc.)

## What psy detects

- **Mid-chain mutation.** Any change to a row's contents that alters its `event_hash` is caught by the chain walk in `psy verify`.
- **Reordering.** Any swap of two rows breaks the `prev_hash -> event_hash` linkage and is caught.
- **Tail truncation.** Deletion of the last N rows is caught by the HMAC-sealed head pointer (`.psy/head.json`) - the sealed `(seq, event_hash)` no longer matches the actual DB tail. Requires that the seal key (`.psy/seal-key`, mode 0600, or `PSY_SEAL_KEY` env var) is not also compromised.
- **Whole-DB substitution.** Swapping in a different `events.sqlite` is caught by the same head-pointer check.
- **Direct-DB writes that bypass meta.** Tampering at the SQLite level (e.g., `DELETE FROM events`) without updating the meta table is detected on the next audit append; the auditor refuses to write further until the chain is reconciled.

## What psy does NOT yet detect

- **Attacker with FS-write access AND read access to the seal key.** If the attacker can read `.psy/seal-key`, they can re-seal a truncated chain. Production deployments that need stronger key custody can inject `PSY_SEAL_KEY` from a secrets manager so the key never lives on disk in the project directory.
- **Result-row failure after the handler already ran.** The two-phase audit (intent -> handler -> result) records `intent` before the handler executes (true fail-closed), but if the audit DB write fails AFTER the memory store mutation succeeded, the result row is missing while the mutation persisted. `psy verify` flags the orphaned `intent` so this state is detectable. Closing this gap fully (audit DB + memory store sharing one transaction) is outside psy-core's current scope.
- **Payload preview leaks under custom redactors.** When `payload_capture.enabled = true` and a custom or `null` redactor is supplied, raw memory content lands in `payload_preview`. The default redactor catches common secret shapes (OpenAI, Anthropic, AWS, GitHub PATs, Bearer tokens, JWTs, PEM blocks, generic `key=value`) but is best-effort, not bulletproof.
- **Cross-tenant chain isolation.** psy-core ships a single hash chain spanning all `tenant_id` values. A corrupted row in tenant A breaks `psy verify` for tenants B and C. Deployments needing per-tenant integrity boundaries should run a separate psy-core instance (with its own `.psy.json` and seal key) per tenant.
- **Pre-HMAC validation is observable.** The head-pointer JSON parser runs schema-shape and `schema_version` checks before the HMAC comparison. The HMAC comparison itself uses `crypto.timingSafeEqual` and is constant-time; the pre-validation paths are not. An attacker who can submit crafted head pointers and observe relative response times learns whether their malformed input passed schema validation but not whether it has the right HMAC. This is not exploitable for key recovery but is an observable oracle for input shape.
- **Multi-process sealed-mode safety.** The seal feature is designed for single-process deployments. Two writers calling `writeHead` concurrently can race in a TOCTOU window between the read-existing-head check and the atomic rename: an older `seq` could clobber a newer one. The `monotonic` check inside `writeHead` (refuses overwrites with strictly lower `seq`) prevents most accidental regressions but is not race-free. Subsequent appends detect the inconsistency via `assertSealMatchesTail` and refuse to write further (exiting with `PsyChainBroken`), so silent corruption is bounded - but the seal itself can be temporarily wrong under contention. Single-process deployments are not affected.
- **Bootstrap key-file race.** Two processes calling `psy init` for the first time simultaneously can each generate a different seal key; whichever wins the rename leaves the other's key orphaned. The losing process's already-sealed events would then fail verification under the persisted key. Mitigated by `psy init` being idempotent (re-running rebootstraps deterministically against the persisted key once one is written) and by the use case being rare (concurrent first-init is uncommon). The simplest avoidance is to ensure `psy init` runs once, before any concurrent writers.

## Operational notes

- **Seal key location.** `.psy/seal-key` is written with file mode 0600 (owner-only). The directory `.psy/` defaults to gitignore. Override the on-disk key by setting `PSY_SEAL_KEY` to a 64-char hex string (32 bytes); when set, no key is written to disk and production secrets-manager flows can inject the key without it ever touching the project directory.
- **CLI vs SDK initialization.** Running `psy init` from the CLI on a fresh project marks `.psy.json` with `seal: "required"`, which makes `psy verify` fail with `seal_missing_required` if `head.json` is later wiped. Projects that bootstrap purely through the SDK (calling `wrap()` without ever running `psy init`) leave the marker as `optional` - meaning a wipe of `.psy/head.json` AND `.psy/seal-key` together would silently downgrade verification on those installs. SDK-only users who want the downgrade-attack defense should either run `psy init` once or set `seal: "required"` in `.psy.json` manually.
- **Migrating older audit DBs.** Run `psy init --migrate` to seal the current DB tail. Pre-migration truncation cannot be retroactively detected (no prior witness existed); only future truncation is caught from the migration moment forward. This is documented at the migration command's output.
- **Windows.** Path-guard support on Windows is not currently provided; the seal infrastructure already works cross-platform.
- **`psy ingest` and the `psy-core-hermes` plugin.** `psy ingest` reads JSONL on stdin and writes events to the same on-disk audit chain as the in-process `Auditor`. It inherits the same threat model: same-host, same-user trust. The `psy-core-hermes` Python plugin spawns `psy ingest` as a child process under the same UID; the parent process owns the stdio pipe and the subprocess inherits no additional privileges. A compromised observer process can forge envelopes (it has write access to the same chain that any in-process call would), so identity and purpose carried in envelopes have the same trust level as identity passed via `runWithContext` in the SDK. Cross-host isolation, multi-tenant chain separation, and protection against an authenticated-but-malicious observer are out of scope for the current local-audit design and reserved for `psy-cloud`.

## Incident Checklist

Use this when the question is "did the agent memory change, and can I still trust the log?"

```bash
psy verify --all
psy query --actor <actor-id> --json
psy tail --once --json
```

If `psy verify --all` fails, preserve `.psy/`, `.psy.json`, rotated archives, the host logs, and the memory provider's own store before attempting repair. The broken state is evidence.
