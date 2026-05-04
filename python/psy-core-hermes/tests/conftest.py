"""Shared pytest fixtures."""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any, cast

import pytest

from psy_core.hermes.config import PsyHermesConfig
from psy_core.hermes.hooks import HookHandlers, make_hook_handlers
from psy_core.hermes.ingest_client import IngestClient


class FakeIngestClient:
    """Drop-in stand-in for `IngestClient` in unit tests.

    Records every envelope passed to `send` instead of spawning a real
    subprocess. Thread-safe so concurrency tests can assert ordering.
    """

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self.degraded = False
        self.handshake: dict[str, Any] = {
            "ok": True,
            "version": "test",
            "schema_version": "1.0.0",
        }

    def send(self, envelope: dict[str, Any]) -> bool:
        with self._lock:
            self.sent.append(envelope)
        return True

    def close(self) -> None:
        return None


@pytest.fixture
def fake_ingest() -> FakeIngestClient:
    return FakeIngestClient()


@pytest.fixture
def base_config(tmp_path: Path) -> PsyHermesConfig:
    return PsyHermesConfig(
        actor_id="alice@acme.com",
        tenant_id="acme",
        purpose="test",
        db_path=tmp_path / "psy" / "audit.db",
        seal_key_path=tmp_path / "psy" / "seal-key",
        memories_dir=tmp_path / "memories",
    )


@pytest.fixture
def hooks(
    base_config: PsyHermesConfig,
    fake_ingest: FakeIngestClient,
) -> Iterator[HookHandlers]:
    # Cast: the fake duck-types IngestClient for the small surface hooks use.
    handlers = make_hook_handlers(base_config, cast(IngestClient, fake_ingest), redactor=None)
    yield handlers


@pytest.fixture(autouse=True)
def _reset_logging() -> Iterator[None]:
    # Suppress the noisy WARN logs that exercises of the failure path emit.
    previous = logging.getLogger("psy_core.hermes").level
    logging.getLogger("psy_core.hermes").setLevel(logging.CRITICAL)
    try:
        yield
    finally:
        logging.getLogger("psy_core.hermes").setLevel(previous)
