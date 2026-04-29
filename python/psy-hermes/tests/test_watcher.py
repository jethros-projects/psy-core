"""Filesystem watcher: pairs FS changes with recent intents."""

from __future__ import annotations

import time
from pathlib import Path

from psy_hermes.config import PsyHermesConfig
from psy_hermes.hooks import HookHandlers, make_hook_handlers
from psy_hermes.watcher import MemoryWatcher
from tests.conftest import FakeIngestClient


def _build(tmp_path: Path) -> tuple[PsyHermesConfig, FakeIngestClient, HookHandlers, MemoryWatcher]:
    cfg = PsyHermesConfig(
        actor_id="alice",
        memories_dir=tmp_path / "memories",
        db_path=tmp_path / "psy" / "audit.db",
        seal_key_path=tmp_path / "psy" / "seal-key",
    )
    cfg.memories_dir.mkdir(parents=True, exist_ok=True)
    fake = FakeIngestClient()
    handlers = make_hook_handlers(cfg, fake, redactor=None)  # type: ignore[arg-type]
    watcher = MemoryWatcher(config=cfg, hooks=handlers, ingest=fake)  # type: ignore[arg-type]
    return cfg, fake, handlers, watcher


def test_watcher_pairs_change_to_recent_intent(tmp_path: Path) -> None:
    cfg, fake, handlers, watcher = _build(tmp_path)
    handlers.pre_tool_call(
        tool_name="memory",
        args={"action": "add", "content": "hello"},
        tool_call_id="call-w1",
        session_id="s1",
    )
    target = cfg.memories_dir / "MEMORY.md"
    watcher.start()
    try:
        # Write AFTER start so the watcher's startup seed differs from the
        # post-write digest. Drive a change event manually rather than wait
        # on inotify so the test isn't flaky across platforms.
        target.write_text("first contents")
        watcher._on_change(target)
    finally:
        watcher.stop()
    types = [e["type"] for e in fake.sent]
    assert "intent" in types
    assert "result" in types
    result = next(e for e in fake.sent if e["type"] == "result")
    assert result["call_id"] == "call-w1"
    assert result["memory_path"] == "/memories/MEMORY.md"
    assert "outcome" not in result


def test_watcher_emits_unattributed_when_no_recent_intent(tmp_path: Path) -> None:
    cfg, fake, handlers, watcher = _build(tmp_path)
    target = cfg.memories_dir / "USER.md"
    watcher.start()
    try:
        target.write_text("manual edit by the user, no tool call")
        watcher._on_change(target)
    finally:
        watcher.stop()
    results = [e for e in fake.sent if e["type"] == "result"]
    assert len(results) == 1
    assert results[0]["outcome"] == "unattributed"
    assert results[0]["call_id"].startswith("unattributed-")


def test_watcher_debounces_identical_writes(tmp_path: Path) -> None:
    cfg, fake, handlers, watcher = _build(tmp_path)
    target = cfg.memories_dir / "MEMORY.md"
    watcher.start()
    try:
        target.write_text("same")
        watcher._on_change(target)
        watcher._on_change(target)  # same content, should be debounced
    finally:
        watcher.stop()
    results = [e for e in fake.sent if e["type"] == "result"]
    assert len(results) == 1


def test_watcher_does_not_pair_with_an_old_intent(tmp_path: Path) -> None:
    cfg, fake, handlers, watcher = _build(tmp_path)
    handlers.pre_tool_call(
        tool_name="memory",
        args={"action": "add", "content": "stale"},
        tool_call_id="call-stale",
        session_id="s1",
    )
    # Manually expire the pending entry by rewriting its enqueued_at.
    pending = handlers.pending["call-stale"]
    handlers.pending["call-stale"] = pending.__class__(
        call_id=pending.call_id,
        operation=pending.operation,
        tool_name=pending.tool_name,
        memory_path=pending.memory_path,
        args=pending.args,
        enqueued_at=time.monotonic() - 10.0,
        session_id=pending.session_id,
    )
    target = cfg.memories_dir / "MEMORY.md"
    watcher.start()
    try:
        target.write_text("after a long delay")
        watcher._on_change(target)
    finally:
        watcher.stop()
    results = [e for e in fake.sent if e["type"] == "result"]
    assert len(results) == 1
    assert results[0]["outcome"] == "unattributed"


def test_watcher_silently_defers_when_memories_dir_is_missing(tmp_path: Path) -> None:
    cfg = PsyHermesConfig(
        actor_id="alice",
        memories_dir=tmp_path / "does" / "not" / "exist",
        db_path=tmp_path / "psy" / "audit.db",
        seal_key_path=tmp_path / "psy" / "seal-key",
    )
    fake = FakeIngestClient()
    handlers = make_hook_handlers(cfg, fake, redactor=None)  # type: ignore[arg-type]
    watcher = MemoryWatcher(config=cfg, hooks=handlers, ingest=fake)  # type: ignore[arg-type]
    watcher.start()  # must not raise
    assert not watcher._started  # private flag, ok in test code
