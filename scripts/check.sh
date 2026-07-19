#!/usr/bin/env bash
# Local type-gate — the command below is DELIBERATELY duplicated in CI at
# .github/workflows/docker-publish.yml ("Type-check (tsc --noEmit)" step).
# Do NOT "fix" that by making CI call this script: the workflow must not depend
# on this repo's file layout (this script moved root -> scripts/ and an inlined
# CI copy survived untouched, while a `./check.sh` call would have broken CI).
# The twins are held in sync by ToolingDriftTests in tests/test_regression.py —
# change one and that test fails. Change BOTH.
# No package.json in this repo, so tsc is fetched on demand via npx.
# --package names the pkg that provides `tsc`; without it npx treats `tsc` as a
# source file (TS5042). Requires Node/npx on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "▶ Type-checking UI (tsc --noEmit -p tsconfig.json)…"
npx -y --package typescript@latest tsc --noEmit -p tsconfig.json
echo "✓ Type-check passed"
