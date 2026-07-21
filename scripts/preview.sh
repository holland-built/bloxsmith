#!/usr/bin/env bash
# preview.sh — one-command local preview of the Bloxsmith UI on a throwaway port.
#
# Rebuilds the embedded bundle, frees the port (kills orphaned go-run servers that
# keep serving the OLD embed), launches the Go binary, waits until it's actually
# serving, then opens the browser. Ctrl-C stops it and cleans up.
#
# Usage: scripts/preview.sh [port]     # default 8090 (dodges :8080 prod, :8091 playwright)
set -euo pipefail

PORT="${1:-8090}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null 2>&1 || { echo "preview: node not found" >&2; exit 1; }
command -v go   >/dev/null 2>&1 || { echo "preview: go not found"   >&2; exit 1; }
[ -f scripts/build_ui.js ] || { echo "preview: run from the bloxsmith repo (scripts/build_ui.js missing)" >&2; exit 1; }

echo "preview: rebuilding UI bundle…"
node scripts/build_ui.js

# The embed is compiled at 'go run' time, so a stale server keeps serving old code.
# go run also leaves an orphan child binary — kill by PORT, not process.
if lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "preview: freeing port $PORT (stale server)…"
  lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

echo "preview: starting on http://localhost:$PORT  (Ctrl-C to stop)…"
( cd go && PORT="$PORT" exec go run . ) &
SRV=$!
cleanup(){ echo; echo "preview: stopping…"; kill "$SRV" 2>/dev/null || true; lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# go build can take ~20s on a cold cache; poll until it answers, then open the browser.
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
    echo "preview: up — opening browser"
    if command -v open >/dev/null 2>&1; then open "http://localhost:$PORT/"
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$PORT/"
    else echo "preview: open http://localhost:$PORT/ manually"; fi
    break
  fi
  sleep 1
done

wait "$SRV"
