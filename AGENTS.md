# psy-core Agent Guide

psy-core has one job: give durable agent memory writes receipts.

Keep that job sharp. The product should feel powerful at the boundary and boring underneath: deterministic hashes, explicit trust assumptions, narrow adapters, and docs that say exactly what the code can prove.

Start here before changing the repo.

## Read Order

1. `README.md` for product shape, supported surfaces, and install examples.
2. `SECURITY.md` for the threat model and the exact guarantees.
3. `src/types.ts`, `src/auditor.ts`, `src/store.ts`, `src/verify.ts`, and `src/seal.ts` before changing chain semantics.
4. The target adapter under `src/adapters/**` before changing provider behavior.
5. `python/psy-core-hermes/README.md` or `plugins/psy-core-openclaw/README.md` before touching those integrations.

## Operating Rules

- Preserve the audit pair: write `intent` before the provider call, write `result` after the provider call, and let verification flag orphaned intents.
- Do not turn psy-core into a universal activity logger. Durable memory and skill surfaces are in scope. Ordinary tool calls are not.
- Keep provider adapters structural and narrow. If an upstream SDK adds a new operation, classify it explicitly.
- Treat payload previews as diagnostics. Keep payload capture off by default and use the built-in redactor unless the user asks for raw previews.
- Never claim tamper-proof storage. psy-core is tamper-evident under the local seal-key threat model documented in `SECURITY.md`.
- Use canonical JSON and the existing hash-chain helpers for any new row-like data. No ad hoc serialization.
- Keep CLI output script-friendly. Human text is fine, but JSON flags must stay stable.
- Add tests for behavior changes. Chain, seal, adapter classification, redaction, and ingest changes all need targeted coverage.

## Product Sense

Good psy-core work makes one of these things easier:

| User question | What the change should improve |
|---|---|
| "What did the agent remember?" | Queryability, identity, provider/path capture, or payload preview safety |
| "Did the write actually happen?" | Intent/result pairing, orphan detection, or observer confirmation |
| "Was this log edited later?" | Hash-chain verification, archive verification, or sealed-tail checks |
| "Which memory surface is covered?" | Adapter scope, plugin hook coverage, or docs that draw the line |

If a change cannot be tied to one of those answers, question the scope before adding it.

## Common Tasks

| Task | Start here | Verification |
|---|---|---|
| Add a Node adapter | `src/adapters/`, `src/provider.ts` | Adapter unit test plus `tests/public-api.test.ts` if exports change |
| Change chain semantics | `src/auditor.ts`, `src/store.ts`, `src/verify.ts` | `npm run test:node` and focused verifier tests |
| Change seal behavior | `src/seal.ts`, `src/config.ts` | `tests/seal.test.ts`, `tests/verify.test.ts` |
| Change CLI behavior | `src/cli.ts` | `tests/cli.test.ts`, `tests/cli-ingest.test.ts` |
| Change redaction | `src/redactor.ts` | `tests/redactor.test.ts`, regression test for any missed secret shape |
| Change GBrain support | `src/adapters/gbrain/` | `npm run test:gbrain`; live test only with `PSY_GBRAIN_REAL_REPO` |
| Change Hermes support | `python/psy-core-hermes/` | Python tests in that package plus root ingest tests if envelopes change |
| Change OpenClaw support | `plugins/psy-core-openclaw/` | Plugin tests under `plugins/psy-core-openclaw/test/` |

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
```

For cross-integration checks:

```bash
npm run test:e2e:adapters
npm run test:e2e:integrations
PSY_GBRAIN_REAL_REPO=/path/to/gbrain npm run test:gbrain:live
```

## Style

The public voice is direct and operational: name the problem, show the command, state the boundary. Prefer concrete examples over abstract assurance. If a sentence sounds like a compliance claim, either prove it in code or cut it.

Garry-style docs are allowed to be confident. They are not allowed to be vague. Say "this catches tail truncation when the seal key is not compromised," not "enterprise-grade security."
