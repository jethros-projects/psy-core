# psy-core-openclaw

Tamper-evident audit adapter for OpenClaw memory and skill access.

This local plugin registers as a native OpenClaw plugin, observes relevant tool
calls through OpenClaw's `before_tool_call` and `after_tool_call` hooks, and
writes paired intent/result envelopes directly to a psy-core compatible SQLite
audit chain.

## Local install

```bash
openclaw plugins install ./plugins/psy-core-openclaw
openclaw config set plugins.entries.psy-core.enabled true
openclaw config set plugins.entries.psy-core.config.actorId "alice@example.com"
openclaw gateway restart
```

On a VPS, install the plugin as the same service user that runs OpenClaw and
keep the plugin under a stable path. The plugin does not execute shell commands
or require a `psy` binary at runtime; install `psy-core` only when you want the
`psy verify`, `psy tail`, or `psy query` CLI commands:

```bash
sudo -iu openclaw
mkdir -p ~/.local/openclaw-plugins ~/.psy
cp -R /path/to/psy-core/plugins/psy-core-openclaw ~/.local/openclaw-plugins/
npm install -g psy-core@0.5.1
openclaw plugins install ~/.local/openclaw-plugins/psy-core-openclaw
openclaw config set plugins.entries.psy-core.enabled true
openclaw config set plugins.entries.psy-core.config.actorId "alice@example.com"
openclaw gateway restart
PSY_AUDIT_DB_PATH="$HOME/.psy/audit.db" \
PSY_SEAL_KEY_PATH="$HOME/.psy/seal-key" \
PSY_HEAD_PATH="$HOME/.psy/head.json" \
  psy verify --all
```

The old `psyBinary` and `psyCoreVersion` config keys are still accepted for
compatibility with early development configs, but they are ignored.

## Agentic install

For a production one-liner after publishing, prefer the native OpenClaw path:

```bash
openclaw plugins install psy-core-openclaw
```

OpenClaw checks ClawHub first and then npm for bare plugin specs. Until this
package is published, install from a stable local clone or unpacked tarball.

Copy this prompt into OpenClaw when you want the agent to do the setup:

```text
Install the psy-core OpenClaw plugin from the psy-core repository. Use
plugins/psy-core-openclaw/AGENT_INSTALL.md as the procedure. Run all commands as
the same service user that runs OpenClaw. Keep the plugin under a durable local
path, enable plugins.entries.psy-core, set plugins.entries.psy-core.config.actorId
to my operator identity, restart the OpenClaw gateway, and verify with
openclaw plugins inspect psy-core --json. Install psy-core@0.5.1 only if you
need the psy CLI, then verify the chain with PSY_AUDIT_DB_PATH="$HOME/.psy/audit.db"
PSY_SEAL_KEY_PATH="$HOME/.psy/seal-key" PSY_HEAD_PATH="$HOME/.psy/head.json"
psy verify --all.
Do not enable payloadCapture unless I explicitly ask.
```

The plugin also ships a `psy-core-openclaw` skill. It becomes available after
the plugin is enabled and gives OpenClaw a short operating checklist for
verification and troubleshooting.

## Captured surfaces

| OpenClaw source | psy operation | Notes |
| --- | --- | --- |
| `read` of `MEMORY.md`, `USER.md`, `DREAMS.md`, `memory/**`, or skill roots | `view` | Captures direct file reads against OpenClaw memory and skill storage. |
| `write` to `MEMORY.md`, `USER.md`, `DREAMS.md`, or `memory/**` | `create` or `str_replace` | Existing files map to `str_replace`; new files map to `create`. |
| `edit` on memory files | `str_replace` | Captures the edit payload before and after the tool call. |
| `apply_patch` touching memory files | `create`, `str_replace`, `delete` | One audit pair per touched memory file. |
| `write`, `edit`, or `apply_patch` under `skills/`, `.agents/skills/`, `~/.openclaw/skills/`, `~/.agents/skills/`, or `skills.load.extraDirs` | `create`, `str_replace`, `delete` | Covers workspace, project-agent, managed, personal, and configured extra skill roots. |
| `skill_workshop` direct writes | `create` or `str_replace` | Covers OpenClaw's Skill Workshop tool when it applies workspace skills without going through file tools. |
| `memory_search`, `memory_get`, `memory_recall` | `view` | Covers bundled file-backed and LanceDB memory retrieval tools. |
| `memory_store` / `memory_forget` | `create` / `delete` | Covers the bundled `memory-lancedb` semantic memory mutation tools. |
| `wiki_status`, `wiki_search`, `wiki_get` | `view` | Covers bundled `memory-wiki` inspection and retrieval tools. |
| `wiki_lint` | `view` plus `create` or `str_replace` | Captures the wiki read and the persisted `reports/lint.md` report. |
| `wiki_apply` | `create` / `str_replace` | Covers the bundled `memory-wiki` mutation tool. |

## Configuration

```json5
{
  plugins: {
    entries: {
      "psy-core": {
        enabled: true,
        config: {
          actorId: "alice@example.com",
          tenantId: "acme",
          purpose: "openclaw-audit",
          dbPath: "~/.psy/audit.db",
          sealKeyPath: "~/.psy/seal-key",
          // Deprecated compatibility fields; ignored by current plugin builds.
          psyCoreVersion: "0.5.1",
          psyBinary: null,
          payloadCapture: false,
          allowAnonymous: false,
          dryRun: false
        }
      }
    }
  }
}
```

`actorId` is required unless `allowAnonymous` is explicitly set to `true`.
Payload capture is off by default; when enabled, payload previews are redacted
in-process before storage.

## Development notes

This package is deliberately plain ESM JavaScript so it can be installed from a
local directory without a build step. OpenClaw supplies `openclaw/plugin-sdk/*`
at runtime.
