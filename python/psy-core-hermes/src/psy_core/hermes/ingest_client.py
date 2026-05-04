"""Long-lived subprocess manager + thread-safe queue for ingest envelopes.

Spawns either `psy` on PATH or, mirroring the plur-hermes precedent on
PyPI, falls back to `npx -y psy-core@<exact-version> psy ingest`. Both
forms are invoked via argv (never `shell=True`).

Threading model:

- Hooks fire from Hermes's `ThreadPoolExecutor`. Hook handlers MUST enqueue
  the envelope and return immediately — they never own the subprocess pipe.
- A single background writer thread drains the queue, writes one JSONL line
  per envelope, and reads one ACK line. The pipe is single-owner.
- stdout is read by one per-process reader thread so handshake/ACK waits can
  have deadlines without leaving abandoned readline threads behind.
- stderr is drained by one per-process reader thread so noisy children cannot
  fill the pipe and block ACK progress.
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
#: Per-envelope ACK timeout (seconds).
ACK_TIMEOUT_S = 5.0
#: Soft termination grace period (seconds) before SIGKILL.
TERM_GRACE_S = 3.0
#: Maximum events held in memory before drops kick in.
QUEUE_MAX_SIZE = 1024
#: Stderr drain chunk size. Chunked reads avoid buffering an unbounded line.
STDERR_DRAIN_CHARS = 4096
#: Maximum stderr preview characters included in a single debug log entry.
STDERR_LOG_PREVIEW_CHARS = 2048

_STDOUT_EOF = object()


@dataclass(frozen=True)
class _ReadLineResult:
    """Result of a deadline-bound stdout line read."""

    line: str | None
    timed_out: bool = False


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
        ack_timeout_s: float = ACK_TIMEOUT_S,
        log: logging.Logger | None = None,
    ) -> None:
        self._plan = plan
        self._cwd = cwd
        self._env = env or {}
        self._startup_timeout_s = startup_timeout_s
        self._ack_timeout_s = ack_timeout_s
        self._log = log or LOG
        self._queue: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=QUEUE_MAX_SIZE)
        self._proc: subprocess.Popen[str] | None = None
        self._stdout_lines: queue.Queue[str | object] | None = None
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
            self._stdout_lines = None
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
                stdout_lines = self._start_stdout_reader(proc)
                self._start_stderr_drain(proc)
                handshake = self._read_handshake(proc, stdout_lines)
            except Exception:
                self._terminate_proc(proc)
                self._close_proc_streams(proc)
                self._proc = None
                self._stdout_lines = None
                self._handshake = None
                raise
            self._proc = proc
            self._stdout_lines = stdout_lines
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

    def _start_stdout_reader(
        self,
        proc: subprocess.Popen[str],
    ) -> queue.Queue[str | object]:
        if not proc.stdout:
            raise RuntimeError("ingest subprocess has no stdout pipe")
        lines: queue.Queue[str | object] = queue.Queue()

        def reader() -> None:
            try:
                assert proc.stdout is not None
                for line in proc.stdout:
                    lines.put(line)
            except (OSError, ValueError):
                pass
            finally:
                lines.put(_STDOUT_EOF)

        thread = threading.Thread(
            target=reader,
            name=f"psy-core-hermes-stdout-{proc.pid}",
            daemon=True,
        )
        thread.start()
        return lines

    def _start_stderr_drain(self, proc: subprocess.Popen[str]) -> None:
        if not proc.stderr:
            return

        def drain() -> None:
            try:
                assert proc.stderr is not None
                while True:
                    chunk = proc.stderr.read(STDERR_DRAIN_CHARS)
                    if not chunk:
                        break
                    preview = chunk.rstrip()
                    if not preview:
                        continue
                    if len(preview) > STDERR_LOG_PREVIEW_CHARS:
                        preview = preview[:STDERR_LOG_PREVIEW_CHARS] + "..."
                    self._log.debug("ingest stderr: %s", preview)
            except (OSError, ValueError):
                pass

        thread = threading.Thread(
            target=drain,
            name=f"psy-core-hermes-stderr-{proc.pid}",
            daemon=True,
        )
        thread.start()

    def _read_handshake(
        self,
        proc: subprocess.Popen[str],
        stdout_lines: queue.Queue[str | object],
    ) -> dict[str, Any]:
        deadline = time.monotonic() + self._startup_timeout_s
        result = self._readline_with_deadline(stdout_lines, deadline)
        if result.timed_out:
            raise TimeoutError(
                f"ingest subprocess did not emit handshake within {self._startup_timeout_s}s"
            )
        if result.line is None:
            raise BrokenPipeError("ingest subprocess closed stdout before handshake")
        try:
            parsed = json.loads(result.line)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"ingest subprocess emitted non-JSON handshake: {result.line!r}"
            ) from exc
        if not parsed.get("ok"):
            raise RuntimeError(f"ingest subprocess refused handshake: {parsed!r}")
        return cast(dict[str, Any], parsed)

    def _readline_with_deadline(
        self,
        stdout_lines: queue.Queue[str | object],
        deadline: float,
    ) -> _ReadLineResult:
        timeout = max(0.0, deadline - time.monotonic())
        try:
            item = stdout_lines.get(timeout=timeout)
        except queue.Empty:
            return _ReadLineResult(line=None, timed_out=True)
        if item is _STDOUT_EOF:
            return _ReadLineResult(line=None)
        line = cast(str, item).strip()
        return _ReadLineResult(line=line or None)

    def _run_writer(self) -> None:
        proc = self._proc
        stdout_lines = self._stdout_lines
        if not proc or not proc.stdin or stdout_lines is None:
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
                ack = self._read_ack(proc, stdout_lines)
                if not ack.get("ok"):
                    self._log.warning("ingest rejected envelope: %s", ack)
                self._consecutive_failures = 0
            except (BrokenPipeError, OSError, TimeoutError, json.JSONDecodeError) as exc:
                if self._closed:
                    break
                self._record_failure(f"writer error: {exc}")
                self._retire_proc(proc)
                break

    def _read_ack(
        self,
        proc: subprocess.Popen[str],
        stdout_lines: queue.Queue[str | object],
    ) -> dict[str, Any]:
        result = self._readline_with_deadline(
            stdout_lines,
            time.monotonic() + self._ack_timeout_s,
        )
        if result.timed_out:
            raise TimeoutError(
                f"ingest subprocess did not ACK envelope within {self._ack_timeout_s}s"
            )
        if result.line is None:
            if proc.poll() is None:
                raise BrokenPipeError("ingest subprocess closed stdout")
            raise BrokenPipeError(
                f"ingest subprocess exited before ACK with code {proc.returncode}"
            )
        return cast(dict[str, Any], json.loads(result.line))

    def _retire_proc(self, proc: subprocess.Popen[str]) -> None:
        with self._lock:
            if self._proc is proc:
                self._proc = None
                self._stdout_lines = None
                self._handshake = None
        if proc.poll() is None:
            self._terminate_proc(proc)
        self._close_proc_streams(proc)

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
