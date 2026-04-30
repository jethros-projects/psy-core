"""Typed configuration for psy-core-hermes.

Read from `~/.hermes/config.yaml` under `plugins.psy` via Hermes's standard
`hermes_cli.config.load_config` idiom. Pydantic validates required fields
and rejects unknown keys with the F4-template error message format.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from psy_core.hermes._version import PSY_CORE_SCHEMA_VERSION, PSY_CORE_VERSION


def _expand(path: str | os.PathLike[str]) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(str(path))))


def _default_hermes_home() -> Path:
    raw = os.environ.get("HERMES_HOME")
    if raw:
        return _expand(raw)
    return Path.home() / ".hermes"


def _default_db_path() -> Path:
    return _default_hermes_home() / "psy" / "audit.db"


def _default_seal_key_path() -> Path:
    return _default_hermes_home() / "psy" / "seal-key"


def _default_memories_dir() -> Path:
    return _default_hermes_home() / "memories"


class PsyHermesConfig(BaseModel):
    """User-facing config schema.

    Loaded from YAML under `plugins.psy`. Keys are intentionally explicit;
    `extra=forbid` rejects typos so misconfigurations fail loud at session
    start rather than silently doing nothing.
    """

    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    actor_id: str | None = None
    tenant_id: str | None = None
    purpose: str | None = None

    db_path: Path = Field(default_factory=_default_db_path)
    seal_key_path: Path = Field(default_factory=_default_seal_key_path)
    memories_dir: Path = Field(default_factory=_default_memories_dir)

    psy_core_version: str = PSY_CORE_VERSION
    psy_binary: str | None = None

    redactor: Literal["default", "none"] | str = "default"
    payload_capture: bool = True
    dry_run: bool = False
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    allow_anonymous: bool = False
    schema_version_pin: str = PSY_CORE_SCHEMA_VERSION

    @field_validator("db_path", "seal_key_path", "memories_dir", mode="before")
    @classmethod
    def _expand_paths(cls, value: Any) -> Any:
        if value is None:
            return value
        if isinstance(value, Path):
            return _expand(value)
        if isinstance(value, str):
            return _expand(value)
        return value

    @field_validator("actor_id", "tenant_id", "purpose", mode="before")
    @classmethod
    def _trim_optional_str(cls, value: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, str):
            trimmed = value.strip()
            return trimmed or None
        return value


def load_psy_config(raw: dict[str, Any] | None) -> PsyHermesConfig:
    """Build a typed config object from a plain dict (or None for defaults).

    Pydantic's validation error is intentionally let through; the caller
    formats it via `format_config_error`. This keeps the F4 error template
    in one place rather than scattering it through register/CLI/doctor.
    """

    return PsyHermesConfig.model_validate(raw or {})


F4_ERROR_TEMPLATE = """\
psy-core-hermes: {summary}
  Why:    {why}
  Where:  {where}
  Example:
{example}
{bypass_block}  Docs:   https://github.com/jethros-projects/psy-core/blob/main/python/psy-core-hermes/README.md{anchor}
"""


def format_actor_id_required_error() -> str:
    """Standard F4 error message for the missing-actor-id case."""
    return F4_ERROR_TEMPLATE.format(
        summary="actor_id is required.",
        why="audit events must attribute the session to a principal.",
        where="~/.hermes/config.yaml -> plugins.psy.actor_id",
        example="    plugins:\n      psy:\n        actor_id: alice@acme.com",
        bypass_block="  Bypass: set allow_anonymous: true (not recommended in production).\n",
        anchor="#identity",
    )
