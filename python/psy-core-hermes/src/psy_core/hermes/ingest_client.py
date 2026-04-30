"""Long-lived subprocess manager + thread-safe queue for ingest envelopes.

Spawns either `psy` on PATH or, mirroring the plur-hermes precedent on
PyPI, falls back to `npx -y psy-core@<exact-version> psy ingest`. Both
forms are invoked via argv (never `shell=True`).

Threading model:

- Hooks fire from Hermes's `ThreadPoolExecutor`. Hook handlers MUST enqueue
  the envelope and return immediately — they never own the subprocess pipe.
- A single background writer thread drains the queue, writes one JSONL line
  per envelope, and reads one ACK line. The pipe is single-owner.
- Crash recovery: 3 consecutive subprocess failures put the client into a
  degraded state where new events are dropped and a WARN is logged
  once-per-60s. Resume on next session by reinstantiating the client.

Subprocess lifecycle:
- `Popen(start_new_session=True)` — own process group so we can `killpg`.
- 5s startup timeout, expecting one handshake line `{"ok":true,...}`.
- `atexit` + `SIGTERM`/`SIGINT` handlers tear the child down with TERM,
  then 3s wait, then KILL.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import queue
import shutil
import signal
import subprocess
import threading
import time
from collections.abc import Iterable
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

LOG = logging.getLogger("psy_core.hermes.ingest")

#: How many consecutive failures put the client into degraded state.
MAX_CONSECUTIVE_FAILURES = 3
#: How frequently to log the degraded-state warning.
DEGRADED_WARN_INTERVAL_S = 60.0
#: Subprocess handshake timeout (seconds).
STARTUP_TIMEOUT_S = 5.0
#: Soft termination grace period (seconds) before SIGKILL.
TERM_GRACE_S = 3.0
#: Maximum events held in memory before drops kick in.
QUEUE_MAX_SIZE = 1024


@dataclass
class IngestSpawnPlan:
    """Resolved invocation plan for the ingest subprocess.

    Either a direct binary on PATH (`psy`) or the npx fallback
    (`npx -y psy-core@<exact> psy ingest`). The fallback form is the same
    pattern plur-hermes uses against `@plur-ai/cli` on npm.
    """

    argv: list[str]
    description: str


def resolve_spawn_plan(psy_binary: str | None, psy_core_version: str) -> IngestSpawnPlan:
    """Pick a subprocess invocation strategy.

    1. Explicit `psy_binary` config wins if set and resolvable.
    2. `psy` on PATH is used directly (most natural form for users with
       `npm i -g psy-core` already done).
    3. Otherwise fall back to `npx -y psy-core@<exact> psy ingest`.
    """
    if psy_binary:
        resolved = shutil.which(psy_binary) or psy_binary
        return IngestSpawnPlan(argv=[resolved, "ingest"], description=f"binary:{resolved}")
    on_path = shutil.which("psy")
    if on_path:
        return IngestSpawnPlan(argv=[on_path, "ingest"], description=f"path:{on_path}")
    npx = shutil.which("npx")
    if npx:
        return IngestSpawnPlan(
            argv=[npx, "-y", f"psy-core@{psy_core_version}", "psy", "ingest"],
            description=f"npx:psy-core@{psy_core_version}",
        )
    raise FileNotFoundError(
        "psy-core-hermes: neither `psy` nor `npx` was found on PATH. "
        "Install with `npm i -g psy-core` or install Node.js so npx is available."
    )


def _scrub_env() -> dict[str, str]:
    """Return a minimal env for the subprocess.

    Strip everything except a vetted allow-list. PSY_SEAL_KEY is forwarded
    so users with secrets-manager-injected keys keep working; common Node
    + npm vars are kept so npx can hit the registry; the rest is dropped
    to avoid leaking app secrets into the child's env table.
    """
    keep = (
        "HOME",
        "PATH",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        "TZ",
        "TMPDIR",
        "PSY_SEAL_KEY",
        "PSY_SEAL_KEY_PATH",
        "PSY_HEAD_PATH",
        "PSY_AUDIT_DB_PATH",
        "PSY_DB_PATH",
        "PSY_ARCHIVES_PATH",
        "NODE_OPTIONS",
        "NPM_CONFIG_REGISTRY",
        "npm_config_cache",
        "npm_config_userconfig",
        "NVM_DIR",
        "NVM_BIN",
    )
    env = {k: os.environ[k] for k in keep if k in os.environ}
    return env


class IngestClient:
    """Thread-safe client for sending envelopes to a long-lived `psy ingest`.

    Spawning is lazy: the subprocess is only started on the first call to
    `send`. This avoids paying a subprocess cost at session-start time for
    sessions that never make a memory write.
    """

    def __init__(
        self,
        *,
        plan: IngestSpawnPlan,
        cwd: Path | None = None,
        env: dict[str, str] | None = None,
        startup_timeout_s: float = STARTUP_TIMEOUT_S,
        log: logging.Logger | None = None,
    ) -> None:
        self._plan = plan
        self._cwd = cwd
        self._env = env or {}
        self._startup_timeout_s = startup_timeout_s
        self._log = log or LOG
        self._queue: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=QUEUE_MAX_SIZE)
        self._proc: subprocess.Popen[str] | None = None
        self._writer_thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._consecutive_failures = 0
        self._degraded_until_restart = False
        self._last_warn_at = 0.0
        self._closed = False
        self._handshake: dict[str, Any] | None = None

        # atexit + signal cleanup so the subprocess exits with the parent.
        atexit.register(self.close)
        for sig in (signal.SIGTERM, signal.SIGINT):
            with suppress(ValueError, OSError):
                # Don't override an existing handler; chain to it. In tests
                # we may be on a non-main thread; in that case skip.
                if threading.current_thread() is threading.main_thread():
                    self._install_signal(sig)

    def _install_signal(self, sig: signal.Signals) -> None:
        previous = signal.getsignal(sig)

        def handler(signum: int, frame: Any) -> None:
            self.close()
            if callable(previous):
                previous(signum, frame)

        signal.signal(sig, handler)

    @property
    def degraded(self) -> bool:
        return self._degraded_until_restart

    @property
    def handshake(self) -> dict[str, Any] | None:
        return self._handshake

    def send(self, envelope: dict[str, Any]) -> bool:
        """Enqueue an envelope. Returns False if dropped (queue full or
        client is in degraded state).
        """
        if self._closed:
            return False
        if self._degraded_until_restart:
            self._maybe_warn("degraded; dropping event")
            return False
        try:
            self._ensure_started()
        except Exception as exc:
            self._record_failure(f"spawn failed: {exc}")
            return False
        try:
            self._queue.put_nowait(envelope)
            return True
        except queue.Full:
            self._maybe_warn("queue full; dropping event")
            return False

    def close(self) -> None:
        """Best-effort cleanup. Idempotent."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            with suppress(Exception):
                self._queue.put_nowait(None)
            proc = self._proc
            self._proc = None
        if proc:
            if proc.poll() is None:
                self._terminate_proc(proc)
            self._close_proc_streams(proc)
        thread = self._writer_thread
        if thread and thread.is_alive():
            thread.join(timeout=2.0)

    def _ensure_started(self) -> None:
        with self._lock:
            if self._proc and self._proc.poll() is None:
                return
            proc = self._spawn()
            try:
                handshake = self._read_handshake(proc)
            except Exception:
                self._terminate_proc(proc)
                self._close_proc_streams(proc)
                self._proc = None
                self._handshake = None
                raise
            self._proc = proc
            self._handshake = handshake
            self._writer_thread = threading.Thread(
                target=self._run_writer,
                name="psy-core-hermes-writer",
                daemon=True,
            )
            self._writer_thread.start()

    def _spawn(self) -> subprocess.Popen[str]:
        self._log.info("spawning ingest subprocess: %s", self._plan.description)
        return subprocess.Popen(
            self._plan.argv,
            cwd=str(self._cwd) if self._cwd else None,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # line-buffered
            start_new_session=True,
            env={**_scrub_env(), **self._env},
        )

    def _read_handshake(self, proc: subprocess.Popen[str]) -> dict[str, Any]:
        deadline = time.monotonic() + self._startup_timeout_s
        if not proc.stdout:
            raise RuntimeError("ingest subprocess has no stdout pipe")
        # Use a polling-friendly read so we honor the deadline rather than
        # blocking forever on a child that never wrote a handshake.
        line = self._readline_with_deadline(proc, deadline)
        if line is None:
            raise TimeoutError(
                f"ingest subprocess did not emit handshake within {self._startup_timeout_s}s"
            )
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"ingest subprocess emitted non-JSON handshake: {line!r}") from exc
        if not parsed.get("ok"):
            raise RuntimeError(f"ingest subprocess refused handshake: {parsed!r}")
        return cast(dict[str, Any], parsed)

    def _readline_with_deadline(
        self,
        proc: subprocess.Popen[str],
        deadline: float,
    ) -> str | None:
        # subprocess.Popen.stdout.readline blocks; for a handshake we want
        # a deadline. Spawn a thread that reads one line and join it with
        # a timeout. This is small enough not to warrant aiofiles.
        result: dict[str, str | None] = {"line": None}

        def reader() -> None:
            assert proc.stdout is not None
            line = proc.stdout.readline()
            result["line"] = line if line else None

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        timeout = max(0.01, deadline - time.monotonic())
        t.join(timeout=timeout)
        if t.is_alive():
            return None
        line = result["line"]
        if line is None:
            return None
        return line.strip() or None

    def _run_writer(self) -> None:
        proc = self._proc
        if not proc or not proc.stdin or not proc.stdout:
            return
        while True:
            try:
                envelope = self._queue.get(timeout=0.5)
            except queue.Empty:
                if self._closed:
                    break
                continue
            if envelope is None:
                break
            try:
                line = json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
                proc.stdin.write(line + "\n")
                proc.stdin.flush()
                ack_line = proc.stdout.readline()
                if not ack_line:
                    raise BrokenPipeError("ingest subprocess closed stdout")
                ack = json.loads(ack_line)
                if not ack.get("ok"):
                    self._log.warning("ingest rejected envelope: %s", ack)
                self._consecutive_failures = 0
            except (BrokenPipeError, OSError, json.JSONDecodeError) as exc:
                self._record_failure(f"writer error: {exc}")
                # Loop will exit on the next iteration if degraded.
                if self._degraded_until_restart:
                    break

    def _record_failure(self, message: str) -> None:
        self._consecutive_failures += 1
        self._log.warning("psy-core-hermes: %s (consecutive=%d)", message, self._consecutive_failures)
        if self._consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
            self._degraded_until_restart = True

    def _maybe_warn(self, message: str) -> None:
        now = time.monotonic()
        if now - self._last_warn_at >= DEGRADED_WARN_INTERVAL_S:
            self._log.warning("psy-core-hermes: %s", message)
            self._last_warn_at = now

    def _terminate_proc(self, proc: subprocess.Popen[str]) -> None:
        # Per-group SIGTERM, then SIGKILL after grace.
        try:
            pgid = os.getpgid(proc.pid)
        except (ProcessLookupError, OSError):
            pgid = None
        if pgid is not None:
            with suppress(ProcessLookupError, OSError):
                os.killpg(pgid, signal.SIGTERM)
        else:
            with suppress(ProcessLookupError, OSError):
                proc.terminate()
        try:
            proc.wait(timeout=TERM_GRACE_S)
            return
        except subprocess.TimeoutExpired:
            pass
        if pgid is not None:
            with suppress(ProcessLookupError, OSError):
                os.killpg(pgid, signal.SIGKILL)
        else:
            with suppress(ProcessLookupError, OSError):
                proc.kill()
        with suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=1.0)

    def _close_proc_streams(self, proc: subprocess.Popen[str]) -> None:
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                with suppress(Exception):
                    stream.close()


def envelopes_from_iterable(items: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Test helper: realize a generator into a list."""
    return list(items)
