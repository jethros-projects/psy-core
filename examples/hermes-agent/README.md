# psy-core-hermes example — auditing a Hermes Agent session

A self-contained walkthrough that wires `psy-core-hermes` into a fresh Hermes
agent install, exercises a few memory writes, and verifies the
hash-chained, HMAC-sealed audit log.

## What this demonstrates

- Installing `psy-core-hermes` from PyPI alongside `hermes-agent`
- Inserting the `plugins.psy` block via `psy-core-hermes init`
- Running Hermes interactively while `psy ingest` writes to `~/.psy/audit.db`
- Inspecting the chain with `psy tail` / `psy query` / `psy verify`

## Files

- `hermes-config.yaml` — the `~/.hermes/config.yaml` layout with a
  populated `plugins.psy` block.
- `run.sh` — bootstrap script that installs both sides into a fresh
  virtualenv + npm-global location, runs `psy-core-hermes doctor`, and
  prints next steps.

## Walkthrough

```bash
# 1. Bootstrap (creates a venv at .venv/ and installs both sides)
./run.sh --actor-id you@example.com

# 2. In one terminal, watch psy tail:
.venv/bin/psy tail

# 3. In another terminal, drive Hermes:
.venv/bin/hermes
> save: "I prefer email, in the EU timezone"
> recall my preferences

# 4. Verify the chain:
.venv/bin/psy verify --all
```

You should see paired `intent` + `result` rows for each memory mutation.
`psy verify --all` should exit 0 and print `verification passed`.

## Scope

This example is **memory-only** — it captures every memory mutation
Hermes performs (MEMORY.md, USER.md, skills) and nothing else. Tool
calls, LLM calls, and session lifecycle events are deliberately not
captured in v0.4 to keep the brand crisp; they'll return as separate
adapter scopes if there's user demand.

See [`python/psy-core-hermes/README.md`](../../python/psy-core-hermes/README.md)
for the full configuration reference and operation table.
