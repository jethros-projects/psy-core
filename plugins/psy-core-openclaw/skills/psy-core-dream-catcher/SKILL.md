---
name: psy-core-dream-catcher
description: Use when reviewing, scheduling, or briefing OpenClaw Dreaming changes captured by psy-core.
metadata: {"openclaw":{"requires":{"config":["plugins.entries.psy-core.enabled","plugins.entries.psy-core.config.dreamCatcherEnabled"]}}}
---

# psy-core Dream Catcher

Use this skill to turn psy-core dream receipts into a morning dream brief.

## What to Review

Dream artifacts are staging areas, not durable truth.

Review:

- `DREAMS.md`
- `dreams.md`
- `memory/dreaming/**`
- `memory/.dreams/**` only if machine-state capture is explicitly enabled

Treat `MEMORY.md`, `USER.md`, and skills as promoted durable memory.

## Morning Dream Brief

Run the brief against the same audit DB the OpenClaw plugin writes:

```bash
PSY_AUDIT_DB_PATH="$HOME/.psy/audit.db" \
PSY_SEAL_KEY_PATH="$HOME/.psy/seal-key" \
PSY_HEAD_PATH="$HOME/.psy/head.json" \
  psy dream-catcher --since 24h
```

Then:

1. Verify the chain with `psy verify --all --no-color`.
2. Read changed dream artifacts if the brief shows any.
3. Summarize what changed, where it changed, and whether anything was promoted into durable memory.
4. Call out anything that needs user approval before promotion.
5. Do not promote dream candidates into `MEMORY.md`, `USER.md`, or skills unless the user asks.

## Schedule It

For a dedicated chat, ask the user for the channel and target, then create an isolated cron job:

```bash
openclaw cron add \
  --name "Dream Catcher morning brief" \
  --cron "0 9 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Use the psy-core-dream-catcher skill. Run psy dream-catcher --since 24h, verify the audit chain, inspect changed dream artifacts if needed, and send a concise Dream Catcher brief: what changed, where, promotions, and approvals needed." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

Use the user's real channel and target. Telegram, Discord, Slack, Google Chat,
Mattermost, Signal, iMessage, WhatsApp, and MS Teams targets follow OpenClaw's
`openclaw message` target formats.

## Message Shape

Keep the morning brief short:

```text
Dream Catcher - last 24h

Dream artifacts:
- create /memories/DREAMS.md
- str_replace /memories/memory/dreaming/rem/2026-05-08.md

Durable memory:
- str_replace /memories/MEMORY.md

Needs review:
- Proposed preference update in DREAMS.md; not promoted yet.

Chain:
- verified
```

If nothing changed, send one quiet line unless the user requested silence:

```text
Dream Catcher: no dream or durable-memory changes in the last 24h. Chain verified.
```
