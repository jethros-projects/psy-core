"""Console scripts for psy-core-hermes.

Four subcommands:

- `init`     — idempotent: insert `plugins.psy` into `~/.hermes/config.yaml`
- `doctor`   — show config resolution, paths, subprocess handshake test
- `status`   — one-line summary of the current install
- `dry-run`  — emit envelopes locally, never spawn the subprocess

The CLI is intentionally non-interactive: each subcommand accepts flags
for everything it might prompt for, so it can be scripted from CI.
"""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import os
import shutil
import subprocess
import sys
from collections.abc import Callable, Sequence
from datetime import timedelta
from pathlib import Path
from typing import Any, cast

from psy_core.hermes._version import (
    INGEST_PROTOCOL_VERSION,
    PSY_CORE_HERMES_VERSION,
    PSY_CORE_VERSION,
)
from psy_core.hermes.config import PsyHermesConfig, load_psy_config
from psy_core.hermes.ingest_client import IngestClient, resolve_spawn_plan
from psy_core.hermes.trust_layer import (
    TRUST_LAYER_FRAMING,
    TRUST_LAYER_SKILL_NAME,
    default_trust_layer_skill_path,
    install_trust_layer_skill,
)

DEFAULT_CONFIG_PATH = Path.home() / ".hermes" / "config.yaml"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="psy-core-hermes", description="psy audit adapter for Hermes Agent")
    parser.add_argument("--version", action="version", version=PSY_CORE_HERMES_VERSION)
    sub = parser.add_subparsers(dest="cmd", required=True)

    init_p = sub.add_parser("init", help="insert plugins.psy block into ~/.hermes/config.yaml")
    init_p.add_argument("--actor-id", help="set plugins.psy.actor_id")
    init_p.add_argument("--config", default=str(DEFAULT_CONFIG_PATH), help="path to Hermes config.yaml")
    init_p.add_argument(
        "--allow-anonymous",
        action="store_true",
        help="set allow_anonymous: true (skip actor_id requirement)",
    )

    install_skill_p = sub.add_parser(
        "install-skill",
        help="install the Hermes psy-core trust-layer skill",
    )
    install_skill_p.add_argument(
        "--path",
        help="where to write SKILL.md (default: ~/.hermes/skills/devops/psy-core-trust-layer/SKILL.md)",
    )

    trust_p = sub.add_parser(
        "trust-layer",
        help="configure psy-core as the Hermes trust layer and install the operating skill",
    )
    trust_p.add_argument("--actor-id", help="set plugins.psy.actor_id")
    trust_p.add_argument("--tenant-id", help="set plugins.psy.tenant_id")
    trust_p.add_argument("--purpose", help="set plugins.psy.purpose")
    trust_p.add_argument("--config", default=str(DEFAULT_CONFIG_PATH), help="path to Hermes config.yaml")
    trust_p.add_argument(
        "--allow-anonymous",
        action="store_true",
        help="set allow_anonymous: true (not recommended outside local experiments)",
    )
    trust_p.add_argument(
        "--payload-capture",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="capture redacted payloads in audit rows (default: true)",
    )
    trust_p.add_argument("--redactor", default="default", help="default | none | dotted.path")
    trust_p.add_argument("--psy-binary", help="explicit path to psy/psy-core binary")
    trust_p.add_argument(
        "--install-skill",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="install the Hermes psy-core trust-layer skill (default: true)",
    )
    trust_p.add_argument(
        "--skill-path",
        help="where to write the trust-layer SKILL.md",
    )
    trust_p.add_argument(
        "--verify",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="run psy verify --all after doctor (default: true)",
    )

    doctor_p = sub.add_parser("doctor", help="show resolved config + paths + subprocess health")
    doctor_p.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))

    status_p = sub.add_parser("status", help="one-line summary")
    status_p.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))

    dry_p = sub.add_parser("dry-run", help="emit envelopes locally without spawning ingest")
    dry_p.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))

    stats_p = sub.add_parser(
        "skill-stats",
        help="report skill quality from the audit chain (churn, rapid-patch rate, false starts)",
    )
    stats_p.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))
    stats_p.add_argument(
        "--db-path",
        help="override db_path from config (read-only access to the psy audit chain)",
    )
    stats_p.add_argument(
        "--actor",
        dest="actor_id",
        help="restrict to events from this actor_id",
    )
    stats_p.add_argument(
        "--since",
        help="restrict to events newer than this window (e.g. 1h, 24h, 7d, 30d)",
    )
    stats_p.add_argument(
        "--top",
        type=int,
        default=None,
        help="show only the N skills with the highest churn",
    )
    stats_p.add_argument(
        "--skill-md-only",
        action="store_true",
        help="only count operations on the skill's SKILL.md, not on attached files",
    )
    stats_p.add_argument("--json", action="store_true", help="emit JSON instead of a table")

    args = parser.parse_args(argv)

    handlers: dict[str, Callable[[argparse.Namespace], int]] = {
        "init": cmd_init,
        "install-skill": cmd_install_skill,
        "trust-layer": cmd_trust_layer,
        "doctor": cmd_doctor,
        "status": cmd_status,
        "dry-run": cmd_dry_run,
        "skill-stats": cmd_skill_stats,
    }
    if args.cmd in handlers:
        return handlers[args.cmd](args)
    parser.error(f"unknown command {args.cmd}")
    return 2


def _load_config_section(config_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Load the YAML config (or {} if missing). Returns (full, plugins.psy)."""
    if not config_path.exists():
        return {}, {}
    yaml = _yaml_module()
    raw_text = config_path.read_text(encoding="utf-8")
    raw = yaml.safe_load(raw_text) or {}
    if not isinstance(raw, dict):
        raise SystemExit(f"psy-core-hermes: {config_path} is not a YAML mapping at the top level")
    plugins = raw.get("plugins") or {}
    psy = plugins.get("psy") if isinstance(plugins, dict) else None
    return raw, psy if isinstance(psy, dict) else {}


def _write_config(config_path: Path, raw: dict[str, Any]) -> None:
    yaml = _yaml_module()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")


def _yaml_module() -> Any:
    try:
        return importlib.import_module("yaml")
    except ImportError as exc:
        raise SystemExit(
            "psy-core-hermes: PyYAML is required to read/write ~/.hermes/config.yaml. "
            "Install it via `pip install pyyaml` (Hermes already depends on it)."
        ) from exc


def cmd_init(args: argparse.Namespace) -> int:
    config_path = Path(args.config).expanduser()
    raw, _existing = _load_config_section(config_path)

    psy = _ensure_psy_section(raw, config_path)
    psy.setdefault("enabled", True)
    if args.actor_id:
        psy["actor_id"] = args.actor_id
    if args.allow_anonymous:
        psy["allow_anonymous"] = True
    psy.setdefault("psy_core_version", PSY_CORE_VERSION)

    _write_config(config_path, raw)
    sys.stdout.write(f"psy-core-hermes: wrote plugins.psy block to {config_path}\n")
    return 0


def cmd_install_skill(args: argparse.Namespace) -> int:
    path = Path(args.path).expanduser() if args.path else default_trust_layer_skill_path()
    result = install_trust_layer_skill(path)
    sys.stdout.write(f"psy-core-hermes: installed {TRUST_LAYER_SKILL_NAME} skill at {result.path}\n")
    if result.backup_path:
        sys.stdout.write(f"psy-core-hermes: backed up previous skill to {result.backup_path}\n")
    if not result.changed:
        sys.stdout.write("psy-core-hermes: skill already up to date\n")
    return 0


def cmd_trust_layer(args: argparse.Namespace) -> int:
    config_path = Path(args.config).expanduser().resolve()
    raw, _existing = _load_config_section(config_path)
    psy = _ensure_psy_section(raw, config_path)
    _configure_trust_layer_section(psy, config_path, args)

    if not psy.get("actor_id") and not psy.get("allow_anonymous"):
        raise SystemExit(
            "psy-core-hermes trust-layer: --actor-id is required unless "
            "--allow-anonymous is set or plugins.psy.actor_id already exists"
        )

    _write_config(config_path, raw)
    _, config, err = _resolve_or_empty(argparse.Namespace(config=str(config_path)))
    if err or config is None:
        sys.stdout.write(f"psy-core-hermes trust-layer: config invalid after write: {err}\n")
        return 2
    _prepare_trust_layer_paths(config)

    sys.stdout.write("psy-core trust layer for Hermes\n\n")
    sys.stdout.write(f"ok Hermes config updated: {config_path}\n")
    sys.stdout.write("   plugins.enabled includes psy\n")
    sys.stdout.write(f"   plugins.psy.actor_id = {psy.get('actor_id') or '<anonymous>'}\n")
    sys.stdout.write(f"   plugins.psy.allow_anonymous = {str(psy.get('allow_anonymous')).lower()}\n")
    sys.stdout.write(f"ok Trust-layer paths ready: {config.db_path.parent}\n")

    if args.install_skill:
        skill_path = (
            Path(args.skill_path).expanduser()
            if args.skill_path
            else default_trust_layer_skill_path(config_path.parent)
        )
        result = install_trust_layer_skill(skill_path)
        sys.stdout.write(f"ok Hermes skill installed: {result.path}\n")
        if result.backup_path:
            sys.stdout.write(f"   previous skill backed up to {result.backup_path}\n")
        elif not result.changed:
            sys.stdout.write("   skill already up to date\n")

    sys.stdout.write("\nDoctor:\n")
    doctor_rc = cmd_doctor(argparse.Namespace(config=str(config_path)))
    if doctor_rc != 0:
        return doctor_rc

    if args.verify:
        verify_rc = _run_psy_verify(config)
        if verify_rc != 0:
            return verify_rc

    sys.stdout.write("\nNext:\n")
    sys.stdout.write("  restart Hermes for plugin discovery\n")
    sys.stdout.write('  ask: "Use the psy-core trust layer skill to verify my setup."\n\n')
    sys.stdout.write(TRUST_LAYER_FRAMING)
    return 0


def _ensure_psy_section(raw: dict[str, Any], config_path: Path) -> dict[str, Any]:
    plugins = raw.setdefault("plugins", {})
    if not isinstance(plugins, dict):
        raise SystemExit(f"psy-core-hermes: plugins must be a mapping in {config_path}")
    enabled = plugins.setdefault("enabled", [])
    if not isinstance(enabled, list):
        raise SystemExit(f"psy-core-hermes: plugins.enabled must be a list in {config_path}")
    if "psy" not in enabled:
        enabled.append("psy")

    psy = plugins.setdefault("psy", {})
    if not isinstance(psy, dict):
        raise SystemExit(f"psy-core-hermes: plugins.psy must be a mapping in {config_path}")
    return cast(dict[str, Any], psy)


def _configure_trust_layer_section(
    psy: dict[str, Any],
    config_path: Path,
    args: argparse.Namespace,
) -> None:
    hermes_home = config_path.parent
    psy["enabled"] = True
    if args.actor_id:
        psy["actor_id"] = args.actor_id
    if args.tenant_id:
        psy["tenant_id"] = args.tenant_id
    if args.purpose:
        psy["purpose"] = args.purpose
    psy["allow_anonymous"] = bool(args.allow_anonymous)
    psy["psy_core_version"] = PSY_CORE_VERSION
    psy["payload_capture"] = bool(args.payload_capture)
    psy["redactor"] = args.redactor
    psy.setdefault("db_path", str(hermes_home / "psy" / "audit.db"))
    psy.setdefault("seal_key_path", str(hermes_home / "psy" / "seal-key"))
    psy.setdefault("memories_dir", str(hermes_home / "memories"))
    if args.psy_binary:
        psy["psy_binary"] = str(Path(args.psy_binary).expanduser())
    elif not psy.get("psy_binary"):
        on_path = shutil.which("psy")
        if on_path:
            psy["psy_binary"] = on_path


def _prepare_trust_layer_paths(config: PsyHermesConfig) -> None:
    config.db_path.parent.mkdir(parents=True, exist_ok=True)
    config.seal_key_path.parent.mkdir(parents=True, exist_ok=True)
    config.memories_dir.mkdir(parents=True, exist_ok=True)


def _resolve_or_empty(args: argparse.Namespace) -> tuple[Path, PsyHermesConfig | None, str | None]:
    config_path = Path(args.config).expanduser()
    _, section = _load_config_section(config_path)
    try:
        config = load_psy_config(section)
        return config_path, config, None
    except Exception as exc:
        return config_path, None, str(exc)


def cmd_doctor(args: argparse.Namespace) -> int:
    config_path, config, err = _resolve_or_empty(args)
    out = sys.stdout
    out.write(f"psy-core-hermes {PSY_CORE_HERMES_VERSION} (psy-core pin {PSY_CORE_VERSION})\n")
    out.write(f"config:           {config_path}\n")
    if err:
        out.write(f"  status:         INVALID — {err}\n")
        return 2
    assert config is not None
    out.write(f"  enabled:        {config.enabled}\n")
    out.write(f"  actor_id:       {config.actor_id or '<unset>'}\n")
    out.write(f"  tenant_id:      {config.tenant_id or '<unset>'}\n")
    out.write(f"  purpose:        {config.purpose or '<unset>'}\n")
    out.write(f"  db_path:        {config.db_path}\n")
    out.write(f"  seal_key_path:  {config.seal_key_path}\n")
    out.write(f"  memories_dir:   {config.memories_dir}\n")
    out.write(f"  redactor:       {config.redactor}\n")
    out.write(f"  payload_capture:{config.payload_capture}\n")
    out.write(f"  dry_run:        {config.dry_run}\n")
    out.write(f"  allow_anon:     {config.allow_anonymous}\n")

    out.write("\nPaths:\n")
    out.write(f"  memories_dir exists: {config.memories_dir.exists()}\n")
    out.write(f"  db parent exists:    {config.db_path.parent.exists()}\n")
    if config.seal_key_path.exists():
        try:
            mode = config.seal_key_path.stat().st_mode & 0o777
            out.write(f"  seal_key mode:       0o{mode:o} ({'OK' if mode == 0o600 else 'NOT 0600'})\n")
        except OSError as exc:
            out.write(f"  seal_key mode:       <unreadable: {exc}>\n")
    else:
        out.write("  seal_key:            not yet created (will be on first append)\n")

    out.write("\nSubprocess:\n")
    plan = resolve_spawn_plan(config.psy_binary, config.psy_core_version)
    out.write(f"  resolved invocation: {plan.description}\n")
    out.write(f"  argv:                {plan.argv}\n")
    if config.psy_binary:
        out.write(f"  psy_binary:          explicit override in use ({config.psy_binary})\n")
    elif shutil.which("psy"):
        out.write("  psy on PATH:         yes\n")
    else:
        out.write("  psy on PATH:         no (will use npx fallback)\n")
    if shutil.which("npx"):
        out.write("  npx on PATH:         yes\n")
    else:
        out.write("  npx on PATH:         no (install Node.js)\n")

    out.write("\nHandshake test:\n")
    client = IngestClient(plan=plan, env=_ingest_env(config))
    try:
        try:
            client._ensure_started()
        except Exception as exc:
            out.write(f"  spawn:               FAILED — {exc}\n")
            return 1
        handshake = client.handshake or {}
        out.write(f"  handshake:           {json.dumps(handshake)}\n")
    finally:
        client.close()
    out.write("\nTrust-layer framing:\n")
    for line in TRUST_LAYER_FRAMING.strip().splitlines():
        out.write(f"  {line}\n" if line else "\n")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    _, config, err = _resolve_or_empty(args)
    if err:
        sys.stdout.write(f"psy-core-hermes: config invalid — {err}\n")
        return 2
    assert config is not None
    sys.stdout.write(
        f"psy-core-hermes {PSY_CORE_HERMES_VERSION} | "
        f"actor={config.actor_id or '<unset>'} "
        f"redactor={config.redactor} "
        f"dry_run={config.dry_run} "
        f"db={config.db_path}\n"
    )
    return 0


def cmd_dry_run(args: argparse.Namespace) -> int:
    """Read envelopes from stdin and pretty-print them. Useful for piping
    `psy-core-hermes dry-run < some.jsonl` to inspect what the plugin would
    forward without spawning the ingest subprocess.
    """
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            envelope = json.loads(line)
        except json.JSONDecodeError as exc:
            sys.stderr.write(f"psy-core-hermes dry-run: invalid JSON: {exc}\n")
            continue
        sys.stdout.write(
            json.dumps(
                {"protocol": INGEST_PROTOCOL_VERSION, "envelope": envelope},
                ensure_ascii=False,
                separators=(",", ":"),
            )
            + "\n"
        )
    return 0


def cmd_skill_stats(args: argparse.Namespace) -> int:
    """Report skill quality from the audit chain.

    Loop 2 of the optimization roadmap: revert-rate as a skill quality
    signal. The audit chain's tamper-evident ordering makes
    "patches-since-creation" and "create-then-delete-within-K-events"
    well-defined queries. Hermes's curator can't currently use usage
    counters (it explicitly distrusts them); these metrics are the
    outcome-attribution complement.
    """
    from psy_core.hermes.skill_stats import (
        compute_skill_stats,
        format_metrics_table,
    )

    db_path = _resolve_db_path_for_stats(args)
    since = _parse_since(args.since) if args.since else None

    metrics = compute_skill_stats(
        db_path,
        actor_id=args.actor_id,
        since=since,
        skill_md_only=args.skill_md_only,
    )
    # Sort by churn descending (most-suspect first), then by patch count.
    metrics.sort(key=lambda m: (m.churn_ratio, m.patch_count), reverse=True)
    if args.top is not None:
        metrics = metrics[: args.top]

    if args.json:
        sys.stdout.write(
            json.dumps(
                [m.to_dict() for m in metrics],
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        )
        return 0

    sys.stdout.write(format_metrics_table(metrics))
    # Only emit a hint when we have data and the user didn't ask for JSON.
    # Helps demo the signal: reading the table alone doesn't tell you what
    # `unstable` means or what to do about it.
    if metrics and any(m.status != "ok" for m in metrics):
        sys.stdout.write(
            "\nlegend:  unstable = churn>=2.0 or 3+ rapid patches  |  "
            "short-lived = create+delete within 1 day\n"
        )
    return 0


def _resolve_db_path_for_stats(args: argparse.Namespace) -> Path:
    """db_path resolution order for `skill-stats`:
       --db-path flag > config file > config defaults.
    """
    if args.db_path:
        return Path(args.db_path).expanduser()
    _, config, err = _resolve_or_empty(args)
    if err is not None or config is None:
        # Fall back to the default path the config schema would have computed.
        from psy_core.hermes.config import PsyHermesConfig as _Cfg

        return cast(Path, _Cfg().db_path)
    return cast(Path, config.db_path)


def _parse_since(value: str) -> timedelta:
    """Parse durations like ``1h``, ``24h``, ``7d``, ``30d``.

    Intentionally narrow: only the suffixes a CLI user would type. Big
    enough to cover real ops needs (last day, last week, last month);
    not a general-purpose duration parser.
    """
    from datetime import timedelta

    if not value:
        raise SystemExit("psy-core-hermes skill-stats: --since cannot be empty")
    suffix = value[-1]
    try:
        amount = int(value[:-1])
    except ValueError as exc:
        raise SystemExit(
            f"psy-core-hermes skill-stats: --since must look like 1h / 24h / 7d / 30d, got {value!r}"
        ) from exc
    if amount <= 0:
        raise SystemExit("psy-core-hermes skill-stats: --since must be positive")
    if suffix == "h":
        return timedelta(hours=amount)
    if suffix == "d":
        return timedelta(days=amount)
    raise SystemExit(
        f"psy-core-hermes skill-stats: --since suffix must be h or d, got {value!r}"
    )


def _ingest_env(config: PsyHermesConfig) -> dict[str, str]:
    return {
        "PSY_AUDIT_DB_PATH": str(config.db_path),
        "PSY_ARCHIVES_PATH": str(config.db_path.parent / "archives"),
        "PSY_SEAL_KEY_PATH": str(config.seal_key_path),
        "PSY_HEAD_PATH": str(config.seal_key_path.with_name("head.json")),
    }


def _run_psy_verify(config: PsyHermesConfig) -> int:
    plan = resolve_spawn_plan(config.psy_binary, config.psy_core_version)
    argv = [*plan.argv[:-1], "verify", "--all", "--no-color"]
    env = {**os.environ, **_ingest_env(config)}
    sys.stdout.write("\nVerify:\n")
    sys.stdout.write(f"  command:             {argv}\n")
    proc = subprocess.run(
        argv,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.stdout:
        for line in proc.stdout.rstrip().splitlines():
            sys.stdout.write(f"  {line}\n")
    if proc.stderr:
        for line in proc.stderr.rstrip().splitlines():
            sys.stderr.write(f"  {line}\n")
    if proc.returncode == 0:
        sys.stdout.write("  result:              passed\n")
    else:
        sys.stdout.write(f"  result:              failed (exit {proc.returncode})\n")
    return proc.returncode


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
