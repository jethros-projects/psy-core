"""Skill-quality metrics derived from the psy audit chain.

This module powers Loop 2 — skill quality scoring via revert-rate. The
hash-chained audit log gives a tamper-evident ordering on the event
stream, which makes "did this write get patched/reverted within K
events / T seconds?" a *well-defined* SQL query, not a best-effort
approximation.

Why this is useful: Hermes's curator at agent/curator.py:283-285
explicitly tells its review LLM:

    "DO NOT use usage counters as a reason to skip consolidation …
     'use=0' is not evidence a skill is valuable; it's absence of
     evidence either way."

The team knows usage counters are insufficient. The audit chain
provides a complementary signal — *outcome attribution*. A skill that
gets patched 5 times within an hour of creation is probably unstable.
A skill that's created then deleted within a few turns was a false
start. Those signals come from the chain's ordering, not from
frequency counts.

Design notes:

- Read-only DB handle (`mode=ro` URI). The trust boundary is enforced
  at the SQLite level — this code provably cannot mutate the chain.
- No dependency beyond stdlib `sqlite3`. Keep the read path ascetic.
- All metrics are computed in Python, not SQL, so the query layer
  stays simple and the metric definitions are easy to read in one
  place. Skill volumes are small enough (hundreds, not millions) that
  this is comfortably fast.
- The "skill" entity is the parent directory under `/skills/`. Files
  under `references/`, `scripts/`, `templates/`, `assets/` count
  toward the same skill — patches to those are also instability
  signals. Filter with `skill_md_only=True` for the stricter view.
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

#: Two events on the same skill are "rapid" if they're within this window.
#: Used for `rapid_patches` — high count means the skill is being rewritten
#: in tight loops (almost certainly unstable).
RAPID_WINDOW = timedelta(hours=1)

#: A skill is "short-lived" if it was created and then deleted within this
#: many seconds. Default: 1 day. Captures the "false start" pattern where
#: the agent creates a skill, decides it's wrong, deletes it.
SHORT_LIVED_WINDOW = timedelta(days=1)

#: Status thresholds.
#: A skill is `unstable` if churn_ratio >= UNSTABLE_CHURN OR rapid_patches >= UNSTABLE_RAPID.
UNSTABLE_CHURN = 2.0
UNSTABLE_RAPID = 3


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SkillMetrics:
    """Per-skill quality summary derived from the audit chain.

    Fields are intentionally flat for easy `--json` output and easy
    consumption by downstream tooling (Hermes curator, Atropos
    quality-filter, dashboards).
    """

    skill_name: str
    create_count: int
    patch_count: int
    delete_count: int
    actor_count: int  # distinct actor_ids that touched the skill
    session_count: int  # distinct session_ids that touched the skill
    first_seen: datetime | None
    last_seen: datetime | None
    churn_ratio: float  # patch_count / max(create_count, 1)
    rapid_patches: int  # patches with a prior event on this skill within RAPID_WINDOW
    short_lived: bool  # created and deleted within SHORT_LIVED_WINDOW
    status: str  # "unstable" | "short-lived" | "ok"

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        # ISO-format the datetimes so the dict survives json.dumps.
        d["first_seen"] = self.first_seen.isoformat() if self.first_seen else None
        d["last_seen"] = self.last_seen.isoformat() if self.last_seen else None
        return d


@dataclass(frozen=True)
class _RawEvent:
    """The subset of the events row that skill_stats actually reads."""

    seq: int
    timestamp: datetime
    operation: str  # 'create' | 'str_replace' | 'delete' | ...
    memory_path: str
    actor_id: str | None
    session_id: str | None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def compute_skill_stats(
    db_path: Path,
    *,
    actor_id: str | None = None,
    since: timedelta | None = None,
    skill_md_only: bool = False,
) -> list[SkillMetrics]:
    """Read the psy audit chain and compute per-skill quality metrics.

    Returns an empty list if the DB doesn't exist yet (fresh install,
    no events written) — callers don't need to special-case that.

    Args:
        db_path: path to the psy SQLite chain (typically
            ``~/.psy/audit.db``).
        actor_id: if provided, restrict metrics to events from this
            actor. Useful for multi-tenant deployments where you want
            per-user skill quality.
        since: if provided, restrict to events newer than ``now - since``.
            Default: all time.
        skill_md_only: if True, only count operations on the skill's
            ``SKILL.md`` file (the procedural-memory document itself),
            not on attached files like references/scripts/templates.
            Default: False (count everything under ``/skills/<name>/``).
    """
    if not db_path.exists():
        return []

    raw = _load_skill_events(
        db_path,
        actor_id=actor_id,
        since=since,
        skill_md_only=skill_md_only,
    )
    by_skill: dict[str, list[_RawEvent]] = {}
    for event in raw:
        name = _skill_name_from_path(event.memory_path)
        if name is None:
            continue
        by_skill.setdefault(name, []).append(event)

    return [_summarize(name, events) for name, events in sorted(by_skill.items())]


# ---------------------------------------------------------------------------
# Implementation details
# ---------------------------------------------------------------------------


def _load_skill_events(
    db_path: Path,
    *,
    actor_id: str | None,
    since: timedelta | None,
    skill_md_only: bool,
) -> list[_RawEvent]:
    """Pull `intent`-phase events for skill paths from the audit DB.

    We restrict to ``audit_phase = 'intent'`` because every memory
    mutation in psy is recorded as a paired intent+result; counting both
    would double every metric. Intent is the better choice because it
    captures the agent's *attempt*, even if the result row never landed
    (which itself is a quality signal — orphaned intents are a possible
    follow-on metric for v0.6).

    Read-only connection: the URI flag prevents accidental mutation
    even if the calling code is buggy. The trust boundary is enforced
    by SQLite, not by us.
    """
    uri = f"{db_path.resolve().as_uri()}?mode=ro"
    sql = (
        "SELECT seq, timestamp, operation, memory_path, actor_id, session_id "
        "FROM events "
        "WHERE audit_phase = 'intent' "
        "  AND memory_path LIKE '/skills/%' "
    )
    params: list[Any] = []
    if skill_md_only:
        sql += " AND memory_path LIKE '%/SKILL.md' "
    if actor_id is not None:
        sql += " AND actor_id = ? "
        params.append(actor_id)
    if since is not None:
        cutoff = (datetime.now(UTC) - since).isoformat()
        sql += " AND timestamp >= ? "
        params.append(cutoff)
    sql += " ORDER BY seq ASC"

    out: list[_RawEvent] = []
    with closing(sqlite3.connect(uri, uri=True)) as conn:
        for seq, ts, op, path, actor, session in conn.execute(sql, params):
            out.append(
                _RawEvent(
                    seq=seq,
                    timestamp=_parse_timestamp(ts),
                    operation=op,
                    memory_path=path,
                    actor_id=actor,
                    session_id=session,
                )
            )
    return out


def _skill_name_from_path(memory_path: str) -> str | None:
    """Extract the skill name from a memory_path like /skills/<name>/...

    Returns None for paths that don't match the skill pattern. Defensive
    against malformed input — the chain is supposed to only have well-
    formed paths but we don't trust that.
    """
    parts = memory_path.split("/")
    # ['', 'skills', '<name>', ...rest]
    if len(parts) < 3 or parts[0] != "" or parts[1] != "skills":
        return None
    name = parts[2]
    return name or None


def _parse_timestamp(value: str) -> datetime:
    """Parse the chain's ISO-8601 timestamp. Always UTC.

    The chain stores timestamps via `Date.toISOString()` on the TS side,
    which always emits UTC with a `Z` suffix. We normalize to a
    timezone-aware datetime so arithmetic against `now()` works.
    """
    # Python's fromisoformat handles `+00:00` but not `Z` until 3.11; we
    # require 3.11+ in pyproject.toml so this is fine. Guard against any
    # pre-3.11 Z-handling weirdness anyway.
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.fromisoformat(value)


def _summarize(skill_name: str, events: list[_RawEvent]) -> SkillMetrics:
    """Reduce a skill's event list into a single SkillMetrics summary."""
    creates = [e for e in events if e.operation == "create"]
    patches = [e for e in events if e.operation == "str_replace"]
    deletes = [e for e in events if e.operation == "delete"]

    actors = {e.actor_id for e in events if e.actor_id is not None}
    sessions = {e.session_id for e in events if e.session_id is not None}

    first_seen = events[0].timestamp if events else None
    last_seen = events[-1].timestamp if events else None

    churn_ratio = len(patches) / max(len(creates), 1)

    rapid_patches = _count_rapid_patches(events)
    short_lived = _is_short_lived(creates, deletes)

    if short_lived:
        status = "short-lived"
    elif churn_ratio >= UNSTABLE_CHURN or rapid_patches >= UNSTABLE_RAPID:
        status = "unstable"
    else:
        status = "ok"

    return SkillMetrics(
        skill_name=skill_name,
        create_count=len(creates),
        patch_count=len(patches),
        delete_count=len(deletes),
        actor_count=len(actors),
        session_count=len(sessions),
        first_seen=first_seen,
        last_seen=last_seen,
        churn_ratio=round(churn_ratio, 2),
        rapid_patches=rapid_patches,
        short_lived=short_lived,
        status=status,
    )


def _count_rapid_patches(events: list[_RawEvent]) -> int:
    """Count patches whose nearest prior event on this skill is within
    RAPID_WINDOW.

    "Rapid" means the agent re-touched the skill quickly — a strong
    instability signal regardless of whether the prior event was a
    create or another patch.
    """
    count = 0
    last_ts: datetime | None = None
    for event in events:  # already seq-ordered by the SQL
        if event.operation == "str_replace":
            if last_ts is not None and event.timestamp - last_ts <= RAPID_WINDOW:
                count += 1
        last_ts = event.timestamp
    return count


def _is_short_lived(
    creates: list[_RawEvent], deletes: list[_RawEvent]
) -> bool:
    """A skill is short-lived if any create-delete pair fell within
    SHORT_LIVED_WINDOW.

    We pair each delete with the most recent prior create (by seq).
    If that delete fell within SHORT_LIVED_WINDOW of its create, this
    skill had a "false start" — created and abandoned quickly.
    """
    if not creates or not deletes:
        return False
    creates_by_seq = sorted(creates, key=lambda e: e.seq)
    for delete in deletes:
        prior_creates = [c for c in creates_by_seq if c.seq < delete.seq]
        if not prior_creates:
            continue
        most_recent_create = prior_creates[-1]
        if delete.timestamp - most_recent_create.timestamp <= SHORT_LIVED_WINDOW:
            return True
    return False


# ---------------------------------------------------------------------------
# CLI formatting helpers — kept here so cli.py is a thin layer.
# ---------------------------------------------------------------------------


def format_metrics_table(metrics: list[SkillMetrics]) -> str:
    """Render metrics as a fixed-width text table for `psy-core-hermes
    skill-stats` default output.

    Columns are deliberately narrow so the table fits in 100 cols.
    """
    if not metrics:
        return "no skill activity recorded\n"
    header = f"{'SKILL':<32}{'CREATE':>7}{'PATCH':>7}{'DEL':>5}{'CHURN':>7}{'RAPID':>7}  STATUS\n"
    lines = [header]
    for m in metrics:
        lines.append(
            f"{m.skill_name:<32.32}"
            f"{m.create_count:>7}"
            f"{m.patch_count:>7}"
            f"{m.delete_count:>5}"
            f"{m.churn_ratio:>7.2f}"
            f"{m.rapid_patches:>7}"
            f"  {m.status}\n"
        )
    return "".join(lines)
