---
name: psy-core-openclaw
description: Use when configuring, verifying, or troubleshooting the psy-core OpenClaw plugin that audits memory and skill access.
metadata: {"openclaw":{"requires":{"config":["plugins.entries.psy-core.enabled"]}}}
---

# psy-core OpenClaw

Use this skill after the `psy-core` plugin has been installed or enabled.

## Operating Checklist

1. Inspect the plugin before changing config:
   ```bash
   openclaw plugins inspect psy-core --json
   openclaw config get plugins.entries.psy-core --json
   ```
2. Install the `psy` CLI only if verification/tailing is needed:
   ```bash
   command -v psy || npm install -g psy-core@0.5.1
   ```
3. Set the required config:
   ```bash
   openclaw config set plugins.entries.psy-core.enabled true
   openclaw config set plugins.entries.psy-core.config.actorId "REPLACE_WITH_OPERATOR_ID"
   openclaw config set plugins.entries.psy-core.config.payloadCapture false
   ```
4. Validate and restart:
   ```bash
   openclaw config validate
   openclaw gateway restart
   ```
5. Verify the audit chain:
   ```bash
   PSY_AUDIT_DB_PATH="$HOME/.psy/audit.db" \
   PSY_SEAL_KEY_PATH="$HOME/.psy/seal-key" \
   PSY_HEAD_PATH="$HOME/.psy/head.json" \
     psy verify --all
   ```

## Guardrails

- Keep `payloadCapture` off unless the user explicitly asks to store redacted
  payload previews.
- The plugin writes audit rows in-process and does not need `psyBinary`, `npx`,
  or shell execution at runtime.
- Do not create or edit memory and skill files just to smoke-test the plugin
  without the user's approval.
- If the local plugin source is needed, read `AGENT_INSTALL.md` from the plugin
  root for the full install procedure.
