# Dream Catcher

OpenClaw dreams in the background. Dream Catcher catches those dream changes, verifies them, and turns them into a short morning brief.

Dream Catcher is part of the `psy-core-openclaw` plugin. It does not do the dreaming itself. OpenClaw Dreaming creates and promotes memory candidates; Dream Catcher watches the artifacts, records receipts, and gives the user a clear review moment.

## The Prompt

The product should be usable from one conversational request:

```text
Install psy-core-openclaw, turn on OpenClaw Dreaming, enable Dream Catcher, and send me my morning dream brief at 9am.
```

If the destination is missing, ask one question:

```text
Where should I send the 9am Dream Catcher brief?
```

Then confirm in plain language:

```text
Done. OpenClaw Dreaming is on, Dream Catcher is watching the dream ledger, and I will send your morning dream brief every day at 9:00 AM.
```

## What It Watches

By default Dream Catcher watches the human-reviewable dream ledger:

- `DREAMS.md`
- `dreams.md`
- `memory/dreaming/**`

It can also watch `memory/.dreams/**`, but that is off by default because it is noisier machine state.

## Morning Brief

The brief should be short and conversational:

```text
Dream Catcher
Your morning dream brief

I checked the last 24 hours.

Dream activity:
- DREAMS.md was updated with a possible preference about planning style.
- memory/dreaming/rem/2026-05-08.md added a reflection about recurring project priorities.

Durable memory:
- No promoted memory changes.

Needs review:
The planning-style preference looks useful, but I did not promote it.

Want me to promote it to MEMORY.md?
```

If nothing changed:

```text
Dream Catcher: no dream or durable-memory changes in the last 24h. Chain verified.
```

## The Rule

Dream artifacts are candidates, not durable truth.

Dream Catcher can show what changed, verify the chain, and ask what to do next. It should not promote anything into `MEMORY.md`, `USER.md`, or skills unless the user asks.

## Admin Notes

The user should not need these commands during normal use, but this is what the agent does underneath:

```bash
openclaw plugins install psy-core-openclaw
openclaw config set plugins.entries.psy-core.enabled true
openclaw config set plugins.entries.psy-core.config.actorId "you@example.com"
openclaw config set plugins.entries.psy-core.config.dreamCatcherEnabled true
/dreaming on
openclaw gateway restart
```

Manual brief:

```bash
PSY_AUDIT_DB_PATH="$HOME/.psy/audit.db" \
PSY_SEAL_KEY_PATH="$HOME/.psy/seal-key" \
PSY_HEAD_PATH="$HOME/.psy/head.json" \
  psy dream-catcher --since 24h
```

Morning schedule example:

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

Use the user's real channel and target. If they say "this chat," use the current OpenClaw conversation target when OpenClaw exposes one.
