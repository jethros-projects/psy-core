# psy-core-openclaw

> Audit receipts for OpenClaw memory and skills.
> Let OpenClaw keep working, but make durable memory changes inspectable.

[![npm version](https://img.shields.io/npm/v/psy-core-openclaw.svg?color=cb3837)](https://www.npmjs.com/package/psy-core-openclaw)
[![npm downloads](https://img.shields.io/npm/dm/psy-core-openclaw.svg)](https://www.npmjs.com/package/psy-core-openclaw)
[![license](https://img.shields.io/npm/l/psy-core-openclaw.svg)](https://github.com/jethros-projects/psy-core/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/psy-core-openclaw.svg)](https://nodejs.org)

[npm](https://www.npmjs.com/package/psy-core-openclaw) | [psy-core](../../README.md) | [Agent install guide](AGENT_INSTALL.md) | [Issues](https://github.com/jethros-projects/psy-core/issues)

**psy-core-openclaw is the OpenClaw adapter for [psy-core](https://github.com/jethros-projects/psy-core).** OpenClaw agents can read and rewrite durable memory, maintain dreams, build skills, store semantic memories, and update memory-wiki pages. Those writes are useful because they persist. psy-core-openclaw gives that persistence a tamper-evident trail.

It does not replace OpenClaw memory. It does not become a memory provider. It is a native OpenClaw plugin that listens at the tool boundary through `before_tool_call` and `after_tool_call`, classifies memory and skill surfaces, and writes paired psy audit envelopes directly into the local SQLite chain.

The result is simple: OpenClaw keeps its normal memory and skill workflow, and operators get receipts for what changed.

## Quick Install

From this repository:

```bash
openclaw plugins install ./plugins/psy-core-openclaw
openclaw config set plugins.entries.psy-core.enabled true
openclaw config set plugins.entries.psy-core.config.actorId "you@example.com"
openclaw gateway restart
```

For the published package, the native OpenClaw install path is:

```bash
openclaw plugins install psy-core-openclaw
```

Install `psy-core` only when you want the CLI for verification, tailing, or querying:

```bash
npm install -g psy-core@0.5.1
psy tail
psy verify --all
```

The plugin writes audit rows in-process at runtime. It does not shell out to `psy`, `npx`, or a configured binary.

## Why This Exists

OpenClaw memory is operational state, not just conversation history. It can influence future tool use, user personalization, skill selection, and agent behavior.

Use psy-core-openclaw when you want to answer questions like:

- Which session wrote or edited this memory file?
- Did a skill change through a normal file tool or through Skill Workshop?
- Did a semantic memory get stored, recalled, or forgotten?
- Did memory-wiki produce or apply a durable update?
- Was a write attempted but never confirmed?
- Has the audit log been edited, reordered, or truncated since it was written?

The adapter gives OpenClaw operators receipts without forcing a new memory backend.

## How It Works

```text
OpenClaw gateway process                     psy-core audit store
------------------------                     --------------------
before_tool_call hook
  memory / skill intent  ----------------->  intent row

OpenClaw executes the tool
  files, skills, LanceDB, or wiki change

after_tool_call hook
  result confirmation    ----------------->  result row

                                             SQLite row is canonicalized
                                             row hash chains to previous row
                                             HMAC sealed head is advanced
```

The OpenClaw plugin owns observation. The psy-core audit engine owns the canonical hash chain and sealed head. That keeps OpenClaw-specific hook logic close to OpenClaw while preserving the same verifier used by every psy adapter.

## What Gets Captured

| OpenClaw action | psy operation | Result confirmation |
|---|---|---|
| `read` of `MEMORY.md`, `USER.md`, `DREAMS.md`, `memory/**`, or skill roots | `view` | `after_tool_call` |
| `write` to `MEMORY.md`, `USER.md`, `DREAMS.md`, or `memory/**` | `create` or `str_replace` | Existing files map to `str_replace`; new files map to `create` |
| `edit` on memory files | `str_replace` | `after_tool_call` |
| `apply_patch` touching memory files | `create`, `str_replace`, or `delete` | One audit pair per touched memory file |
| `write`, `edit`, or `apply_patch` under `skills/`, `.agents/skills/`, `~/.openclaw/skills/`, `~/.agents/skills/`, or `skills.load.extraDirs` | `create`, `str_replace`, or `delete` | Workspace, project-agent, managed, personal, and extra skill roots |
| `skill_workshop` direct writes | `create` or `str_replace` | Covers Skill Workshop writes that do not pass through file tools |
| `memory_search`, `memory_get`, `memory_recall` | `view` | Bundled file-backed and LanceDB memory retrieval tools |
| `memory_store` / `memory_forget` | `create` / `delete` | Bundled `memory-lancedb` semantic memory mutation tools |
| `wiki_status`, `wiki_search`, `wiki_get` | `view` | Bundled `memory-wiki` inspection and retrieval tools |
| `wiki_lint` | `view` plus `create` or `str_replace` | Captures wiki read plus persisted `reports/lint.md` |
| `wiki_apply` | `create` or `str_replace` | Bundled `memory-wiki` mutation tool |

## What Stays Out of Scope

| Surface | Captured? | Why |
|---|---:|---|
| OpenClaw memory and skill files through supported tools | Yes | Core durable memory and procedural memory |
| Skill Workshop writes | Yes | Durable procedural memory |
| Bundled `memory-lancedb` and `memory-wiki` tools | Yes | Durable memory surfaces exposed through OpenClaw tools |
| General project files outside memory and skill roots | No | Not operational memory |
| LLM calls, shell commands, browser actions, and ordinary tool calls | No | Separate behavior or observability surfaces |
| External memory providers not exposed through OpenClaw's supported memory tools | No | Provider-specific adapters should own those surfaces |
| Raw SQLite or direct filesystem edits outside OpenClaw tools | No | The plugin observes OpenClaw tool hooks, not every host mutation |

This boundary is intentional. psy-core-openclaw should be the audit witness for OpenClaw's durable memory paths, not a universal activity logger.

If your app also calls Mem0, Letta, LangChain, LangGraph, GBrain, or Hermes directly, use the dedicated adapters in the [root psy-core README](../../README.md#what-it-captures).

## Operator Quick Reference

| Goal | Command |
|---|---|
| Install from this repository | `openclaw plugins install ./plugins/psy-core-openclaw` |
| Install the published package | `openclaw plugins install psy-core-openclaw` |
| Enable the plugin | `openclaw config set plugins.entries.psy-core.enabled true` |
| Set required identity | `openclaw config set plugins.entries.psy-core.config.actorId "you@example.com"` |
| Keep payload previews off | `openclaw config set plugins.entries.psy-core.config.payloadCapture false` |
| Validate OpenClaw config | `openclaw config validate` |
| Restart the gateway | `openclaw gateway restart` |
| Inspect plugin state | `openclaw plugins inspect psy-core --json` |
| See enabled plugins | `openclaw plugins list --enabled` |
| See live audit rows | `psy tail` |
| Verify chain integrity | `psy verify --all` |

## Install Details

For a VPS or long-running host, install the plugin as the same service user that runs OpenClaw and keep the plugin source under a stable path:

```bash
sudo -iu openclaw
mkdir -p ~/.local/openclaw-plugins ~/.psy
cp -R /path/to/psy-core/plugins/psy-core-openclaw ~/.local/openclaw-plugins/
openclaw plugins install ~/.local/openclaw-plugins/psy-core-openclaw
openclaw config set plugins.entries.psy-core.enabled true
openclaw config set plugins.entries.psy-core.config.actorId "alice@example.com"
openclaw gateway restart
```

Install the CLI only for operator commands:

```bash
npm install -g psy-core@0.5.1
PSY_AUDIT_DB_PATH="$HOME/.psy/audit.db" \
PSY_SEAL_KEY_PATH="$HOME/.psy/seal-key" \
PSY_HEAD_PATH="$HOME/.psy/head.json" \
  psy verify --all
```

The old `psyBinary` and `psyCoreVersion` config keys are still accepted for compatibility with early development configs, but current plugin builds ignore them at runtime.

## Agentic Install

The plugin ships a short [agent install guide](AGENT_INSTALL.md) for OpenClaw agents that are asked to configure or verify the adapter.

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

The plugin also installs the `psy-core-openclaw` skill. Once enabled, that skill gives OpenClaw a compact checklist for setup verification and troubleshooting.

## Configuration

Full `plugins.entries.psy-core.config` reference:

```json5
{
  plugins: {
    entries: {
      "psy-core": {
        enabled: true,
        config: {
          // Identity
          actorId: "alice@example.com",
          tenantId: "acme",
          purpose: "openclaw-audit",
          allowAnonymous: false,

          // Storage
          dbPath: "~/.psy/audit.db",
          sealKeyPath: "~/.psy/seal-key",

          // Payload handling
          payloadCapture: false,

          // Runtime behavior
          dryRun: false,
          hookTimeoutMs: 5000,

          // Deprecated compatibility fields; ignored by current plugin builds.
          psyCoreVersion: "0.5.1",
          psyBinary: null
        }
      }
    }
  }
}
```

Useful environment variables:

| Variable | Purpose |
|---|---|
| `PSY_ACTOR_ID` | Default actor id if config omits `actorId` |
| `PSY_TENANT_ID` | Default tenant id if config omits `tenantId` |
| `PSY_AUDIT_DB_PATH` | Override the active SQLite path |
| `PSY_SEAL_KEY_PATH` | Override the HMAC seal key path |
| `OPENCLAW_STATE_DIR` | Override OpenClaw state directory discovery |
| `OPENCLAW_PROFILE` | Select profile-specific default workspace discovery |

`actorId` is required unless `allowAnonymous` is explicitly set to `true`. Payload capture is off by default; when enabled, payload previews are redacted in-process before storage.

## Identity Model

`actorId` is required by default. This is deliberate: an audit log without a principal is only half a receipt.

If `actorId` is missing, OpenClaw starts without the plugin hooks and logs:

```text
psy-core-openclaw: actorId is required.
  Why:    audit events must attribute the session to a principal.
  Where:  openclaw.json -> plugins.entries.psy-core.config.actorId
  Example:
    "plugins": {
      "entries": {
        "psy-core": {
          "enabled": true,
          "config": { "actorId": "alice@example.com" }
        }
      }
    }
  Bypass: set allowAnonymous: true (not recommended in production).
```

For local experiments only:

```bash
openclaw config set plugins.entries.psy-core.config.allowAnonymous true
```

For shared machines, hosted agents, or any real user data, set `actorId`.

## Docs by Goal

| Goal | Where to go |
|---|---|
| Understand the core audit chain | [Root psy-core README](../../README.md) |
| Install through an OpenClaw agent | [Agent install guide](AGENT_INSTALL.md) |
| Give OpenClaw an operating checklist | [`skills/psy-core-openclaw/SKILL.md`](skills/psy-core-openclaw/SKILL.md) |
| Inspect captured surfaces | [What Gets Captured](#what-gets-captured) |
| Verify audit integrity | `psy verify --all` |
| Report an issue | [GitHub Issues](https://github.com/jethros-projects/psy-core/issues) |

## Versioning and Compatibility

This package version: `psy-core-openclaw 0.1.2`

Pinned operator CLI shown in docs: `psy-core 0.5.1`

Verified OpenClaw contracts:

| Contract | Behavior |
|---|---|
| Plugin id | `psy-core` |
| Plugin entry | `./src/index.js` |
| OpenClaw host | `>=2026.4.29` |
| Plugin API | `>=2026.4.29` |
| Node runtime | `>=22.14` |
| Hook signatures | `before_tool_call`, `after_tool_call`, and `gateway_stop` |

## Security Notes

- The adapter records durable memory and skill activity; it does not approve or deny OpenClaw tool calls.
- Payload capture is off by default to avoid storing memory text previews. If enabled, built-in redaction is useful operational hygiene, not a DLP system.
- The seal key protects tail verification. Keep `sealKeyPath` private and mode `0600`.
- `psy verify --all` should be part of any incident review involving memory or skill changes.
- Use `allowAnonymous: true` only for local experiments.

## Development

This package is deliberately plain ESM JavaScript so it can be installed from a local directory without a build step. OpenClaw supplies `openclaw/plugin-sdk/*` at runtime.

```bash
cd plugins/psy-core-openclaw
npm test
npm run test:e2e
```

Root audit-engine checks:

```bash
cd ../..
npm test
npm run typecheck
npm run build
```

## License

MIT
