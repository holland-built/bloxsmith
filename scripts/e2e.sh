#!/usr/bin/env bash
# e2e.sh — the disposable Playwright harness playwright.config.ts names in its
# header, and which did not exist until now.
#
# WHY IT EXISTS. tests/ holds 49 spec files and playwright.config.ts points at
# them, but no package.json in this repo declared @playwright/test and no CI job
# mentioned Playwright — so `npx playwright test` resolved to nothing and the
# whole suite had never been executed by anything except a human with a dev
# server already running. A suite nothing runs is not a gate.
#
# WHAT IT DOES. Builds the UI and the Go binary from the CURRENT WORKING TREE,
# runs that binary on its own port with throwaway state, points NOC_BASE at it,
# runs Playwright, then kills the server and deletes the state. It never touches
# the live :8080 (published image) or :8090 (scripts/dev-serve.sh) instances,
# and it never writes to the real per-user config directory.
#
#   scripts/e2e.sh                         # whole suite
#   scripts/e2e.sh tests/tabs-smoke.spec.ts   # one spec (args pass to playwright)
#   E2E_PORT=8099 scripts/e2e.sh --headed
#
# ISOLATION, and what each override is actually protecting:
#   PORT             8091 by default (E2E_PORT). Refuses to start if taken, so a
#                    typo can never point the suite at the live dev server and
#                    report its results as this tree's.
#   WEB_DIR          ui/dist. NOT go/web: that directory is tracked, and copying
#                    into it (what dev-serve.sh does) would dirty the working
#                    tree on every test run. The two are byte-identical when
#                    go/web is current -- CI's "UI dist up to date" step is
#                    exactly that assertion.
#   TEMPLATES_DIR    go/templates. config.go defaults this relative to the
#                    BINARY's directory, and the binary is built into a temp
#                    dir, so without this the Provision/Drift pickers silently
#                    find no templates.
#   VAULT_DIR        a temp dir. main.go derives stateDir from the vault file's
#                    location, so this one variable also moves vault.json,
#                    audit_log.jsonl and the saved-view store (views/) off the
#                    real machine. The suite creates and deletes __layout_*
#                    records; without this it would do that in the operator's
#                    own state.
#   AUDIT_TRUST_DIR  a temp dir. Defaults to a SIBLING of the per-user config
#                    dir (internal/audit/key.go), i.e. ~/Library/... on macOS.
#                    A test run must not create or rotate the machine's real
#                    audit HMAC key.
#
# ONE HAZARD THIS SCRIPT CANNOT CONTAIN, and it was observed rather than
# reasoned about. tests/layout-persist.spec.ts restarts the server by running
# `pgrep -f "^/tmp/bloxsmith-dev$"` and SIGTERMing whatever comes back — a
# hardcoded path, not the server this harness started, and it ignores NOC_BASE
# entirely. /tmp/bloxsmith-dev is scripts/dev-serve.sh's binary. So on a machine
# with dev-serve.sh running, that spec kills the :8090 DEV SERVER and then
# passes, having proved something about a process this run does not own.
# Measured 2026-08-11: a full-suite run through this harness changed the pid
# listening on :8090. Nothing here can prevent that without editing the spec —
# run the full suite with dev-serve.sh stopped, or expect it to be restarted
# under you. On a CI runner there is no such process and the spec bails out with
# its own message ("not pointed at scripts/dev-serve.sh").
#
# ENV LEAKAGE, which is the non-obvious hazard here. go/main.go:387 loads
# /Users/sholland/AI/Infoblox MCP/.env by ABSOLUTE PATH, and LoadServiceEnv()
# reads the per-user config .env as well -- so on a developer machine the binary
# picks up real Infoblox credentials no matter what directory it runs from.
# config.LoadDotEnv is setdefault (a variable already in the environment wins),
# so every credential-bearing variable is exported explicitly below, empty
# unless deliberately supplied. That is what makes a local run and a CI run the
# same run.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

PORT="${E2E_PORT:-8091}"
BASE="http://localhost:$PORT"

for tool in node npm go curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "e2e: $tool not found" >&2; exit 1; }
done

if curl -s -o /dev/null --max-time 2 "$BASE/" 2>/dev/null; then
  echo "e2e: something is already listening on $PORT — refusing to run the suite against a server this script did not build" >&2
  echo "e2e: set E2E_PORT to a free port, or stop whatever owns $PORT" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/bloxsmith-e2e.XXXXXX")" || exit 1
BIN="$WORK/bloxsmith"
STATE="$WORK/state"
TRUST="$WORK/trust"
mkdir -p "$STATE" "$TRUST"

SRV=""
cleanup() {
  if [ -n "$SRV" ] && kill -0 "$SRV" 2>/dev/null; then
    kill -TERM "$SRV" 2>/dev/null
    waited=0
    while kill -0 "$SRV" 2>/dev/null && [ "$waited" -lt 25 ]; do
      sleep 0.2
      waited=$((waited + 1))
    done
    kill -0 "$SRV" 2>/dev/null && kill -9 "$SRV" 2>/dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# ---- UI ---------------------------------------------------------------------
# npm ci only when node_modules is absent: it deletes and reinstalls the whole
# tree, which is right on a cold CI runner and pure cost on a warm laptop.
if [ ! -d ui/node_modules ]; then
  echo "e2e: installing UI dependencies (npm ci)"
  ( cd ui && npm ci ) || { echo "e2e: npm ci failed" >&2; exit 1; }
fi
echo "e2e: building UI (vite)"
( cd ui && npm run build >/dev/null ) || { echo "e2e: UI build failed" >&2; exit 1; }

# ---- server -----------------------------------------------------------------
echo "e2e: building the Go binary from the current tree"
( cd go && go build -ldflags "-X main.version=e2e" -o "$BIN" . ) \
  || { echo "e2e: go build failed" >&2; exit 1; }

export PORT HOST=localhost
export WEB_DIR="$ROOT/ui/dist"
export TEMPLATES_DIR="$ROOT/go/templates"
export VAULT_DIR="$STATE"
export AUDIT_TRUST_DIR="$TRUST"
export DISABLE_UPDATE_CHECK=1
# Credentials: empty unless the caller supplies them. Exported even when empty,
# because that is what stops the two .env files described in the header from
# supplying a real one (LoadDotEnv is setdefault).
export INFOBLOX_API_KEY="${E2E_INFOBLOX_API_KEY:-e2e-no-upstream}"
export INFOBLOX_URL="${E2E_INFOBLOX_URL:-https://csp.invalid}"
export VAULT_PASSPHRASE="" VAULT_PASSPHRASE_FILE=""
export GROQ_API_KEY="" LLM_API_KEY="" DASHBOARD_TOKEN=""
# tests/fixtures.ts reads this on a FAILED attempt and uses it to tell "the
# request never reached the server" apart from "the server restarted under the
# test". Unset it and every failure attachment says "not-configured".
export BLOXSMITH_REQLOG="$WORK/reqlog.jsonl"
# What playwright.config.ts and tests/global-setup.ts resolve baseURL from.
export NOC_BASE="$BASE"

"$BIN" > "$WORK/server.log" 2>&1 &
SRV=$!

# Readiness. globalSetup polls for 15s of its own; failing here instead gives a
# diagnostic that includes the server's log, which globalSetup cannot see.
tries=0
until curl -fsS -o /dev/null --max-time 2 "$BASE/" 2>/dev/null; do
  if ! kill -0 "$SRV" 2>/dev/null; then
    echo "e2e: the server exited before it answered — its log:" >&2
    cat "$WORK/server.log" >&2
    exit 1
  fi
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "e2e: $BASE did not answer within 30s — server log:" >&2
    cat "$WORK/server.log" >&2
    exit 1
  fi
  sleep 0.5
done
echo "e2e: serving $BASE (state $STATE, WEB_DIR $WEB_DIR)"

# ---- tests ------------------------------------------------------------------
npx playwright test "$@"
code=$?

if [ "$code" -ne 0 ]; then
  echo "e2e: playwright exited $code — last 40 lines of the server log:" >&2
  tail -n 40 "$WORK/server.log" >&2
fi
exit "$code"
