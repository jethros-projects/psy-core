"""pre_tool_call / post_tool_call behavior + dedup."""

from __future__ import annotations

import time
from typing import Any

from psy_core.hermes.config import PsyHermesConfig
from psy_core.hermes.hooks import _MEMORY_ACTION_MAP, HookHandlers, make_hook_handlers


def test_pre_tool_call_emits_intent_for_memory_add(hooks: HookHandlers, fake_ingest: Any) -> None:
    # Real Hermes memory tool args: {action, target, content?, old_text?}
    # where target ∈ {"memory","user"}.
    hooks.pre_tool_call(
        tool_name="memory",
        args={"action": "add", "target": "memory", "content": "hello"},
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
    assert env["memory_path"] == "/memories/MEMORY.md"
    assert env["payload"]["tool"] == "memory"


def test_pre_tool_call_routes_user_target_to_user_md(hooks: HookHandlers, fake_ingest: Any) -> None:
    hooks.pre_tool_call(
        tool_name="memory",
        args={"action": "add", "target": "user", "content": "alice prefers email"},
        tool_call_id="call-user",
    )
    assert fake_ingest.sent[-1]["memory_path"] == "/memories/USER.md"


def test_pre_tool_call_routes_skill_manage_to_skill_md(
    hooks: HookHandlers, fake_ingest: Any,
) -> None:
    hooks.pre_tool_call(
        tool_name="skill_manage",
        args={"action": "create", "name": "deploy-runbook", "content": "..."},
        tool_call_id="skill-create",
    )
    env = fake_ingest.sent[-1]
    assert env["operation"] == "create"
    assert env["memory_path"] == "/skills/deploy-runbook/SKILL.md"


def test_pre_tool_call_uses_file_path_for_subfile_writes(
    hooks: HookHandlers, fake_ingest: Any,
) -> None:
    hooks.pre_tool_call(
        tool_name="skill_manage",
        args={
            "action": "write_file",
            "name": "deploy-runbook",
            "file_path": "references/example.md",
            "file_content": "x",
        },
        tool_call_id="skill-wf",
    )
    assert fake_ingest.sent[-1]["memory_path"] == "/skills/deploy-runbook/references/example.md"


def test_pre_tool_call_skips_unrelated_tools(hooks: HookHandlers, fake_ingest: Any) -> None:
    hooks.pre_tool_call(tool_name="terminal", args={"command": "ls"}, tool_call_id="call-x")
    assert fake_ingest.sent == []


def test_pre_tool_call_skips_when_action_unknown(hooks: HookHandlers, fake_ingest: Any) -> None:
    hooks.pre_tool_call(
        tool_name="memory",
        # An action outside the write set must be skipped.
        args={"action": "nonexistent_action", "target": "memory"},
        tool_call_id="call-2",
    )
    assert fake_ingest.sent == []


def test_pre_tool_call_dedupes_double_fire(hooks: HookHandlers, fake_ingest: Any) -> None:
    args = {"action": "replace", "content": "v2"}
    hooks.pre_tool_call(tool_name="memory", args=args, tool_call_id="dup-1", session_id="s")
    hooks.pre_tool_call(tool_name="memory", args=args, tool_call_id="dup-1", session_id="s")
    assert len(fake_ingest.sent) == 1


def test_skill_manage_pre_policy_probe_without_tool_call_id_is_ignored(
    hooks: HookHandlers,
    fake_ingest: Any,
) -> None:
    args = {"action": "create", "name": "demo", "content": "x"}
    hooks.pre_tool_call(tool_name="skill_manage", args=args, task_id="session-only")
    assert fake_ingest.sent == []


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


def test_post_tool_call_removes_pending_skill_intent(hooks: HookHandlers) -> None:
    hooks.pre_tool_call(
        tool_name="skill_manage",
        args={"action": "create", "name": "demo", "content": "x"},
        tool_call_id="skill-pending",
    )
    assert "skill-pending" in hooks.pending

    hooks.post_tool_call(
        tool_name="skill_manage",
        args={"action": "create", "name": "demo", "content": "x"},
        tool_call_id="skill-pending",
        result="created",
    )

    assert "skill-pending" not in hooks.pending


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

    def boom(_: dict[str, Any]) -> bool:
        raise RuntimeError("boom")

    fake_ingest.send = boom
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


def test_take_pending_discards_stale_entries(hooks: HookHandlers) -> None:
    hooks.pre_tool_call(
        tool_name="memory",
        args={"action": "add", "content": "stale"},
        tool_call_id="too-old",
    )
    with hooks.pending_lock:
        pending = hooks.pending["too-old"]
        hooks.pending["too-old"] = pending.__class__(
            call_id=pending.call_id,
            operation=pending.operation,
            tool_name=pending.tool_name,
            memory_path=pending.memory_path,
            args=pending.args,
            enqueued_at=time.monotonic() - 60.0,
            session_id=pending.session_id,
        )

    assert hooks.take_pending("too-old", max_age_s=1.0) is None
    assert "too-old" not in hooks.pending


def test_payload_capture_false_omits_payload(
    base_config: PsyHermesConfig,
    fake_ingest: Any,
) -> None:
    cfg = base_config.model_copy(update={"payload_capture": False})
    handlers = make_hook_handlers(cfg, fake_ingest, redactor=None)

    handlers.pre_tool_call(
        tool_name="memory",
        args={"action": "add", "content": "hello"},
        tool_call_id="no-payload",
    )

    env = fake_ingest.sent[0]
    assert env["call_id"] == "no-payload"
    assert env["identity"]["actor_id"] == "alice@acme.com"
    assert "payload" not in env


def test_custom_redactor_is_applied_before_send(
    base_config: PsyHermesConfig,
    fake_ingest: Any,
) -> None:
    def redactor(payload: Any) -> dict[str, str]:
        assert payload["tool"] == "memory"
        return {"redacted": "yes"}

    handlers = make_hook_handlers(base_config, fake_ingest, redactor=redactor)

    handlers.pre_tool_call(
        tool_name="memory",
        args={"action": "add", "content": "secret"},
        tool_call_id="custom-redactor",
    )

    assert fake_ingest.sent[0]["payload"] == {"redacted": "yes"}


def test_memory_action_map_covers_documented_actions() -> None:
    # Sanity check: our map at least covers add/replace/remove.
    for action in ("add", "replace", "remove"):
        assert action in _MEMORY_ACTION_MAP
