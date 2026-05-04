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
import time
from collections.abc import Callable
from pathlib import Path
from typing import cast

import pytest

from psy_core.hermes.ingest_client import (
    MAX_CONSECUTIVE_FAILURES,
    IngestClient,
    IngestSpawnPlan,
    resolve_spawn_plan,
)

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


def _wait_until(predicate: Callable[[], bool], *, timeout_s: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


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
    plan = resolve_spawn_plan(str(binary), "0.5.1")
    assert plan.argv[0] == str(binary)
    assert plan.argv[-1] == "ingest"


def test_resolve_spawn_plan_uses_psy_on_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    binary = tmp_path / "psy"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ.get("PATH", ""))
    plan = resolve_spawn_plan(None, "0.5.1")
    assert plan.argv[0].endswith("/psy")
    assert plan.description.startswith("path:")


def test_resolve_spawn_plan_falls_back_to_npx(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """When `psy` is missing but `npx` exists, fall back to npx."""
    npx = tmp_path / "npx"
    npx.write_text("#!/bin/sh\nexit 0\n")
    npx.chmod(0o755)
    # PATH contains only the dir with npx; psy is absent.
    monkeypatch.setenv("PATH", str(tmp_path))
    plan = resolve_spawn_plan(None, "0.5.1")
    assert plan.argv[0].endswith("/npx")
    assert "psy-core@0.5.1" in " ".join(plan.argv)
    assert plan.description.startswith("npx:")


def test_resolve_spawn_plan_raises_when_neither_available(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("PATH", str(tmp_path))  # empty dir
    with pytest.raises(FileNotFoundError):
        resolve_spawn_plan(None, "0.5.1")


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


def test_ingest_client_rejects_failed_handshake(tmp_path: Path) -> None:
    binary = tmp_path / "psy-refuse"
    binary.write_text(
        f"#!{sys.executable}\n"
        "import json, sys\n"
        "sys.stdout.write(json.dumps({'ok': False, 'error': {'code': 'NOPE'}}) + '\\n')\n"
        "sys.stdout.flush()\n"
    )
    binary.chmod(0o755)
    plan = IngestSpawnPlan(argv=[str(binary), "ingest"], description="refuse")
    client = IngestClient(plan=plan, startup_timeout_s=1.0)
    try:
        assert client.send({"type": "intent", "operation": "create", "call_id": "x"}) is False
        assert client._proc is None
        assert client.handshake is None
        assert client.degraded is False
    finally:
        client.close()


def test_ingest_client_degrades_after_non_json_handshakes(tmp_path: Path) -> None:
    binary = tmp_path / "psy-bad-json"
    binary.write_text(f"#!{sys.executable}\nimport sys\nsys.stdout.write('not-json\\n')\nsys.stdout.flush()\n")
    binary.chmod(0o755)
    plan = IngestSpawnPlan(argv=[str(binary), "ingest"], description="bad-json")
    client = IngestClient(plan=plan, startup_timeout_s=1.0)
    try:
        for index in range(MAX_CONSECUTIVE_FAILURES):
            assert client.send(
                {"type": "intent", "operation": "create", "call_id": f"bad-{index}"}
            ) is False
        assert client.degraded is True
        assert client._proc is None
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


def test_ingest_client_close_terminates_running_child(fake_ingest_binary: Path) -> None:
    plan = IngestSpawnPlan(argv=[str(fake_ingest_binary), "ingest"], description="test")
    client = IngestClient(plan=plan, startup_timeout_s=5.0)
    assert client.send({"type": "intent", "operation": "create", "call_id": "alive"}) is True
    assert _wait_until(lambda: client._proc is not None and client._proc.poll() is None)
    proc = client._proc
    assert proc is not None

    client.close()

    assert _wait_until(lambda: proc.poll() is not None, timeout_s=2.0)


def test_ingest_client_drains_stderr_so_ack_can_arrive(tmp_path: Path) -> None:
    probe = tmp_path / "acked"
    binary = tmp_path / "psy-stderr"
    binary.write_text(
        f"#!{sys.executable}\n"
        "import json, pathlib, sys\n"
        "sys.stdout.write(json.dumps({'ok': True, 'version': 'fake', 'schema_version': '1.0.0'}) + '\\n')\n"
        "sys.stdout.flush()\n"
        "for line in sys.stdin:\n"
        "    sys.stderr.write('x' * 200000)\n"
        "    sys.stderr.flush()\n"
        f"    pathlib.Path({str(probe)!r}).write_text('acked')\n"
        "    sys.stdout.write(json.dumps({'ok': True}) + '\\n')\n"
        "    sys.stdout.flush()\n"
    )
    binary.chmod(0o755)
    plan = IngestSpawnPlan(argv=[str(binary), "ingest"], description="stderr")
    client = IngestClient(plan=plan, ack_timeout_s=2.0)
    try:
        assert client.send({"type": "intent", "operation": "create", "call_id": "stderr"}) is True
        assert _wait_until(probe.exists, timeout_s=2.0)
        assert client.degraded is False
    finally:
        client.close()


def test_ingest_client_records_failures_when_ack_blocks(tmp_path: Path) -> None:
    binary = tmp_path / "psy-no-ack"
    binary.write_text(
        f"#!{sys.executable}\n"
        "import json, sys, time\n"
        "sys.stdout.write(json.dumps({'ok': True, 'version': 'fake', 'schema_version': '1.0.0'}) + '\\n')\n"
        "sys.stdout.flush()\n"
        "for line in sys.stdin:\n"
        "    time.sleep(60)\n"
    )
    binary.chmod(0o755)
    plan = IngestSpawnPlan(argv=[str(binary), "ingest"], description="no-ack")
    client = IngestClient(plan=plan, ack_timeout_s=0.1)
    try:
        for index in range(MAX_CONSECUTIVE_FAILURES):
            assert client.send(
                {"type": "intent", "operation": "create", "call_id": f"timeout-{index}"}
            ) is True
            expected_failures = index + 1

            def failure_count_reached(expected: int = expected_failures) -> bool:
                return cast(int, client._consecutive_failures) >= expected

            assert _wait_until(
                failure_count_reached,
                timeout_s=2.0,
            )
        assert client.degraded is True
        assert client.send({"type": "intent", "operation": "create", "call_id": "dropped"}) is False
    finally:
        client.close()
