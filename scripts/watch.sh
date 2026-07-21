#!/usr/bin/env bash
# watch.sh — live local dev. Edit src/*.jsx, save, and the change shows in ~2s.
#
# Serves the UI from DISK (WEB_DIR dev mode in main.go), so a change only rebuilds
# the bundle in place — no go recompile, no server restart. On macOS+Chrome it also
# auto-reloads the tab; otherwise just refresh. Ctrl-C stops and cleans up.
#
# Usage: scripts/watch.sh [port]        # default 8090
# (For a one-shot frozen snapshot instead, use scripts/preview.sh.)
set -euo pipefail

PORT="${1:-8090}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null 2>&1 || { echo "watch: node not found" >&2; exit 1; }
command -v go   >/dev/null 2>&1 || { echo "watch: go not found"   >&2; exit 1; }
[ -f scripts/build_ui.js ] || { echo "watch: run from the bloxsmith repo" >&2; exit 1; }

echo "watch: initial build…"
node scripts/build_ui.js

if lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "watch: freeing port $PORT…"
  lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

echo "watch: serving from disk on http://localhost:$PORT  (edit src/*.jsx — Ctrl-C to stop)"
( cd go && WEB_DIR="$ROOT/go/web" PORT="$PORT" exec go run . ) &
SRV=$!
cleanup(){ echo; echo "watch: stopping…"; kill "$SRV" 2>/dev/null || true; lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Wait until it serves, then open the browser once.
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
    command -v open >/dev/null 2>&1 && open "http://localhost:$PORT/"
    break
  fi
  sleep 1
done

# Best-effort auto-reload of the localhost tab (macOS + Chrome); no-op elsewhere.
reload_browser(){
  command -v osascript >/dev/null 2>&1 || return 0
  osascript >/dev/null 2>&1 <<OSA || true
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "localhost:$PORT" then reload t
    end repeat
  end repeat
end tell
OSA
}

# Content-hash the sources (portable: shasum on macOS+Linux). Rebuild on any change;
# the server serves the new bundle from disk immediately — no restart.
sig(){ cat src/*.jsx go/web/index.html 2>/dev/null | shasum | cut -d' ' -f1; }
echo "watch: watching src/*.jsx + index.html …"
LAST="$(sig)"
while sleep 1; do
  NOW="$(sig)"
  if [ "$NOW" != "$LAST" ]; then
    LAST="$NOW"
    echo "watch: change detected → rebuilding…"
    if node scripts/build_ui.js >/dev/null 2>&1; then
      LAST="$(sig)"   # re-hash: build_ui rewrites the bundle (part of the watched set is unaffected, but be safe)
      echo "watch: ✓ rebuilt — reloading"
      reload_browser
    else
      echo "watch: ✗ build failed — fix the error, save again"
    fi
  fi
done
