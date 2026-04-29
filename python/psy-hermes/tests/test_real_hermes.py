"""Integration tests that drive the *real* hermes-agent PluginManager.

These tests skip cleanly when ``hermes_cli`` is not importable (so the
unit-only test run on a machine without hermes-agent installed still
passes). When hermes-agent is installed, the suite walks every path
through Hermes's plugin discovery + invocation machinery and asserts
that psy-hermes behaves correctly under the real contract.

Coverage:

- Entry-point discovery via the real ``hermes_agent.plugins`` group.
- Real ``PluginManager.discover_and_load`` -> our ``register(ctx)`` ->
  real ``ctx.register_hook(...)``.
- ``hermes_cli.config.load_config`` driving config resolution from a
  temp HERMES_HOME.
- Identity threading (actor_id / tenant_id / session_id) end-to-end.
- All memory tool actions (add / replace / remove) with both targets
  (``memory`` -> MEMORY.md, ``user`` -> USER.md).
- All skill_manage actions (create / patch / edit / delete / write_file
  / remove_file) including ``file_path`` sub-routing.
- Filtering: tools outside the memory/skill_manage set must be ignored.
- pre_tool_call blocking semantics: our observer must NEVER return a
  block directive (returning anything truthy could veto a tool call).
- Hook handler exception isolation: a raise inside our handler must NOT
  escape into Hermes's invoke_hook loop.
- Dedupe under double-fire (Hermes's invoke_hook fires once per turn
  per call site; in real flow run_agent.py + model_tools.py each fire
  once for a normal-registry tool).
- ``actor_id`` enforcement: missing actor_id with allow_anonymous=false
  -> emit F4 error to stderr, do NOT register hooks.
- ``allow_anonymous: true`` bypass.
- Disabled plugin (``enabled: false``) registers nothing.
- Concurrency: 4 worker threads firing 50 events each through
  invoke_hook.
- Real ``psy ingest`` Node subprocess round-trip: spawn psy on PATH,
  feed envelopes via stdio, observe DB rows + psy verify rc=0.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest

# Skip the entire module if hermes-agent isn't installed.
hermes_plugins = pytest.importorskip(
    "hermes_cli.plugins",
    reason="hermes-agent is not installed; install with `pip install hermes-agent`",
)
hermes_config = pytest.importorskip("hermes_cli.config")

from psy_hermes.hooks import HookHandlers  # noqa: E402

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _FakeIngest:
    """Drop-in for IngestClient that records every envelope without spawning."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def send(self, env: dict[str, Any]) -> bool:
        with self._lock:
            self.sent.append(env)
        return True

    def close(self) -> None:
        return None


@pytest.fixture
def hermes_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point HERMES_HOME at a fresh temp directory."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    # Hermes caches load_config keyed on path; clearing the cache ensures we
    # see the YAML each test writes.
    cache = getattr(hermes_config, "_RAW_CONFIG_CACHE", None)
    if cache is not None:
        cache.clear()
    return tmp_path


def _write_config(home: Path, psy_section: dict[str, Any]) -> None:
    import yaml

    payload = {"plugins": {"enabled": ["psy"], "psy": psy_section}}
    (home / "config.yaml").write_text(yaml.safe_dump(payload, sort_keys=False))


def _fresh_manager() -> Any:
    """Return a brand-new PluginManager, bypassing the module-global cache.

    ``get_plugin_manager`` returns a singleton; the test suite needs a fresh
    one per test so prior test state doesn't bleed in.
    """
    PM = hermes_plugins.PluginManager
    return PM()


def _load_psy_into(manager: Any, *, psy_binary: str = "/bin/echo") -> Any:
    """Drive plugin discovery + load. Replace the IngestClient with a fake."""
    manager.discover_and_load()
    handlers: HookHandlers | None = None
    for fn in manager._hooks.get("pre_tool_call", []):
        if hasattr(fn, "__self__") and isinstance(fn.__self__, HookHandlers):
            handlers = fn.__self__
            break
    if handlers is not None:
        handlers.ingest = _FakeIngest()
    return handlers


# ---------------------------------------------------------------------------
# Plugin discovery + lifecycle
# ---------------------------------------------------------------------------


def test_psy_entry_point_is_discoverable() -> None:
    import importlib.metadata as md

    eps = list(md.entry_points(group="hermes_agent.plugins"))
    psy = [ep for ep in eps if ep.name == "psy"]
    assert len(psy) == 1, f"psy entry point not found in {[e.name for e in eps]}"
    # Module form (not module:attr) — Hermes's loader does ep.load() then
    # getattr(module, "register"), so this MUST be a module path.
    assert ":" not in psy[0].value
    target = psy[0].load()
    # Loaded object should be the psy_hermes.register module (a module),
    # which exposes a callable named `register`.
    assert hasattr(target, "register")
    assert callable(target.register)


def test_real_discover_and_load_registers_both_hooks(hermes_home: Path) -> None:
    _write_config(hermes_home, {"actor_id": "alice", "psy_binary": "/bin/echo"})
    mgr = _fresh_manager()
    handlers = _load_psy_into(mgr)
    loaded = mgr._plugins["psy"]
    assert loaded.enabled is True, f"plugin failed to load: error={loaded.error!r}"
    assert loaded.error is None
    assert "pre_tool_call" in mgr._hooks
    assert "post_tool_call" in mgr._hooks
    assert handlers is not None


def test_disabled_plugin_registers_no_hooks(hermes_home: Path) -> None:
    _write_config(hermes_home, {"enabled": False, "actor_id": "alice"})
    mgr = _fresh_manager()
    mgr.discover_and_load()
    # `register()` returns early on enabled=false, so no hooks land.
    assert mgr._hooks.get("pre_tool_call", []) == []
    assert mgr._hooks.get("post_tool_call", []) == []


def test_missing_actor_id_emits_f4_error_and_skips_registration(
    hermes_home: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _write_config(hermes_home, {})  # no actor_id, no allow_anonymous
    mgr = _fresh_manager()
    mgr.discover_and_load()
    err = capsys.readouterr().err
    assert "actor_id is required" in err
    assert "Why:" in err and "Where:" in err and "Bypass:" in err
    assert mgr._hooks.get("pre_tool_call", []) == []


def test_allow_anonymous_bypasses_actor_id_requirement(hermes_home: Path) -> None:
    _write_config(hermes_home, {"allow_anonymous": True, "psy_binary": "/bin/echo"})
    mgr = _fresh_manager()
    _load_psy_into(mgr)
    loaded = mgr._plugins["psy"]
    assert loaded.enabled is True
    assert "pre_tool_call" in mgr._hooks


def test_invalid_config_section_does_not_crash_discovery(hermes_home: Path) -> None:
    """Unknown config keys (extra=forbid) must not crash the manager —
    register() catches the validation error and logs."""
    _write_config(hermes_home, {"actor_id": "alice", "totally_made_up_field": True})
    mgr = _fresh_manager()
    mgr.discover_and_load()
    # Plugin is recorded as loaded but disabled (enabled=False) because
    # register() returned early on the validation failure.
    loaded = mgr._plugins.get("psy")
    assert loaded is not None
    assert mgr._hooks.get("pre_tool_call", []) == []


# ---------------------------------------------------------------------------
# Memory tool — every action × every target
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("action", "expected_op"),
    [("add", "create"), ("replace", "str_replace"), ("remove", "delete")],
)
@pytest.mark.parametrize(
    ("target", "expected_path"),
    [("memory", "/memories/MEMORY.md"), ("user", "/memories/USER.md")],
)
def test_memory_tool_action_target_matrix(
    hermes_home: Path,
    action: str,
    expected_op: str,
    target: str,
    expected_path: str,
) -> None:
    _write_config(hermes_home, {"actor_id": "alice", "psy_binary": "/bin/echo"})
    mgr = _fresh_manager()
    handlers = _load_psy_into(mgr)
    assert handlers is not None
    captured: list[dict[str, Any]] = handlers.ingest.sent  # type: ignore[attr-defined]

    args: dict[str, Any] = {"action": action, "target": target}
    if action == "add":
        args["content"] = "x"
    else:
        args["old_text"] = "x"
        if action == "replace":
            args["content"] = "y"

    # invoke through the *real* invoke_hook path so we exercise Hermes's
    # try/except wrapper and return-value collection.
    mgr.invoke_hook(
        "pre_tool_call",
        tool_name="memory",
        args=args,
        task_id="t1",
        session_id="s1",
        tool_call_id=f"call-{action}-{target}",
    )
    assert len(captured) == 1
    env = captured[0]
    assert env["type"] == "intent"
    assert env["operation"] == expected_op
    assert env["memory_path"] == expected_path
    assert env["identity"]["actor_id"] == "alice"
    assert env["identity"]["session_id"] == "s1"


def test_memory_read_action_is_silently_ignored(hermes_home: Path) -> None:
    """The schema only enumerates add/replace/remove; an unknown action
    (or a hypothetical read) must not produce an envelope."""
    _write_config(hermes_home, {"actor_id": "alice", "psy_binary": "/bin/echo"})
    mgr = _fresh_manager()
    handlers = _load_psy_into(mgr)
    assert handlers is not None
    mgr.invoke_hook(
        "pre_tool_call",
        tool_name="memory",
        args={"action": "read", "target": "memory"},
        tool_call_id="c-read",
        session_id="s1",
    )
    assert handlers.ingest.sent == []  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# skill_manage — every action + file_path routing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("action", "expected_op"),
    [
        ("create", "create"),
        ("write_file", "create"),
        ("patch", "str_replace"),
        ("edit", "str_replace"),
        ("delete", "delete"),
        ("remove_file", "delete"),
    ],
)
def test_skill_manage_action_matrix(
    hermes_home: Path, action: str, expected_op: str,
) -> None:
    _write_config(hermes_home, {"actor_id": "alice", "psy_binary": "/bin/echo"})
    mgr = _fresh_manager()
    handlers = _load_psy_into(mgr)
    assert handlers is not None
    captured: list[dict[str, Any]] = handlers.ingest.sent  # type: ignore[attr-defined]

    args: dict[str, Any] = {"action": action, "name": "demo-skill"}
    if action in ("create", "edit"):
        args["content"] = "..."
    elif action == "patch":
        args["old_string"] = "a"
        args["new_string"] = "b"
    elif action == "write_file":
        args["file_path"] = "scripts/run.sh"
        args["file_content"] = "#!/bin/sh\n"
    elif action == "remove_file":
        args["file_path"] = "scripts/run.sh"

    mgr.invoke_hook(
        "pre_tool_call",
        tool_name="skill_manage",
        args=args,
        tool_call_id=f"skill-{action}",
        session_id="s1",
    )
    # post_tool_call DOES fire for skill_manage (not in _AGENT_LOOP_TOOLS).
    mgr.invoke_hook(
        "post_tool_call",
        tool_name="skill_manage",
        args=args,
        result="ok",
        tool_call_id=f"skill-{action}",
        session_id="s1",
    )
    assert len(captured) == 2
    intent, result = captured
    assert intent["type"] == "intent" and intent["operation"] == expected_op
    assert result["type"] == "result" and result["operation"] == expected_op
    if action in ("write_file", "remove_file"):
        assert intent["memory_path"] == "/skills/demo-skill/scripts/run.sh"
    else:
        assert intent["memory_path"] == "/skills/demo-skill/SKILL.md"


# ---------------------------------------------------------------------------
# Filtering + isolation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "tool_name",
    ["terminal", "read_file", "search_files", "web_search", "todo", "delegate_task"],
)
def test_unrelated_tools_produce_no_envelope(hermes_home: Path, tool_name: str) -> None:
    _write_config(hermes_home, {"actor_id": "alice", "psy_binary": "/bin/echo"})
    mgr = _fresh_manager()
    handlers = _load_psy_into(mgr)
    assert handlers is not None
    mgr.invoke_hook(
        "pre_tool_call",
        tool_name=tool_name,
        args={"command": "ls"},
        tool_call_id="x",
        session_id="s1",
    )
    mgr.invoke_hook(
        "post_tool_call",
        tool_name=tool_name,
        args={"command": "ls"},
        result="ok",
        tool_call_id="x",
        session_id="s1",
    )
    assert handlers.ingest.sent == []  # type: ignore[attr-defined]


def test_post_tool_call_does_not_fire_for_memory(hermes_home: Path) -> None:
    """memory is in _AGENT_LOOP_TOOLS upstream — post_tool_call never fires
    for it. Our handler must also be a no-op for memory in case Hermes is
    ever called directly (defense in depth)."""
    _write_config(hermes_home, {"actor_id": "alice", "psy_binary": "/bin/echo"})
    mgr = _fresh_manager()
    handlers = _load_psy_into(mgr)
    assert handlers is not None
    mgr.invoke_hook(
        "post_tool_call",
        tool_name="memory",
        args={"action": "add", "target": "user", "content": "x"},
        result="ok",
        tool_call_id="m1",
        session_id="s1",
    )
    assert handlers.ingest.sent == []  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Blocking semantics: our hook MUST NOT veto tool calls.
# ---------------------------------------------------------------------------


def test_pre_tool_call_never_returns_block_directive(hermes_home: Path) -> None:
    """Hermes's get_pre_tool_call_block_message looks for
    ``{"action": "block", "message": str}`` returns from pre_tool_call
    callbacks. Observer plugins MUST return None so they never accidentally
    veto a tool call."""
    _write_config(hermes_home, {"actor_id": "alice", "psy_binary": "/bin/echo"})
    mgr = _fresh_manager()
    _load_psy_into(mgr)

    # Drive the real block-message resolver. We need to call the module-level
    # function (which uses the global manager). Easiest: monkeypatch
    # _ensure_plugins_discovered to return our fresh manager.
    original = hermes_plugins._ensure_plugins_discovered
    hermes_plugins._ensure_plugins_discovered = lambda force=False: mgr  # type: ignore[assignment]
    try:
        block = hermes_plugins.get_pre_tool_call_block_message(
            tool_name="memory",
            args={"action": "add", "target": "user", "content": "x"},
            task_id="t",
            session_id="s",
            tool_call_id="c",
        )
    finally:
        hermes_plugins._ensure_plugins_discovered = original  # type: ignore[assignment]
    assert block is None, f"observer plugin must not block tool calls; got {block!r}"


def test_handler_exceptions_dont_escape_into_hermes(hermes_home: Path) -> None:
    """A bug in our handler must not break Hermes's invoke_hook loop."""
    _write_config(hermes_home, {"actor_id": "alice", "psy_binary": "/bin/echo"})
    mgr = _fresh_manager()
    handlers = _load_psy_into(mgr)
    assert handlers is not None

    def boom(_e: dict[str, Any]) -> bool:
        raise RuntimeError("simulated handler crash")

    # Replace the fake ingest with one that raises on send.
    handlers.ingest.send = boom  # type: ignore[method-assign]

    # invoke_hook should swallow the exception (Hermes wraps each callback in
    # try/except). It MUST NOT propagate out of invoke_hook, which would crash
    # the agent loop.
    results = mgr.invoke_hook(
        "pre_tool_call",
        tool_name="memory",
        args={"action": "add", "target": "user", "content": "x"},
        tool_call_id="boom-1",
        session_id="s1",
    )
    # No return value (our handler swallows internally) so results is empty.
    assert results == []


# ---------------------------------------------------------------------------
# Identity threading
# ---------------------------------------------------------------------------


def test_identity_propagates_actor_tenant_session(hermes_home: Path) -> None:
    _write_config(
        hermes_home,
        {
            "actor_id": "alice@acme.com",
            "tenant_id": "acme",
            "purpose": "support",
            "psy_binary": "/bin/echo",
        },
    )
    mgr = _fresh_manager()
    handlers = _load_psy_into(mgr)
    assert handlers is not None
    mgr.invoke_hook(
        "pre_tool_call",
        tool_name="memory",
        args={"action": "add", "target": "user", "content": "x"},
        tool_call_id="id-1",
        session_id="ticket-12345",
    )
    env = handlers.ingest.sent[0]  # type: ignore[attr-defined]
    assert env["identity"] == {
        "actor_id": "alice@acme.com",
        "tenant_id": "acme",
        "session_id": "ticket-12345",
    }
    assert env["purpose"] == "support"


def test_identity_session_id_omitted_when_unknown(hermes_home: Path) -> None:
    _write_config(hermes_home, {"actor_id": "alice", "psy_binary": "/bin/echo"})
    mgr = _fresh_manager()
    handlers = _load_psy_into(mgr)
    assert handlers is not None
    mgr.invoke_hook(
        "pre_tool_call",
        tool_name="memory",
        args={"action": "add", "target": "user", "content": "x"},
        tool_call_id="no-sess",
        # session_id deliberately omitted
    )
    env = handlers.ingest.sent[0]  # type: ignore[attr-defined]
    assert env["identity"]["actor_id"] == "alice"
    assert "session_id" not in env["identity"]


# ---------------------------------------------------------------------------
# Dedupe — pre_tool_call double-fire scenario
# ---------------------------------------------------------------------------


def test_dedupe_collapses_double_fire(hermes_home: Path) -> None:
    """Hermes's run_agent.py + model_tools.py both call invoke_hook for a
    normal-registry tool. Our dedupe must collapse identical (session,
    call_id, tool, args) tuples to a single envelope."""
    _write_config(hermes_home, {"actor_id": "alice", "psy_binary": "/bin/echo"})
    mgr = _fresh_manager()
    handlers = _load_psy_into(mgr)
    assert handlers is not None
    args = {"action": "create", "name": "demo", "content": "x"}
    for _ in range(2):
        mgr.invoke_hook(
            "pre_tool_call",
            tool_name="skill_manage",
            args=args,
            tool_call_id="dup-call",
            session_id="s1",
        )
    assert len(handlers.ingest.sent) == 1  # type: ignore[attr-defined]


def test_dedupe_does_not_collapse_distinct_calls(hermes_home: Path) -> None:
    _write_config(hermes_home, {"actor_id": "alice", "psy_binary": "/bin/echo"})
    mgr = _fresh_manager()
    handlers = _load_psy_into(mgr)
    assert handlers is not None
    for i in range(5):
        mgr.invoke_hook(
            "pre_tool_call",
            tool_name="memory",
            args={"action": "add", "target": "memory", "content": f"v{i}"},
            tool_call_id=f"call-{i}",
            session_id="s1",
        )
    assert len(handlers.ingest.sent) == 5  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------


def test_thread_pool_through_invoke_hook(hermes_home: Path) -> None:
    """Drive 4 worker threads x 50 events each through Hermes's invoke_hook.
    No envelopes lost, no exceptions out."""
    _write_config(hermes_home, {"actor_id": "alice", "psy_binary": "/bin/echo"})
    mgr = _fresh_manager()
    handlers = _load_psy_into(mgr)
    assert handlers is not None

    def fire(worker_idx: int) -> None:
        for i in range(50):
            mgr.invoke_hook(
                "pre_tool_call",
                tool_name="memory",
                args={"action": "add", "target": "memory", "content": f"w{worker_idx}-{i}"},
                tool_call_id=f"w{worker_idx}-{i}",
                session_id=f"sess-{worker_idx}",
            )

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(fire, range(4)))

    assert len(handlers.ingest.sent) == 200  # type: ignore[attr-defined]
    call_ids = {e["call_id"] for e in handlers.ingest.sent}  # type: ignore[attr-defined]
    assert len(call_ids) == 200


# ---------------------------------------------------------------------------
# End-to-end: real psy ingest Node binary
# ---------------------------------------------------------------------------


def _node_psy_wrapper(home: Path) -> Path:
    """Materialize a `psy` shim that execs `node dist/cli.js`. Returns the
    bin dir to prepend to PATH."""
    psy_root = Path(__file__).resolve().parents[2]  # python/psy-hermes/tests/.. -> repo root via psy-core
    # Walk up until we hit psy-core/dist/cli.js.
    candidate = psy_root
    for _ in range(6):
        if (candidate / "dist" / "cli.js").exists():
            break
        candidate = candidate.parent
    cli_js = candidate / "dist" / "cli.js"
    if not cli_js.exists():
        pytest.skip(f"dist/cli.js not built; run `npm run build` (looked under {psy_root})")
    bin_dir = home / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    wrapper = bin_dir / "psy"
    wrapper.write_text(f"#!/usr/bin/env bash\nexec node {cli_js} \"$@\"\n")
    wrapper.chmod(0o755)
    return bin_dir


def test_real_psy_ingest_subprocess_round_trip(
    hermes_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Drive the FULL pipeline:
    Hermes invoke_hook -> psy_hermes handlers -> IngestClient ->
    real `psy ingest` Node subprocess -> SQLite chain -> psy verify rc=0.
    """
    if shutil.which("node") is None:
        pytest.skip("node not on PATH")

    bin_dir = _node_psy_wrapper(hermes_home)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")

    psy_root = hermes_home / "psy-root"
    psy_root.mkdir()
    init = subprocess.run(
        ["psy", "init", "--no-color"],
        cwd=psy_root,
        capture_output=True,
        text=True,
    )
    assert init.returncode == 0, init.stderr

    _write_config(hermes_home, {"actor_id": "alice@acme.com", "tenant_id": "acme"})
    mgr = _fresh_manager()
    mgr.discover_and_load()
    loaded = mgr._plugins["psy"]
    assert loaded.enabled is True, f"plugin failed to load: error={loaded.error!r}"
    handlers = next(
        fn.__self__
        for fn in mgr._hooks["pre_tool_call"]
        if hasattr(fn, "__self__") and isinstance(fn.__self__, HookHandlers)
    )
    handlers.ingest._cwd = psy_root  # type: ignore[attr-defined]

    # Fire a real intent + result pair through the full stack.
    mgr.invoke_hook(
        "pre_tool_call",
        tool_name="skill_manage",
        args={"action": "create", "name": "live-skill", "content": "..."},
        tool_call_id="e2e-call",
        session_id="sess-e2e",
    )
    mgr.invoke_hook(
        "post_tool_call",
        tool_name="skill_manage",
        args={"action": "create", "name": "live-skill", "content": "..."},
        result="created",
        tool_call_id="e2e-call",
        session_id="sess-e2e",
    )
    # Drain the writer thread.
    time.sleep(2.0)
    handlers.ingest.close()

    rows_proc = subprocess.run(
        ["psy", "query", "--actor", "alice@acme.com", "--json"],
        cwd=psy_root,
        capture_output=True,
        text=True,
    )
    assert rows_proc.returncode == 0, rows_proc.stderr
    rows = json.loads(rows_proc.stdout)
    assert len(rows) == 2
    assert {r["audit_phase"] for r in rows} == {"intent", "result"}
    assert {r["operation"] for r in rows} == {"create"}
    assert all(r["actor_id"] == "alice@acme.com" for r in rows)
    assert all(r["memory_path"] == "/skills/live-skill/SKILL.md" for r in rows)

    verify_proc = subprocess.run(
        ["psy", "verify", "--no-color"],
        cwd=psy_root,
        capture_output=True,
        text=True,
    )
    assert verify_proc.returncode == 0, verify_proc.stdout + verify_proc.stderr
    assert "verification passed" in verify_proc.stdout


def test_real_psy_ingest_chain_advances_seal(
    hermes_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """After ingest, the head pointer must reflect the new tail (psy verify
    fails with seal_seq_mismatch otherwise)."""
    if shutil.which("node") is None:
        pytest.skip("node not on PATH")

    bin_dir = _node_psy_wrapper(hermes_home)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")

    psy_root = hermes_home / "psy-root"
    psy_root.mkdir()
    subprocess.run(["psy", "init", "--no-color"], cwd=psy_root, check=True)
    head_before = (psy_root / ".psy" / "head.json")
    assert not head_before.exists()

    _write_config(hermes_home, {"actor_id": "alice"})
    mgr = _fresh_manager()
    mgr.discover_and_load()
    handlers = next(
        fn.__self__
        for fn in mgr._hooks["pre_tool_call"]
        if hasattr(fn, "__self__") and isinstance(fn.__self__, HookHandlers)
    )
    handlers.ingest._cwd = psy_root  # type: ignore[attr-defined]

    # Fire 3 paired turns.
    for i in range(3):
        mgr.invoke_hook(
            "pre_tool_call",
            tool_name="skill_manage",
            args={"action": "patch", "name": f"s{i}", "old_string": "a", "new_string": "b"},
            tool_call_id=f"call-{i}",
            session_id="sess",
        )
        mgr.invoke_hook(
            "post_tool_call",
            tool_name="skill_manage",
            args={"action": "patch", "name": f"s{i}", "old_string": "a", "new_string": "b"},
            result="ok",
            tool_call_id=f"call-{i}",
            session_id="sess",
        )
    time.sleep(2.0)
    handlers.ingest.close()

    # Head pointer must now exist, and `psy verify` must pass.
    assert head_before.exists()
    head = json.loads(head_before.read_text())
    assert head["seq"] == 6  # 3 pairs
    verify = subprocess.run(
        ["psy", "verify", "--no-color"], cwd=psy_root, capture_output=True, text=True
    )
    assert verify.returncode == 0
