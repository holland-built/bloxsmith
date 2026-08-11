package main

import "embed"

// web holds the already-built frontend assets: the output of `cd ui && npm run
// build`, copied into go/web (step 1 of the repo-root SHIP.md). Nothing here is
// generated at compile time, so a stale copy embeds silently — ci.yml's "UI dist
// up to date" step rebuilds ui/ and diffs ui/dist against go/web to catch that.
//
//go:embed all:web
var webFS embed.FS
