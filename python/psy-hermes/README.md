# psy-hermes

> Tamper-evident memory audit log for your Hermes agent.
> Every memory write — to MEMORY.md, USER.md, or skills — hash-chained and HMAC-sealed.
> One `pip install`.

[![PyPI](https://img.shields.io/pypi/v/psy-hermes.svg)](https://pypi.org/project/psy-hermes/)
[![Python](https://img.shields.io/pypi/pyversions/psy-hermes.svg)](https://pypi.org/project/psy-hermes/)
[![License](https://img.shields.io/pypi/l/psy-hermes.svg)](https://github.com/jethros-projects/psy-core/blob/main/LICENSE)

`psy-hermes` is the Hermes Agent companion to [`psy-core`](https://www.npmjs.com/package/psy-core). It registers as a plain Hermes plugin, observes every memory mutation, and forwards each one to a long-lived `psy ingest` subprocess that writes the canonical hash-chained, HMAC-sealed audit log to `~/.psy/audit.db`.

## Install

```bash
pip install psy-hermes
psy-hermes init --actor-id you@example.com
```

This adds a `plugins.psy` block to `~/.hermes/config.yaml`. Then run Hermes as usual; the plugin loads via Hermes's `hermes_agent.plugins` entry-point group.

If `psy` is not on your PATH, the plugin falls back to `npx -y psy-core@<exact-version> psy ingest`. Most modern dev machines already have Node.js, so this Just Works; if you want to skip the npx round-trip, install psy-core globally with `npm i -g psy-core`.

## What gets captured

Every memory mutation Hermes exposes, mapped to psy-core's canonical operation vocabulary.

| psy operation | Hermes source                                       | Captured via                                         |
|---------------|-----------------------------------------------------|------------------------------------------------------|
| `create`      | `memory` tool with `action: "add"`                  | `pre_tool_call` (intent) + filesystem watcher (result) |
| `str_replace` | `memory` tool with `action: "replace"`              | `pre_tool_call` + filesystem watcher                 |
| `delete`      | `memory` tool with `action: "remove"`               | `pre_tool_call` + filesystem watcher                 |
| `create`      | `skill_manage` with `action: "create"` / `"write_file"` | `pre_tool_call` + `post_tool_call`                |
| `str_replace` | `skill_manage` with `action: "edit"` / `"patch"`    | `pre_tool_call` + `post_tool_call`                   |
| `delete`      | `skill_manage` with `action: "delete"` / `"remove_file"` | `pre_tool_call` + `post_tool_call`              |

Every mutation produces a paired intent + result row, the same shape as every other psy-core adapter.

## Scope (and what's deliberately out of scope)

`psy-hermes` is **memory-only** in v0.4. Tool call telemetry (terminal, web search, MCP), LLM call telemetry (`pre_llm_call` / `post_llm_call`), session lifecycle (`on_session_start`/`end`/`finalize`/`reset`), and subagent stops are not subscribed. They return as separate scopes (e.g. `psy-hermes-cost`, `psy-hermes-llm`) if user demand surfaces.

We also do not capture writes for which Hermes exposes no hook — SessionDB summaries, trajectory JSONL writes, `flush_memories()`, and gateway transport events. These would each require an upstream Hermes PR.

## Identity

`actor_id` is **required** unless `allow_anonymous: true`. Audit events must attribute the session to a principal. When `actor_id` is missing the plugin emits the F4 error template at session start and refuses to register hooks:

```
psy-hermes: actor_id is required.
  Why:    audit events must attribute the session to a principal.
  Where:  ~/.hermes/config.yaml -> plugins.psy.actor_id
  Example:
    plugins:
      psy:
        actor_id: alice@acme.com
  Bypass: set allow_anonymous: true (not recommended in production).
  Docs:   https://github.com/jethros-projects/psy-core/blob/main/python/psy-hermes/README.md#identity
```

## Configuration

```yaml
# ~/.hermes/config.yaml
plugins:
  enabled:
    - psy

  psy:
    enabled: true
    actor_id: alice@acme.com         # REQUIRED unless allow_anonymous: true
    tenant_id: acme                  # optional
    purpose: production-debug        # optional

    db_path: ~/.psy/audit.db         # optional; default <HERMES_HOME>/psy/audit.db
    seal_key_path: ~/.psy/seal-key   # optional
    memories_dir: ~/.hermes/memories # filesystem-watched dir

    psy_core_version: 0.4.0          # exact pin (used for npx fallback)
    psy_binary: null                 # optional override

    redactor: default                # default | none | "<dotted_path>"
    payload_capture: true            # capture memory content (with redaction)
    dry_run: false
    log_level: info
    allow_anonymous: false
    schema_version_pin: "1.0.0"
```

## Console scripts

```bash
psy-hermes init [--actor-id NAME]   # idempotent config block insertion
psy-hermes doctor                   # config + paths + subprocess handshake test
psy-hermes status                   # one-line summary
psy-hermes dry-run < envelopes.jsonl  # emit envelopes locally; never spawn ingest
```

## Architecture

```
┌─────────────────────────────────────────┐         ┌─────────────────────┐
│ Hermes process (Python)                 │         │ psy ingest (Node)   │
│                                         │         │                     │
│  psy_hermes.register(ctx)               │         │  Auditor.append()   │
│   ├─ register_hook(pre_tool_call,       │         │  Sealer.writeHead() │
│   │   filter: tool_name in              │  JSONL  │  ↓                  │
│   │   {"memory","skill_manage"})        │  ──────▶│  ~/.psy/audit.db    │
│   └─ register_hook(post_tool_call,      │  stdio  │  ~/.psy/head.json   │
│       filter: tool_name=="skill_manage")│  ◀─ACK  │  ~/.psy/seal-key    │
│                                         │         │                     │
│  Filesystem watcher (watchdog)          │         └─────────────────────┘
│   ├─ ~/.hermes/memories/MEMORY.md       │
│   ├─ ~/.hermes/memories/USER.md         │         Spawn flow:
│   └─ on change: emit confirmed-result   │           1. shutil.which("psy") → use directly
│                                         │           2. else npx -y psy-core@X psy ingest
│  IngestClient (thread-safe queue)       │           3. else error: install psy-core or Node
│   ├─ enqueue(envelope)                  │
│   ├─ background writer thread           │
│   └─ atexit + SIGTERM cleanup           │
└─────────────────────────────────────────┘
```

## Distribution

- **Primary:** PyPI as `psy-hermes`. Auto-discovered via `hermes_agent.plugins` entry-point.
- **Secondary:** `hermes plugins install jethros-projects/psy-hermes` (Hermes's own installer; runs `git clone --depth 1` against the in-repo path).

## Verification

```bash
psy verify --all   # full chain integrity check + sealed-tail verify
```

The TS-side `psy verify` reads `~/.psy/audit.db`, walks the hash chain, validates the HMAC seal, and exits non-zero on any tampering.

## License

MIT
