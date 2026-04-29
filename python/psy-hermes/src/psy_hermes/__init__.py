"""psy-hermes — tamper-evident memory audit for Hermes Agent.

A plain Hermes plugin that subscribes to `pre_tool_call` (filtered to the
`memory` and `skill_manage` tools) and `post_tool_call` (filtered to
`skill_manage`), plus a filesystem watcher on the user's memory files. Each
captured event is forwarded as a JSONL envelope over stdio to a long-lived
`psy ingest` subprocess (TypeScript binary, either `psy` on PATH or
`npx -y psy-core@<exact> psy ingest`).

The TypeScript side is the sole writer of the audit chain: this Python
package never touches the SQLite DB, the seal key, or `head.json`.

Plugin entry point: `psy_hermes.register` (see `register.py`).
"""

from __future__ import annotations

from psy_hermes._version import (
    INGEST_PROTOCOL_VERSION,
    PSY_CORE_SCHEMA_VERSION,
    PSY_CORE_VERSION,
    PSY_HERMES_VERSION,
)

# The Hermes plugin entry point is `psy_hermes.register:register` (see
# pyproject.toml). We deliberately do NOT re-export the `register` function
# at the package root: doing so would rebind `psy_hermes.register` (the
# submodule) to the function, breaking `import psy_hermes.register` and
# anything that depends on submodule-level monkeypatching.
__all__ = [
    "INGEST_PROTOCOL_VERSION",
    "PSY_CORE_SCHEMA_VERSION",
    "PSY_CORE_VERSION",
    "PSY_HERMES_VERSION",
]

__version__ = PSY_HERMES_VERSION
