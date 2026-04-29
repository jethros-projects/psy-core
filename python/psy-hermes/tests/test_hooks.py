"""pre_tool_call / post_tool_call behavior + dedup."""

from __future__ import annotations

from typing import Any

from psy_hermes.config import PsyHermesConfig
from psy_hermes.hooks import _MEMORY_ACTION_MAP, HookHandlers


def test_pre_tool_call_emits_intent_for_memory_add(hooks: HookHandlers, fake_ingest: Any) -> None:
    hooks.pre_tool_call(
        tool_name="memory",
        args={"action": "add", "content": "hello"},
        tool_call_id="call-1",
        session_id="sess-1",
    )
    assert len(fake_ingest.sent) == 1
    env = fake_ingest.sent[0]
    assert env["type"] == "intent"
    assert env["operation"] == "create"
    assert env["call_id"] == "call-1"
    assert env["identity"]["actor_id"] == "alice@acme.com"
    assert env["identity"]["tenant_id"] == "acme"
    assert env["identity"]["session_id"] == "sess-1"
    assert env["memory_path"].startswith("/memories/")
    assert env["payload"]["tool"] == "memory"


def test_pre_tool_call_skips_unrelated_tools(hooks: HookHandlers, fake_ingest: Any) -> None:
    hooks.pre_tool_call(tool_name="terminal", args={"command": "ls"}, tool_call_id="call-x")
    assert fake_ingest.sent == []


def test_pre_tool_call_skips_when_action_unknown(hooks: HookHandlers, fake_ingest: Any) -> None:
    hooks.pre_tool_call(
        tool_name="memory",
        args={"action": "list"},  # not a write
        tool_call_id="call-2",
    )
    assert fake_ingest.sent == []


def test_pre_tool_call_dedupes_double_fire(hooks: HookHandlers, fake_ingest: Any) -> None:
    args = {"action": "replace", "content": "v2"}
    hooks.pre_tool_call(tool_name="memory", args=args, tool_call_id="dup-1", session_id="s")
    hooks.pre_tool_call(tool_name="memory", args=args, tool_call_id="dup-1", session_id="s")
    assert len(fake_ingest.sent) == 1


def test_pre_tool_call_does_not_dedupe_across_call_ids(
    hooks: HookHandlers,
    fake_ingest: Any,
) -> None:
    args = {"action": "add", "content": "v"}
    hooks.pre_tool_call(tool_name="memory", args=args, tool_call_id="a")
    hooks.pre_tool_call(tool_name="memory", args=args, tool_call_id="b")
    assert len(fake_ingest.sent) == 2


def test_post_tool_call_emits_result_for_skill_manage(hooks: HookHandlers, fake_ingest: Any) -> None:
    hooks.pre_tool_call(
        tool_name="skill_manage",
        args={"action": "edit", "skill": "demo"},
        tool_call_id="skill-1",
        session_id="sess-1",
    )
    hooks.post_tool_call(
        tool_name="skill_manage",
        args={"action": "edit", "skill": "demo"},
        tool_call_id="skill-1",
        session_id="sess-1",
        result="patched",
    )
    types = [e["type"] for e in fake_ingest.sent]
    assert types == ["intent", "result"]
    assert fake_ingest.sent[1]["operation"] == "str_replace"


def test_post_tool_call_skips_memory_tool(hooks: HookHandlers, fake_ingest: Any) -> None:
    """The `memory` tool is in _AGENT_LOOP_TOOLS upstream, so post_tool_call
    never fires for it. The watcher emits the result envelope instead.
    """
    hooks.post_tool_call(
        tool_name="memory",
        args={"action": "add"},
        tool_call_id="m-1",
        result="ok",
    )
    assert fake_ingest.sent == []


def test_pre_tool_call_swallows_handler_exceptions(hooks: HookHandlers, fake_ingest: Any) -> None:
    """A handler exception MUST NOT escape into Hermes's executor."""

    def boom(_: dict) -> bool:
        raise RuntimeError("boom")

    fake_ingest.send = boom  # type: ignore[method-assign]
    # Should not raise.
    hooks.pre_tool_call(
        tool_name="memory",
        args={"action": "add"},
        tool_call_id="will-fail",
    )


def test_dry_run_short_circuits_send(
    base_config: PsyHermesConfig,
    fake_ingest: Any,
) -> None:
    cfg = base_config.model_copy(update={"dry_run": True})
    from psy_hermes.hooks import make_hook_handlers

    handlers = make_hook_handlers(cfg, fake_ingest, redactor=None)
    handlers.pre_tool_call(
        tool_name="memory",
        args={"action": "add"},
        tool_call_id="dry",
    )
    assert fake_ingest.sent == []


def test_pre_tool_call_records_pending_for_watcher(hooks: HookHandlers) -> None:
    hooks.pre_tool_call(
        tool_name="memory",
        args={"action": "add", "content": "x"},
        tool_call_id="p-1",
        session_id="s",
    )
    pending = hooks.take_pending("p-1", max_age_s=5.0)
    assert pending is not None
    assert pending.tool_name == "memory"


def test_memory_action_map_covers_documented_actions() -> None:
    # Sanity check: our map at least covers add/replace/remove.
    for action in ("add", "replace", "remove"):
        assert action in _MEMORY_ACTION_MAP
