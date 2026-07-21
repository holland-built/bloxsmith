#!/usr/bin/env bash
# dev-serve.sh — persistent bleeding-edge dev server on :8090.
#
# Uses the COMPILED binary (not `go run`, so no orphan processes) with
# DISABLE_UPDATE_CHECK=1 (so it never self-updates away) and WEB_DIR (serves the
# UI from disk, so a `src/*.jsx` edit shows after a bundle rebuild — no restart).
# Rebuilds the bundle on change; restarts the binary if it dies. Meant to be run
# under launchd (KeepAlive) but also works standalone: scripts/dev-serve.sh [port]
set -uo pipefail

PORT="${1:-8090}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
BIN="/tmp/bloxsmith-dev"
export WEB_DIR="$ROOT/go/web" DISABLE_UPDATE_CHECK=1 PORT

command -v node >/dev/null 2>&1 || { echo "dev-serve: node not found" >&2; exit 1; }
command -v go   >/dev/null 2>&1 || { echo "dev-serve: go not found"   >&2; exit 1; }

echo "dev-serve: build bundle + binary…"
node scripts/build_ui.js >/dev/null 2>&1 || echo "dev-serve: bundle build failed (continuing)"
# Stamp a clear dev version (dev-<sha>) so :8090 never shows a release number and
# never looks "behind" a real release — it IS the bleeding edge, not a version to update.
DEVVER="dev-$(git rev-parse --short HEAD 2>/dev/null || echo local)"
rm -f "$BIN"; ( cd go && go build -ldflags "-X main.version=$DEVVER" -o "$BIN" . ) || { echo "dev-serve: go build failed" >&2; exit 1; }

start(){ lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null; "$BIN" & SRV=$!; }
cleanup(){ kill "$SRV" 2>/dev/null; lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null; }
trap cleanup EXIT INT TERM

echo "dev-serve: serving :$PORT (DISABLE_UPDATE_CHECK, WEB_DIR)"
start

sig(){ cat src/*.jsx go/web/index.html 2>/dev/null | shasum | cut -d' ' -f1; }
LAST="$(sig)"
while sleep 2; do
  # self-heal: restart the binary if the port is dead and the process is gone
  if ! curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null && ! kill -0 "$SRV" 2>/dev/null; then
    echo "dev-serve: server down — restarting"; start
  fi
  # UI edit → rebuild bundle (binary serves it from disk, no restart needed)
  NOW="$(sig)"
  if [ "$NOW" != "$LAST" ]; then LAST="$NOW"; echo "dev-serve: change → rebuild"; node scripts/build_ui.js >/dev/null 2>&1 && echo "dev-serve: ✓ rebuilt"; fi
done
