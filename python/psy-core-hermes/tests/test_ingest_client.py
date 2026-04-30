"""IngestClient: spawn-plan resolution + handshake against a fake binary.

The fake binary is a small Python script that emits the handshake on
startup and writes one ACK line per incoming envelope. This exercises
the real subprocess machinery (Popen, pipes, signal cleanup) without
depending on a real `psy ingest` binary or Node being installed.
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

import pytest

from psy_core.hermes.ingest_client import IngestClient, IngestSpawnPlan, resolve_spawn_plan

FAKE_INGEST = """\
#!/usr/bin/env python3
import json, sys, time
sys.stdout.write(json.dumps({"ok": True, "version": "fake", "schema_version": "1.0.0"}) + "\\n")
sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        env = json.loads(line)
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": {"code": "E_BAD_JSON", "message": str(exc)}}) + "\\n")
    else:
        sys.stdout.write(json.dumps({"ok": True, "type": env.get("type"), "call_id": env.get("call_id"), "seq": 1}) + "\\n")
    sys.stdout.flush()
"""


@pytest.fixture
def fake_ingest_binary(tmp_path: Path) -> Path:
    binary = tmp_path / "psy"
    binary.write_text(f"#!{sys.executable}\n" + FAKE_INGEST.split("\n", 1)[1])
    binary.chmod(binary.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return binary


def test_resolve_spawn_plan_prefers_explicit_binary(tmp_path: Path) -> None:
    binary = tmp_path / "custom-psy"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)
    plan = resolve_spawn_plan(str(binary), "0.4.0")
    assert plan.argv[0] == str(binary)
    assert plan.argv[-1] == "ingest"


def test_resolve_spawn_plan_uses_psy_on_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    binary = tmp_path / "psy"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ.get("PATH", ""))
    plan = resolve_spawn_plan(None, "0.4.0")
    assert plan.argv[0].endswith("/psy")
    assert plan.description.startswith("path:")


def test_resolve_spawn_plan_falls_back_to_npx(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """When `psy` is missing but `npx` exists, fall back to npx."""
    npx = tmp_path / "npx"
    npx.write_text("#!/bin/sh\nexit 0\n")
    npx.chmod(0o755)
    # PATH contains only the dir with npx; psy is absent.
    monkeypatch.setenv("PATH", str(tmp_path))
    plan = resolve_spawn_plan(None, "0.4.0")
    assert plan.argv[0].endswith("/npx")
    assert "psy-core@0.4.0" in " ".join(plan.argv)
    assert plan.description.startswith("npx:")


def test_resolve_spawn_plan_raises_when_neither_available(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("PATH", str(tmp_path))  # empty dir
    with pytest.raises(FileNotFoundError):
        resolve_spawn_plan(None, "0.4.0")


def test_ingest_client_handshake_and_send(fake_ingest_binary: Path) -> None:
    plan = IngestSpawnPlan(argv=[str(fake_ingest_binary), "ingest"], description="test")
    client = IngestClient(plan=plan, startup_timeout_s=5.0)
    try:
        ok = client.send({"type": "intent", "operation": "create", "call_id": "c-1"})
        assert ok is True
        # Send a couple more so the writer thread has time to drain.
        for i in range(3):
            client.send({"type": "intent", "operation": "create", "call_id": f"c-{i + 2}"})
        # Give the writer thread a moment to process.
        import time
        for _ in range(20):
            if client.handshake is not None:
                break
            time.sleep(0.05)
        assert client.handshake == {"ok": True, "version": "fake", "schema_version": "1.0.0"}
        assert client.degraded is False
    finally:
        client.close()


def test_ingest_client_degrades_when_binary_does_not_exist(tmp_path: Path) -> None:
    plan = IngestSpawnPlan(
        argv=[str(tmp_path / "definitely-not-here"), "ingest"],
        description="missing",
    )
    client = IngestClient(plan=plan, startup_timeout_s=1.0)
    try:
        for _ in range(4):
            client.send({"type": "intent", "operation": "create", "call_id": "x"})
        assert client.degraded is True
    finally:
        client.close()


def test_ingest_client_clears_process_after_handshake_failure(tmp_path: Path) -> None:
    binary = tmp_path / "psy"
    binary.write_text("#!/usr/bin/env python3\nimport time\ntime.sleep(2)\n")
    binary.chmod(0o755)
    plan = IngestSpawnPlan(argv=[str(binary), "ingest"], description="silent")
    client = IngestClient(plan=plan, startup_timeout_s=0.1)
    try:
        ok = client.send({"type": "intent", "operation": "create", "call_id": "x"})
        assert ok is False
        assert client._proc is None  # regression guard for stale child state
        assert client.handshake is None
    finally:
        client.close()


def test_ingest_client_passes_configured_env(tmp_path: Path) -> None:
    probe = tmp_path / "probe"
    binary = tmp_path / "psy-env"
    binary.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, pathlib, sys\n"
        f"pathlib.Path({str(probe)!r}).write_text(os.environ.get('PSY_AUDIT_DB_PATH', ''))\n"
        "sys.stdout.write(json.dumps({'ok': True, 'version': 'fake', 'schema_version': '1.0.0'}) + '\\n')\n"
        "sys.stdout.flush()\n"
        "for line in sys.stdin:\n"
        "    sys.stdout.write(json.dumps({'ok': True}) + '\\n')\n"
        "    sys.stdout.flush()\n"
    )
    binary.chmod(0o755)
    plan = IngestSpawnPlan(argv=[str(binary), "ingest"], description="env")
    client = IngestClient(plan=plan, env={"PSY_AUDIT_DB_PATH": "/tmp/hermes-audit.db"})
    try:
        assert client.send({"type": "intent", "operation": "create", "call_id": "env"}) is True
        assert probe.read_text() == "/tmp/hermes-audit.db"
    finally:
        client.close()


def test_ingest_client_close_is_idempotent(fake_ingest_binary: Path) -> None:
    plan = IngestSpawnPlan(argv=[str(fake_ingest_binary), "ingest"], description="test")
    client = IngestClient(plan=plan, startup_timeout_s=5.0)
    client.send({"type": "intent", "operation": "create", "call_id": "a"})
    client.close()
    client.close()  # must not raise
