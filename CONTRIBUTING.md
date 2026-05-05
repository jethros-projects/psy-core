# Contributing

psy-core is the receipt layer for agent memory. Contributions should keep that boundary sharp: durable memory and skill writes get auditable receipts; ordinary tool calls stay out of scope.

If memory can change future agent behavior, psy-core should help explain what changed. If a change does not make that explanation clearer, safer, or easier to verify, keep asking why it belongs here.

## Local Checks

```bash
git commit -s
npm test
npm run typecheck
```

## Rules of Thumb

- Keep changes small and explain the memory surface they affect.
- Include tests for behavior changes, especially chain, seal, adapter, ingest, redaction, and CLI behavior.
- Preserve fail-closed intent writes before provider execution.
- Do not make compliance claims the code and `SECURITY.md` threat model cannot support.
- Use [AGENTS.md](AGENTS.md) when an AI agent is doing the work.

## What a Good PR Does

| Change type | Good shape |
|---|---|
| New adapter | Names the provider boundary, records only durable memory operations, and tests every classified method. |
| New plugin hook | Shows the host surface, what confirms results, and what stays out of scope. |
| Verifier change | Adds a failing fixture first, then proves `psy verify --all` catches it. |
| Docs change | Starts with the user problem, shows the command, then states the limit. |
