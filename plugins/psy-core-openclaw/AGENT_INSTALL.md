# Agent Install Guide

Use this guide when an OpenClaw agent is asked to install or verify the
`psy-core-openclaw` plugin.

## Choose the Install Source

Prefer the native OpenClaw plugin installer.

- Published package: `openclaw plugins install psy-core-openclaw`
- Local checkout or unpacked package: `openclaw plugins install <absolute path to plugins/psy-core-openclaw>`

Current development builds are local-path installs. Run the setup as the
OpenClaw service user. Clone or update the repo in a durable directory owned by
that user, then install from the plugin subdirectory.

```bash
set -euo pipefail

repo="$HOME/.local/openclaw-plugins/psy-core"
mkdir -p ~/.local/openclaw-plugins ~/.psy
if [ -d "$repo/.git" ]; then
  git -C "$repo" pull --ff-only
else
  git clone https://github.com/jethros-projects/psy-core.git "$repo"
fi

if [ -n "${PSY_CORE_REF:-}" ]; then
  git -C "$repo" fetch --tags origin
  git -C "$repo" checkout "$PSY_CORE_REF"
fi

openclaw plugins install "$repo/plugins/psy-core-openclaw"
```

If the user gave a branch or tag, set `PSY_CORE_REF` before running the block.
Install `psy-core@0.5.1` separately only when the user wants the `psy` CLI for
verification, tailing, or querying the audit chain.

## Configure

`actorId` is required unless the user explicitly accepts anonymous audit events.
The plugin writes to the audit store in-process; it does not need a shell,
`npx`, or a configured `psyBinary`.

```bash
openclaw config set plugins.entries.psy-core.enabled true
openclaw config set plugins.entries.psy-core.config.actorId "REPLACE_WITH_OPERATOR_ID"
openclaw config set plugins.entries.psy-core.config.payloadCapture false
openclaw config validate
openclaw gateway restart
```

Optional tenant context:

```bash
openclaw config set plugins.entries.psy-core.config.tenantId "REPLACE_WITH_TENANT"
openclaw config set plugins.entries.psy-core.config.purpose "openclaw-audit"
```

## Verify

Run these checks before declaring the install complete.

```bash
openclaw plugins inspect psy-core --json
openclaw plugins list --enabled
PSY_AUDIT_DB_PATH="$HOME/.psy/audit.db" \
PSY_SEAL_KEY_PATH="$HOME/.psy/seal-key" \
PSY_HEAD_PATH="$HOME/.psy/head.json" \
  psy verify --all
```

Confirm the inspect output shows `psy-core` as enabled and loaded. Confirm
`psy verify --all` succeeds. If verification fails because no audit records
exist yet, say that the plugin is installed but the chain has no events, then
ask before creating a test memory or skill write.

## Safety Rules

- Run install and config commands as the OpenClaw service user.
- Do not enable `payloadCapture` unless the user explicitly requests memory
  payload previews.
- Do not edit existing memory or skill files for a smoke test without approval.
- Do not use `--dangerously-force-unsafe-install`; current plugin builds avoid
  OpenClaw's dangerous-code patterns.
- Keep the local plugin path stable. Reinstall with `--force` only when the user
  wants to replace the same plugin id from a newer local path or archive.

## Troubleshooting

- `openclaw plugins install` fails because config is invalid: run
  `openclaw doctor --fix`, then retry.
- `psy` is not found during verification: install `psy-core@0.5.1` as the
  service user. The plugin itself does not need the CLI.
- Plugin appears installed but no hooks run: check
  `openclaw plugins inspect psy-core --json`, confirm it is enabled, and restart
  the gateway.
- npm global installs are not allowed on the host: skip the CLI and inspect the
  SQLite store directly, or run `psy verify` from a controlled admin shell with
  `PSY_AUDIT_DB_PATH`, `PSY_SEAL_KEY_PATH`, and `PSY_HEAD_PATH` set as above.

## OpenClaw References

- Plugin CLI: https://docs.openclaw.ai/cli/plugins
- Plugin manifest: https://docs.openclaw.ai/plugins/manifest
- Skills: https://docs.openclaw.ai/tools/skills
