"""Filesystem watcher for Hermes memory files.

The Hermes `memory` tool is in `_AGENT_LOOP_TOOLS` upstream, which means
its results never trigger `post_tool_call`. To produce a paired result
envelope we observe the filesystem instead: when MEMORY.md or USER.md
changes, the watcher consults the recent pending-intent map (kept by the
hook handlers) and emits a result envelope referencing the matching
`call_id`.

Write detection edge cases that we explicitly handle:
- atomic rename writes (write-to-temp + os.replace) — caught via
  on_modified + on_moved listeners.
- inotify event coalescing on rapid sequential writes — debounce on a
  short timer (50ms) per file path.
- symlink replacement — the watchdog Observer follows the link target
  by default; we additionally hash the target's bytes so a rebound
  symlink (without content change) doesn't produce a spurious event.
- writes that DIDN'T originate from a tool call we observed — emit with
  outcome="unattributed" so the chain still records them.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections.abc import Iterable
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from psy_hermes.config import PsyHermesConfig
    from psy_hermes.hooks import HookHandlers
    from psy_hermes.ingest_client import IngestClient

LOG = logging.getLogger("psy_hermes.watcher")

#: Files we watch by default (relative to `memories_dir`).
DEFAULT_WATCH_FILES: tuple[str, ...] = ("MEMORY.md", "USER.md")
#: Debounce window for coalescing rapid filesystem events on the same path.
DEBOUNCE_S = 0.05
#: How long after an intent we'll still pair a filesystem change with it.
PAIR_WINDOW_S = 1.0


@dataclass
class _LastSeen:
    """Per-file content hash + last event time used for debouncing."""

    digest: str | None = None
    at: float = 0.0


class MemoryWatcher:
    """Observe memory files; emit result envelopes to the ingest client.

    The watcher does not own the ingest pipeline directly — it borrows
    the hook handlers' pending-intent map so it can pair filesystem
    changes back to recent `pre_tool_call` envelopes.
    """

    def __init__(
        self,
        *,
        config: PsyHermesConfig,
        hooks: HookHandlers,
        ingest: IngestClient,
        watch_files: Iterable[str] = DEFAULT_WATCH_FILES,
        log: logging.Logger | None = None,
    ) -> None:
        self._config = config
        self._hooks = hooks
        self._ingest = ingest
        self._watch_files = tuple(watch_files)
        self._log = log or LOG
        self._observer: Any | None = None
        self._last_seen: dict[Path, _LastSeen] = {}
        self._lock = threading.Lock()
        self._started = False

    def start(self) -> None:
        """Start the watchdog observer thread.

        Idempotent. If `memories_dir` doesn't exist yet, the watcher
        defers until it does — Hermes creates the dir on first memory
        write, so it's normal for it to be missing at session start.
        """
        if self._started:
            return
        memories_dir = self._config.memories_dir
        if not memories_dir.exists():
            self._log.debug("memories_dir %s does not exist yet; deferring watcher", memories_dir)
            return

        # Lazy import: watchdog is a heavy import we don't want to pay
        # at module load time for users running `psy-hermes init` etc.
        from watchdog.events import FileSystemEvent, FileSystemEventHandler
        from watchdog.observers import Observer

        watch_paths = {memories_dir / name for name in self._watch_files}

        # Seed each file's known digest so the first inotify event after
        # startup doesn't fire spuriously for a no-op stat.
        for path in watch_paths:
            self._last_seen[path] = _LastSeen(digest=_safe_hash(path), at=time.monotonic())

        watcher = self

        class _Handler(FileSystemEventHandler):
            def on_modified(self, event: FileSystemEvent) -> None:
                if event.is_directory:
                    return
                path = Path(event.src_path)
                if path in watch_paths:
                    watcher._on_change(path)

            def on_moved(self, event: FileSystemEvent) -> None:
                if event.is_directory:
                    return
                # atomic-rename pattern: a temp file is renamed onto the
                # watched path. Treat the destination as the change target.
                dest = Path(getattr(event, "dest_path", "") or "")
                if dest and dest in watch_paths:
                    watcher._on_change(dest)

            def on_created(self, event: FileSystemEvent) -> None:
                if event.is_directory:
                    return
                path = Path(event.src_path)
                if path in watch_paths:
                    watcher._on_change(path)

        self._observer = Observer()
        self._observer.schedule(_Handler(), str(memories_dir), recursive=False)
        self._observer.start()
        self._started = True
        self._log.info("psy-hermes watcher started on %s", memories_dir)

    def stop(self) -> None:
        if not self._started or self._observer is None:
            return
        with suppress(Exception):
            self._observer.stop()
            self._observer.join(timeout=2.0)
        self._started = False

    def _on_change(self, path: Path) -> None:
        now = time.monotonic()
        digest = _safe_hash(path)
        with self._lock:
            last = self._last_seen.get(path)
            if last is None:
                last = _LastSeen()
                self._last_seen[path] = last
            if now - last.at < DEBOUNCE_S and digest == last.digest:
                return  # debounce: same content within debounce window
            if digest is not None and digest == last.digest:
                # Same content but the FS layer fired anyway (e.g. atime
                # touch). Don't emit a result envelope.
                last.at = now
                return
            last.digest = digest
            last.at = now

        # Try to pair this change back to a recent pending intent.
        pending = self._most_recent_pending(within_s=PAIR_WINDOW_S)
        envelope = self._build_envelope(path, digest, pending)
        if self._config.dry_run:
            self._log.info("psy-hermes dry-run watcher: %s", envelope)
            return
        self._ingest.send(envelope)

    def _most_recent_pending(self, *, within_s: float) -> Any:
        """Find the most recent pending intent (any call_id) within window.

        We deliberately match on recency, not on memory_path: the Hermes
        memory tool can be invoked with a `path` arg, but the tool's
        output is appended to MEMORY.md or USER.md regardless of any
        sub-path. Pairing strictly by memory_path would miss most events.
        """
        from psy_hermes.hooks import PendingIntent  # local import — avoids cycle

        cutoff = time.monotonic() - within_s
        candidate: PendingIntent | None = None
        with self._hooks.pending_lock:
            for entry in list(self._hooks.pending.values()):
                if entry.enqueued_at < cutoff:
                    continue
                if candidate is None or entry.enqueued_at > candidate.enqueued_at:
                    candidate = entry
            if candidate is not None:
                self._hooks.pending.pop(candidate.call_id, None)
        return candidate

    def _build_envelope(
        self,
        path: Path,
        digest: str | None,
        pending: Any,
    ) -> dict[str, Any]:
        memory_path = f"/memories/{path.name}"
        if pending is not None:
            envelope: dict[str, Any] = {
                "type": "result",
                "operation": pending.operation,
                "call_id": pending.call_id,
                "memory_path": memory_path,
                "source": "psy-hermes-watcher",
            }
            if pending.session_id:
                envelope.setdefault("identity", {})["session_id"] = pending.session_id
        else:
            envelope = {
                "type": "result",
                "operation": "create",
                "call_id": f"unattributed-{int(time.monotonic() * 1000)}-{path.name}",
                "memory_path": memory_path,
                "source": "psy-hermes-watcher",
                "outcome": "unattributed",
            }
        identity_block: dict[str, Any] = envelope.get("identity", {}) or {}
        if self._config.actor_id:
            identity_block["actor_id"] = self._config.actor_id
        if self._config.tenant_id:
            identity_block["tenant_id"] = self._config.tenant_id
        if identity_block:
            envelope["identity"] = identity_block
        if self._config.purpose:
            envelope["purpose"] = self._config.purpose
        if self._config.payload_capture and digest:
            envelope["payload"] = {"content_hash": digest, "path": str(path)}
        return envelope


def _safe_hash(path: Path) -> str | None:
    """Hash the file's bytes; return None if it doesn't exist or can't be read."""
    try:
        with path.open("rb") as fh:
            digest = hashlib.sha256()
            for chunk in iter(lambda: fh.read(64 * 1024), b""):
                digest.update(chunk)
            return digest.hexdigest()
    except (FileNotFoundError, OSError):
        return None
