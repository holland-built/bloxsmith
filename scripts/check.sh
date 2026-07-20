#!/usr/bin/env bash
# Local type-gate — the same `tsc --noEmit` runs in CI at
# .github/workflows/ci.yml ("Type-check (tsc --noEmit)" step). The CI copy is
# inlined rather than calling this script so the workflow does not depend on this
# repo's file layout; keep the two in sync by hand if you change the command.
# No package.json in this repo, so tsc is fetched on demand via npx.
# --package names the pkg that provides `tsc`; without it npx treats `tsc` as a
# source file (TS5042). Requires Node/npx on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "▶ Type-checking UI (tsc --noEmit -p tsconfig.json)…"
npx -y --package typescript@latest tsc --noEmit -p tsconfig.json
echo "✓ Type-check passed"
