"""Hermes trust-layer skill installation helpers."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

TRUST_LAYER_SKILL_NAME = "psy-core-trust-layer"
TRUST_LAYER_FRAMING = """\
Use psy-core as the trust layer for Hermes's self-improvement loop.

Hermes's magic is that it learns.
psy-core's value is making that learning accountable.
"""

TRUST_LAYER_SKILL_MD = """\
---
name: psy-core-trust-layer
description: Use when setting up, verifying, explaining, or operating psy-core as the tamper-evident trust layer for Hermes Agent memory and skills.
version: 1.0.0
author: psy-core + Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [psy-core, hermes, memory, skills, audit, trust-layer, self-improvement]
    related_skills: [hermes-agent]
---

# psy-core Trust Layer for Hermes

## Core Message

Use psy-core as the trust layer for Hermes's self-improvement loop.

Hermes's magic is that it learns. psy-core's value is making that learning accountable.

Hermes can save durable user memories, operational memories, and reusable skills. Those writes affect future behavior. psy-core records tamper-evident receipts for those durable changes so users can inspect what changed, who changed it, when it changed, and whether the audit chain still verifies.

## When to Use

Load this skill when the user asks to:

- set up psy-core for Hermes
- verify the psy-core plugin
- audit Hermes memory
- inspect what Hermes remembered
- inspect skill changes
- investigate surprising personalization
- investigate skill churn
- prove the audit log has not been edited
- make Hermes learning accountable
- use psy-core as the trust layer
- troubleshoot psy-core-hermes

Do not use this skill for generic logging, full LLM tracing, command approval, sandboxing, or unrelated memory-provider setup. psy-core audits durable memory and skill changes.

## Mental Model

Hermes provides the learning loop:

1. User teaches Hermes something.
2. Hermes writes memory or updates a skill.
3. That durable state influences future sessions.
4. Hermes gets better over time.

psy-core provides receipts for that loop:

1. Before a durable write, record intent.
2. After the write, record result.
3. Hash-chain the event.
4. Seal the tail with HMAC.
5. Verify later with `psy verify --all`.

## What psy-core-hermes Captures

Captured:

- memory add/replace/remove targeting `MEMORY.md`
- memory add/replace/remove targeting `USER.md`
- `skill_manage` create/edit/patch/delete
- `skill_manage` write_file/remove_file for skill support files
- filesystem-observed changes to native Hermes memory files

Not captured:

- every terminal command
- every LLM call
- every browser action
- every gateway message
- read-only `session_search`
- temporary todo state
- external memory-provider internals unless those providers have their own psy-core adapter

## Setup Verification

First identify the Hermes runtime Python. Do not use a random `python` or `pip`.

```bash
HERMES_BIN=$(command -v hermes)
HERMES_PY=$(head -1 "$HERMES_BIN" | sed 's/^#!//')
"$HERMES_PY" --version
```

Check the adapter package and entrypoint:

```bash
"$HERMES_PY" - <<'PY'
import importlib.metadata as md

try:
    d = md.distribution("psy-core-hermes")
    print("psy-core-hermes", d.version, d.locate_file(""))
except Exception as e:
    print("psy-core-hermes missing:", e)

print("Hermes plugin entrypoints:")
for ep in md.entry_points(group="hermes_agent.plugins"):
    print(ep.name, ep.value, ep.dist.metadata["Name"], ep.dist.version)
PY
```

Run deterministic checks:

```bash
"$HERMES_PY" -m psy_core.hermes.cli doctor
"$HERMES_PY" -m psy_core.hermes.cli status
```

## Required Configuration

Recommended production shape in `~/.hermes/config.yaml`:

```yaml
plugins:
  enabled:
    - psy

  psy:
    enabled: true
    actor_id: alice@example.com
    allow_anonymous: false
    psy_core_version: "0.4.0"
    psy_binary: /absolute/path/to/psy
    payload_capture: true
    redactor: default
```

For local experiments only, `allow_anonymous: true` is acceptable. For shared machines, gateway bots, teams, or real user data, set `actor_id` and keep `allow_anonymous: false`.

## Fresh Process Requirement

Hermes discovers plugins at process startup. If psy-core-hermes was installed or enabled after the current Hermes process started, tell the user to restart Hermes.

A running Hermes agent may not have the plugin hooks loaded yet.

## Smoke Test

To test end-to-end behavior, use a fresh one-shot Hermes process after enabling the plugin.

```bash
MARKER="psy smoke test $(date -u +%Y%m%dT%H%M%SZ)"
hermes chat -q "Use your memory tool to remember this exact sentence: $MARKER"
```

Then query and verify the audit DB. Use the same paths the plugin uses:

```bash
export PSY_AUDIT_DB_PATH="$HOME/.hermes/psy/audit.db"
export PSY_ARCHIVES_PATH="$HOME/.hermes/psy/archives"
export PSY_SEAL_KEY_PATH="$HOME/.hermes/psy/seal-key"
export PSY_HEAD_PATH="$HOME/.hermes/psy/head.json"

psy verify --all --no-color
psy query --json
```

## Skill Churn Review

Skills are procedural memory. Churn is a quality signal.

```bash
HERMES_PY=$(head -1 "$(command -v hermes)" | sed 's/^#!//')
"$HERMES_PY" -m psy_core.hermes.cli skill-stats --since 7d
```

Interpret results:

- `ok`: skill is stable.
- `unstable`: skill has high patch churn or rapid repeated edits.
- `short-lived`: skill was created and deleted quickly.

If a skill is unstable, inspect recent audit events and recommend one of:

- rewrite the skill for clarity
- add missing prerequisites
- add pitfalls discovered during failures
- split the skill into narrower skills
- replace fragile prose with tested code or scripts

## Incident Response

Use this workflow when Hermes behaves differently because of a suspected memory or skill change:

1. Ask what changed behavior the user observed.
2. Run `psy verify --all --no-color`.
3. If verification fails, report that the audit chain itself is suspect.
4. Query recent events by actor/session if known.
5. Look for memory writes to `MEMORY.md` or `USER.md`.
6. Look for `skill_manage` edits around the relevant time.
7. Identify the intent/result pair.
8. Explain what changed and which session/actor changed it.
9. If needed, use Hermes memory or `skill_manage` to remove or patch the bad durable state.
10. Verify again.

## Optional Scheduled Checks

If the user wants ongoing assurance, offer to create scheduled jobs:

- daily: run `psy verify --all`
- weekly: run `psy-core-hermes skill-stats --since 7d`
- monthly: summarize memory and skill mutation counts

Do not create scheduled jobs without the user's approval. Prefer Hermes-native scheduling tools when available.

## Common Pitfalls

1. Using system Python instead of Hermes Python.

   Always resolve `HERMES_PY` from the Hermes shebang.

2. Expecting the current session to see a newly installed plugin.

   Restart Hermes after installing or enabling psy-core-hermes.

3. Leaving production installs anonymous.

   `allow_anonymous: true` is for local testing. Real deployments should set `actor_id`.

4. Treating psy-core as a full tracing system.

   psy-core audits durable memory and skill changes. It does not replace Langfuse-style tracing.

5. Treating redaction as perfect DLP.

   Default redaction catches common secret patterns but is not a complete data-loss-prevention system.

6. Forgetting explicit psy paths.

   If `psy` is not on PATH, configure `plugins.psy.psy_binary`.

7. Running `psy verify` against the wrong DB.

   Use the same `PSY_AUDIT_DB_PATH`, `PSY_ARCHIVES_PATH`, `PSY_SEAL_KEY_PATH`, and `PSY_HEAD_PATH` that the plugin uses.

## Verification Checklist

- [ ] psy-core-hermes is installed in the Hermes Python runtime.
- [ ] `hermes_agent.plugins` includes entrypoint `psy`.
- [ ] `plugins.enabled` includes `psy`.
- [ ] `plugins.psy.enabled` is true.
- [ ] `actor_id` is set for real deployments.
- [ ] `allow_anonymous` is false for real deployments.
- [ ] `psy-core-hermes doctor` passes.
- [ ] `psy verify --all` passes.
- [ ] A fresh Hermes process can write memory and produce audit rows.
- [ ] `skill-stats` works.
- [ ] The user understands: Hermes learns; psy-core makes that learning accountable.
"""


@dataclass(frozen=True)
class SkillInstallResult:
    path: Path
    changed: bool
    backup_path: Path | None = None


def default_trust_layer_skill_path(hermes_home: Path | None = None) -> Path:
    if hermes_home is not None:
        root = hermes_home
    elif raw := os.environ.get("HERMES_HOME"):
        root = Path(os.path.expandvars(os.path.expanduser(raw)))
    else:
        root = Path.home() / ".hermes"
    return root / "skills" / "devops" / TRUST_LAYER_SKILL_NAME / "SKILL.md"


def install_trust_layer_skill(
    path: Path,
    *,
    backup_existing: bool = True,
) -> SkillInstallResult:
    path = path.expanduser()
    content = TRUST_LAYER_SKILL_MD
    if path.exists():
        existing = path.read_text(encoding="utf-8")
        if existing == content:
            return SkillInstallResult(path=path, changed=False)
        backup_path = None
        if backup_existing:
            backup_path = _next_backup_path(path)
            backup_path.write_text(existing, encoding="utf-8")
    else:
        backup_path = None

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return SkillInstallResult(path=path, changed=True, backup_path=backup_path)


def _next_backup_path(path: Path) -> Path:
    for suffix in ["bak", *(f"bak.{i}" for i in range(1, 1000))]:
        candidate = path.with_name(f"{path.name}.{suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"could not choose a backup path for {path}")
