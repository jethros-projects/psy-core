# psy-core-hermes example

A tiny Hermes lab: install the plugin, make Hermes write memory, then verify the receipts.

Use this when you want to see the whole loop before wiring psy-core-hermes into a real agent. The script bootstraps a local Python environment, installs the Hermes plugin, points it at psy-core, and gives you a short session that should produce paired `intent` and `result` rows.

> **Ten minutes to a working audit chain.** Run `./run.sh`, start `psy tail`, make Hermes remember something, then run `psy verify --all`.

## What This Shows

- Installing `psy-core-hermes` from PyPI into a Hermes-compatible Python environment.
- Writing the `plugins.psy` config block through `psy-core-hermes`.
- Running Hermes while `psy ingest` writes to the local audit DB.
- Inspecting the chain with `psy tail`, `psy query`, and `psy verify`.

## Quick Start

```bash
./run.sh --actor-id you@example.com
```

To also install Hermes Agent from GitHub into the local virtualenv:

```bash
./run.sh --actor-id you@example.com --with-hermes
```

In one terminal:

```bash
psy tail
```

In another terminal:

```bash
.venv/bin/hermes
```

Then ask Hermes to write memory:

```text
save: "I prefer email, in the EU timezone"
recall my preferences
```

Verify the chain:

```bash
psy verify --all
```

You should see paired `intent` and `result` rows for each memory mutation. `psy verify --all` should exit 0 and print `verification passed`.

## Files

| File | Purpose |
|---|---|
| `hermes-config.yaml` | Example `~/.hermes/config.yaml` with a populated `plugins.psy` block. |
| `run.sh` | Bootstrap script that installs both sides, runs `psy-core-hermes doctor`, and prints next steps. |

## Scope

This is a memory-and-skill audit example. It captures Hermes writes to `MEMORY.md`, `USER.md`, and skills. It does not capture ordinary tool calls, LLM calls, or session lifecycle events.

For the full configuration reference and operation table, use [python/psy-core-hermes/README.md](../../python/psy-core-hermes/README.md).
