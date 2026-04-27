#!/usr/bin/env bash
# psy v0.3.x testing bench.
#
# Builds psy-core from the working tree (or pulls a published version
# from npm), installs it into a clean sandbox, and exercises every public
# surface end-to-end: subpath imports for all 6 adapters (anthropic-memory,
# letta, mastra, mem0, langchain, langgraph), full method coverage per
# adapter, real-SDK structural shape checks, real-instance integration
# tests for LangChain + LangGraph, sealed-tail tamper detection (with
# meta-rewrite), CLI commands with JSON-parsed assertions, fail-closed
# proofs, perf microbench with a real threshold gate.
#
# Visual feedback per step (spinner + ANSI color), aggregated summary.
# Each step runs in a set -e subshell so failed commands always propagate.
#
# Usage:
#   scripts/bench.sh                                 # build + test working tree
#   scripts/bench.sh --from-npm                      # test latest psy-core on npm
#   scripts/bench.sh --from-npm --version 0.3.2      # pin a published version
#   scripts/bench.sh --tiers 1,2b,3                  # subset
#   scripts/bench.sh --keep                          # keep workspace at end
#   scripts/bench.sh --verbose                       # stream per-step output
#   scripts/bench.sh --no-color                      # plain output for CI / piping
#   scripts/bench.sh --p95 30                        # custom perf threshold (ms)
#
# Anthropic test (Tier 2A) only runs if $ANTHROPIC_API_KEY is set.
# Letta and Mastra are exercised against in-process stub clients.

set -uo pipefail
unset PSY_SEAL_KEY 2>/dev/null || true   # never inherit from caller

# ───────────────────────────────────────────────────────────────────
# Args + setup
# ───────────────────────────────────────────────────────────────────

TIERS_FILTER=""
KEEP_WORKSPACE=0
VERBOSE=0
USE_COLOR=1
P95_THRESHOLD_MS=50   # bench fails if Tier 7 p95 exceeds this
FROM_NPM=0            # default: build local tarball; --from-npm flips to registry
PUBLISHED_VERSION=""  # optional: pin a specific published version

usage() {
  sed -n '2,27p' "$0" | sed 's/^# \?//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tiers)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "error: --tiers requires a value (e.g. --tiers 1,2b,3)" >&2
        exit 2
      fi
      TIERS_FILTER="$2"; shift 2 ;;
    --keep) KEEP_WORKSPACE=1; shift ;;
    --verbose|-v) VERBOSE=1; shift ;;
    --no-color) USE_COLOR=0; shift ;;
    --p95)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "error: --p95 requires a millisecond value" >&2
        exit 2
      fi
      P95_THRESHOLD_MS="$2"; shift 2 ;;
    --from-npm) FROM_NPM=1; shift ;;
    --version)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "error: --version requires a semver (e.g. --version 0.3.2)" >&2
        exit 2
      fi
      PUBLISHED_VERSION="$2"; FROM_NPM=1; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [ ! -t 1 ] || [ "$USE_COLOR" -eq 0 ]; then
  RESET="" BOLD="" DIM="" GREEN="" RED="" YELLOW="" BLUE="" CYAN=""
else
  RESET=$'\033[0m'
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  GREEN=$'\033[32m'
  RED=$'\033[31m'
  YELLOW=$'\033[33m'
  BLUE=$'\033[34m'
  CYAN=$'\033[36m'
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE="$(mktemp -d "/tmp/psy-bench-XXXXXX")"
LOG_FILE="$WORKSPACE/bench.log"
PASS=0
FAIL=0
SKIP=0
FAILED_STEPS=()
TIER_START=$(date +%s)

cleanup() {
  # Kill any still-running spinner before tearing down.
  if [ -n "${SPINNER_PID:-}" ]; then
    kill "$SPINNER_PID" 2>/dev/null || true
  fi
  if [ "$KEEP_WORKSPACE" -eq 1 ]; then
    printf "\n%sworkspace kept at:%s %s\n" "$DIM" "$RESET" "$WORKSPACE"
  else
    rm -rf "$WORKSPACE"
  fi
}

interrupt() {
  printf "\n%sinterrupted%s\n" "$YELLOW" "$RESET"
  KEEP_WORKSPACE=1
  cleanup
  exit 130
}

trap cleanup EXIT
trap interrupt INT TERM

# ───────────────────────────────────────────────────────────────────
# Helpers
# ───────────────────────────────────────────────────────────────────

# tier_enabled <tier-id> — returns 0 if tier should run.
tier_enabled() {
  local id="$1"
  if [ -z "$TIERS_FILTER" ]; then return 0; fi
  case ",$TIERS_FILTER," in
    *",$id,"*) return 0 ;;
    *) return 1 ;;
  esac
}

header() {
  printf "\n%s%s%s\n" "$BOLD$CYAN" "$1" "$RESET"
}

# Spinner runs in background and is killed when the step finishes.
SPINNER_FRAMES=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
SPINNER_PID=""

start_spinner() {
  local desc="$1"
  if [ ! -t 1 ]; then
    printf "  %s…%s %s\n" "$DIM" "$RESET" "$desc"
    return
  fi
  (
    trap 'exit 0' INT TERM
    local i=0
    while :; do
      local frame="${SPINNER_FRAMES[$((i % ${#SPINNER_FRAMES[@]}))]}"
      printf "\r  %s%s%s %s" "$BLUE" "$frame" "$RESET" "$desc"
      i=$((i + 1))
      sleep 0.08
    done
  ) &
  SPINNER_PID=$!
  disown $SPINNER_PID 2>/dev/null || true
}

stop_spinner() {
  if [ -n "$SPINNER_PID" ]; then
    kill "$SPINNER_PID" 2>/dev/null || true
    wait "$SPINNER_PID" 2>/dev/null || true
    SPINNER_PID=""
    printf "\r\033[K"
  fi
}

# step <description> <fn-name> — run a step, show status, capture log.
# The fn runs in a set -e subshell so any failed sub-command propagates.
step() {
  local desc="$1"; shift
  local t0
  t0=$(date +%s)
  start_spinner "$desc"
  local out
  if out=$( ( set -e; "$@" ) 2>&1 ); then
    stop_spinner
    local t1
    t1=$(date +%s)
    local elapsed=$((t1 - t0))
    printf "  %s✓%s %s   %s(%ds)%s\n" "$GREEN" "$RESET" "$desc" "$DIM" "$elapsed" "$RESET"
    if [ "$VERBOSE" -eq 1 ] && [ -n "$out" ]; then
      printf "%s\n" "$out" | sed 's/^/    /'
    fi
    PASS=$((PASS + 1))
    {
      echo "=== PASS: $desc (${elapsed}s) ==="
      echo "$out"
      echo ""
    } >> "$LOG_FILE"
    return 0
  else
    local rc=$?
    stop_spinner
    local t1
    t1=$(date +%s)
    local elapsed=$((t1 - t0))
    printf "  %s✗%s %s   %s(%ds, rc=%d)%s\n" "$RED" "$RESET" "$desc" "$DIM" "$elapsed" "$rc" "$RESET"
    if [ -n "$out" ]; then
      printf "%s\n" "$out" | head -25 | sed "s/^/    ${RED}│${RESET} /"
    fi
    FAIL=$((FAIL + 1))
    FAILED_STEPS+=("$desc")
    {
      echo "=== FAIL: $desc (${elapsed}s, rc=$rc) ==="
      echo "$out"
      echo ""
    } >> "$LOG_FILE"
    return $rc
  fi
}

skip() {
  local desc="$1"
  local reason="$2"
  printf "  %s⏭%s  %s   %s(%s)%s\n" "$YELLOW" "$RESET" "$desc" "$DIM" "$reason" "$RESET"
  SKIP=$((SKIP + 1))
  {
    echo "=== SKIP: $desc ($reason) ==="
    echo ""
  } >> "$LOG_FILE"
}

# Run a Node ESM one-liner from inside the workspace (so psy-core resolves).
node_run() {
  ( cd "$WORKSPACE/local-sdk" && node --input-type=module -e "$1" )
}

# Run psy CLI from the workspace's installed copy.
psy_cli() {
  ( cd "$WORKSPACE/local-sdk" && PSY_AUDIT_DB_PATH=.psy/events.sqlite ./node_modules/.bin/psy "$@" )
}

# Reset psy DB. Returns non-zero if init fails.
reset_db() {
  rm -rf "$WORKSPACE/local-sdk/.psy" "$WORKSPACE/local-sdk/.psy.json"
  ( cd "$WORKSPACE/local-sdk" && PSY_AUDIT_DB_PATH=.psy/events.sqlite ./node_modules/.bin/psy init >/dev/null 2>&1 )
}

# ───────────────────────────────────────────────────────────────────
# Banner
# ───────────────────────────────────────────────────────────────────

PKG_VERSION=$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo "?.?.?")
if [ "$FROM_NPM" -eq 1 ]; then
  if [ -n "$PUBLISHED_VERSION" ]; then
    MODE_LABEL="npm@$PUBLISHED_VERSION (published)"
  else
    MODE_LABEL="latest from npm (published)"
  fi
else
  MODE_LABEL="local working tree v$PKG_VERSION"
fi

printf "%s%s╔════════════════════════════════════════════════════╗%s\n" "$BOLD" "$CYAN" "$RESET"
printf "%s%s║%s  %spsy-core testing bench%s                            %s%s║%s\n" "$BOLD" "$CYAN" "$RESET" "$BOLD" "$RESET" "$BOLD" "$CYAN" "$RESET"
printf "%s%s║%s  mode:      %-39s %s%s║%s\n" "$BOLD" "$CYAN" "$RESET" "$MODE_LABEL" "$BOLD" "$CYAN" "$RESET"
printf "%s%s║%s  workspace: %-39s %s%s║%s\n" "$BOLD" "$CYAN" "$RESET" "$(echo "$WORKSPACE" | sed 's/.*\///')" "$BOLD" "$CYAN" "$RESET"
printf "%s%s║%s  repo:      %-39s %s%s║%s\n" "$BOLD" "$CYAN" "$RESET" "$(basename "$REPO_ROOT")" "$BOLD" "$CYAN" "$RESET"
printf "%s%s╚════════════════════════════════════════════════════╝%s\n" "$BOLD" "$CYAN" "$RESET"

# ───────────────────────────────────────────────────────────────────
# Preflight — required host tools
# ───────────────────────────────────────────────────────────────────

header "Preflight"

preflight_node() {
  command -v node >/dev/null 2>&1 || { echo "node not found on PATH"; return 1; }
  local ver
  ver=$(node --version | sed 's/^v//' | cut -d. -f1)
  if [ "$ver" -lt 20 ]; then
    echo "node $ver is too old (need >=20)"
    return 1
  fi
  return 0
}
preflight_npm() { command -v npm >/dev/null 2>&1 || { echo "npm not found"; return 1; }; }
preflight_sqlite3() { command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 not on PATH (Tier 3 needs it)"; return 1; }; }
preflight_jq() { command -v jq >/dev/null 2>&1 || { echo "jq not on PATH (Tier 5 + Tier 7 need it)"; return 1; }; }
preflight_awk() { command -v awk >/dev/null 2>&1 || { echo "awk not on PATH"; return 1; }; }
preflight_openssl() { command -v openssl >/dev/null 2>&1 || { echo "openssl not on PATH (only needed for --tiers 2a)"; return 1; }; }

step "node >= 20 on PATH" preflight_node
step "npm on PATH" preflight_npm
step "sqlite3 on PATH" preflight_sqlite3
step "jq on PATH" preflight_jq
step "awk on PATH" preflight_awk
# openssl is only required by the Anthropic real-API tier, so it's a soft skip.
if ! command -v openssl >/dev/null 2>&1; then
  skip "openssl on PATH" "not required for default tiers"
else
  step "openssl on PATH" preflight_openssl
fi

if [ "$FAIL" -gt 0 ]; then
  printf "\n%sPreflight failed. Install missing tools and retry.%s\n" "$RED" "$RESET"
  exit 1
fi

# ───────────────────────────────────────────────────────────────────
# Setup — build a tarball, install it, validate the published shape
# ───────────────────────────────────────────────────────────────────

header "Setup"

build_tarball() {
  cd "$REPO_ROOT"
  local tmp
  tmp=$(mktemp -d)
  npm pack --pack-destination "$tmp" --silent >/dev/null
  local tarball
  tarball=$(ls "$tmp"/*.tgz | head -1)
  test -f "$tarball" || { echo "npm pack produced no tarball"; return 1; }
  echo "$tarball" > "$WORKSPACE/.tarball-path"
}

setup_workspace() {
  mkdir -p "$WORKSPACE/local-sdk"
  cd "$WORKSPACE/local-sdk"
  npm init -y >/dev/null 2>&1
  npm pkg set type=module >/dev/null 2>&1
}

install_psy_from_tarball() {
  local tarball
  tarball=$(cat "$WORKSPACE/.tarball-path")
  cd "$WORKSPACE/local-sdk"
  # Capture full output; only check exit status, not piped tail.
  if ! npm install --silent --no-fund --no-audit "$tarball" >"$WORKSPACE/.install.log" 2>&1; then
    cat "$WORKSPACE/.install.log"
    return 1
  fi
}

# Install the published psy-core directly from the npm registry instead of a
# locally-packed tarball. Used when --from-npm is set: proves the registry
# artifact (not just the working tree) installs and works end-to-end.
install_psy_from_npm() {
  cd "$WORKSPACE/local-sdk"
  local pkg="psy-core"
  if [ -n "$PUBLISHED_VERSION" ]; then
    pkg="psy-core@$PUBLISHED_VERSION"
  fi
  if ! npm install --silent --no-fund --no-audit "$pkg" >"$WORKSPACE/.install.log" 2>&1; then
    cat "$WORKSPACE/.install.log"
    return 1
  fi
  # Confirm the installed version (so the rest of the bench has a known target).
  local installed
  installed=$(node -p "require('psy-core/package.json').version" 2>/dev/null || echo "")
  if [ -z "$installed" ]; then
    echo "could not read installed psy-core version"
    return 1
  fi
  echo "installed: psy-core@$installed"
}

verify_dist() {
  cd "$WORKSPACE/local-sdk"
  # All 6 adapters' compiled JS + the root + the CLI shim.
  for f in \
    dist/index.js \
    dist/cli.js \
    dist/anthropic-memory/index.js \
    dist/letta/index.js \
    dist/mastra/index.js \
    dist/mem0/index.js \
    dist/langchain/index.js \
    dist/langgraph/index.js; do
    test -f "node_modules/psy-core/$f" || { echo "missing $f in installed package"; return 1; }
  done
  # All 6 adapters' type definitions.
  for f in \
    dist/index.d.ts \
    dist/anthropic-memory/index.d.ts \
    dist/letta/index.d.ts \
    dist/mastra/index.d.ts \
    dist/mem0/index.d.ts \
    dist/langchain/index.d.ts \
    dist/langgraph/index.d.ts; do
    test -f "node_modules/psy-core/$f" || { echo "missing types: $f"; return 1; }
  done
  # ESM-only invariant: no CJS bundle should exist (canonicalize is ESM-only).
  test ! -f node_modules/psy-core/dist/index.cjs || { echo "ESM-only violation: dist/index.cjs exists in installed package"; return 1; }
}

# Catch metadata regressions in the installed package: a future release that
# accidentally drops keywords, repository, or 1+ subpath exports would fail
# here instead of silently shipping with a degraded npm presence.
verify_package_metadata() {
  cd "$WORKSPACE/local-sdk"
  local pkg="node_modules/psy-core/package.json"
  test -f "$pkg" || { echo "package.json missing"; return 1; }
  node -e "
    const p = require('./$pkg');
    const fail = (msg) => { console.error(msg); process.exit(1); };
    // description present and themed
    const desc = p.description || '';
    if (!/audit|tamper|memory/i.test(desc)) fail('description missing key terms (audit/tamper/memory): ' + desc);
    // exports has all 6 subpaths + root + package.json
    const expected = ['.', './anthropic-memory', './letta', './mastra', './mem0', './langchain', './langgraph', './package.json'];
    for (const e of expected) {
      if (!p.exports || !p.exports[e]) fail('missing exports entry: ' + e);
    }
    // npm discoverability metadata
    const missing = [];
    if (!p.repository) missing.push('repository');
    if (!p.homepage) missing.push('homepage');
    if (!p.bugs) missing.push('bugs');
    if (!Array.isArray(p.keywords) || p.keywords.length < 5) missing.push('keywords (>=5)');
    if (missing.length) fail('missing metadata: ' + missing.join(', '));
    // bin entry for CLI
    if (!p.bin || !p.bin.psy) fail('missing bin.psy entry');
  " || return 1
}

verify_bench_shipped() {
  cd "$WORKSPACE/local-sdk"
  test -f node_modules/psy-core/scripts/bench.sh || { echo "scripts/bench.sh not shipped in tarball"; return 1; }
  test -x node_modules/psy-core/scripts/bench.sh || { echo "scripts/bench.sh not executable"; return 1; }
}

verify_cli() {
  cd "$WORKSPACE/local-sdk"
  ./node_modules/.bin/psy --help >/dev/null 2>&1 || return 1
  ./node_modules/.bin/psy verify --help 2>&1 | grep -qE -- '--all|--no-seal' || { echo "psy verify help missing expected flags"; return 1; }
}

if [ "$FROM_NPM" -eq 1 ]; then
  step "Create sandbox + npm init" setup_workspace
  if [ -n "$PUBLISHED_VERSION" ]; then
    step "Install psy-core@$PUBLISHED_VERSION from npm registry" install_psy_from_npm
  else
    step "Install latest psy-core from npm registry" install_psy_from_npm
  fi
else
  step "Build tarball via npm pack" build_tarball
  step "Create sandbox + npm init" setup_workspace
  step "Install psy-core from tarball" install_psy_from_tarball
fi
step "Verify ESM-only dist shape (all 6 adapters + types)" verify_dist
step "Verify package.json metadata (exports, keywords, repo, bugs)" verify_package_metadata
step "Verify scripts/bench.sh ships with the package" verify_bench_shipped
step "Verify psy CLI is on PATH and accepts --all/--no-seal" verify_cli

if [ "$FAIL" -gt 0 ]; then
  printf "\n%sSetup failed. See %s%s\n" "$RED" "$LOG_FILE" "$RESET"
  exit 1
fi

# ───────────────────────────────────────────────────────────────────
# Tier 1 — Quick smoke
# ───────────────────────────────────────────────────────────────────

if tier_enabled 1; then
  header "Tier 1 — Quick smoke"

  smoke_six_providers() {
    local out
    out=$(node_run "
import { listProviders } from 'psy-core';
import 'psy-core/anthropic-memory';
import 'psy-core/letta';
import 'psy-core/mastra';
import 'psy-core/mem0';
import 'psy-core/langchain';
import 'psy-core/langgraph';
const names = listProviders().map(p => p.name).sort();
if (names.length !== 6) { console.error('expected 6 providers, got', names.length); process.exit(1); }
const expected = ['anthropic-memory','langchain','langgraph','letta','mastra','mem0'];
for (const e of expected) {
  if (!names.includes(e)) { console.error('missing provider:', e); process.exit(1); }
}
")
    [ -z "$out" ] || echo "$out"
  }

  smoke_lookup() {
    node_run "
import { getProvider } from 'psy-core';
import 'psy-core/letta';
const found = getProvider('letta');
const ghost = getProvider('does-not-exist');
if (found?.name !== 'letta') { console.error('letta lookup failed'); process.exit(1); }
if (ghost !== null) { console.error('ghost should be null'); process.exit(1); }
"
  }

  step "Six providers register via subpath imports" smoke_six_providers
  step "getProvider lookup hits + misses correctly" smoke_lookup
fi

# ───────────────────────────────────────────────────────────────────
# Tier 2A — Anthropic real API
# ───────────────────────────────────────────────────────────────────

if tier_enabled 2 || tier_enabled 2a; then
  header "Tier 2A — Anthropic MemoryTool (real API)"
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    skip "Anthropic real-API demo" "ANTHROPIC_API_KEY not set"
  else
    anthropic_real_demo() {
      cd "$WORKSPACE/local-sdk"
      reset_db || { echo "reset_db failed"; return 1; }
      # Use the file-based seal key created by `psy init`. Don't pass
      # PSY_SEAL_KEY — that would sign the head with a different key than
      # the one verify reads back from .psy/seal-key, producing a spurious
      # seal_hmac_invalid mismatch.
      npm install --silent --no-fund --no-audit --legacy-peer-deps @anthropic-ai/sdk tsx >/dev/null 2>&1
      cp "$REPO_ROOT/examples/claude-agent.ts" demo.ts
      ./node_modules/.bin/tsx demo.ts >/dev/null 2>&1
    }
    anthropic_chain_check() {
      psy_cli verify --all
      local rows
      rows=$(psy_cli query --actor sarah@example.com --json | jq 'length')
      [ "$rows" -gt 0 ] || { echo "expected >0 rows from real demo"; return 1; }
    }
    step "Run claude-agent.ts demo (3 turns)" anthropic_real_demo
    step "Chain verifies, audit rows present" anthropic_chain_check
  fi
fi

# ───────────────────────────────────────────────────────────────────
# Tier 2B — Letta blocks (full coverage)
# ───────────────────────────────────────────────────────────────────

if tier_enabled 2 || tier_enabled 2b; then
  header "Tier 2B — Letta blocks (full coverage)"

  letta_full_run() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    cat > _bench-letta.mjs <<'EOF'
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/letta';

let globalCalls = 0;
let agentCalls = 0;
let listCalls = 0;
let detachCalls = 0;

const stubGlobal = {
  async create(b)       { globalCalls++; return { id: 'blk_g1', label: b.label, value: b.value }; },
  async retrieve(id)    { globalCalls++; return { id, label: 'human', value: 'stubbed' }; },
  async update(id, b)   { globalCalls++; return { id, label: 'human', value: b.value ?? 'kept' }; },
  async delete(id)      { globalCalls++; return { ok: true, id }; },
  async list()          { listCalls++;   return { data: [], has_more: false }; },
};
const stubAgent = {
  async retrieve(label, p) { agentCalls++;  return { id: `blk_${p.agent_id}_${label}`, label, value: 'a' }; },
  async update(label, b)   { agentCalls++;  return { id: `blk_${b.agent_id}_${label}`, label, value: b.value }; },
  async attach(id, p)      { agentCalls++;  return { ok: true, id, agent: p.agent_id }; },
  async detach(id, p)      { detachCalls++; return { ok: true, id, agent: p.agent_id }; },
};

// Identity comes from runWithContext (no actorId in options) so the tier
// validates ALS propagation, not the wrap-options shortcut.
const blocks = wrap(stubGlobal, {});
const agentBlocks = wrap(stubAgent, {});

await runWithContext({ actorId: 'ctx-actor', tenantId: 'demo' }, async () => {
  // Exercise every audited method on both surfaces.
  const c = await blocks.create({ label: 'preferences', value: 'v1' });
  await blocks.retrieve(c.id);
  await blocks.update(c.id, { value: 'v2' });
  await blocks.delete(c.id);
  // Pass-through: wrapped surface still exposes list (not audited).
  const ls = await blocks.list();
  if (!ls || ls.has_more !== false) throw new Error('list passthrough broken');

  await agentBlocks.retrieve('persona', { agent_id: 'agent_1' });
  await agentBlocks.update('persona', { agent_id: 'agent_1', value: 'be helpful' });
  // attach is on the agent surface but is not audited (lifecycle, not memory op).
  await agentBlocks.attach('blk_g1', { agent_id: 'agent_1' });
  await agentBlocks.detach('blk_g1', { agent_id: 'agent_1' });
});

if (globalCalls !== 4) { console.error('globalCalls expected 4 got', globalCalls); process.exit(1); }
if (agentCalls !== 3)  { console.error('agentCalls expected 3 got', agentCalls); process.exit(1); }
if (listCalls !== 1)   { console.error('listCalls expected 1 got', listCalls); process.exit(1); }
if (detachCalls !== 1) { console.error('detachCalls expected 1 got', detachCalls); process.exit(1); }
EOF
    node _bench-letta.mjs
    rm _bench-letta.mjs
  }

  letta_audit_assertions() {
    cd "$WORKSPACE/local-sdk"
    # Pull the full audit log and parse with jq. Assert exact (operation,phase)
    # sequence on the global surface, identity propagation from runWithContext,
    # and that intent/result rows pair up via call_id.
    local out
    out=$(psy_cli query --actor ctx-actor --json)
    [ -n "$out" ] || { echo "no rows for ctx-actor"; return 1; }
    # Letta wrap audits: 4 global + 2 agent = 6 audited ops × 2 phases = 12 rows.
    # attach/detach/list are passthrough.
    local count
    count=$(echo "$out" | jq 'length')
    [ "$count" -eq 12 ] || { echo "expected 12 audit rows, got $count"; return 1; }

    # Assert exact (operation,phase) sequence.
    local seq
    seq=$(echo "$out" | jq -r '[ .[] | "\(.operation):\(.audit_phase)" ] | join(",")')
    local expected="create:intent,create:result,view:intent,view:result,str_replace:intent,str_replace:result,delete:intent,delete:result,view:intent,view:result,str_replace:intent,str_replace:result"
    [ "$seq" = "$expected" ] || { echo "operation/phase sequence mismatch"; echo "  expected: $expected"; echo "  actual:   $seq"; return 1; }

    # Identity propagated from runWithContext to every row.
    local actors tenants
    actors=$(echo "$out" | jq -r '[ .[].actor_id ] | unique | join(",")')
    tenants=$(echo "$out" | jq -r '[ .[].tenant_id ] | unique | join(",")')
    [ "$actors" = "ctx-actor" ] || { echo "actor mismatch: $actors"; return 1; }
    [ "$tenants" = "demo" ] || { echo "tenant mismatch: $tenants"; return 1; }

    # Every intent has a paired result with the same operation_id.
    local unpaired
    unpaired=$(echo "$out" | jq '[ group_by(.operation_id)[] | select(length != 2) ] | length')
    [ "$unpaired" -eq 0 ] || { echo "$unpaired call_ids without intent+result pair"; return 1; }

    # Path schemes correct on both surfaces.
    local global_paths agent_paths
    global_paths=$(echo "$out" | jq -r '[ .[] | select(.memory_path | startswith("letta://blocks/")) ] | length')
    agent_paths=$(echo "$out"  | jq -r '[ .[] | select(.memory_path | startswith("letta://agents/")) ] | length')
    [ "$global_paths" -eq 8 ] || { echo "expected 8 global-block paths, got $global_paths"; return 1; }
    [ "$agent_paths" -eq 4 ]  || { echo "expected 4 agent-block paths, got $agent_paths"; return 1; }
  }

  letta_real_sdk_shape() {
    cd "$WORKSPACE/local-sdk"
    npm install --silent --no-fund --no-audit --legacy-peer-deps '@letta-ai/letta-client@>=1.10 <2' >/dev/null 2>&1 || {
      echo "could not install @letta-ai/letta-client (network?)"; return 1
    }
    node --input-type=module -e "
import { Letta } from '@letta-ai/letta-client';
const c = new Letta({ token: 'fake' });
for (const m of ['create','retrieve','update','delete']) {
  if (typeof c.blocks[m] !== 'function') { console.error('client.blocks missing:', m); process.exit(1); }
}
for (const m of ['retrieve','update','attach']) {
  if (typeof c.agents.blocks[m] !== 'function') { console.error('client.agents.blocks missing:', m); process.exit(1); }
}
"
  }

  step "Run wrapped Letta stubs (full method coverage)" letta_full_run
  step "Audit rows: exact sequence, identity, pairing, schemes" letta_audit_assertions
  step "Real @letta-ai/letta-client class shape matches" letta_real_sdk_shape
fi

# ───────────────────────────────────────────────────────────────────
# Tier 2C — Mastra (full coverage of all 4 primitives)
# ───────────────────────────────────────────────────────────────────

if tier_enabled 2 || tier_enabled 2c; then
  header "Tier 2C — Mastra (all 4 primitives, every audited method)"

  mastra_full_run() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    cat > _bench-mastra.mjs <<'EOF'
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/mastra';

let calls = {};
const tally = (k) => () => { calls[k] = (calls[k] ?? 0) + 1; };

const stub = {
  async getWorkingMemory({ threadId })           { tally('getWorkingMemory')();    return `wm:${threadId}`; },
  async updateWorkingMemory()                    { tally('updateWorkingMemory')(); },
  async createThread(p)                          { tally('createThread')();        return { id: p.threadId ?? 't1', resourceId: p.resourceId, title: p.title }; },
  async updateThread(p)                          { tally('updateThread')();        return { id: p.id, title: p.title }; },
  async deleteThread()                           { tally('deleteThread')(); },
  async getThreadById(p)                         { tally('getThreadById')();       return { id: p.threadId }; },
  async saveMessages(p)                          { tally('saveMessages')();        return { messages: p.messages }; },
  async updateMessages(p)                        { tally('updateMessages')();      return p.messages; },
  async deleteMessages()                         { tally('deleteMessages')(); },
  async recall()                                 { tally('recall')();              return { messages: [] }; },
  async searchMessages()                         { tally('searchMessages')();      return { results: [] }; },
  async indexObservation()                       { tally('indexObservation')(); },
  async unwrapped()                              { tally('unwrapped')();           return 'passthrough-ok'; },
};

// Identity comes from runWithContext only — proves ALS propagation.
const memory = wrap(stub, {});

await runWithContext({ actorId: 'ctx-actor', tenantId: 'demo' }, async () => {
  // working memory
  await memory.getWorkingMemory({ threadId: 't1', resourceId: 'res_1' });
  await memory.updateWorkingMemory({ threadId: 't1', resourceId: 'res_1', workingMemory: 'state' });

  // threads
  const th = await memory.createThread({ resourceId: 'res_1', threadId: 't1', title: 'hello' });
  if (th.id !== 't1') throw new Error('createThread return mismatch');
  await memory.updateThread({ id: 't1', title: 'updated' });
  await memory.getThreadById({ threadId: 't1' });

  // messages
  await memory.saveMessages({ messages: [{ id: 'm1', threadId: 't1', role: 'user', content: 'hi' }] });
  await memory.updateMessages({ messages: [{ id: 'm1', threadId: 't1', role: 'user', content: 'hi v2' }] });
  await memory.recall({ threadId: 't1', resourceId: 'res_1' });

  // semantic recall (queries hashed in path per codex [P2])
  await memory.searchMessages({ query: 'sensitive ssn 123-45-6789', resourceId: 'res_1' });
  await memory.indexObservation({ text: 'observed', groupId: 'g1', range: {}, threadId: 't1', resourceId: 'res_1' });

  await memory.deleteMessages([{ id: 'm1' }]);
  await memory.deleteThread('t1');

  // pass-through method that the wrap should NOT audit but should still call.
  const r = await memory.unwrapped();
  if (r !== 'passthrough-ok') throw new Error('passthrough lost return value');
});

const expected = {
  getWorkingMemory: 1, updateWorkingMemory: 1,
  createThread: 1, updateThread: 1, getThreadById: 1, deleteThread: 1,
  saveMessages: 1, updateMessages: 1, deleteMessages: 1, recall: 1,
  searchMessages: 1, indexObservation: 1,
  unwrapped: 1,
};
for (const [k, v] of Object.entries(expected)) {
  if (calls[k] !== v) { console.error(`call count for ${k}: expected ${v}, got ${calls[k] ?? 0}`); process.exit(1); }
}
EOF
    node _bench-mastra.mjs
    rm _bench-mastra.mjs
  }

  mastra_audit_assertions() {
    cd "$WORKSPACE/local-sdk"
    local out
    out=$(psy_cli query --actor ctx-actor --json)
    # 12 audited ops × 2 phases = 24 rows.
    # (unwrapped is pass-through and not audited.)
    local count
    count=$(echo "$out" | jq 'length')
    [ "$count" -eq 24 ] || { echo "expected 24 audit rows, got $count"; return 1; }

    # Path schemes from all 4 primitives must be present.
    local schemes
    schemes=$(echo "$out" | jq -r '[ .[].memory_path | scan("^mastra://[^/]+") ] | unique | sort | join(",")')
    for required in "mastra://working-memory" "mastra://threads" "mastra://messages" "mastra://semantic-recall" "mastra://observational-memory"; do
      echo "$schemes" | grep -q "$required" || { echo "missing scheme $required (saw: $schemes)"; return 1; }
    done

    # codex [P2]: search query must be hashed (no raw text in any memory_path).
    local pii_leak
    pii_leak=$(echo "$out" | jq -r '.[].memory_path' | grep -E 'ssn|123-45|sensitive' || true)
    [ -z "$pii_leak" ] || { echo "PII leak in path: $pii_leak"; return 1; }
    local hashed
    hashed=$(echo "$out" | jq -r '[ .[].memory_path | select(startswith("mastra://semantic-recall/res_1/")) ] | first')
    echo "$hashed" | grep -qE 'mastra://semantic-recall/res_1/[0-9a-f]{16}$' || { echo "expected hashed semantic-recall path, got $hashed"; return 1; }

    # All rows under same actor/tenant.
    local actors
    actors=$(echo "$out" | jq -r '[ .[].actor_id ] | unique | join(",")')
    [ "$actors" = "ctx-actor" ] || { echo "actor mismatch: $actors"; return 1; }

    # Every intent paired with a result.
    local unpaired
    unpaired=$(echo "$out" | jq '[ group_by(.operation_id)[] | select(length != 2) ] | length')
    [ "$unpaired" -eq 0 ] || { echo "$unpaired unpaired call_ids"; return 1; }
  }

  mastra_indexobservation_defensive() {
    cd "$WORKSPACE/local-sdk"
    node_run "
import { wrap } from 'psy-core/mastra';
const mem = wrap({
  getWorkingMemory: async () => null, updateWorkingMemory: async () => {},
  createThread: async () => ({}), updateThread: async () => ({}), deleteThread: async () => {}, getThreadById: async () => null,
  saveMessages: async () => ({ messages: [] }), updateMessages: async () => [], deleteMessages: async () => {},
  recall: async () => ({}), searchMessages: async () => ({}),
  // No indexObservation on this stub.
}, { actorId: 't' });
try {
  await mem.indexObservation({ text: 'x', groupId: 'g', range: {}, threadId: 't', resourceId: 'r' });
  console.error('FAIL: expected throw');
  process.exit(1);
} catch (e) {
  if (!/indexObservation is not available/.test(e.message)) { console.error('wrong error:', e.message); process.exit(1); }
}
"
  }

  mastra_real_sdk_shape() {
    cd "$WORKSPACE/local-sdk"
    npm install --silent --no-fund --no-audit --legacy-peer-deps '@mastra/core@>=1.28 <2' '@mastra/memory@>=1.17 <2' >/dev/null 2>&1 || {
      echo "could not install @mastra/core + @mastra/memory (network?)"; return 1
    }
    node --input-type=module -e "
import { Memory } from '@mastra/memory';
const proto = Memory.prototype;
for (const m of ['getWorkingMemory','updateWorkingMemory','createThread','updateThread','deleteThread','getThreadById','saveMessages','updateMessages','deleteMessages','recall','searchMessages']) {
  if (typeof proto[m] !== 'function') { console.error('Memory.prototype missing:', m); process.exit(1); }
}
"
  }

  step "Run wrapped Mastra (4 primitives × every audited method)" mastra_full_run
  step "Audit rows: count, all 4 primitive schemes, query hashed, identity" mastra_audit_assertions
  step "indexObservation on a backend without it throws helpfully" mastra_indexobservation_defensive
  step "Real @mastra/memory Memory class shape matches" mastra_real_sdk_shape
fi

# ───────────────────────────────────────────────────────────────────
# Tier 2D — All 3 adapters in one process (collision check)
# ───────────────────────────────────────────────────────────────────

if tier_enabled 2 || tier_enabled 2d; then
  header "Tier 2D — All 6 adapters in one process"

  combined_demo() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    cat > _bench-combined.mjs <<'EOF'
import { listProviders, runWithContext } from 'psy-core';
import { wrap as wrapAnthropic } from 'psy-core/anthropic-memory';
import { wrap as wrapLetta } from 'psy-core/letta';
import { wrap as wrapMastra } from 'psy-core/mastra';
import { wrap as wrapMem0 } from 'psy-core/mem0';
import { wrap as wrapLangChain } from 'psy-core/langchain';
import { wrap as wrapLangGraph } from 'psy-core/langgraph';

if (listProviders().length !== 6) throw new Error('expected 6 providers, got ' + listProviders().length);

const a = wrapAnthropic({
  view: async () => 'view',
  create: async () => 'create',
  str_replace: async () => 'replace',
  insert: async () => 'insert',
  delete: async () => 'delete',
  rename: async () => 'rename',
}, { actorId: 'multi' });

const l = wrapLetta({
  create: async (b) => ({ id: 'blk_x', label: b.label, value: b.value }),
  retrieve: async (id) => ({ id, label: 'h', value: 'x' }),
  update: async (id, b) => ({ id, label: 'h', value: b.value }),
  delete: async () => ({ ok: true }),
}, { actorId: 'multi' });

const m = wrapMastra({
  getWorkingMemory: async () => 'wm', updateWorkingMemory: async () => {},
  createThread: async (p) => ({ id: 't1', resourceId: p.resourceId }),
  updateThread: async (p) => ({ id: p.id }), deleteThread: async () => {},
  getThreadById: async (p) => ({ id: p.threadId }),
  saveMessages: async (p) => ({ messages: p.messages }),
  updateMessages: async (p) => p.messages, deleteMessages: async () => {},
  recall: async () => ({ messages: [] }), searchMessages: async () => ({ results: [] }),
}, { actorId: 'multi' });

const m0 = wrapMem0({
  add: async () => [{ id: 'm_x' }], search: async () => ({ results: [] }),
  get: async () => ({ id: 'm_x' }), getAll: async () => ({ results: [] }),
  update: async () => [{ id: 'm_x' }], delete: async () => ({}), history: async () => [],
}, { actorId: 'multi' });

const lc = wrapLangChain({
  getMessages: async () => [], addMessage: async () => {}, addMessages: async () => {},
  addUserMessage: async () => {}, addAIMessage: async () => {}, clear: async () => {},
}, { actorId: 'multi', sessionId: 'multi-session' });

const lg = wrapLangGraph({
  getTuple: async () => undefined,
  list: async function* () { /* empty */ },
  put: async (c) => c, putWrites: async () => {}, deleteThread: async () => {},
}, { actorId: 'multi' });

await runWithContext({ actorId: 'multi' }, async () => {
  await a.create({ command: 'create', path: '/memories/a.md', file_text: 'x' });
  await l.create({ label: 'human', value: 'y' });
  await m.updateWorkingMemory({ threadId: 't1', workingMemory: 'z' });
  await m0.add([{ role: 'user', content: 'q' }], { userId: 'u' });
  await lc.addMessage({ content: 'w' });
  await lg.put({ configurable: { thread_id: 't1', checkpoint_id: 'cp_1' } }, { id: 'cp_1' }, { source: 'loop' }, {});
});
EOF
    node _bench-combined.mjs
    rm _bench-combined.mjs
  }

  combined_chain_check() {
    cd "$WORKSPACE/local-sdk"
    psy_cli verify --all
    local out
    out=$(psy_cli query --actor multi --json)
    local count
    count=$(echo "$out" | jq 'length')
    [ "$count" -eq 12 ] || { echo "expected 12 rows (6 ops × 2 phases), got $count"; return 1; }
    # All six different schemes must appear.
    local paths
    paths=$(echo "$out" | jq -r '.[].memory_path' | sort -u)
    for required in '/memories/' 'letta://' 'mastra://' 'mem0://' 'langchain://' 'langgraph://'; do
      echo "$paths" | grep -q "$required" || { echo "missing scheme $required (saw: $paths)"; return 1; }
    done
  }

  step "Run all 6 adapters in one process" combined_demo
  step "Chain verifies, all 6 schemes present (no collisions)" combined_chain_check
fi

# ───────────────────────────────────────────────────────────────────
# Tier 2E — Root v0.1 compatibility (codex [P2] back-compat)
# ───────────────────────────────────────────────────────────────────

if tier_enabled 2 || tier_enabled 2e; then
  header "Tier 2E — Root v0.1 back-compat shim"

  # Phase B / codex [P2] restored MEMORY_ROOT, validateMemoryPath,
  # validateMemoryCommandPaths, and the legacy `wrap` at the bare psy-core
  # entry. This tier guards against a future commit silently re-removing them.

  root_path_guard_exports() {
    node_run "
import { MEMORY_ROOT, validateMemoryPath, validateMemoryCommandPaths } from 'psy-core';
if (typeof MEMORY_ROOT !== 'string') { console.error('MEMORY_ROOT not exported as string'); process.exit(1); }
if (typeof validateMemoryPath !== 'function') { console.error('validateMemoryPath not exported'); process.exit(1); }
if (typeof validateMemoryCommandPaths !== 'function') { console.error('validateMemoryCommandPaths not exported'); process.exit(1); }
const ok = validateMemoryPath('/memories/foo.md', 'view');
if (ok !== '/memories/foo.md') { console.error('validateMemoryPath round-trip wrong:', ok); process.exit(1); }
"
  }

  root_legacy_wrap() {
    node_run "
import { wrap } from 'psy-core';
if (typeof wrap !== 'function') { console.error('legacy root wrap missing'); process.exit(1); }
const handlers = {
  view: async () => 'v', create: async () => 'c', str_replace: async () => 'r',
  insert: async () => 'i', delete: async () => 'd', rename: async () => 'n',
};
const wrapped = wrap(handlers, { actorId: 'legacy', databasePath: '/tmp/psy-bench-no-such-db.sqlite' });
if (typeof wrapped.view !== 'function') { console.error('wrapped.view not function'); process.exit(1); }
"
  }

  step "Root re-exports MEMORY_ROOT/validateMemoryPath/validateMemoryCommandPaths" root_path_guard_exports
  step "Legacy wrap from psy-core still resolves and returns shape" root_legacy_wrap
fi

# ───────────────────────────────────────────────────────────────────
# Tier 2F — Mem0 (full coverage + real-SDK class shape)
# ───────────────────────────────────────────────────────────────────

if tier_enabled 2 || tier_enabled 2f; then
  header "Tier 2F — Mem0 (full coverage)"

  mem0_full_run() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    cat > _bench-mem0.mjs <<'EOF'
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/mem0';

let calls = {};
const tally = (k) => () => { calls[k] = (calls[k] ?? 0) + 1; };

const stub = {
  async add(_msgs, _opts)    { tally('add')();     return [{ id: 'm_new', event: 'ADD' }]; },
  async search(_q, _opts)    { tally('search')();  return { results: [{ id: 'm1' }] }; },
  async get(id)              { tally('get')();     return { id }; },
  async getAll(_opts)        { tally('getAll')();  return { results: [] }; },
  async update(id, _body)    { tally('update')();  return [{ id }]; },
  async delete(_id)          { tally('delete')();  return { message: 'ok' }; },
  async history(_id)         { tally('history')(); return []; },
  async ping()               { tally('ping')();    return { ok: true }; },
};
const audited = wrap(stub, {});

await runWithContext({ actorId: 'ctx-actor', tenantId: 'demo' }, async () => {
  await audited.add([{ role: 'user', content: 'x' }], { userId: 'u1' });
  await audited.search('q', { userId: 'u1' });
  await audited.get('m_42');
  await audited.getAll({ userId: 'u1' });
  await audited.update('m_42', { text: 'updated' });
  await audited.history('m_42');
  await audited.delete('m_42');
  await audited.ping();   // unwrapped passthrough
});

const expected = { add: 1, search: 1, get: 1, getAll: 1, update: 1, delete: 1, history: 1, ping: 1 };
for (const [k, v] of Object.entries(expected)) {
  if (calls[k] !== v) { console.error(`call count for ${k}: expected ${v}, got ${calls[k] ?? 0}`); process.exit(1); }
}
EOF
    node _bench-mem0.mjs
    rm _bench-mem0.mjs
  }

  mem0_audit_assertions() {
    cd "$WORKSPACE/local-sdk"
    local out
    out=$(psy_cli query --actor ctx-actor --json)
    local count
    count=$(echo "$out" | jq 'length')
    # 7 audited ops × 2 phases = 14 (ping passes through unaudited).
    [ "$count" -eq 14 ] || { echo "expected 14 audit rows, got $count"; return 1; }
    local seq
    seq=$(echo "$out" | jq -r '[ .[] | "\(.operation):\(.audit_phase)" ] | join(",")')
    local expected="create:intent,create:result,view:intent,view:result,view:intent,view:result,view:intent,view:result,str_replace:intent,str_replace:result,view:intent,view:result,delete:intent,delete:result"
    [ "$seq" = "$expected" ] || { echo "operation/phase sequence mismatch"; echo "  expected: $expected"; echo "  actual:   $seq"; return 1; }
    # Per-op path schemes.
    echo "$out" | jq -r '.[].memory_path' | grep -q '^mem0://users/u1/pending$' || { echo "missing add path"; return 1; }
    echo "$out" | jq -r '.[].memory_path' | grep -q '^mem0://memories/m_42$' || { echo "missing memories path"; return 1; }
    # Identity from runWithContext.
    local actors
    actors=$(echo "$out" | jq -r '[ .[].actor_id ] | unique | join(",")')
    [ "$actors" = "ctx-actor" ] || { echo "actor mismatch: $actors"; return 1; }
  }

  mem0_real_sdk_shape() {
    cd "$WORKSPACE/local-sdk"
    # mem0ai@3.0.2 declares @anthropic-ai/sdk@^0.40.1 as a peer (too narrow);
    # our v0.3 stack uses @anthropic-ai/sdk >=0.91. --legacy-peer-deps accepts
    # the version mismatch — both SDKs are unrelated at the call sites we
    # touch in the bench (mem0 uses anthropic for its own internal
    # extraction; we never invoke that path here).
    npm install --silent --no-fund --no-audit --legacy-peer-deps 'mem0ai@>=3 <4' >/dev/null 2>&1 || {
      echo "could not install mem0ai (network?)"; return 1
    }
    node --input-type=module -e "
import MemoryClient from 'mem0ai';
// Don't instantiate (cloud requires apiKey + makes a ping call). Check
// the class prototype carries every method our wrap intercepts.
const proto = MemoryClient.prototype;
for (const m of ['add','search','get','getAll','update','delete','history']) {
  if (typeof proto[m] !== 'function') { console.error('mem0ai MemoryClient missing:', m); process.exit(1); }
}
"
  }

  step "Run wrapped mem0 stubs (every audited method + passthrough)" mem0_full_run
  step "Audit rows: count, operation sequence, paths, identity" mem0_audit_assertions
  step "Real mem0ai class shape matches structural type" mem0_real_sdk_shape
fi

# ───────────────────────────────────────────────────────────────────
# Tier 2G — LangChain (BaseChatMessageHistory, full coverage + real-SDK)
# ───────────────────────────────────────────────────────────────────

if tier_enabled 2 || tier_enabled 2g; then
  header "Tier 2G — LangChain chat-history"

  langchain_full_run() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    cat > _bench-langchain.mjs <<'EOF'
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/langchain';

let calls = {};
const tally = (k) => () => { calls[k] = (calls[k] ?? 0) + 1; };
const messages = [];

const stub = {
  async getMessages()    { tally('getMessages')();    return [...messages]; },
  async addMessage(m)    { tally('addMessage')();     messages.push(m); },
  async addMessages(ms)  { tally('addMessages')();    messages.push(...ms); },
  async addUserMessage(s){ tally('addUserMessage')(); messages.push({ type: 'human', content: s }); },
  async addAIMessage(s)  { tally('addAIMessage')();   messages.push({ type: 'ai', content: s }); },
  async clear()          { tally('clear')();          messages.length = 0; },
  async unwrapped()      { tally('unwrapped')();      return 'pass'; },
};
const audited = wrap(stub, { actorId: 'ctx-actor', sessionId: 'sess_demo' });

await runWithContext({ actorId: 'ctx-actor', tenantId: 'demo' }, async () => {
  await audited.getMessages();
  await audited.addMessage({ type: 'human', content: 'hi' });
  await audited.addMessages([{ type: 'human', content: 'a' }, { type: 'ai', content: 'b' }]);
  await audited.addUserMessage('hello');
  await audited.addAIMessage('hi back');
  await audited.clear();
  await audited.unwrapped();   // passthrough
});

const expected = { getMessages: 1, addMessage: 1, addMessages: 1, addUserMessage: 1, addAIMessage: 1, clear: 1, unwrapped: 1 };
for (const [k, v] of Object.entries(expected)) {
  if (calls[k] !== v) { console.error(`call count for ${k}: expected ${v}, got ${calls[k] ?? 0}`); process.exit(1); }
}
EOF
    node _bench-langchain.mjs
    rm _bench-langchain.mjs
  }

  langchain_audit_assertions() {
    cd "$WORKSPACE/local-sdk"
    local out
    out=$(psy_cli query --actor ctx-actor --json)
    local count
    count=$(echo "$out" | jq 'length')
    # 6 audited ops × 2 phases = 12 (unwrapped passes through).
    [ "$count" -eq 12 ] || { echo "expected 12 audit rows, got $count"; return 1; }
    local seq
    seq=$(echo "$out" | jq -r '[ .[] | "\(.operation):\(.audit_phase)" ] | join(",")')
    local expected="view:intent,view:result,insert:intent,insert:result,insert:intent,insert:result,insert:intent,insert:result,insert:intent,insert:result,delete:intent,delete:result"
    [ "$seq" = "$expected" ] || { echo "operation/phase sequence mismatch"; echo "  expected: $expected"; echo "  actual:   $seq"; return 1; }
    # Path scheme uses sessions/sess_demo throughout.
    local nonscoped
    nonscoped=$(echo "$out" | jq -r '[ .[] | select(.memory_path | startswith("langchain://sessions/sess_demo") | not) ] | length')
    [ "$nonscoped" -eq 0 ] || { echo "$nonscoped rows escape sess_demo path scope"; return 1; }
  }

  langchain_real_sdk_shape() {
    cd "$WORKSPACE/local-sdk"
    npm install --silent --no-fund --no-audit --legacy-peer-deps '@langchain/core@>=1 <2' >/dev/null 2>&1 || {
      echo "could not install @langchain/core (network?)"; return 1
    }
    node --input-type=module -e "
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';
const h = new InMemoryChatMessageHistory();
for (const m of ['getMessages','addMessage','addMessages','addUserMessage','addAIMessage','clear']) {
  if (typeof h[m] !== 'function') { console.error('@langchain/core ChatMessageHistory missing:', m); process.exit(1); }
}
"
  }

  langchain_real_sdk_integration() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    cat > _bench-langchain-real.mjs <<'EOF'
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/langchain';

// Wrap a REAL LangChain history instance — not a duck-typed stub.
const history = new InMemoryChatMessageHistory();
const audited = wrap(history, { actorId: 'real-test', sessionId: 'sess_real' });

await runWithContext({ actorId: 'real-test' }, async () => {
  await audited.addUserMessage('Hello.');
  await audited.addAIMessage('Hi there.');
  await audited.addMessage(new HumanMessage('How are you?'));
  await audited.addMessages([new AIMessage('Doing well.'), new HumanMessage('Great.')]);
  const msgs = await audited.getMessages();
  if (msgs.length !== 5) throw new Error(`expected 5 messages, got ${msgs.length}`);
  if (msgs[0].content !== 'Hello.') throw new Error('first message content lost');
  await audited.clear();
  const after = await audited.getMessages();
  if (after.length !== 0) throw new Error(`clear failed: ${after.length} remain`);
});
EOF
    node _bench-langchain-real.mjs
    rm _bench-langchain-real.mjs

    # 7 audited ops × 2 phases = 14 audit rows
    # (addUserMessage, addAIMessage, addMessage, addMessages, getMessages,
    #  clear, getMessages-after-clear).
    local count
    count=$(psy_cli query --actor real-test --json | jq 'length')
    [ "$count" -eq 14 ] || { echo "expected 14 audit rows, got $count"; return 1; }
    # Real instance writes still go through the wrap and produce the
    # documented path scheme.
    psy_cli query --actor real-test --json | jq -r '.[].memory_path' | grep -qE '^langchain://sessions/sess_real/messages' || {
      echo "audit rows missing langchain:// path scheme"
      return 1
    }
  }

  step "Run wrapped LangChain history (full method coverage)" langchain_full_run
  step "Audit rows: count, sequence, all paths under sess_demo" langchain_audit_assertions
  step "Real @langchain/core InMemoryChatMessageHistory shape matches" langchain_real_sdk_shape
  step "Real InMemoryChatMessageHistory wrap end-to-end (audits actual instance)" langchain_real_sdk_integration
fi

# ───────────────────────────────────────────────────────────────────
# Tier 2H — LangGraph (BaseCheckpointSaver, full coverage + real-SDK)
# ───────────────────────────────────────────────────────────────────

if tier_enabled 2 || tier_enabled 2h; then
  header "Tier 2H — LangGraph checkpointer"

  langgraph_full_run() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    cat > _bench-langgraph.mjs <<'EOF'
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/langgraph';

let calls = {};
const tally = (k) => () => { calls[k] = (calls[k] ?? 0) + 1; };

const baseConfig = { configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: 'cp_1' } };

const stub = {
  async getTuple(c)      { tally('getTuple')();   return { config: c, checkpoint: { id: c.configurable.checkpoint_id } }; },
  async *list(_c, _o)    { tally('list')();       yield { config: baseConfig, checkpoint: { id: 'cp_1' } }; yield { config: baseConfig, checkpoint: { id: 'cp_2' } }; },
  async put(c)           { tally('put')();        return c; },
  async putWrites()      { tally('putWrites')(); },
  async deleteThread()   { tally('deleteThread')(); },
  async unwrapped()      { tally('unwrapped')();  return 'pass'; },
};
const audited = wrap(stub, {});

await runWithContext({ actorId: 'ctx-actor', tenantId: 'demo' }, async () => {
  await audited.getTuple(baseConfig);
  for await (const _t of audited.list(baseConfig)) { /* drain */ }
  await audited.put(baseConfig, { id: 'cp_2' }, { source: 'loop' }, {});
  await audited.putWrites(baseConfig, [['ch', 'set', 'v']], 'task_1');
  await audited.deleteThread('t1');
  await audited.unwrapped();   // passthrough
});

const expected = { getTuple: 1, list: 1, put: 1, putWrites: 1, deleteThread: 1, unwrapped: 1 };
for (const [k, v] of Object.entries(expected)) {
  if (calls[k] !== v) { console.error(`call count for ${k}: expected ${v}, got ${calls[k] ?? 0}`); process.exit(1); }
}
EOF
    node _bench-langgraph.mjs
    rm _bench-langgraph.mjs
  }

  langgraph_audit_assertions() {
    cd "$WORKSPACE/local-sdk"
    local out
    out=$(psy_cli query --actor ctx-actor --json)
    local count
    count=$(echo "$out" | jq 'length')
    # 5 audited ops × 2 phases = 10 (unwrapped passthrough).
    [ "$count" -eq 10 ] || { echo "expected 10 audit rows, got $count"; return 1; }
    local seq
    seq=$(echo "$out" | jq -r '[ .[] | "\(.operation):\(.audit_phase)" ] | join(",")')
    local expected="view:intent,view:result,view:intent,view:result,create:intent,create:result,insert:intent,insert:result,delete:intent,delete:result"
    [ "$seq" = "$expected" ] || { echo "operation/phase sequence mismatch"; echo "  expected: $expected"; echo "  actual:   $seq"; return 1; }
    # All paths are langgraph://threads/t1/...
    local nonscoped
    nonscoped=$(echo "$out" | jq -r '[ .[] | select(.memory_path | startswith("langgraph://threads/t1") | not) ] | length')
    [ "$nonscoped" -eq 0 ] || { echo "$nonscoped rows escape thread t1 path scope"; return 1; }
    # putWrites path encodes taskId + count.
    echo "$out" | jq -r '.[].memory_path' | grep -q '/writes/task_1+1$' || { echo "missing putWrites path"; return 1; }
  }

  langgraph_real_sdk_shape() {
    cd "$WORKSPACE/local-sdk"
    npm install --silent --no-fund --no-audit --legacy-peer-deps '@langchain/langgraph-checkpoint@>=1 <2' >/dev/null 2>&1 || {
      echo "could not install @langchain/langgraph-checkpoint (network?)"; return 1
    }
    node --input-type=module -e "
import { MemorySaver } from '@langchain/langgraph-checkpoint';
const s = new MemorySaver();
for (const m of ['getTuple','list','put','putWrites','deleteThread']) {
  if (typeof s[m] !== 'function') { console.error('MemorySaver missing:', m); process.exit(1); }
}
"
  }

  langgraph_real_sdk_integration() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    cat > _bench-langgraph-real.mjs <<'EOF'
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/langgraph';

// Wrap a REAL LangGraph saver instance — not a duck-typed stub.
const saver = wrap(new MemorySaver(), {});

const config = { configurable: { thread_id: 't_real', checkpoint_ns: '' } };
const checkpoint = {
  v: 1,
  id: 'cp_real_1',
  ts: '2026-04-26T19:00:00.000Z',
  channel_values: { greeting: 'hi' },
  channel_versions: { greeting: 1 },
  versions_seen: {},
  pending_sends: [],
};

await runWithContext({ actorId: 'real-graph' }, async () => {
  // put → real MemorySaver writes the checkpoint to its in-memory store.
  await saver.put(config, checkpoint, { source: 'loop', step: 0 }, {});

  // getTuple → real MemorySaver returns the checkpoint we just wrote.
  const tuple = await saver.getTuple({
    configurable: { thread_id: 't_real', checkpoint_id: 'cp_real_1' },
  });
  if (!tuple || tuple.checkpoint.id !== 'cp_real_1') {
    throw new Error('getTuple did not return the put checkpoint');
  }

  // list → real MemorySaver yields the checkpoint via AsyncGenerator.
  let listedCount = 0;
  for await (const _t of saver.list(config)) {
    listedCount++;
  }
  if (listedCount !== 1) throw new Error(`list yielded ${listedCount}, expected 1`);

  // putWrites → partial append to the existing checkpoint.
  await saver.putWrites(
    { configurable: { thread_id: 't_real', checkpoint_id: 'cp_real_1', checkpoint_ns: '' } },
    [['greeting', 'set', 'hello']],
    'task_real_1',
  );

  // deleteThread → real MemorySaver removes everything for this thread.
  await saver.deleteThread('t_real');
});
EOF
    node _bench-langgraph-real.mjs
    rm _bench-langgraph-real.mjs

    # 5 audited ops × 2 phases = 10 audit rows.
    local count
    count=$(psy_cli query --actor real-graph --json | jq 'length')
    [ "$count" -eq 10 ] || { echo "expected 10 audit rows, got $count"; return 1; }
    # Path scheme uses langgraph://threads/t_real/_/...
    psy_cli query --actor real-graph --json | jq -r '.[].memory_path' | grep -qE '^langgraph://threads/t_real' || {
      echo "audit rows missing langgraph:// thread scope"
      return 1
    }
  }

  step "Run wrapped LangGraph saver (every audited method + AsyncGenerator list)" langgraph_full_run
  step "Audit rows: count, sequence, paths, putWrites encoding" langgraph_audit_assertions
  step "Real @langchain/langgraph-checkpoint MemorySaver shape matches" langgraph_real_sdk_shape
  step "Real MemorySaver wrap end-to-end (audits actual instance)" langgraph_real_sdk_integration
fi

# ───────────────────────────────────────────────────────────────────
# Tier 3A — Mid-chain tamper detection
# ───────────────────────────────────────────────────────────────────

if tier_enabled 3 || tier_enabled 3a; then
  header "Tier 3A — Mid-chain tamper"

  midchain_setup() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    cat > _bench-seed.mjs <<'EOF'
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/letta';
const blocks = wrap({
  create: async (b) => ({ id: `blk_${Date.now()}_${Math.random()}`, label: b.label, value: b.value }),
  retrieve: async () => ({ id: 'x', label: 'x', value: 'y' }),
  update: async (id, b) => ({ id, label: 'x', value: b.value }),
  delete: async () => ({ ok: true }),
}, { actorId: 'seed' });
await runWithContext({ actorId: 'seed' }, async () => {
  for (let i = 0; i < 5; i++) await blocks.create({ label: `b${i}`, value: 'v' });
});
EOF
    node _bench-seed.mjs
    rm _bench-seed.mjs
  }

  midchain_tamper() {
    cd "$WORKSPACE/local-sdk"
    sqlite3 .psy/events.sqlite "UPDATE events SET memory_path='/memories/HACKED.md' WHERE seq=3"
    # Capture verify output. Must fail AND specifically flag a hash chain issue.
    local out rc
    out=$(psy_cli verify --all 2>&1) && rc=0 || rc=$?
    [ "$rc" -ne 0 ] || { echo "verify should have failed but exited 0"; echo "$out"; return 1; }
    # Look for any of the recognized chain-break codes in the issue list.
    echo "$out" | grep -qE '\b(event_hash_mismatch|prev_hash_mismatch|chain_break|seal_hash_mismatch)\b' || {
      echo "verify failed, but did not surface a chain-break issue code:"
      echo "$out"
      return 1
    }
  }

  step "Seed chain with 5 ops" midchain_setup
  step "UPDATE seq=3 → verify exits non-zero with chain-break issue code" midchain_tamper
fi

# ───────────────────────────────────────────────────────────────────
# Tier 3B — Sealed-head: tail truncation with meta also rewritten
# ───────────────────────────────────────────────────────────────────

if tier_enabled 3 || tier_enabled 3b; then
  header "Tier 3B — Sealed-head detects truncation when meta is also rewritten"

  # Codex [P1] noted: deleting the tail row alone is caught by chain-only
  # verification (meta still points at the deleted row). That's NOT testing
  # the v0.2 sealed head. To exercise the seal, we also rewrite the meta
  # cache so chain-only verify would think the truncated tail is valid.
  # Only the signed head pointer should detect the gap.

  sealed_head_truncation() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    cat > _bench-seed2.mjs <<'EOF'
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/letta';
const blocks = wrap({
  create: async (b) => ({ id: `blk_${Date.now()}_${Math.random()}`, label: b.label, value: b.value }),
  retrieve: async () => ({ id: 'x', label: 'x', value: 'y' }),
  update: async (id, b) => ({ id, label: 'x', value: b.value }),
  delete: async () => ({ ok: true }),
}, { actorId: 'truncate' });
await runWithContext({ actorId: 'truncate' }, async () => {
  for (let i = 0; i < 4; i++) await blocks.create({ label: `b${i}`, value: 'v' });
});
EOF
    node _bench-seed2.mjs
    rm _bench-seed2.mjs

    # Truncate the LAST PAIR (intent+result) so the new tail is still a paired
    # result row — otherwise chain-only verify would catch an orphaned_intent
    # and we wouldn't be exercising the sealed head specifically.
    local new_tail_seq new_tail_hash
    new_tail_seq=$(sqlite3 .psy/events.sqlite "SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET 2")
    new_tail_hash=$(sqlite3 .psy/events.sqlite "SELECT event_hash FROM events ORDER BY seq DESC LIMIT 1 OFFSET 2")
    [ -n "$new_tail_seq" ] || { echo "could not read new tail seq"; return 1; }

    # Truncate the last 2 rows (one full intent/result pair).
    sqlite3 .psy/events.sqlite "DELETE FROM events WHERE seq IN (SELECT seq FROM events ORDER BY seq DESC LIMIT 2)"
    # Also rewrite the meta cache so chain-only verify thinks all is well.
    sqlite3 .psy/events.sqlite "UPDATE meta SET value='$new_tail_seq' WHERE key='last_seq'"
    sqlite3 .psy/events.sqlite "UPDATE meta SET value='$new_tail_hash' WHERE key='chain_head_hash'"

    # Chain-only verify (--no-seal) should now PASS — that's the point.
    psy_cli verify --no-seal >/dev/null 2>&1 || { echo "chain-only verify unexpectedly failed (test is invalid)"; return 1; }

    # Full verify (with seal) MUST fail and surface a seal_*_mismatch.
    local out rc
    out=$(psy_cli verify --all 2>&1) && rc=0 || rc=$?
    [ "$rc" -ne 0 ] || { echo "sealed verify should have failed; meta rewrite hid chain issue"; echo "$out"; return 1; }
    echo "$out" | grep -qE '\b(seal_seq_mismatch|seal_hash_mismatch|seal_hmac_invalid)\b' || {
      echo "expected seal_*_mismatch issue code in:"
      echo "$out"
      return 1
    }
  }

  step "Truncate tail + rewrite meta → only sealed head detects it" sealed_head_truncation
fi

# ───────────────────────────────────────────────────────────────────
# Tier 3C — Seal-key removal (downgrade attack)
# ───────────────────────────────────────────────────────────────────

if tier_enabled 3 || tier_enabled 3c; then
  header "Tier 3C — Downgrade attack: seal-key removal under seal=required"

  downgrade_test() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    grep -q '"seal": *"required"' .psy.json || { echo "fresh init must mark seal: required"; return 1; }
    mv .psy/seal-key .psy/seal-key.bak
    local out rc
    out=$(psy_cli verify --all 2>&1) && rc=0 || rc=$?
    mv .psy/seal-key.bak .psy/seal-key
    [ "$rc" -ne 0 ] || { echo "verify should reject seal-key removal under seal=required"; echo "$out"; return 1; }
    echo "$out" | grep -qE '\bseal_missing_required\b' || {
      echo "expected seal_missing_required issue code:"
      echo "$out"
      return 1
    }
  }

  step "Verify rejects with seal_missing_required when key is gone" downgrade_test
fi

# ───────────────────────────────────────────────────────────────────
# Tier 3D — Concurrent writers (race + chain integrity)
# ───────────────────────────────────────────────────────────────────

if tier_enabled 3 || tier_enabled 3d; then
  header "Tier 3D — Sequential pass + concurrent never-silently-corrupt"

  sequential_test() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    cat > _bench-sequential.mjs <<'EOF'
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/letta';
const blocks = wrap({
  create: async (b) => ({ id: `blk_${Date.now()}_${Math.random()}`, label: b.label, value: b.value }),
  retrieve: async () => ({ id: 'x', label: 'x', value: 'y' }),
  update: async (id, b) => ({ id, label: 'x', value: b.value }),
  delete: async () => ({ ok: true }),
}, { actorId: 'serial' });
await runWithContext({ actorId: 'serial' }, async () => {
  for (let i = 0; i < 50; i++) await blocks.create({ label: `b${i}`, value: 'v' });
});
EOF
    node _bench-sequential.mjs
    rm _bench-sequential.mjs

    local count maxseq
    count=$(sqlite3 .psy/events.sqlite "SELECT COUNT(*) FROM events")
    [ "$count" -eq 100 ] || { echo "expected 100 rows, got $count"; return 1; }
    maxseq=$(sqlite3 .psy/events.sqlite "SELECT MAX(seq) FROM events")
    [ "$maxseq" -eq 100 ] || { echo "expected max seq=100, got $maxseq"; return 1; }
    psy_cli verify --all
  }

  concurrent_chain_safety() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    cat > _bench-concurrent.mjs <<'EOF'
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/letta';
const blocks = wrap({
  create: async (b) => ({ id: `blk_${process.pid}_${Date.now()}`, label: b.label, value: b.value }),
  retrieve: async () => ({ id: 'x', label: 'x', value: 'y' }),
  update: async (id, b) => ({ id, label: 'x', value: b.value }),
  delete: async () => ({ ok: true }),
}, { actorId: `worker_${process.pid}` });
try {
  await runWithContext({ actorId: `worker_${process.pid}` }, async () => {
    for (let i = 0; i < 20; i++) await blocks.create({ label: `b${i}`, value: 'v' });
  });
} catch (e) {
  if (e.code === 'E_CHAIN_BROKEN') process.exit(42);
  throw e;
}
EOF
    node _bench-concurrent.mjs &
    local pid1=$!
    node _bench-concurrent.mjs &
    local pid2=$!
    # The `|| rc=$?` form suppresses set -e on workers that exit non-zero
    # (rc=42 is the documented PsyChainBroken signal we expect under race).
    local rc1=0 rc2=0
    wait $pid1 || rc1=$?
    wait $pid2 || rc2=$?
    rm _bench-concurrent.mjs

    # Each worker either fully succeeds (rc 0) or signals PsyChainBroken (rc 42).
    # Anything else is silent corruption and a real failure.
    for rc in $rc1 $rc2; do
      if [ "$rc" -ne 0 ] && [ "$rc" -ne 42 ]; then
        echo "worker unexpected exit rc=$rc"
        return 1
      fi
    done

    # The DB must NEVER show cryptographic corruption regardless of race.
    # Allowed under-race issues: orphaned_intent (the worker that hit
    # PsyChainBroken left an unpaired intent before throwing).
    # Disallowed: hash_mismatch, prev_hash_mismatch, chain_break, seq_gap,
    #             meta_*, seal_*. These would mean v0.2 actually broke.
    local out
    out=$(psy_cli verify --all 2>&1 || true)
    if [ "$rc1" -eq 0 ] && [ "$rc2" -eq 0 ]; then
      echo "$out" | grep -q 'verification passed' || {
        echo "both workers succeeded but verify failed:"
        echo "$out"
        return 1
      }
    else
      if echo "$out" | grep -qE '\b(event_hash_mismatch|prev_hash_mismatch|chain_break|seq_gap|meta_head_mismatch|meta_seq_mismatch|seal_seq_mismatch|seal_hash_mismatch|seal_hmac_invalid|seal_missing_required|seal_key_unavailable)\b'; then
        echo "cryptographic / seal corruption under race:"
        echo "$out"
        return 1
      fi
      # Whatever verify did say must contain only orphaned_intent (or pass).
      if ! echo "$out" | grep -q 'verification passed' && ! echo "$out" | grep -qE '\borphaned_intent\b'; then
        echo "unexpected issue under race:"
        echo "$out"
        return 1
      fi
    fi
  }

  step "Sequential 50 ops: 100 rows, contiguous seq, verify passes" sequential_test
  step "Concurrent: never silent corruption (orphaned_intent allowed)" concurrent_chain_safety
fi

# ───────────────────────────────────────────────────────────────────
# Tier 4 — Provider discovery + schema gating
# ───────────────────────────────────────────────────────────────────

if tier_enabled 4; then
  header "Tier 4 — Provider discovery + schema gating"

  discovery_test() {
    node_run "
import { listProviders, getProvider, CURRENT_AUDIT_SCHEMA_VERSION } from 'psy-core';
import 'psy-core/letta';
if (CURRENT_AUDIT_SCHEMA_VERSION !== '1.0.0') { console.error('schema mismatch:', CURRENT_AUDIT_SCHEMA_VERSION); process.exit(1); }
const letta = getProvider('letta');
if (!letta) { console.error('letta not registered'); process.exit(1); }
if (letta.memoryPathScheme !== 'letta://') { console.error('letta scheme mismatch'); process.exit(1); }
if (!letta.compatibleProviderVersions.includes('1.10')) { console.error('letta version range mismatch'); process.exit(1); }
const caps = letta.capabilities;
for (const c of ['view','create','str_replace','delete']) {
  if (!caps.includes(c)) { console.error('letta missing capability:', c); process.exit(1); }
}
"
  }

  schema_mismatch_test() {
    node_run "
import { registerProvider, isPsyError } from 'psy-core';
try {
  registerProvider({
    name: 'fake-future',
    auditSchemaVersion: '>=99 <100',
    compatibleProviderVersions: '>=1 <2',
    capabilities: ['view'],
    memoryPathScheme: 'fake://',
    wrap: (h) => h,
  });
  console.error('FAIL: should have thrown');
  process.exit(1);
} catch (e) {
  if (e.code !== 'E_CONFIG_INVALID') { console.error('wrong error code:', e.code); process.exit(1); }
  if (!isPsyError(e)) { console.error('not a PsyError'); process.exit(1); }
}
"
  }

  step "Letta provider exposes correct metadata" discovery_test
  step "Schema-version mismatch rejected at registration with E_CONFIG_INVALID" schema_mismatch_test
fi

# ───────────────────────────────────────────────────────────────────
# Tier 5 — CLI surface (with JSON-parsed assertions)
# ───────────────────────────────────────────────────────────────────

if tier_enabled 5; then
  header "Tier 5 — CLI surface"

  cli_init_idempotent() {
    cd "$WORKSPACE/local-sdk"
    psy_cli init >/dev/null 2>&1
    psy_cli init >/dev/null 2>&1   # idempotent
    test -f .psy.json && test -f .psy/events.sqlite && test -f .psy/seal-key
    # Codex [P3]: seal key file must be mode 0600.
    local mode
    mode=$(stat -f '%Lp' .psy/seal-key 2>/dev/null || stat -c '%a' .psy/seal-key 2>/dev/null)
    [ "$mode" = "600" ] || { echo "seal-key mode is $mode, expected 600"; return 1; }
  }

  cli_query_filters() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    cat > _bench-seed-cli.mjs <<'EOF'
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/letta';
const blocks = wrap({
  create: async (b) => ({ id: 'blk_x', label: b.label, value: b.value }),
  retrieve: async () => ({ id: 'x', label: 'x', value: 'y' }),
  update: async (id, b) => ({ id, label: 'x', value: b.value }),
  delete: async () => ({ ok: true }),
}, { actorId: 'cli-test' });
const other = wrap({
  create: async (b) => ({ id: 'blk_other', label: b.label, value: b.value }),
  retrieve: async () => ({ id: 'x', label: 'x', value: 'y' }),
  update: async (id, b) => ({ id, label: 'x', value: b.value }),
  delete: async () => ({ ok: true }),
}, { actorId: 'cli-other' });
await runWithContext({ actorId: 'cli-test' }, async () => {
  await blocks.create({ label: 'a', value: '1' });
  await blocks.delete('blk_x');
});
await runWithContext({ actorId: 'cli-other' }, async () => {
  await other.create({ label: 'b', value: '2' });
});
EOF
    node _bench-seed-cli.mjs
    rm _bench-seed-cli.mjs

    # --actor filter: every returned row must have actor_id=cli-test.
    local rows
    rows=$(psy_cli query --actor cli-test --json)
    local count
    count=$(echo "$rows" | jq 'length')
    [ "$count" -ge 1 ] || { echo "no rows for cli-test"; return 1; }
    local mismatched
    mismatched=$(echo "$rows" | jq '[ .[] | select(.actor_id != "cli-test") ] | length')
    [ "$mismatched" -eq 0 ] || { echo "$mismatched rows leaked through --actor filter"; return 1; }

    # --operation filter: every row must have operation=delete.
    local del
    del=$(psy_cli query --operation delete --json)
    local del_mismatched
    del_mismatched=$(echo "$del" | jq '[ .[] | select(.operation != "delete") ] | length')
    [ "$del_mismatched" -eq 0 ] || { echo "$del_mismatched rows leaked through --operation filter"; return 1; }
  }

  cli_export_jsonl() {
    cd "$WORKSPACE/local-sdk"
    psy_cli export --format jsonl > export.jsonl
    test -s export.jsonl || { echo "export.jsonl empty"; return 1; }
    # Validate every line is JSON with the canonical fields.
    local total_db total_export
    total_db=$(sqlite3 .psy/events.sqlite "SELECT COUNT(*) FROM events")
    total_export=$(wc -l < export.jsonl | tr -d ' ')
    [ "$total_export" -eq "$total_db" ] || { echo "export count $total_export != db count $total_db"; return 1; }
    # Parse every line — fails fast on any malformed row or missing field.
    while IFS= read -r line; do
      echo "$line" | jq -e '.seq and .event_id and .operation and .audit_phase and .event_hash' >/dev/null || {
        echo "malformed export line: $line"
        return 1
      }
    done < export.jsonl
  }

  cli_verify_no_seal_actually_skips_seal() {
    cd "$WORKSPACE/local-sdk"
    # Move the seal key out of the way. With seal=required, full verify must
    # fail with seal_missing_required. With --no-seal, it must pass.
    mv .psy/seal-key .psy/seal-key.bak
    local out_strict rc_strict out_lax rc_lax
    out_strict=$(psy_cli verify --all 2>&1) && rc_strict=0 || rc_strict=$?
    out_lax=$(psy_cli verify --no-seal 2>&1) && rc_lax=0 || rc_lax=$?
    mv .psy/seal-key.bak .psy/seal-key

    [ "$rc_strict" -ne 0 ] || { echo "verify --all should fail without seal-key"; return 1; }
    # When .psy/seal-key is gone but .psy/head.json still exists, verify reports
    # seal_key_unavailable. (seal_missing_required is the case where head.json
    # itself is also gone — that's tested in Tier 3C.)
    echo "$out_strict" | grep -qE '\bseal_(key_unavailable|missing_required)\b' || {
      echo "expected seal_key_unavailable or seal_missing_required without --no-seal:"
      echo "$out_strict"
      return 1
    }
    [ "$rc_lax" -eq 0 ] || { echo "verify --no-seal should bypass seal check; got rc=$rc_lax"; echo "$out_lax"; return 1; }
  }

  step "psy init is idempotent + .psy/seal-key mode 0600" cli_init_idempotent
  step "psy query --actor / --operation: every row matches filter" cli_query_filters
  step "psy export jsonl: every line valid + count matches DB" cli_export_jsonl
  step "psy verify --no-seal genuinely bypasses seal loading" cli_verify_no_seal_actually_skips_seal
fi

# ───────────────────────────────────────────────────────────────────
# Tier 6 — Failure modes (fail-closed proofs)
# ───────────────────────────────────────────────────────────────────

if tier_enabled 6; then
  header "Tier 6 — Failure modes (fail-closed proofs)"

  anonymous_rejected_handler_uncalled() {
    node_run "
let calls = 0;
const handlers = {
  view: async () => { calls++; return 'x'; },
  create: async () => { calls++; return 'x'; },
  str_replace: async () => { calls++; return 'x'; },
  insert: async () => { calls++; return 'x'; },
  delete: async () => { calls++; return 'x'; },
  rename: async () => { calls++; return 'x'; },
};
const { wrap } = await import('psy-core/anthropic-memory');
const w = wrap(handlers, {});
try {
  await w.view({ command: 'view', path: '/memories/a' });
  console.error('FAIL: expected throw'); process.exit(1);
} catch (e) {
  if (e.code !== 'E_CONFIG_INVALID') { console.error('wrong code:', e.code); process.exit(1); }
}
if (calls !== 0) { console.error('handler invoked ' + calls + ' times despite anon rejection'); process.exit(1); }
"
  }

  path_traversal_rejected_handler_uncalled() {
    node_run "
let calls = 0;
const handlers = {
  view: async () => { calls++; return 'x'; },
  create: async () => { calls++; return 'x'; },
  str_replace: async () => { calls++; return 'x'; },
  insert: async () => { calls++; return 'x'; },
  delete: async () => { calls++; return 'x'; },
  rename: async () => { calls++; return 'x'; },
};
const { wrap } = await import('psy-core/anthropic-memory');
const w = wrap(handlers, { actorId: 't' });
const cases = ['/etc/passwd', '/memories/../escape', '/memories/%2e%2e/x', '/memories/with space'];
for (const p of cases) {
  try { await w.view({ command: 'view', path: p }); console.error('FAIL: accepted', p); process.exit(1); }
  catch (e) {
    // Different unsafe-path categories throw different specific codes
    // (E_PATH_TRAVERSAL, E_PATH_ENCODED, E_PATH_INVALID, etc.). All are
    // members of the path-guard family — the contract is that any unsafe
    // path is rejected, not that all share one code.
    if (typeof e.code !== 'string' || !e.code.startsWith('E_PATH_')) {
      console.error('wrong code family for', p, ':', e.code); process.exit(1);
    }
  }
}
if (calls !== 0) { console.error('handler invoked ' + calls + ' times despite path-guard'); process.exit(1); }
"
  }

  redactor_field_level() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    cat > _bench-leak.mjs <<'EOF'
import { wrap } from 'psy-core/anthropic-memory';
const w = wrap({
  view: async () => 'x', create: async () => 'created', str_replace: async () => 'x',
  insert: async () => 'x', delete: async () => 'x', rename: async () => 'x',
}, { actorId: 'leak-test', includePayloadPreview: true });
await w.create({
  command: 'create',
  path: '/memories/leak.md',
  file_text: 'my key is sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE-stop-here-yo',
});
EOF
    node _bench-leak.mjs
    rm _bench-leak.mjs

    local rows
    rows=$(psy_cli query --actor leak-test --json)
    # Whole-blob check: raw key must be absent.
    if echo "$rows" | grep -q 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE-stop'; then
      echo "raw API key leaked into stored row"
      return 1
    fi
    # Field-level: result row must mark redacted with the right id and the
    # payload_preview.file_text must contain a REDACTED marker.
    local result_row
    result_row=$(echo "$rows" | jq '[ .[] | select(.audit_phase == "result") ] | first')
    [ "$result_row" != "null" ] || { echo "no result row"; return 1; }
    local redacted redactor_id preview
    redacted=$(echo "$result_row" | jq -r '.payload_redacted')
    redactor_id=$(echo "$result_row" | jq -r '.redactor_id')
    preview=$(echo "$result_row" | jq -r '.payload_preview')
    [ "$redacted" = "true" ] || { echo "payload_redacted should be true, got $redacted"; return 1; }
    [ "$redactor_id" = "default-regex-v1" ] || { echo "redactor_id wrong: $redactor_id"; return 1; }
    echo "$preview" | grep -q 'REDACTED' || { echo "preview missing REDACTED marker: $preview"; return 1; }
    echo "$preview" | grep -q 'sk-ant-api03' && { echo "preview leaked raw key prefix"; return 1; }

    # Intent row must have NO payload preview.
    local intent_preview
    intent_preview=$(echo "$rows" | jq -r '[ .[] | select(.audit_phase == "intent") ] | first | .payload_preview')
    [ "$intent_preview" = "null" ] || { echo "intent row should have null payload_preview, got: $intent_preview"; return 1; }
  }

  step "Anonymous: throws E_CONFIG_INVALID + handler call count = 0" anonymous_rejected_handler_uncalled
  step "Path traversal (4 vectors): throws E_PATH_TRAVERSAL + handler call count = 0" path_traversal_rejected_handler_uncalled
  step "Redactor: result row has redacted=true, redactor_id, marker; intent has none" redactor_field_level
fi

# ───────────────────────────────────────────────────────────────────
# Tier 7 — Performance + scale (real threshold gate)
# ───────────────────────────────────────────────────────────────────

if tier_enabled 7; then
  header "Tier 7 — Performance + scale (p95 gate: ${P95_THRESHOLD_MS}ms)"

  perf_microbench() {
    cd "$WORKSPACE/local-sdk"
    reset_db || { echo "reset_db failed"; return 1; }
    cat > _bench-perf.mjs <<'EOF'
import { runWithContext } from 'psy-core';
import { wrap } from 'psy-core/letta';
const blocks = wrap({
  create: async () => ({ id: 'blk', label: 'x', value: 'y' }),
  retrieve: async () => ({ id: 'blk', label: 'x', value: 'y' }),
  update: async () => ({ id: 'blk', label: 'x', value: 'y' }),
  delete: async () => ({ ok: true }),
}, { actorId: 'bench' });
const N = 1000;
const samples = [];
process.stderr.write('progress: ');
await runWithContext({ actorId: 'bench' }, async () => {
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    await blocks.create({ label: `b${i}`, value: 'v' });
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
    if (i % 50 === 49) process.stderr.write('.');
  }
});
process.stderr.write('\n');
samples.sort((a, b) => a - b);
const p = (q) => samples[Math.floor(samples.length * q)].toFixed(2);
console.log(JSON.stringify({
  N, p50_ms: +p(0.5), p95_ms: +p(0.95), p99_ms: +p(0.99), max_ms: +samples.at(-1).toFixed(2),
}));
EOF
    local out
    out=$(node _bench-perf.mjs)
    rm _bench-perf.mjs
    echo "$out"
    local p95
    p95=$(echo "$out" | jq '.p95_ms')
    awk -v v="$p95" -v t="$P95_THRESHOLD_MS" 'BEGIN{ exit (v <= t) ? 0 : 1 }' || {
      echo "p95 ${p95}ms exceeds threshold ${P95_THRESHOLD_MS}ms"
      return 1
    }
  }

  perf_verify_scale() {
    cd "$WORKSPACE/local-sdk"
    psy_cli verify --all
    local rows
    rows=$(sqlite3 .psy/events.sqlite "SELECT COUNT(*) FROM events")
    [ "$rows" -ge 2000 ] || { echo "expected >=2000 rows, got $rows"; return 1; }
  }

  step "1000 wrapped ops + p95 <= ${P95_THRESHOLD_MS}ms" perf_microbench
  step "verify --all passes at 2000+ rows" perf_verify_scale
fi

# ───────────────────────────────────────────────────────────────────
# Summary
# ───────────────────────────────────────────────────────────────────

TIER_END=$(date +%s)
ELAPSED=$((TIER_END - TIER_START))

printf "\n%sSummary%s\n" "$BOLD" "$RESET"
printf "  %s✓%s %d passed   %s⏭%s  %d skipped   %s✗%s %d failed\n" "$GREEN" "$RESET" "$PASS" "$YELLOW" "$RESET" "$SKIP" "$RED" "$RESET" "$FAIL"
printf "  %stotal: %ds   logs: %s%s\n" "$DIM" "$ELAPSED" "$LOG_FILE" "$RESET"

if [ "$FAIL" -gt 0 ]; then
  printf "\n%sFailed steps:%s\n" "$RED" "$RESET"
  for s in "${FAILED_STEPS[@]}"; do
    printf "  %s•%s %s\n" "$RED" "$RESET" "$s"
  done
  printf "\n%sInspect %s for full output%s\n" "$DIM" "$LOG_FILE" "$RESET"
  KEEP_WORKSPACE=1
  exit 1
fi

printf "\n%s%sall checks passed%s\n" "$GREEN" "$BOLD" "$RESET"
exit 0
