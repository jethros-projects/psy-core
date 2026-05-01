"""Version pins for psy-core-hermes.

The exact JS version of psy-core that this Python package release ships
against. The npx fallback uses this exact value (never a range, never
`latest`) so a pinned Python release always boots against a known-compatible
TypeScript ingest binary.
"""

from __future__ import annotations

#: This package's version (must match pyproject.toml).
PSY_CORE_HERMES_VERSION: str = "0.1.2"

#: The exact psy-core JS version this release pins. The npx fallback runs
#: `npx -y psy-core@<PSY_CORE_VERSION> psy ingest`. The cross-lang-e2e CI
#: workflow asserts that this pin still ingests cleanly end-to-end.
PSY_CORE_VERSION: str = "0.4.0"

#: The on-disk audit schema version this release was tested against. Used
#: as the default for `schema_version_pin`; if the subprocess handshake
#: reports a different schema version, the plugin logs a WARN.
PSY_CORE_SCHEMA_VERSION: str = "1.0.0"

#: The ingest protocol version (handshake `version` field). Independent of
#: the on-disk schema; tracks the wire format between Python and Node.
INGEST_PROTOCOL_VERSION: str = "1.0.0"
