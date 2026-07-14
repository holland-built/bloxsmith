#!/usr/bin/env bash
# Local type-gate — mirrors the CI "Type-check (tsc --noEmit)" step exactly so a
# type error surfaces here before it fails the Docker Publish workflow.
# No package.json in this repo, so tsc is fetched on demand via npx.
# --package names the pkg that provides `tsc`; without it npx treats `tsc` as a
# source file (TS5042). Requires Node/npx on PATH.
set -euo pipefail
cd "$(dirname "$0")"
echo "▶ Type-checking UI (tsc --noEmit -p tsconfig.json)…"
npx -y --package typescript@latest tsc --noEmit -p tsconfig.json
echo "✓ Type-check passed"
