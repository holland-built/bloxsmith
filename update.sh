#!/usr/bin/env bash
# ⚠️ DEV-ONLY HOT-SWAP — NOT the product update mechanism.
# Copies your local index.html into the running 'bloxsmith' container for fast
# UI iteration. It does NOT update the app. To actually update, use the in-app
# "Update now" button or:  docker compose pull && docker compose up -d
set -euo pipefail

CONTAINER="bloxsmith"   # the container serving http://127.0.0.1:8080

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "✗ Container '$CONTAINER' is not running. Start it first, then re-run ./update.sh"
  exit 1
fi

docker cp index.html "$CONTAINER":/app/index.html
echo "✓ Dashboard updated on :8080."
echo "  Now hard-refresh the browser to clear the cached old page:"
echo "    macOS Chrome/Edge : Cmd + Shift + R"
echo "    Windows/Linux     : Ctrl + Shift + R"
