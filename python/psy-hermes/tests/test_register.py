"""Plugin entry point: register/identity enforcement."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

import psy_hermes.register as register_module
from psy_hermes.config import PsyHermesConfig
from psy_hermes.ingest_client import IngestSpawnPlan


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


def test_build_for_test_returns_handlers_and_watcher(tmp_path: Path) -> None:
    cfg = PsyHermesConfig(
        actor_id="x",
        memories_dir=tmp_path / "memories",
        db_path=tmp_path / "psy" / "audit.db",
        seal_key_path=tmp_path / "psy" / "seal-key",
    )

    class FakeIngest:
        def send(self, _envelope: dict) -> bool:
            return True

        def close(self) -> None:
            return None

    handlers, watcher = register_module.build_for_test(cfg, FakeIngest())  # type: ignore[arg-type]
    assert handlers is not None
    assert watcher is not None


def test_wire_hooks_handles_ctx_without_register_hook() -> None:
    class Empty:
        pass

    handlers, _ = register_module.build_for_test(
        PsyHermesConfig(actor_id="a"),
        type("F", (), {"send": lambda *_: True, "close": lambda *_: None})(),  # type: ignore[arg-type]
    )
    register_module._wire_hooks(Empty(), handlers)  # should not raise
