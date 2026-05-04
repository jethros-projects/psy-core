"""Console scripts: init / doctor / status / dry-run."""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import pytest

import psy_core.hermes.cli as cli_module
from psy_core.hermes.cli import main
from psy_core.hermes.ingest_client import IngestSpawnPlan


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


def test_init_can_enable_anonymous_mode_without_actor(tmp_path: Path) -> None:
    yaml = _yaml()
    cfg = tmp_path / "config.yaml"
    rc = main(["init", "--allow-anonymous", "--config", str(cfg)])
    assert rc == 0
    contents = yaml.safe_load(cfg.read_text())
    psy = contents["plugins"]["psy"]
    assert "psy" in contents["plugins"]["enabled"]
    assert psy["allow_anonymous"] is True
    assert "actor_id" not in psy


def test_install_skill_writes_trust_layer_skill(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    skill_path = tmp_path / "skills" / "devops" / "psy-core-trust-layer" / "SKILL.md"

    rc = main(["install-skill", "--path", str(skill_path)])

    assert rc == 0
    assert "psy-core-trust-layer" in skill_path.read_text(encoding="utf-8")
    assert "Hermes's magic is that it learns" in skill_path.read_text(encoding="utf-8")
    assert str(skill_path) in capsys.readouterr().out


def test_install_skill_backs_up_existing_different_skill(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    skill_path = tmp_path / "skills" / "devops" / "psy-core-trust-layer" / "SKILL.md"
    skill_path.parent.mkdir(parents=True)
    skill_path.write_text("local draft", encoding="utf-8")

    rc = main(["install-skill", "--path", str(skill_path)])

    assert rc == 0
    assert "psy-core Trust Layer for Hermes" in skill_path.read_text(encoding="utf-8")
    backup = skill_path.with_name("SKILL.md.bak")
    assert backup.read_text(encoding="utf-8") == "local draft"
    assert str(backup) in capsys.readouterr().out


def test_install_skill_default_path_honors_hermes_home(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))

    rc = main(["install-skill"])

    assert rc == 0
    assert (tmp_path / "skills" / "devops" / "psy-core-trust-layer" / "SKILL.md").exists()


def test_trust_layer_bootstrap_updates_config_installs_skill_and_verifies(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    yaml = _yaml()
    cfg = tmp_path / "config.yaml"
    skill_path = tmp_path / "skills" / "devops" / "psy-core-trust-layer" / "SKILL.md"
    binary = tmp_path / "psy"
    run_calls: list[dict[str, Any]] = []

    class FakeIngestClient:
        def __init__(self, **_kwargs: Any) -> None:
            self.handshake = {"ok": True, "version": "test", "schema_version": "1.0.0"}

        def _ensure_started(self) -> None:
            return None

        def close(self) -> None:
            return None

    class FakeCompletedProcess:
        returncode = 0
        stdout = "ok verification passed checked=0\n"
        stderr = ""

    def fake_run(argv: list[str], **kwargs: Any) -> FakeCompletedProcess:
        run_calls.append({"argv": argv, "kwargs": kwargs})
        return FakeCompletedProcess()

    monkeypatch.setattr(cli_module.shutil, "which", lambda name: str(binary) if name == "psy" else None)
    monkeypatch.setattr(
        cli_module,
        "resolve_spawn_plan",
        lambda psy_binary, _version: IngestSpawnPlan(
            argv=[str(psy_binary or binary), "ingest"],
            description=f"binary:{psy_binary or binary}",
        ),
    )
    monkeypatch.setattr(cli_module, "IngestClient", FakeIngestClient)
    monkeypatch.setattr(cli_module.subprocess, "run", fake_run)

    rc = main(
        [
            "trust-layer",
            "--actor-id",
            "alice@example.com",
            "--tenant-id",
            "acme",
            "--purpose",
            "test",
            "--config",
            str(cfg),
            "--skill-path",
            str(skill_path),
        ]
    )

    assert rc == 0
    contents = yaml.safe_load(cfg.read_text(encoding="utf-8"))
    psy = contents["plugins"]["psy"]
    assert contents["plugins"]["enabled"] == ["psy"]
    assert psy["enabled"] is True
    assert psy["actor_id"] == "alice@example.com"
    assert psy["tenant_id"] == "acme"
    assert psy["purpose"] == "test"
    assert psy["allow_anonymous"] is False
    assert psy["payload_capture"] is True
    assert psy["redactor"] == "default"
    assert psy["psy_binary"] == str(binary)
    assert psy["db_path"] == str(tmp_path / "psy" / "audit.db")
    assert psy["seal_key_path"] == str(tmp_path / "psy" / "seal-key")
    assert psy["memories_dir"] == str(tmp_path / "memories")
    assert (tmp_path / "psy").is_dir()
    assert (tmp_path / "memories").is_dir()
    assert "psy-core-trust-layer" in skill_path.read_text(encoding="utf-8")
    assert run_calls[0]["argv"] == [str(binary), "verify", "--all", "--no-color"]
    assert run_calls[0]["kwargs"]["env"]["PSY_AUDIT_DB_PATH"] == str(tmp_path / "psy" / "audit.db")
    out = capsys.readouterr().out
    assert "Use psy-core as the trust layer" in out
    assert "Doctor:" in out
    assert "Verify:" in out


def test_trust_layer_requires_actor_unless_anonymous(tmp_path: Path) -> None:
    cfg = tmp_path / "config.yaml"

    with pytest.raises(SystemExit, match="--actor-id is required"):
        main(["trust-layer", "--config", str(cfg), "--no-verify"])

    assert not cfg.exists()


def test_status_reports_one_line(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    yaml = _yaml()
    cfg = tmp_path / "config.yaml"
    cfg.write_text(yaml.safe_dump({"plugins": {"enabled": ["psy"], "psy": {"actor_id": "alice"}}}))
    rc = main(["status", "--config", str(cfg)])
    assert rc == 0
    out = capsys.readouterr().out
    assert "psy-core-hermes" in out
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


def test_doctor_reports_explicit_psy_binary_without_fallback_text(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    yaml = _yaml()
    cfg = tmp_path / "config.yaml"
    binary = tmp_path / "psy-core-local"
    cfg.write_text(
        yaml.safe_dump(
            {
                "plugins": {
                    "enabled": ["psy"],
                    "psy": {"actor_id": "alice", "psy_binary": str(binary)},
                },
            },
        ),
    )

    class FakeIngestClient:
        def __init__(self, **_kwargs: Any) -> None:
            self.handshake = {"ok": True, "version": "test", "schema_version": "1.0.0"}

        def _ensure_started(self) -> None:
            return None

        def close(self) -> None:
            return None

    monkeypatch.setattr(
        cli_module,
        "resolve_spawn_plan",
        lambda _binary, _version: IngestSpawnPlan(
            argv=[str(binary), "ingest"],
            description=f"binary:{binary}",
        ),
    )
    monkeypatch.setattr(cli_module, "IngestClient", FakeIngestClient)
    monkeypatch.setattr(cli_module.shutil, "which", lambda _name: None)

    rc = main(["doctor", "--config", str(cfg)])
    assert rc == 0
    out = capsys.readouterr().out
    assert f"psy_binary:          explicit override in use ({binary})" in out
    assert "will use npx fallback" not in out


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
