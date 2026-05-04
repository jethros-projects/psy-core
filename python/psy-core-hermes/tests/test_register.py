"""Plugin entry point: register/identity enforcement."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, cast

import pytest

import psy_core.hermes.register as register_module
from psy_core.hermes.config import PsyHermesConfig
from psy_core.hermes.ingest_client import IngestClient, IngestSpawnPlan


class StubCtx:
    """Minimal duck-type for the register(ctx) parameter."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    def register_hook(self, name: str, handler: Any) -> None:
        self.calls.append((name, handler))


def test_register_without_actor_id_emits_f4_error_and_does_not_wire(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(register_module, "_read_psy_section", lambda: {})
    ctx = StubCtx()
    register_module.register(ctx)
    captured = capsys.readouterr()
    assert "actor_id is required" in captured.err
    assert ctx.calls == []


def test_register_with_allow_anonymous_wires_hooks(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        register_module,
        "_read_psy_section",
        lambda: {
            "allow_anonymous": True,
            "memories_dir": str(tmp_path / "memories"),
        },
    )
    fake_binary = tmp_path / "psy"
    fake_binary.write_text(f"#!{sys.executable}\nimport sys\nsys.exit(0)\n")
    fake_binary.chmod(0o755)
    monkeypatch.setattr(
        register_module,
        "resolve_spawn_plan",
        lambda binary, ver: IngestSpawnPlan(
            argv=[str(fake_binary), "ingest"],
            description="stub",
        ),
    )
    ctx = StubCtx()
    register_module.register(ctx)
    names = [name for name, _ in ctx.calls]
    assert names == ["pre_tool_call", "post_tool_call"]


def test_register_disabled_short_circuits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(register_module, "_read_psy_section", lambda: {"enabled": False})
    ctx = StubCtx()
    register_module.register(ctx)
    assert ctx.calls == []


def test_register_invalid_config_does_not_wire(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(
        register_module,
        "_read_psy_section",
        lambda: {"actor_id": "alice", "unknown_field": True},
    )
    caplog.set_level("ERROR", logger="psy_core.hermes")
    ctx = StubCtx()

    register_module.register(ctx)

    assert ctx.calls == []
    assert "psy-core-hermes config invalid" in caplog.text


def test_register_redactor_none_wires_unredacted_handlers(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakeIngestClient:
        def __init__(self, **_kwargs: Any) -> None:
            self.sent: list[dict[str, Any]] = []

        def send(self, envelope: dict[str, Any]) -> bool:
            self.sent.append(envelope)
            return True

        def close(self) -> None:
            return None

    class FakeWatcher:
        started = False

        def __init__(self, **_kwargs: Any) -> None:
            return None

        def start(self) -> None:
            FakeWatcher.started = True

    monkeypatch.setattr(
        register_module,
        "_read_psy_section",
        lambda: {
            "actor_id": "alice",
            "redactor": "none",
            "memories_dir": str(tmp_path / "memories"),
        },
    )
    monkeypatch.setattr(
        register_module,
        "resolve_spawn_plan",
        lambda _binary, _ver: IngestSpawnPlan(argv=["/bin/echo", "ingest"], description="fake"),
    )
    monkeypatch.setattr(register_module, "IngestClient", FakeIngestClient)
    monkeypatch.setattr(register_module, "MemoryWatcher", FakeWatcher)
    ctx = StubCtx()

    register_module.register(ctx)

    assert [name for name, _handler in ctx.calls] == ["pre_tool_call", "post_tool_call"]
    handlers = ctx.calls[0][1].__self__
    assert handlers.redactor is None
    assert FakeWatcher.started is True
    secret = "sk-ant-" + "A" * 32
    handlers.pre_tool_call(
        tool_name="memory",
        args={"action": "add", "content": secret},
        tool_call_id="redactor-none",
    )
    assert handlers.ingest.sent[0]["payload"]["args"]["content"] == secret


def test_build_for_test_returns_handlers_and_watcher(tmp_path: Path) -> None:
    cfg = PsyHermesConfig(
        actor_id="x",
        memories_dir=tmp_path / "memories",
        db_path=tmp_path / "psy" / "audit.db",
        seal_key_path=tmp_path / "psy" / "seal-key",
    )

    class FakeIngest:
        def send(self, _envelope: dict[str, Any]) -> bool:
            return True

        def close(self) -> None:
            return None

    handlers, watcher = register_module.build_for_test(cfg, cast(IngestClient, FakeIngest()))
    assert handlers is not None
    assert watcher is not None


def test_ingest_env_binds_node_cli_to_config_paths(tmp_path: Path) -> None:
    cfg = PsyHermesConfig(
        actor_id="x",
        db_path=tmp_path / "psy" / "audit.db",
        seal_key_path=tmp_path / "keys" / "seal-key",
    )
    env = register_module._ingest_env(cfg)
    assert env["PSY_AUDIT_DB_PATH"] == str(tmp_path / "psy" / "audit.db")
    assert env["PSY_ARCHIVES_PATH"] == str(tmp_path / "psy" / "archives")
    assert env["PSY_SEAL_KEY_PATH"] == str(tmp_path / "keys" / "seal-key")
    assert env["PSY_HEAD_PATH"] == str(tmp_path / "keys" / "head.json")


def test_wire_hooks_handles_ctx_without_register_hook() -> None:
    class Empty:
        pass

    class FakeIngest:
        def send(self, _envelope: dict[str, Any]) -> bool:
            return True

        def close(self) -> None:
            return None

    handlers, _ = register_module.build_for_test(
        PsyHermesConfig(actor_id="a"),
        cast(IngestClient, FakeIngest()),
    )
    register_module._wire_hooks(Empty(), handlers)  # should not raise
