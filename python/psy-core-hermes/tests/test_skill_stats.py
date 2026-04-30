"""Tests for the skill quality metrics module (Loop 2 — revert-rate).

We seed a fixture audit DB with hand-crafted event sequences that
exercise each metric independently:

- churn_ratio:    creates vs str_replaces
- rapid_patches:  patches inside the 1h window
- short_lived:    create+delete within 1 day
- status:         ok / unstable / short-lived classification
- filters:        --actor, --since, --skill-md-only

The fixture writes events directly via sqlite3 so the tests don't need
a running `psy ingest` subprocess. The schema mirrors the one created
by psy-core's TS-side ``store.ts`` ensureSchema (see schema reference
in ``src/psy_core/hermes/skill_stats.py`` docstring).
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from psy_core.hermes.cli import _parse_since
from psy_core.hermes.skill_stats import (
    SkillMetrics,
    compute_skill_stats,
    format_metrics_table,
)

# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

_SCHEMA = """
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE events (
        schema_version TEXT NOT NULL,
        seq INTEGER PRIMARY KEY,
        event_id TEXT UNIQUE NOT NULL,
        operation_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        operation TEXT NOT NULL,
        audit_phase TEXT NOT NULL CHECK (audit_phase IN ('intent', 'result')),
        tool_call_id TEXT,
        actor_id TEXT,
        tenant_id TEXT,
        session_id TEXT,
        memory_path TEXT NOT NULL,
        purpose TEXT,
        payload_preview TEXT,
        payload_redacted INTEGER NOT NULL CHECK (payload_redacted IN (0, 1)),
        redactor_id TEXT,
        redactor_error TEXT,
        tool_input_hash TEXT NOT NULL,
        tool_output_hash TEXT,
        prev_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL,
        outcome TEXT NOT NULL,
        error_code TEXT,
        error_type TEXT,
        error_message TEXT,
        policy_result TEXT NOT NULL
    );
"""


def _seed_db(path: Path, events: list[dict[str, Any]]) -> None:
    """Create a minimal psy-shaped audit DB and seed it with events.

    Only the columns the skill_stats query reads are populated with
    meaningful values; the rest get placeholders to satisfy NOT NULL.
    """
    with sqlite3.connect(path) as conn:
        conn.executescript(_SCHEMA)
        for i, e in enumerate(events, start=1):
            conn.execute(
                """INSERT INTO events (
                    schema_version, seq, event_id, operation_id, timestamp,
                    operation, audit_phase, tool_call_id, actor_id, tenant_id,
                    session_id, memory_path, purpose, payload_preview,
                    payload_redacted, redactor_id, redactor_error,
                    tool_input_hash, tool_output_hash, prev_hash, event_hash,
                    outcome, error_code, error_type, error_message, policy_result
                ) VALUES (
                    '1.0.0', ?, ?, ?, ?,
                    ?, 'intent', ?, ?, ?,
                    ?, ?, NULL, NULL,
                    0, NULL, NULL,
                    'a' * 64, NULL, 'b' * 64, 'c' * 64,
                    'success', NULL, NULL, NULL, 'allow'
                )""".replace("'a' * 64", "'" + "a" * 64 + "'")
                .replace("'b' * 64", "'" + "b" * 64 + "'")
                .replace("'c' * 64", "'" + "c" * 64 + "'"),
                (
                    i,
                    str(uuid.uuid4()),
                    e.get("call_id", f"op-{i}"),
                    e["timestamp"],
                    e["operation"],
                    e.get("call_id", f"op-{i}"),
                    e.get("actor_id"),
                    e.get("tenant_id"),
                    e.get("session_id"),
                    e["memory_path"],
                ),
            )


def _ts(offset_minutes: float = 0.0, *, base: datetime | None = None) -> str:
    """Helper to build ISO-8601 UTC timestamps for fixture events."""
    base = base or datetime(2026, 4, 30, 12, 0, 0, tzinfo=UTC)
    return (base + timedelta(minutes=offset_minutes)).isoformat()


# ---------------------------------------------------------------------------
# Empty / missing DB
# ---------------------------------------------------------------------------


def test_compute_returns_empty_when_db_missing(tmp_path: Path) -> None:
    """A fresh install hasn't created the audit DB yet — must not crash."""
    metrics = compute_skill_stats(tmp_path / "does-not-exist.db")
    assert metrics == []


def test_compute_returns_empty_when_db_has_no_skill_events(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    _seed_db(
        db,
        [
            {
                "operation": "create",
                "memory_path": "/memories/MEMORY.md",  # not a skill
                "timestamp": _ts(),
                "actor_id": "alice",
            }
        ],
    )
    assert compute_skill_stats(db) == []


# ---------------------------------------------------------------------------
# Single-skill happy path
# ---------------------------------------------------------------------------


def test_one_create_no_patches_is_ok(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    _seed_db(
        db,
        [
            {
                "operation": "create",
                "memory_path": "/skills/release-checklist/SKILL.md",
                "timestamp": _ts(),
                "actor_id": "alice",
            }
        ],
    )
    [m] = compute_skill_stats(db)
    assert isinstance(m, SkillMetrics)
    assert m.skill_name == "release-checklist"
    assert m.create_count == 1
    assert m.patch_count == 0
    assert m.delete_count == 0
    assert m.churn_ratio == 0.0
    assert m.rapid_patches == 0
    assert m.short_lived is False
    assert m.status == "ok"


# ---------------------------------------------------------------------------
# Churn ratio
# ---------------------------------------------------------------------------


def test_high_churn_marked_unstable(tmp_path: Path) -> None:
    """5 patches against 1 create → churn 5.0 → unstable.

    Patches are spaced 2h apart so rapid_patches stays at 0; this
    isolates the churn signal from the rapid-patch signal.
    """
    db = tmp_path / "audit.db"
    events: list[dict[str, Any]] = [
        {
            "operation": "create",
            "memory_path": "/skills/flaky/SKILL.md",
            "timestamp": _ts(0),
            "actor_id": "alice",
        }
    ]
    for i in range(5):
        events.append(
            {
                "operation": "str_replace",
                "memory_path": "/skills/flaky/SKILL.md",
                "timestamp": _ts((i + 1) * 120),  # 2h apart
                "actor_id": "alice",
            }
        )
    _seed_db(db, events)
    [m] = compute_skill_stats(db)
    assert m.create_count == 1
    assert m.patch_count == 5
    assert m.churn_ratio == 5.0
    assert m.rapid_patches == 0
    assert m.status == "unstable"


# ---------------------------------------------------------------------------
# Rapid patches
# ---------------------------------------------------------------------------


def test_rapid_patches_within_window_count(tmp_path: Path) -> None:
    """4 patches at 5min intervals → all 4 are rapid (each within 1h
    of the previous event). churn is 4.0 so status is unstable; this
    test asserts the rapid_patches counter specifically.
    """
    db = tmp_path / "audit.db"
    events = [
        {
            "operation": "create",
            "memory_path": "/skills/quick-fix/SKILL.md",
            "timestamp": _ts(0),
            "actor_id": "alice",
        }
    ]
    for i in range(4):
        events.append(
            {
                "operation": "str_replace",
                "memory_path": "/skills/quick-fix/SKILL.md",
                "timestamp": _ts((i + 1) * 5),  # 5 min apart
                "actor_id": "alice",
            }
        )
    _seed_db(db, events)
    [m] = compute_skill_stats(db)
    assert m.rapid_patches == 4
    assert m.status == "unstable"


def test_patches_outside_window_not_rapid(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    _seed_db(
        db,
        [
            {
                "operation": "create",
                "memory_path": "/skills/slow-evolve/SKILL.md",
                "timestamp": _ts(0),
                "actor_id": "alice",
            },
            {
                "operation": "str_replace",
                "memory_path": "/skills/slow-evolve/SKILL.md",
                "timestamp": _ts(60 * 25),  # 25h later
                "actor_id": "alice",
            },
        ],
    )
    [m] = compute_skill_stats(db)
    assert m.rapid_patches == 0


# ---------------------------------------------------------------------------
# Short-lived (false start)
# ---------------------------------------------------------------------------


def test_create_then_delete_within_a_day_is_short_lived(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    _seed_db(
        db,
        [
            {
                "operation": "create",
                "memory_path": "/skills/false-start/SKILL.md",
                "timestamp": _ts(0),
                "actor_id": "alice",
            },
            {
                "operation": "delete",
                "memory_path": "/skills/false-start/SKILL.md",
                "timestamp": _ts(60 * 3),  # 3h later
                "actor_id": "alice",
            },
        ],
    )
    [m] = compute_skill_stats(db)
    assert m.short_lived is True
    assert m.status == "short-lived"


def test_long_lived_skill_not_short_lived(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    _seed_db(
        db,
        [
            {
                "operation": "create",
                "memory_path": "/skills/keeper/SKILL.md",
                "timestamp": _ts(0),
                "actor_id": "alice",
            },
            # Deleted 2 days later — outside the 1-day short-lived window.
            {
                "operation": "delete",
                "memory_path": "/skills/keeper/SKILL.md",
                "timestamp": _ts(60 * 24 * 2),
                "actor_id": "alice",
            },
        ],
    )
    [m] = compute_skill_stats(db)
    assert m.short_lived is False


# ---------------------------------------------------------------------------
# Multi-skill: stable grouping + sorting
# ---------------------------------------------------------------------------


def test_multiple_skills_grouped_by_name(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    _seed_db(
        db,
        [
            {
                "operation": "create",
                "memory_path": "/skills/aaa/SKILL.md",
                "timestamp": _ts(0),
                "actor_id": "alice",
            },
            {
                "operation": "create",
                "memory_path": "/skills/bbb/SKILL.md",
                "timestamp": _ts(1),
                "actor_id": "alice",
            },
            {
                "operation": "str_replace",
                "memory_path": "/skills/bbb/SKILL.md",
                "timestamp": _ts(60 * 3),
                "actor_id": "alice",
            },
        ],
    )
    metrics = compute_skill_stats(db)
    assert {m.skill_name for m in metrics} == {"aaa", "bbb"}
    by_name = {m.skill_name: m for m in metrics}
    assert by_name["aaa"].patch_count == 0
    assert by_name["bbb"].patch_count == 1


# ---------------------------------------------------------------------------
# Filters: actor, since, skill_md_only
# ---------------------------------------------------------------------------


def test_actor_filter_restricts_results(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    _seed_db(
        db,
        [
            {
                "operation": "create",
                "memory_path": "/skills/alice-skill/SKILL.md",
                "timestamp": _ts(0),
                "actor_id": "alice",
            },
            {
                "operation": "create",
                "memory_path": "/skills/bob-skill/SKILL.md",
                "timestamp": _ts(1),
                "actor_id": "bob",
            },
        ],
    )
    metrics = compute_skill_stats(db, actor_id="alice")
    assert {m.skill_name for m in metrics} == {"alice-skill"}


def test_since_filter_excludes_old_events(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    # Old event well in the past + recent event near "now". The `since`
    # filter is "newer than now - delta", so an explicit timestamp far
    # in the past is what we need to test it.
    now = datetime.now(UTC)
    _seed_db(
        db,
        [
            {
                "operation": "create",
                "memory_path": "/skills/old/SKILL.md",
                "timestamp": (now - timedelta(days=30)).isoformat(),
                "actor_id": "alice",
            },
            {
                "operation": "create",
                "memory_path": "/skills/new/SKILL.md",
                "timestamp": (now - timedelta(minutes=5)).isoformat(),
                "actor_id": "alice",
            },
        ],
    )
    metrics = compute_skill_stats(db, since=timedelta(days=1))
    assert {m.skill_name for m in metrics} == {"new"}


def test_skill_md_only_excludes_attached_files(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    _seed_db(
        db,
        [
            # Skill.md create + 2 patches.
            {
                "operation": "create",
                "memory_path": "/skills/runbook/SKILL.md",
                "timestamp": _ts(0),
                "actor_id": "alice",
            },
            {
                "operation": "str_replace",
                "memory_path": "/skills/runbook/SKILL.md",
                "timestamp": _ts(10),
                "actor_id": "alice",
            },
            # 5 noisy attached-file writes that should NOT count under skill_md_only=True.
            *(
                {
                    "operation": "str_replace",
                    "memory_path": "/skills/runbook/scripts/run.sh",
                    "timestamp": _ts(20 + i),
                    "actor_id": "alice",
                }
                for i in range(5)
            ),
        ],
    )
    metrics_all = compute_skill_stats(db, skill_md_only=False)
    metrics_md = compute_skill_stats(db, skill_md_only=True)
    [m_all] = metrics_all
    [m_md] = metrics_md
    # All-files view sees 6 patches; md-only view sees 1.
    assert m_all.patch_count == 6
    assert m_md.patch_count == 1


# ---------------------------------------------------------------------------
# Output formats
# ---------------------------------------------------------------------------


def test_to_dict_serializes_to_json(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    _seed_db(
        db,
        [
            {
                "operation": "create",
                "memory_path": "/skills/json-test/SKILL.md",
                "timestamp": _ts(0),
                "actor_id": "alice",
            }
        ],
    )
    [m] = compute_skill_stats(db)
    payload = json.dumps(m.to_dict())
    parsed = json.loads(payload)
    assert parsed["skill_name"] == "json-test"
    assert parsed["create_count"] == 1
    assert isinstance(parsed["first_seen"], str)
    assert parsed["status"] == "ok"


def test_format_metrics_table_is_compact(tmp_path: Path) -> None:
    db = tmp_path / "audit.db"
    _seed_db(
        db,
        [
            {
                "operation": "create",
                "memory_path": "/skills/aaa/SKILL.md",
                "timestamp": _ts(0),
                "actor_id": "alice",
            },
            {
                "operation": "str_replace",
                "memory_path": "/skills/aaa/SKILL.md",
                "timestamp": _ts(1),
                "actor_id": "alice",
            },
        ],
    )
    out = format_metrics_table(compute_skill_stats(db))
    assert "SKILL" in out
    assert "aaa" in out
    # The table rows fit comfortably in 100 columns.
    for line in out.splitlines():
        assert len(line) < 100


def test_format_metrics_table_handles_empty_input() -> None:
    assert format_metrics_table([]).strip() == "no skill activity recorded"


# ---------------------------------------------------------------------------
# CLI helper: --since parser
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1h", timedelta(hours=1)),
        ("24h", timedelta(hours=24)),
        ("7d", timedelta(days=7)),
        ("30d", timedelta(days=30)),
    ],
)
def test_parse_since_accepts_h_and_d_suffixes(text: str, expected: timedelta) -> None:
    assert _parse_since(text) == expected


@pytest.mark.parametrize("text", ["", "0h", "-1d", "1m", "weekly", "h"])
def test_parse_since_rejects_garbage(text: str) -> None:
    with pytest.raises(SystemExit):
        _parse_since(text)
