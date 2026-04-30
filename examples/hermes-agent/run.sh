#!/usr/bin/env bash
# Bootstrap a self-contained walkthrough of psy-core-hermes against a fresh
# Hermes agent install. See README.md for the narrative.
#
# Usage:
#   ./run.sh --actor-id you@example.com [--with-hermes]
#
# By default this only installs psy-core-hermes and psy-core; pass --with-hermes
# to also install hermes-agent from PyPI (requires Python >=3.11).

set -euo pipefail

ACTOR_ID=""
WITH_HERMES=false

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
  --with-hermes      also install hermes-agent from PyPI
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
  echo "==> installing hermes-agent"
  pip install 'hermes-agent>=0.11,<0.12'
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
       $ROOT/.venv/bin/psy tail

  2. In another terminal, run Hermes (requires --with-hermes if you
     didn't pass it):
       $ROOT/.venv/bin/hermes

  3. Verify the chain after a few memory writes:
       $ROOT/.venv/bin/psy verify --all

EOF
