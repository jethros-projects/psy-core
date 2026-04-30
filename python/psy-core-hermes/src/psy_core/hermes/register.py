"""Hermes Agent plugin entry point.

Exposed via the `hermes_agent.plugins` entry-point group as `psy`. Hermes
discovers it after the user adds `plugins.enabled: [psy]` to
`~/.hermes/config.yaml` (or runs `psy-core-hermes init`).

The plugin is intentionally a plain observer rather than a
`MemoryProvider` subclass: `MemoryManager.add_provider` rejects more than
one non-builtin provider, so subclassing would lock the user out of
running Honcho/Mem0/Hindsight alongside psy.
"""

from __future__ import annotations

import logging
import sys
from contextlib import suppress
from typing import Any

from psy_core.hermes.config import (
    PsyHermesConfig,
    format_actor_id_required_error,
    load_psy_config,
)
from psy_core.hermes.hooks import HookHandlers, make_hook_handlers
from psy_core.hermes.ingest_client import IngestClient, resolve_spawn_plan
from psy_core.hermes.redaction import resolve_redactor
from psy_core.hermes.watcher import MemoryWatcher

LOG = logging.getLogger("psy_core.hermes")


def _read_psy_section() -> dict[str, Any] | None:
    """Read `plugins.psy` from Hermes's config via the standard idiom.

    We import lazily because `hermes_cli` may not be importable in test
    contexts that exercise the rest of the plugin in isolation.
    """
    try:
        from hermes_cli.config import load_config  # type: ignore[import-not-found]
    except Exception:
        LOG.debug("hermes_cli.config.load_config unavailable; using empty section")
        return None
    try:
        config = load_config()
    except Exception:
        LOG.debug("hermes_cli.load_config raised; using empty section")
        return None
    plugins = config.get("plugins", {}) if isinstance(config, dict) else {}
    psy = plugins.get("psy") if isinstance(plugins, dict) else None
    if isinstance(psy, dict):
        return psy
    return None


def register(ctx: Any) -> None:
    """Plugin entry point invoked by Hermes during plugin discovery.

    `ctx` exposes `register_hook(name, handler)` and is opaque to us. We
    never call `ctx.config` (it's not part of the public plugin contract);
    config is read via the standard `hermes_cli.config.load_config`.
    """
    section = _read_psy_section()
    try:
        config = load_psy_config(section)
    except Exception as exc:
        LOG.error("psy-core-hermes config invalid: %s", exc)
        return

    if not config.enabled:
        LOG.info("psy-core-hermes is disabled (config.enabled=false)")
        return

    if not config.actor_id and not config.allow_anonymous:
        # Loud failure with the F4-template message. We log to stderr so
        # the user sees it on session start regardless of log level.
        sys.stderr.write(format_actor_id_required_error())
        sys.stderr.flush()
        return

    try:
        plan = resolve_spawn_plan(config.psy_binary, config.psy_core_version)
    except FileNotFoundError as exc:
        LOG.error("psy-core-hermes: %s", exc)
        return

    ingest = IngestClient(plan=plan)
    redactor = resolve_redactor(config.redactor)
    handlers = make_hook_handlers(config, ingest, redactor)
    watcher = MemoryWatcher(config=config, hooks=handlers, ingest=ingest)

    _wire_hooks(ctx, handlers)

    # Best-effort start: if memories_dir doesn't exist yet (fresh Hermes
    # install) the watcher silently defers. The first memory write creates
    # the dir; we'll catch subsequent changes.
    with suppress(Exception):
        watcher.start()

    LOG.info(
        "psy-core-hermes registered (actor=%s, tenant=%s, purpose=%s, version=%s)",
        config.actor_id,
        config.tenant_id,
        config.purpose,
        config.psy_core_version,
    )


def _wire_hooks(ctx: Any, handlers: HookHandlers) -> None:
    """Subscribe the two hooks. `ctx.register_hook` is the documented API."""
    register_hook = getattr(ctx, "register_hook", None)
    if register_hook is None:
        LOG.warning("psy-core-hermes: ctx has no register_hook; nothing wired")
        return
    register_hook("pre_tool_call", handlers.pre_tool_call)
    register_hook("post_tool_call", handlers.post_tool_call)


def build_for_test(
    config: PsyHermesConfig,
    ingest: IngestClient,
) -> tuple[HookHandlers, MemoryWatcher]:
    """Test helper: build handlers + watcher without invoking `register`."""
    redactor = resolve_redactor(config.redactor)
    handlers = make_hook_handlers(config, ingest, redactor)
    watcher = MemoryWatcher(config=config, hooks=handlers, ingest=ingest)
    return handlers, watcher
