# psy-core-hermes

> Tamper-evident memory audit log for your Hermes agent.
> Every memory write — to MEMORY.md, USER.md, or skills — hash-chained and HMAC-sealed.
> One `pip install`.

[![PyPI](https://img.shields.io/pypi/v/psy-core-hermes.svg)](https://pypi.org/project/psy-core-hermes/)
[![Python](https://img.shields.io/pypi/pyversions/psy-core-hermes.svg)](https://pypi.org/project/psy-core-hermes/)
[![License](https://img.shields.io/pypi/l/psy-core-hermes.svg)](https://github.com/jethros-projects/psy-core/blob/main/LICENSE)

`psy-core-hermes` is the Hermes Agent companion to [`psy-core`](https://www.npmjs.com/package/psy-core). It registers as a plain Hermes plugin, observes every memory mutation, and forwards each one to a long-lived `psy ingest` subprocess that writes the canonical hash-chained, HMAC-sealed audit log to `~/.psy/audit.db`.

## Install

```bash
pip install psy-core-hermes
psy-core-hermes init --actor-id you@example.com
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

## Hermes memory surface — what's captured and what's not

Hermes has more than one kind of memory. v0.4 deliberately covers the file-backed `memory` tool plus `skill_manage`, and explicitly stays out of the way of everything else. The boundary is pinned by tests at `tests/test_real_hermes.py`.

| # | Surface | Hookable? | v0.4 |
|---|---|:---:|:---:|
| 1 | `memory` tool — `add/replace/remove × {memory,user}` writing MEMORY.md / USER.md | ✅ via `pre_tool_call` + filesystem watcher | **Captured** |
| 2 | `skill_manage` tool — SKILL.md + sub-files | ✅ via `pre_tool_call` + `post_tool_call` | **Captured** |
| 3 | **MemoryProvider plugins** — Honcho, Mem0, Hindsight, Byterover, Holographic, OpenViking, RetainDB, Supermemory; each exposes its own write tools (`honcho_conclude`, `mem0_conclude`, `hindsight_retain`, `fact_store`, `viking_remember`, `retaindb_remember`/`ingest_file`, `supermemory_store`, `brv_curate`, …) | ✅ via `pre_tool_call` (verified at `run_agent.py:9051`'s `_invoke_tool` block — the hook fires before `memory_manager.handle_tool_call`) | **Not captured** in v0.4. Write-tool capture is the single largest v0.5 candidate; turn-on is one allowlist edit. |
| 4 | MemoryProvider lifecycle hooks (`sync_turn`, `on_turn_start`, `on_session_end`, `on_pre_compress`, `on_memory_write`, `on_delegation`) | Subclass-only — `MemoryManager.add_provider` is single-select, so subclassing locks the user out of running Honcho/Mem0/Hindsight alongside psy | Out of scope (architectural — would require psy-core-hermes to BE the user's MemoryProvider, which the plan explicitly rejected) |
| 5 | `session_search` (read-only SessionDB query) | ✅ via `pre_tool_call` (in `_AGENT_LOOP_TOOLS`, no post) | Not captured (read-only) |
| 6 | `todo` tool | ✅ via `pre_tool_call` (in `_AGENT_LOOP_TOOLS`) | Not captured (not memory) |
| 7 | SessionDB writes (cross-session summaries) | ❌ no upstream hook | Out of scope (would need an upstream PR) |
| 8 | Trajectory JSONL writes | ❌ no upstream hook | Out of scope (would need an upstream PR) |
| 9 | `flush_memories()` auxiliary writes | ❌ no upstream hook | Out of scope (would need an upstream PR) |
| 10 | Gateway transport events | Separate `gateway/hooks.py` registry | Separate adapter scope |

Note on #3 ↔ #1: at `run_agent.py:9098`, when the file-backed `memory` tool runs, Hermes also calls `memory_manager.on_memory_write(...)` so any active external MemoryProvider can mirror the write semantically. That makes psy-core-hermes (audit) and Honcho/Mem0 (semantic recall) **complementary observers of the same write**, not competing writers — they're additive.

If you need Mem0/Letta/LangChain memory audited at the API level (rather than via Hermes's tool dispatch), psy-core ships dedicated adapters for those frameworks; see the [adapter table in the root README](../../README.md#supported-memory-frameworks).

## Identity

`actor_id` is **required** unless `allow_anonymous: true`. Audit events must attribute the session to a principal. When `actor_id` is missing the plugin emits the F4 error template at session start and refuses to register hooks:

```
psy-core-hermes: actor_id is required.
  Why:    audit events must attribute the session to a principal.
  Where:  ~/.hermes/config.yaml -> plugins.psy.actor_id
  Example:
    plugins:
      psy:
        actor_id: alice@acme.com
  Bypass: set allow_anonymous: true (not recommended in production).
  Docs:   https://github.com/jethros-projects/psy-core/blob/main/python/psy-core-hermes/README.md#identity
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
psy-core-hermes init [--actor-id NAME]   # idempotent config block insertion
psy-core-hermes doctor                   # config + paths + subprocess handshake test
psy-core-hermes status                   # one-line summary
psy-core-hermes dry-run < envelopes.jsonl  # emit envelopes locally; never spawn ingest
```

## Architecture

```
┌─────────────────────────────────────────┐         ┌─────────────────────┐
│ Hermes process (Python)                 │         │ psy ingest (Node)   │
│                                         │         │                     │
│  psy_core.hermes.register(ctx)               │         │  Auditor.append()   │
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

- **Primary:** PyPI as `psy-core-hermes`. Auto-discovered via `hermes_agent.plugins` entry-point.
- **Secondary:** `hermes plugins install jethros-projects/psy-core-hermes` (Hermes's own installer; runs `git clone --depth 1` against the in-repo path).

## Verification

```bash
psy verify --all   # full chain integrity check + sealed-tail verify
```

The TS-side `psy verify` reads `~/.psy/audit.db`, walks the hash chain, validates the HMAC seal, and exits non-zero on any tampering.

### Verified against hermes-agent v0.11.0

The plugin contract was source-verified against
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) at
v0.11.0:

- Entry-point group is `hermes_agent.plugins`; the loader does
  `ep.load()` and then `getattr(module, "register")`, so our entry-point
  value is the **module path** `psy_core.hermes.register` (not the `module:attr`
  form — that returns the function from `ep.load()` and breaks the
  `getattr(module, "register")` lookup).
- `_AGENT_LOOP_TOOLS = {"todo", "memory", "session_search", "delegate_task"}`
  — confirmed `memory` bypasses `post_tool_call`; we use the filesystem
  watcher to confirm result envelopes for memory writes.
- `memory` tool args: `{action, target, content, old_text}` where
  `target ∈ {"memory", "user"}` maps to `MEMORY.md` / `USER.md`.
- `skill_manage` args: `{action, name, content?, old_string?, new_string?,
  file_path?, file_content?, ...}`. Skill key is `name`; `file_path` is
  the optional sub-path under the skill directory.
- Hook callback signature: keyword-only
  `(*, tool_name, args, task_id, session_id, tool_call_id, **_)`.
- `hermes_cli.config.load_config()` returns the parsed YAML as a dict.

A live integration test that loads our plugin into a real Hermes
`PluginManager` and asserts captured envelopes is part of the e2e
workflow at `.github/workflows/cross-lang-e2e.yml`.

## License

MIT
