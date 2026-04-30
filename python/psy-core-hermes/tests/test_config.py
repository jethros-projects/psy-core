"""Config loading + F4 error template snapshot tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from psy_core.hermes._version import PSY_CORE_SCHEMA_VERSION, PSY_CORE_VERSION
from psy_core.hermes.config import (
    PsyHermesConfig,
    format_actor_id_required_error,
    load_psy_config,
)


def test_load_psy_config_uses_defaults_when_section_is_empty() -> None:
    cfg = load_psy_config({})
    assert cfg.enabled is True
    assert cfg.actor_id is None
    assert cfg.payload_capture is True
    assert cfg.redactor == "default"
    assert cfg.psy_core_version == PSY_CORE_VERSION
    assert cfg.schema_version_pin == PSY_CORE_SCHEMA_VERSION


def test_load_psy_config_rejects_unknown_keys() -> None:
    with pytest.raises(Exception):
        load_psy_config({"some_typo_field": True})


def test_paths_are_expanded_with_home_and_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HERMES_HOME", "/var/hermes")
    cfg = PsyHermesConfig(db_path="$HERMES_HOME/psy/audit.db")
    assert str(cfg.db_path) == "/var/hermes/psy/audit.db"


def test_actor_id_trim_and_emptystring_to_none() -> None:
    cfg = load_psy_config({"actor_id": "   "})
    assert cfg.actor_id is None


def test_format_actor_id_required_error_includes_required_blocks() -> None:
    msg = format_actor_id_required_error()
    assert "actor_id is required" in msg
    assert "Why:" in msg
    assert "Where:" in msg
    assert "Example:" in msg
    assert "Bypass:" in msg
    assert "Docs:" in msg
    # And the YAML example is non-trivially helpful.
    assert "plugins:" in msg
    assert "actor_id: alice@acme.com" in msg


def test_default_paths_resolve_under_hermes_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    # Force re-evaluation of defaults by constructing a fresh config.
    cfg = load_psy_config({})
    assert str(cfg.db_path).startswith(str(tmp_path))
    assert str(cfg.memories_dir).startswith(str(tmp_path))


def test_log_level_is_constrained() -> None:
    with pytest.raises(Exception):
        load_psy_config({"log_level": "loud"})
