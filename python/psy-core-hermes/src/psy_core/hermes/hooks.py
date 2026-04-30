"""Hermes hook handlers.

Two subscriptions only:

- `pre_tool_call` filtered to {"memory", "skill_manage"}
- `post_tool_call` filtered to {"skill_manage"}

The `memory` tool bypasses `post_tool_call` because it's listed in
`_AGENT_LOOP_TOOLS` upstream; we confirm memory results via the
filesystem watcher in `watcher.py`.

Pre-hook double-fires for normal-registry tools (Hermes calls the hook
twice: once from `run_agent.py` and once from `model_tools.py`). We dedupe
on `(session_id, tool_call_id, tool_name, sha256(canonical(args)))` with
TTL ≥ one turn.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from psy_core.hermes.config import PsyHermesConfig
from psy_core.hermes.ingest_client import IngestClient
from psy_core.hermes.redaction import Redactor

LOG = logging.getLogger("psy_core.hermes.hooks")

#: Hermes tool names we observe. Tools outside this set are ignored.
MEMORY_TOOLS = frozenset({"memory", "skill_manage"})
#: Subset of MEMORY_TOOLS that goes through the normal post_tool_call path.
SKILL_TOOLS = frozenset({"skill_manage"})

#: Map Hermes-specific argument actions onto psy-core canonical operations.
#: Hermes 'memory' tool actions:
_MEMORY_ACTION_MAP: dict[str, str] = {
    "add": "create",
    "create": "create",
    "replace": "str_replace",
    "edit": "str_replace",
    "remove": "delete",
    "delete": "delete",
}
#: Hermes 'skill_manage' tool actions:
_SKILL_ACTION_MAP: dict[str, str] = {
    "create": "create",
    "write_file": "create",
    "edit": "str_replace",
    "patch": "str_replace",
    "delete": "delete",
    "remove_file": "delete",
}


@dataclass
class DedupeCache:
    """Bounded LRU dedupe cache with per-entry TTL.

    Hermes hooks fire on multiple worker threads, so the cache is guarded
    by a lock. We don't reach for `functools.lru_cache` because we need
    TTL semantics (one turn, ~30s) and not just LRU eviction.
    """

    ttl_s: float = 60.0
    max_entries: int = 4096
    _store: OrderedDict[str, float] = field(default_factory=OrderedDict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def seen(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            self._evict_expired(now)
            if key in self._store:
                self._store.move_to_end(key)
                return True
            self._store[key] = now
            if len(self._store) > self.max_entries:
                self._store.popitem(last=False)
            return False

    def _evict_expired(self, now: float) -> None:
        cutoff = now - self.ttl_s
        while self._store:
            oldest_key, oldest_at = next(iter(self._store.items()))
            if oldest_at >= cutoff:
                break
            self._store.popitem(last=False)


def _canonical_json(value: Any) -> str:
    """Canonicalize a JSON-shaped value for hashing.

    Sorted keys + tight separators. NFC-normalize string values to mirror
    psy-core's canonicalization for the dedupe key (full byte-equivalence
    is not required here — this hash never crosses to TS).
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _args_hash(args: Any) -> str:
    return hashlib.sha256(_canonical_json(args).encode("utf-8")).hexdigest()


def _operation_for(tool_name: str, args: dict[str, Any]) -> str | None:
    """Map (tool_name, args) -> psy canonical operation. None means skip."""
    action = args.get("action")
    if not isinstance(action, str):
        return None
    if tool_name == "memory":
        return _MEMORY_ACTION_MAP.get(action)
    if tool_name == "skill_manage":
        return _SKILL_ACTION_MAP.get(action)
    return None


def _memory_path_for(tool_name: str, args: dict[str, Any]) -> str:
    """Best-effort path string. Used for the audit row's `memory_path` column.

    Mapped against the real Hermes v0.11 tool schemas:
      - memory: required args are `{action, target, content?, old_text?}`,
        where `target` ∈ {"memory", "user"} and writes land in MEMORY.md or
        USER.md respectively.
      - skill_manage: required args are `{action, name, ...}`, where `name`
        is the skill key. `file_path` is an optional sub-path under the
        skill directory used by `write_file` / `remove_file` / `patch`.
    """
    if tool_name == "memory":
        target = args.get("target")
        if target == "user":
            return "/memories/USER.md"
        # Default ("memory" target, or unspecified) writes to MEMORY.md.
        return "/memories/MEMORY.md"
    if tool_name == "skill_manage":
        skill = args.get("name") or "<unknown>"
        file_path = args.get("file_path")
        if file_path:
            return f"/skills/{skill}/{file_path}"
        return f"/skills/{skill}/SKILL.md"
    return "/memories"


def _identity_block(config: PsyHermesConfig, session_id: str | None) -> dict[str, Any] | None:
    actor = config.actor_id
    tenant = config.tenant_id
    if not actor and not tenant and not session_id:
        return None
    block: dict[str, Any] = {}
    if actor:
        block["actor_id"] = actor
    if tenant:
        block["tenant_id"] = tenant
    if session_id:
        block["session_id"] = session_id
    return block


@dataclass
class PendingIntent:
    """An intent envelope's identifying metadata, retained briefly so the
    filesystem watcher can pair a result envelope back to it.
    """

    call_id: str
    operation: str
    tool_name: str
    memory_path: str
    args: dict[str, Any]
    enqueued_at: float
    session_id: str | None


@dataclass
class HookHandlers:
    """Bundle of hook callables that Hermes registers.

    Holding them on a dataclass (rather than as bare functions) keeps the
    config / ingest client / dedupe cache dependencies explicit and
    testable without a lot of `nonlocal` ceremony.
    """

    config: PsyHermesConfig
    ingest: IngestClient
    redactor: Redactor | None
    dedupe: DedupeCache = field(default_factory=DedupeCache)
    pending: dict[str, PendingIntent] = field(default_factory=dict)
    pending_lock: threading.Lock = field(default_factory=threading.Lock)
    log: logging.Logger = field(default_factory=lambda: LOG)

    def pre_tool_call(self, **kwargs: Any) -> None:
        """Called by Hermes before every tool dispatch.

        We filter to memory + skill_manage and emit an `intent` envelope.
        Errors are swallowed: this hook MUST NOT escape an exception into
        Hermes's executor.
        """
        try:
            self._handle_pre(kwargs)
        except Exception:
            self.log.exception("psy-core-hermes: pre_tool_call failed")

    def post_tool_call(self, **kwargs: Any) -> None:
        """Called by Hermes after a tool returns, but only for tools NOT in
        `_AGENT_LOOP_TOOLS`. The `memory` tool is in that set, so this
        only fires for `skill_manage`.
        """
        try:
            self._handle_post(kwargs)
        except Exception:
            self.log.exception("psy-core-hermes: post_tool_call failed")

    def _handle_pre(self, kwargs: dict[str, Any]) -> None:
        tool_name = kwargs.get("tool_name")
        if tool_name not in MEMORY_TOOLS:
            return
        args = kwargs.get("args") or kwargs.get("tool_args") or {}
        if not isinstance(args, dict):
            args = {}
        operation = _operation_for(tool_name, args)
        if operation is None:
            return  # not a write we care about (e.g. memory.list)
        call_id = (
            kwargs.get("tool_call_id")
            or kwargs.get("call_id")
            or kwargs.get("task_id")
            or _args_hash(args)
        )
        session_id = kwargs.get("session_id")
        dedupe_key = f"{session_id}|{call_id}|{tool_name}|{_args_hash(args)}"
        if self.dedupe.seen(dedupe_key):
            return

        memory_path = _memory_path_for(tool_name, args)
        envelope = self._build_envelope(
            kind="intent",
            operation=operation,
            call_id=call_id,
            session_id=session_id,
            memory_path=memory_path,
            payload={"tool": tool_name, "args": args},
        )
        if self.config.dry_run:
            self.log.info("psy-core-hermes dry-run intent: %s", envelope)
            return
        self.ingest.send(envelope)

        # Stash the intent so the filesystem watcher can match a result
        # envelope back to it within the 1-second window.
        with self.pending_lock:
            self.pending[call_id] = PendingIntent(
                call_id=call_id,
                operation=operation,
                tool_name=tool_name,
                memory_path=memory_path,
                args=args,
                enqueued_at=time.monotonic(),
                session_id=session_id,
            )

    def _handle_post(self, kwargs: dict[str, Any]) -> None:
        tool_name = kwargs.get("tool_name")
        if tool_name not in SKILL_TOOLS:
            return  # `memory` results come from the filesystem watcher
        args = kwargs.get("args") or kwargs.get("tool_args") or {}
        if not isinstance(args, dict):
            args = {}
        operation = _operation_for(tool_name, args)
        if operation is None:
            return
        call_id = (
            kwargs.get("tool_call_id")
            or kwargs.get("call_id")
            or kwargs.get("task_id")
            or _args_hash(args)
        )
        session_id = kwargs.get("session_id")
        result = kwargs.get("result")
        memory_path = _memory_path_for(tool_name, args)

        envelope = self._build_envelope(
            kind="result",
            operation=operation,
            call_id=call_id,
            session_id=session_id,
            memory_path=memory_path,
            payload={"tool": tool_name, "args": args, "result": _summarize_result(result)},
        )
        if self.config.dry_run:
            self.log.info("psy-core-hermes dry-run result: %s", envelope)
            return
        self.ingest.send(envelope)
        with self.pending_lock:
            self.pending.pop(call_id, None)

    def take_pending(self, call_id: str, *, max_age_s: float = 1.0) -> PendingIntent | None:
        """Pop a pending intent that matches the given call_id, if it
        was enqueued within `max_age_s`. Used by the filesystem watcher.
        """
        cutoff = time.monotonic() - max_age_s
        with self.pending_lock:
            pending = self.pending.pop(call_id, None)
            if pending is None:
                return None
            if pending.enqueued_at < cutoff:
                return None
            return pending

    def _build_envelope(
        self,
        *,
        kind: str,
        operation: str,
        call_id: str,
        session_id: str | None,
        memory_path: str,
        payload: dict[str, Any] | None,
    ) -> dict[str, Any]:
        envelope: dict[str, Any] = {
            "type": kind,
            "operation": operation,
            "call_id": call_id,
            "memory_path": memory_path,
            "source": "psy-core-hermes",
        }
        identity = _identity_block(self.config, session_id)
        if identity:
            envelope["identity"] = identity
        if self.config.purpose:
            envelope["purpose"] = self.config.purpose
        if payload is not None and self.config.payload_capture:
            redacted = self.redactor(payload) if self.redactor else payload
            envelope["payload"] = redacted
        return envelope


def _summarize_result(result: Any) -> Any:
    """Coerce a tool result into something JSON-serializable + bounded.

    We don't try to capture the full output: most tool results are large
    and frequently include text blocks the redactor never sees inside the
    structured envelope. Strings get truncated; everything else is left
    alone for `json.dumps` to validate.
    """
    if result is None:
        return None
    if isinstance(result, str):
        return result if len(result) <= 1024 else result[:1024] + "…"
    if isinstance(result, (list, dict)):
        return result
    return repr(result)


HookFactory = Callable[[PsyHermesConfig, IngestClient, Redactor | None], HookHandlers]


def make_hook_handlers(
    config: PsyHermesConfig,
    ingest: IngestClient,
    redactor: Redactor | None,
) -> HookHandlers:
    return HookHandlers(config=config, ingest=ingest, redactor=redactor)
