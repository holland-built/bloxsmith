package main

import "embed"

// web holds the already-built frontend assets, copied verbatim from the repo
// root by hand (Phase 1 replaces this with scripts/stage_ui.sh). Mirrors what
// Dockerfile:10-13 copies into the Python image.
//
//go:embed all:web
var webFS embed.FS
