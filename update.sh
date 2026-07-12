#!/usr/bin/env bash
# Update the LIVE BloxSmith dashboard.
# Copies the current index.html into the running Docker container that serves :8080.
# Usage:  ./update.sh
set -euo pipefail

CONTAINER="infoblox-mcp"   # the container serving http://127.0.0.1:8080

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "✗ Container '$CONTAINER' is not running. Start it first, then re-run ./update.sh"
  exit 1
fi

docker cp index.html "$CONTAINER":/app/index.html
echo "✓ Dashboard updated on :8080."
echo "  Now hard-refresh the browser to clear the cached old page:"
echo "    macOS Chrome/Edge : Cmd + Shift + R"
echo "    Windows/Linux     : Ctrl + Shift + R"
