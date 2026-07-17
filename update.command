#!/usr/bin/env bash
# Bloxsmith updater (macOS) — double-click to pull the newest image and restart.
set -euo pipefail
cd "$(dirname "$0")"
docker compose pull && docker compose up -d
