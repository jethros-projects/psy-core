"""Concurrency: 4 worker threads x 50 events each, no envelopes lost."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any

from psy_core.hermes.hooks import HookHandlers


def test_thread_pool_does_not_drop_envelopes(hooks: HookHandlers, fake_ingest: Any) -> None:
    workers = 4
    per_worker = 50

    def fire(idx: int) -> None:
        for i in range(per_worker):
            hooks.pre_tool_call(
                tool_name="memory",
                args={"action": "add", "content": f"w{idx}-{i}"},
                tool_call_id=f"w{idx}-{i}",
                session_id=f"sess-{idx}",
            )

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(fire, range(workers)))

    assert len(fake_ingest.sent) == workers * per_worker
    # All call_ids unique => no dedupe collisions across workers.
    call_ids = {e["call_id"] for e in fake_ingest.sent}
    assert len(call_ids) == workers * per_worker


def test_session_ordering_is_preserved_within_a_session(
    hooks: HookHandlers,
    fake_ingest: Any,
) -> None:
    """Inside a single session, envelopes appear in submission order even if
    other sessions are firing concurrently."""
    workers = 4
    per_worker = 50

    def fire(idx: int) -> None:
        for i in range(per_worker):
            hooks.pre_tool_call(
                tool_name="memory",
                args={"action": "add", "content": f"w{idx}-{i}"},
                tool_call_id=f"w{idx}-{i}",
                session_id=f"sess-{idx}",
            )

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(fire, range(workers)))

    by_session: dict[str, list[str]] = {}
    for env in fake_ingest.sent:
        by_session.setdefault(env["identity"]["session_id"], []).append(env["call_id"])
    for sid, ids in by_session.items():
        # The fake ingest preserves submission order; within a session each
        # thread submitted strictly in order.
        idx = int(sid.split("-")[1])
        expected = [f"w{idx}-{i}" for i in range(per_worker)]
        assert ids == expected
