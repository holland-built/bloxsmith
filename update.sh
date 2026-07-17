#!/usr/bin/env bash
# Bloxsmith updater — pull the newest image and restart. Run: ./update.sh
set -euo pipefail
cd "$(dirname "$0")"
docker compose pull && docker compose up -d
