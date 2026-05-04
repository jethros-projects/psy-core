#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GBRAIN_REPO="${PSY_GBRAIN_REAL_REPO:-/tmp/codex-gbrain}"
OPENCLAW_REPO="${OPENCLAW_REPO:-$(cd "$ROOT/.." && pwd)/openclaw-official}"
HERMES_VENV="${HERMES_VENV:-/tmp/psy-core-hermes-review-venv}"
HERMES_PYTHON="${HERMES_PYTHON:-$HERMES_VENV/bin/python}"

ensure_gbrain() {
  if [[ ! -d "$GBRAIN_REPO/.git" ]]; then
    mkdir -p "$(dirname "$GBRAIN_REPO")"
    git clone https://github.com/garrytan/gbrain.git "$GBRAIN_REPO"
  fi
  if [[ ! -d "$GBRAIN_REPO/node_modules" ]]; then
    bun install --cwd "$GBRAIN_REPO"
  fi
}

ensure_openclaw() {
  if [[ ! -d "$OPENCLAW_REPO/.git" ]]; then
    mkdir -p "$(dirname "$OPENCLAW_REPO")"
    git clone https://github.com/openclaw/openclaw.git "$OPENCLAW_REPO"
  fi
  if [[ ! -d "$OPENCLAW_REPO/node_modules" ]]; then
    pnpm --dir "$OPENCLAW_REPO" install --frozen-lockfile
  fi
}

ensure_hermes() {
  if [[ ! -x "$HERMES_PYTHON" ]]; then
    python3 -m venv "$HERMES_VENV"
  fi
  "$HERMES_PYTHON" -m pip install -e "$ROOT/python/psy-core-hermes[dev]"
  if ! "$HERMES_PYTHON" -c "import hermes_cli.plugins" >/dev/null 2>&1; then
    "$HERMES_PYTHON" -m pip install "git+https://github.com/NousResearch/hermes-agent.git"
  fi
}

echo "==> Preparing live integration fixtures"
ensure_gbrain
ensure_openclaw
ensure_hermes

echo "==> Root TypeScript suite with real GBrain fixture"
PSY_GBRAIN_REAL_REPO="$GBRAIN_REPO" npm test --prefix "$ROOT"

echo "==> Built TypeScript adapters shared-chain E2E"
PSY_GBRAIN_REAL_REPO="$GBRAIN_REPO" npm run test:e2e:adapters --prefix "$ROOT"

echo "==> GBrain live process/repo boundary"
PSY_GBRAIN_REAL_REPO="$GBRAIN_REPO" npm run test:gbrain:live --prefix "$ROOT"

echo "==> OpenClaw plugin unit + real-source contract suite"
OPENCLAW_REPO="$OPENCLAW_REPO" OPENCLAW_REPO_REQUIRED=1 npm test --prefix "$ROOT/plugins/psy-core-openclaw"

echo "==> OpenClaw live gateway/process E2E"
OPENCLAW_REPO="$OPENCLAW_REPO" npm run test:e2e --prefix "$ROOT/plugins/psy-core-openclaw"

echo "==> Hermes real PluginManager + subprocess E2E"
cd "$ROOT/python/psy-core-hermes"
"$HERMES_PYTHON" -m pytest -rs
