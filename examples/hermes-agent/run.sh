#!/usr/bin/env bash
# Bootstrap a self-contained walkthrough of psy-core-hermes against a fresh
# Hermes agent install. See README.md for the narrative.
#
# Usage:
#   ./run.sh --actor-id you@example.com [--with-hermes]
#
# By default this only installs psy-core-hermes and psy-core; pass --with-hermes
# to also install Hermes Agent from GitHub (requires Python >=3.11).

set -euo pipefail

ACTOR_ID=""
WITH_HERMES=false
HERMES_AGENT_REF="${HERMES_AGENT_REF:-v2026.4.30}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --actor-id)
      ACTOR_ID="$2"
      shift 2
      ;;
    --with-hermes)
      WITH_HERMES=true
      shift
      ;;
    --help|-h)
      cat <<EOF
Usage: $0 --actor-id NAME [--with-hermes]

  --actor-id NAME    actor_id to write into ~/.hermes/config.yaml
  --with-hermes      also install Hermes Agent from GitHub
EOF
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$ACTOR_ID" ]]; then
  echo "ERROR: --actor-id is required (audits must attribute to a principal)" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "==> creating .venv"
python3 -m venv .venv
. .venv/bin/activate

echo "==> upgrading pip"
pip install --upgrade pip

echo "==> installing psy-core-hermes"
pip install -e ../../python/psy-core-hermes

if $WITH_HERMES; then
  echo "==> installing hermes-agent from GitHub ($HERMES_AGENT_REF)"
  pip install "git+https://github.com/NousResearch/hermes-agent.git@${HERMES_AGENT_REF}"
fi

echo "==> installing psy-core CLI globally (so 'psy' is on PATH)"
if command -v npm >/dev/null 2>&1; then
  npm install -g ../../
else
  echo "  npm not found; the npx fallback will be used at runtime."
fi

echo "==> running psy-core-hermes init"
psy-core-hermes init --actor-id "$ACTOR_ID"

echo "==> running psy-core-hermes doctor"
psy-core-hermes doctor || true

cat <<EOF

Next steps:

  1. Watch the audit chain:
       psy tail

  2. In another terminal, run Hermes (requires --with-hermes if you
     didn't pass it):
       $ROOT/.venv/bin/hermes

  3. Verify the chain after a few memory writes:
       psy verify --all

EOF
