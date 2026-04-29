"""Console scripts: init / doctor / status / dry-run."""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import pytest

from psy_hermes.cli import main


def _yaml() -> Any:
    pytest.importorskip("yaml")
    import yaml as _y

    return _y


def test_init_creates_plugins_block_in_fresh_yaml(tmp_path: Path) -> None:
    yaml = _yaml()
    cfg = tmp_path / "config.yaml"
    rc = main(["init", "--actor-id", "alice@acme.com", "--config", str(cfg)])
    assert rc == 0
    contents = yaml.safe_load(cfg.read_text())
    assert "psy" in contents["plugins"]["enabled"]
    assert contents["plugins"]["psy"]["actor_id"] == "alice@acme.com"
    assert contents["plugins"]["psy"]["enabled"] is True
    assert contents["plugins"]["psy"]["psy_core_version"]


def test_init_is_idempotent(tmp_path: Path) -> None:
    yaml = _yaml()
    cfg = tmp_path / "config.yaml"
    cfg.write_text(yaml.safe_dump({"plugins": {"enabled": ["other"], "other": {"a": 1}}}))
    rc = main(["init", "--actor-id", "bob", "--config", str(cfg)])
    assert rc == 0
    contents = yaml.safe_load(cfg.read_text())
    # Existing plugins are preserved.
    assert "other" in contents["plugins"]["enabled"]
    assert contents["plugins"]["other"] == {"a": 1}
    # And psy is added.
    assert "psy" in contents["plugins"]["enabled"]


def test_status_reports_one_line(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    yaml = _yaml()
    cfg = tmp_path / "config.yaml"
    cfg.write_text(yaml.safe_dump({"plugins": {"enabled": ["psy"], "psy": {"actor_id": "alice"}}}))
    rc = main(["status", "--config", str(cfg)])
    assert rc == 0
    out = capsys.readouterr().out
    assert "psy-hermes" in out
    assert "actor=alice" in out


def test_status_returns_2_on_invalid_config(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    yaml = _yaml()
    cfg = tmp_path / "config.yaml"
    cfg.write_text(yaml.safe_dump({"plugins": {"psy": {"unknown_field": True}}}))
    rc = main(["status", "--config", str(cfg)])
    assert rc == 2
    out = capsys.readouterr().out
    assert "config invalid" in out


def test_dry_run_passes_through_envelopes(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(
        "sys.stdin",
        io.StringIO('{"type":"intent","operation":"create","call_id":"a"}\n'),
    )
    rc = main(["dry-run"])
    assert rc == 0
    out = capsys.readouterr().out.strip()
    parsed = json.loads(out)
    assert parsed["envelope"]["call_id"] == "a"
    assert parsed["protocol"]
