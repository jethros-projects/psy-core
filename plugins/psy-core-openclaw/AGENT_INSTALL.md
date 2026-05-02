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

npm install -g psy-core@0.4.0
openclaw plugins install "$repo/plugins/psy-core-openclaw"
```

If the user gave a branch or tag, set `PSY_CORE_REF` before running the block.

## Configure

`actorId` is required unless the user explicitly accepts anonymous audit events.
Use an absolute `psyBinary` path so service managers do not depend on shell
startup files.

```bash
openclaw config set plugins.entries.psy-core.enabled true
openclaw config set plugins.entries.psy-core.config.actorId "REPLACE_WITH_OPERATOR_ID"
openclaw config set plugins.entries.psy-core.config.psyBinary "$(command -v psy)"
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
- Do not use `--dangerously-force-unsafe-install` unless the user reviewed the
  scan failure and explicitly asks for the override.
- Keep the local plugin path stable. Reinstall with `--force` only when the user
  wants to replace the same plugin id from a newer local path or archive.

## Troubleshooting

- `openclaw plugins install` fails because config is invalid: run
  `openclaw doctor --fix`, then retry.
- `psy` is not found after restart: install `psy-core@0.4.0` as the service user
  and reset `plugins.entries.psy-core.config.psyBinary` to `command -v psy`.
- Plugin appears installed but no hooks run: check
  `openclaw plugins inspect psy-core --json`, confirm it is enabled, and restart
  the gateway.
- npm global installs are not allowed on the host: set `psyBinary` to another
  executable wrapper that runs `psy ingest --no-startup`, or leave it unset and
  rely on the plugin's pinned `npx -y psy-core@0.4.0 psy ingest --no-startup`
  fallback.

## OpenClaw References

- Plugin CLI: https://docs.openclaw.ai/cli/plugins
- Plugin manifest: https://docs.openclaw.ai/plugins/manifest
- Skills: https://docs.openclaw.ai/tools/skills
