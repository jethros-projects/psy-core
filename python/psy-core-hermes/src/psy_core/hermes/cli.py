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
import shutil
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from psy_core.hermes._version import (
    INGEST_PROTOCOL_VERSION,
    PSY_CORE_HERMES_VERSION,
    PSY_CORE_VERSION,
)
from psy_core.hermes.config import PsyHermesConfig, load_psy_config
from psy_core.hermes.ingest_client import IngestClient, resolve_spawn_plan

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

    doctor_p = sub.add_parser("doctor", help="show resolved config + paths + subprocess health")
    doctor_p.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))

    status_p = sub.add_parser("status", help="one-line summary")
    status_p.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))

    dry_p = sub.add_parser("dry-run", help="emit envelopes locally without spawning ingest")
    dry_p.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))

    args = parser.parse_args(argv)

    if args.cmd == "init":
        return cmd_init(args)
    if args.cmd == "doctor":
        return cmd_doctor(args)
    if args.cmd == "status":
        return cmd_status(args)
    if args.cmd == "dry-run":
        return cmd_dry_run(args)
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
    psy.setdefault("enabled", True)
    if args.actor_id:
        psy["actor_id"] = args.actor_id
    if args.allow_anonymous:
        psy["allow_anonymous"] = True
    psy.setdefault("psy_core_version", PSY_CORE_VERSION)

    _write_config(config_path, raw)
    sys.stdout.write(f"psy-core-hermes: wrote plugins.psy block to {config_path}\n")
    return 0


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
    if shutil.which("psy"):
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


def _ingest_env(config: PsyHermesConfig) -> dict[str, str]:
    return {
        "PSY_AUDIT_DB_PATH": str(config.db_path),
        "PSY_ARCHIVES_PATH": str(config.db_path.parent / "archives"),
        "PSY_SEAL_KEY_PATH": str(config.seal_key_path),
        "PSY_HEAD_PATH": str(config.seal_key_path.with_name("head.json")),
    }


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
