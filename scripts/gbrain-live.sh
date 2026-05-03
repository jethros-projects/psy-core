#!/usr/bin/env bash
set -euo pipefail

repo="${PSY_GBRAIN_REAL_REPO:-/tmp/codex-gbrain}"

if [[ ! -d "$repo" ]]; then
  echo "Missing GBrain repo: $repo" >&2
  echo "Set PSY_GBRAIN_REAL_REPO=/path/to/gbrain or clone https://github.com/garrytan/gbrain to /tmp/codex-gbrain." >&2
  exit 1
fi

echo "==> GBrain repo: $repo"
git -C "$repo" rev-parse --short HEAD

echo "==> Node/Psy SQLite + real GBrain BrainEngine"
PSY_GBRAIN_REAL_REPO="$repo" npx vitest run tests/gbrain-real.test.ts

echo "==> Bun + real GBrain operations.ts boundary"
PSY_GBRAIN_REAL_REPO="$repo" bun run scripts/gbrain-live-operations.ts

