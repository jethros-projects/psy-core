# psy-core-hermes

Hermes learns by rewriting durable files. psy-core-hermes gives those changes receipts.

Package: [`psy-core-hermes`](https://pypi.org/project/psy-core-hermes/). Core: [psy-core](../../README.md). Example: [Hermes lab](../../examples/hermes-agent/README.md). Upstream: [Hermes Agent](https://github.com/NousResearch/hermes-agent). Issues: [GitHub Issues](https://github.com/jethros-projects/psy-core/issues).

Hermes is built to improve itself. It saves memories, updates user profiles, creates skills, and patches those skills as recurring work gets clearer. That learning loop is the magic. It is also the reason durable writes need an audit trail.

**psy-core-hermes is the Hermes Agent plugin for [psy-core](https://github.com/jethros-projects/psy-core).** It listens at the Hermes tool boundary, watches the file-backed memory directory, and streams canonical audit envelopes into `psy ingest`. The Node `psy` verifier then writes the same SQLite hash chain and HMAC-sealed head used by every psy-core integration.

It does not replace Hermes memory. It does not become your MemoryProvider. Hermes keeps improving in the normal way. You get a verifiable trail of what changed.

> **Five minutes to a trust layer.** Install the package, run `trust-layer`, restart Hermes, and watch paired `intent` / `result` rows land with `psy tail`.

## Who This Is For

- **Hermes operators** who want memory and skill changes to be inspectable after the fact.
- **Agent builders** who need Hermes to keep learning without switching memory providers.
- **Teams running persistent agents** who need to answer what changed, when, and under which actor.
- **Security-minded users** who want tamper-evident local receipts before making larger governance claims.

## Quick Install

```bash
pip install psy-core-hermes
psy-core-hermes trust-layer --actor-id you@example.com
```

That command configures the plugin, installs the local Hermes skill `psy-core-trust-layer`, runs `doctor`, and runs `psy verify --all`.

Then restart Hermes:

```bash
hermes
```

Inside Hermes, ask:

```text
Use the psy-core trust layer skill to verify my setup.
```

In another terminal:

```bash
psy tail
```

When Hermes writes `MEMORY.md`, `USER.md`, or a skill file, you should see paired `intent` and `result` rows. Verify the chain at any time:

```bash
psy verify --all
```

The smaller `psy-core-hermes init --actor-id you@example.com` command is still
available when you only want idempotent config insertion.

## See It Work

```text
Hermes: save that Alice prefers short incident summaries.

psy:    intent  operation=create actor=you@example.com path=MEMORY.md

Hermes: writes the memory file

psy:    result  status=success hash=... prev_hash=...

You:    psy query --actor you@example.com

psy:    shows the attempted memory write, confirmed result, session,
        timestamp, redacted preview, and chain position

You:    psy verify --all

psy:    active DB, archives, orphan checks, and sealed tail agree
```

Hermes keeps the learning loop. psy-core-hermes gives the loop receipts.

## Why This Exists

Hermes memory is valuable because it persists. That persistence is also why it deserves an audit trail.

Use psy-core-hermes when you want to answer questions like:

- What did Hermes just remember about this user?
- Which session created or edited this skill?
- Did a memory write fail, or did Hermes never attempt it?
- Did a skill churn through several rapid patches after creation?
- Has the audit log been edited, reordered, or truncated since it was written?

The plugin gives operators receipts without forcing Hermes into a new memory backend.

## The Hermes Audit Loop

```text
Hermes Agent process                        psy-core audit process
--------------------                        ----------------------
pre_tool_call hook
  memory / skill intent  ----------------->  psy ingest writes intent row

Hermes executes the tool
  MEMORY.md / USER.md changes
  SKILL.md or skill file changes

filesystem watcher / post_tool_call ------>  psy ingest writes result row

                                             SQLite row is canonicalized
                                             row hash chains to previous row
                                             HMAC sealed head is advanced
```

The Python plugin owns observation. The Node `psy` CLI owns the canonical audit chain. That split keeps one verifier for every psy-core integration, whether events originate from TypeScript, Python, or another language.

## What Gets Captured

| Hermes action | psy operation | Result confirmation |
|---|---|---|
| `memory` add to `MEMORY.md` or `USER.md` | `create` | Filesystem watcher |
| `memory` replace in `MEMORY.md` or `USER.md` | `str_replace` | Filesystem watcher |
| `memory` remove from `MEMORY.md` or `USER.md` | `delete` | Filesystem watcher |
| `skill_manage` create skill or file | `create` | `post_tool_call` |
| `skill_manage` edit or patch skill/file | `str_replace` | `post_tool_call` |
| `skill_manage` delete skill/file | `delete` | `post_tool_call` |

Hermes handles the `memory` tool inside its agent loop, so there is no normal post-tool hook for memory writes. psy-core-hermes records the pre-tool intent and lets `watchdog` confirm the resulting file change.

## What Stays Out of Scope

| Surface | Captured? | Why |
|---|---:|---|
| `MEMORY.md` and `USER.md` writes through the built-in `memory` tool | Yes | Core file-backed Hermes memory |
| Skills written through `skill_manage` | Yes | Durable procedural memory |
| External MemoryProvider tools such as Honcho, Mem0, Hindsight, RetainDB, Supermemory, and Byterover | No | Separate provider-specific memory surfaces |
| MemoryProvider lifecycle hooks | No | Becoming a provider would block users from running their chosen provider |
| `session_search` | No | Read-only lookup |
| `todo` | No | Task state, not memory |
| SessionDB summaries, trajectory JSONL, `flush_memories()` writes | No | No stable upstream hook today |
| Gateway transport events | No | Separate adapter surface |

This boundary is intentional. psy-core-hermes should be the audit witness for Hermes's native durable memory paths, not a competing memory system.

If your app also calls Mem0, Letta, LangChain, or LangGraph directly, use the dedicated adapters in the [root psy-core README](../../README.md#what-it-captures).

## Operator Quick Reference

| Goal | Command |
|---|---|
| Configure plugin, install skill, run doctor, and verify | `psy-core-hermes trust-layer --actor-id you@example.com` |
| Install or refresh only the Hermes operating skill | `psy-core-hermes install-skill` |
| Enable only the plugin in `~/.hermes/config.yaml` | `psy-core-hermes init --actor-id you@example.com` |
| Allow anonymous local testing | `psy-core-hermes init --allow-anonymous` |
| Diagnose config, paths, Node, `npx`, and subprocess handshake | `psy-core-hermes doctor` |
| Print a compact current status | `psy-core-hermes status` |
| Inspect JSONL envelopes without spawning `psy ingest` | `psy-core-hermes dry-run < envelopes.jsonl` |
| See live audit rows | `psy tail` |
| Query by actor | `psy query --actor you@example.com` |
| Verify chain integrity | `psy verify --all` |
| Rank unstable skills by churn | `psy-core-hermes skill-stats` |

## Install Details

`psy-core-hermes` is a Python package with a Hermes plugin entry point:

```toml
[project.entry-points."hermes_agent.plugins"]
psy = "psy_core.hermes.register"
```

After `psy-core-hermes trust-layer --actor-id you@example.com`, your Hermes
config contains the plugin block plus explicit trust-layer paths:

```yaml
plugins:
  enabled:
    - psy

  psy:
    enabled: true
    actor_id: you@example.com
    allow_anonymous: false
    db_path: ~/.hermes/psy/audit.db
    seal_key_path: ~/.hermes/psy/seal-key
    memories_dir: ~/.hermes/memories
    psy_core_version: 0.5.1
```

The command also writes:

```text
~/.hermes/skills/devops/psy-core-trust-layer/SKILL.md
```

Useful bootstrap flags:

```bash
psy-core-hermes trust-layer --actor-id alice@example.com --no-verify
psy-core-hermes trust-layer --actor-id alice@example.com --psy-binary /usr/local/bin/psy
psy-core-hermes trust-layer --actor-id alice@example.com --no-payload-capture
psy-core-hermes trust-layer --allow-anonymous   # local experiments only
```

At runtime, the plugin starts the audit writer using this order:

1. Use `psy_binary` if configured.
2. Else use `psy` if it is on `PATH`.
3. Else use `npx -y psy-core@0.5.1 psy ingest`.
4. Else fail with an install diagnostic.

Most users only need `pip install psy-core-hermes`. Installing `psy-core` globally avoids the `npx` fallback:

```bash
npm i -g psy-core
```

## Configuration

Full `plugins.psy` reference:

```yaml
plugins:
  enabled:
    - psy

  psy:
    enabled: true

    # Identity
    actor_id: alice@acme.com          # required unless allow_anonymous: true
    tenant_id: acme                   # optional
    purpose: production-debug         # optional
    allow_anonymous: false

    # Storage; defaults shown for HERMES_HOME unset.
    db_path: ~/.hermes/psy/audit.db
    seal_key_path: ~/.hermes/psy/seal-key
    memories_dir: ~/.hermes/memories

    # Ingest subprocess
    psy_core_version: 0.5.1
    psy_binary: null
    schema_version_pin: "1.0.0"

    # Payload handling
    payload_capture: true
    redactor: default                 # default | none | "<dotted_path>"

    # Debugging
    dry_run: false
    log_level: info
```

`HERMES_HOME` changes the default base directory. Without it, paths resolve under `~/.hermes`.

## Identity Model

`actor_id` is required by default. This is deliberate: an audit log without a principal is only half a receipt.

If `actor_id` is missing, Hermes starts without the plugin hooks and prints:

```text
psy-core-hermes: actor_id is required.
  Why:    audit events must attribute the session to a principal.
  Where:  ~/.hermes/config.yaml -> plugins.psy.actor_id
  Example:
    plugins:
      psy:
        actor_id: alice@acme.com
  Bypass: set allow_anonymous: true (not recommended in production).
  Docs:   https://github.com/jethros-projects/psy-core/blob/main/python/psy-core-hermes/README.md#identity-model
```

For local experiments, use:

```bash
psy-core-hermes init --allow-anonymous
```

For shared machines, hosted agents, or any real user data, set `actor_id`.

## Skill Churn Reports

Hermes skills are procedural memory. A skill that is created once and reused may be healthy; a skill that is patched five times in an hour may be unstable. The audit chain can measure that because every skill write has a timestamp and an immutable order.

```bash
psy-core-hermes skill-stats
```

Example:

```text
SKILL                            CREATE  PATCH  DEL  CHURN  RAPID  STATUS
deploy-runbook                        1      7    0   7.00      5  unstable
flaky-test-recovery                   1      4    0   4.00      4  unstable
release-checklist                     1      0    0   0.00      0  ok

legend: unstable = churn>=2.0 or 3+ rapid patches | short-lived = create+delete within 1 day
```

Useful views:

```bash
psy-core-hermes skill-stats --since 7d
psy-core-hermes skill-stats --actor alice@acme.com
psy-core-hermes skill-stats --top 10
psy-core-hermes skill-stats --skill-md-only
psy-core-hermes skill-stats --json
```

Library usage:

```python
from datetime import timedelta
from pathlib import Path
from psy_core.hermes.skill_stats import compute_skill_stats

metrics = compute_skill_stats(
    Path.home() / ".hermes" / "psy" / "audit.db",
    actor_id="alice@acme.com",
    since=timedelta(days=7),
)

for skill in metrics:
    if skill.status == "unstable":
        print(skill.skill, skill.churn_ratio)
```

The stats path opens SQLite read-only.

## Docs by Goal

| Goal | Where to go |
|---|---|
| Try the plugin quickly | [`../../examples/hermes-agent`](../../examples/hermes-agent/README.md) |
| Understand the core audit chain | [Root psy-core README](../../README.md) |
| See generated Hermes config | [`../../examples/hermes-agent/hermes-config.yaml`](../../examples/hermes-agent/hermes-config.yaml) |
| Debug install issues | `psy-core-hermes doctor` |
| Verify audit integrity | `psy verify --all` |
| Report suspicious skill churn | `psy-core-hermes skill-stats` |

## Versioning and Compatibility

This package version: `psy-core-hermes 0.1.4`

Pinned Node audit engine: `psy-core 0.5.1`

Audit schema: `1.0.0`

Verified Hermes Agent contracts:

| Contract | Behavior |
|---|---|
| Plugin entry point group | `hermes_agent.plugins` |
| Entry point value | Module path `psy_core.hermes.register` |
| Hook signature | Keyword-only `tool_name`, `args`, `task_id`, `session_id`, `tool_call_id`, and extras |
| Memory post-hook behavior | Built-in `memory` bypasses `post_tool_call`; watcher confirms results |
| Memory args | `{action, target, content, old_text}` |
| Skill args | `{action, name, content, old_string, new_string, file_path, file_content, ...}` |

Source verification covers Hermes Agent v0.11.0 (`v2026.4.23`) and v0.12.0 (`v2026.4.30`). The cross-language workflow also loads the plugin into a real Hermes `PluginManager`.

## Security Notes

- The plugin records durable memory writes; it does not approve or deny Hermes tool calls.
- Payload capture is enabled by default for the Hermes plugin so memory content previews are useful. Built-in redaction catches common secret patterns, but it is not a DLP system.
- The seal key protects tail verification. Keep `seal_key_path` private and mode `0600`.
- `psy verify --all` should be part of any incident review involving memory changes.
- Use `allow_anonymous: true` only for local experiments.

## Development

```bash
cd python/psy-core-hermes
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
ruff check .
mypy src
```

Root audit-engine checks:

```bash
cd ../..
npm test
npm run typecheck
npm run build
```

## License

MIT
