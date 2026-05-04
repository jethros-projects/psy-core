"""Filesystem watcher: pairs FS changes with recent intents."""

from __future__ import annotations

import time
from dataclasses import replace
from pathlib import Path
from typing import cast

from psy_core.hermes.config import PsyHermesConfig
from psy_core.hermes.hooks import HookHandlers, make_hook_handlers
from psy_core.hermes.ingest_client import IngestClient
from psy_core.hermes.watcher import MemoryWatcher
from tests.conftest import FakeIngestClient


def _build(
    tmp_path: Path,
    *,
    tenant_id: str | None = None,
    purpose: str | None = None,
    payload_capture: bool = True,
) -> tuple[PsyHermesConfig, FakeIngestClient, HookHandlers, MemoryWatcher]:
    cfg = PsyHermesConfig(
        actor_id="alice",
        tenant_id=tenant_id,
        purpose=purpose,
        payload_capture=payload_capture,
        memories_dir=tmp_path / "memories",
        db_path=tmp_path / "psy" / "audit.db",
        seal_key_path=tmp_path / "psy" / "seal-key",
    )
    cfg.memories_dir.mkdir(parents=True, exist_ok=True)
    fake = FakeIngestClient()
    ingest = cast(IngestClient, fake)
    handlers = make_hook_handlers(cfg, ingest, redactor=None)
    watcher = MemoryWatcher(config=cfg, hooks=handlers, ingest=ingest)
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


def test_watcher_prefers_pending_intent_with_same_memory_path(tmp_path: Path) -> None:
    cfg, fake, handlers, watcher = _build(tmp_path)
    handlers.pre_tool_call(
        tool_name="memory",
        args={"action": "add", "target": "user", "content": "user scoped"},
        tool_call_id="call-user",
        session_id="s1",
    )
    handlers.pre_tool_call(
        tool_name="memory",
        args={"action": "add", "target": "memory", "content": "global scoped"},
        tool_call_id="call-memory",
        session_id="s1",
    )

    # Make the MEMORY.md intent newer so a pure recency match would choose
    # the wrong pending intent for the USER.md filesystem change.
    with handlers.pending_lock:
        now = time.monotonic()
        handlers.pending["call-user"] = replace(
            handlers.pending["call-user"],
            enqueued_at=now,
        )
        handlers.pending["call-memory"] = replace(
            handlers.pending["call-memory"],
            enqueued_at=now + 0.1,
        )

    target = cfg.memories_dir / "USER.md"
    watcher.start()
    try:
        target.write_text("updated user memory")
        watcher._on_change(target)
    finally:
        watcher.stop()

    result = next(e for e in fake.sent if e["type"] == "result")
    assert result["call_id"] == "call-user"
    assert result["memory_path"] == "/memories/USER.md"
    assert "call-memory" in handlers.pending


def test_watcher_falls_back_to_newest_recent_intent_without_path_match(tmp_path: Path) -> None:
    cfg, fake, handlers, watcher = _build(tmp_path)
    handlers.pre_tool_call(
        tool_name="memory",
        args={"action": "add", "target": "memory", "content": "global scoped"},
        tool_call_id="call-memory",
        session_id="s1",
    )

    target = cfg.memories_dir / "USER.md"
    watcher.start()
    try:
        target.write_text("legacy surface wrote a different file")
        watcher._on_change(target)
    finally:
        watcher.stop()

    result = next(e for e in fake.sent if e["type"] == "result")
    assert result["call_id"] == "call-memory"
    assert result["memory_path"] == "/memories/USER.md"
    assert handlers.pending == {}


def test_watcher_result_merges_identity_purpose_and_payload(tmp_path: Path) -> None:
    cfg, fake, handlers, watcher = _build(tmp_path, tenant_id="acme", purpose="support")
    handlers.pre_tool_call(
        tool_name="memory",
        args={"action": "add", "target": "user", "content": "user scoped"},
        tool_call_id="call-user",
        session_id="s1",
    )

    target = cfg.memories_dir / "USER.md"
    watcher.start()
    try:
        target.write_text("updated user memory")
        watcher._on_change(target)
    finally:
        watcher.stop()

    result = next(e for e in fake.sent if e["type"] == "result")
    assert result["identity"] == {
        "session_id": "s1",
        "actor_id": "alice",
        "tenant_id": "acme",
    }
    assert result["purpose"] == "support"
    assert result["payload"]["path"] == str(target)
    assert len(result["payload"]["content_hash"]) == 64


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


def test_watcher_creates_memories_dir_before_starting(tmp_path: Path) -> None:
    cfg = PsyHermesConfig(
        actor_id="alice",
        memories_dir=tmp_path / "does" / "not" / "exist",
        db_path=tmp_path / "psy" / "audit.db",
        seal_key_path=tmp_path / "psy" / "seal-key",
    )
    fake = FakeIngestClient()
    ingest = cast(IngestClient, fake)
    handlers = make_hook_handlers(cfg, ingest, redactor=None)
    watcher = MemoryWatcher(config=cfg, hooks=handlers, ingest=ingest)
    try:
        watcher.start()  # must not raise
        assert cfg.memories_dir.exists()
        assert watcher._started  # private flag, ok in test code
    finally:
        watcher.stop()
