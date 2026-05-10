#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GBRAIN_REPO_DEFAULT="/tmp/codex-gbrain"
GBRAIN_REPO="${PSY_GBRAIN_REAL_REPO:-$GBRAIN_REPO_DEFAULT}"
OPENCLAW_REPO="${OPENCLAW_REPO:-$(cd "$ROOT/.." && pwd)/openclaw-official}"
HERMES_VENV="${HERMES_VENV:-/tmp/psy-core-hermes-review-venv}"
HERMES_PYTHON="${HERMES_PYTHON:-$HERMES_VENV/bin/python}"
HERMES_BUILD_DIR="${HERMES_BUILD_DIR:-/tmp/psy-core-hermes-dist}"
HERMES_VENV_PYTHON="${HERMES_VENV_PYTHON:-}"

if [[ -z "$HERMES_VENV_PYTHON" ]]; then
  HERMES_VENV_PYTHON="$(command -v python3.12 || command -v python3.11 || command -v python3 || true)"
fi

step() {
  echo "==> $1"
}

ensure_gbrain() {
  if ! gbrain_fixture_ok; then
    if [[ -n "${PSY_GBRAIN_REAL_REPO:-}" ]]; then
      echo "Invalid GBrain repo fixture: $GBRAIN_REPO" >&2
      echo "Expected a valid git checkout with package.json and src/core/{engine-factory,operations}.ts." >&2
      exit 1
    fi
    rm -rf "$GBRAIN_REPO"
    mkdir -p "$(dirname "$GBRAIN_REPO")"
    git clone --depth 1 https://github.com/garrytan/gbrain.git "$GBRAIN_REPO"
  fi
  if [[ ! -d "$GBRAIN_REPO/node_modules" ]]; then
    bun install --cwd "$GBRAIN_REPO"
  fi
}

gbrain_fixture_ok() {
  [[ -d "$GBRAIN_REPO/.git" ]] &&
    git -C "$GBRAIN_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 &&
    [[ -f "$GBRAIN_REPO/package.json" ]] &&
    [[ -f "$GBRAIN_REPO/src/core/engine-factory.ts" ]] &&
    [[ -f "$GBRAIN_REPO/src/core/operations.ts" ]]
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

is_venv_python() {
  [[ -x "$HERMES_PYTHON" ]] &&
    "$HERMES_PYTHON" -c 'import sys; ok = sys.prefix != sys.base_prefix and sys.version_info >= (3, 11); raise SystemExit(0 if ok else 1)' >/dev/null 2>&1
}

create_hermes_venv() {
  if [[ -z "$HERMES_VENV_PYTHON" ]] ||
    ! "$HERMES_VENV_PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
    echo "Hermes release E2E requires Python >=3.11. Set HERMES_VENV_PYTHON to a compatible interpreter." >&2
    exit 1
  fi
  rm -rf "$HERMES_VENV"
  "$HERMES_VENV_PYTHON" -m venv "$HERMES_VENV"
  HERMES_PYTHON="$HERMES_VENV/bin/python"
}

ensure_hermes() {
  if ! is_venv_python; then
    create_hermes_venv
  fi
  "$HERMES_PYTHON" -m pip install --upgrade pip
  "$HERMES_PYTHON" -m pip install -e "$ROOT/python/psy-core-hermes[dev]"
  if ! "$HERMES_PYTHON" -c "import hermes_cli.plugins" >/dev/null 2>&1; then
    "$HERMES_PYTHON" -m pip install "git+https://github.com/NousResearch/hermes-agent.git"
  fi
}

step "Preparing live integration fixtures"
ensure_gbrain
ensure_openclaw
ensure_hermes

step "Repository whitespace and patch sanity"
git -C "$ROOT" diff --check

step "Root TypeScript typecheck"
npm run typecheck --prefix "$ROOT"

step "Root unit + atomic integration suite with real GBrain fixture"
PSY_GBRAIN_REAL_REPO="$GBRAIN_REPO" npm test --prefix "$ROOT"

step "Root package build"
npm run build --prefix "$ROOT"

step "Built TypeScript adapters shared-chain E2E"
PSY_GBRAIN_REAL_REPO="$GBRAIN_REPO" npm run test:e2e:adapters --prefix "$ROOT"

step "GBrain live process/repo boundary"
PSY_GBRAIN_REAL_REPO="$GBRAIN_REPO" npm run test:gbrain:live --prefix "$ROOT"

step "Root npm package dry-run"
cd "$ROOT"
npm pack --dry-run

step "OpenClaw plugin unit + real-source contract suite"
OPENCLAW_REPO="$OPENCLAW_REPO" OPENCLAW_REPO_REQUIRED=1 npm test --prefix "$ROOT/plugins/psy-core-openclaw"

step "OpenClaw live gateway/process E2E"
OPENCLAW_REPO="$OPENCLAW_REPO" npm run test:e2e --prefix "$ROOT/plugins/psy-core-openclaw"

step "OpenClaw npm package dry-run"
cd "$ROOT/plugins/psy-core-openclaw"
npm pack --dry-run

step "Hermes real PluginManager + subprocess E2E"
cd "$ROOT/python/psy-core-hermes"
"$HERMES_PYTHON" -m pytest -rs

step "Hermes PyPI package build"
rm -rf "$HERMES_BUILD_DIR"
uv build --out-dir "$HERMES_BUILD_DIR"
