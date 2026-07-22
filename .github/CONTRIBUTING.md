# Contributing

Thanks for your interest in improving Bloxsmith. This is a small
demo/dashboard tool — contributions that keep it simple and dependency-light are
most welcome.

## Local development (build from source)

Requires **Go >= 1.26** and **Node** (to rebuild the embedded UI).

```bash
cd ui && npm ci && npm run build              # Vite build: ui/src → go/web (embedded)
cd .. && cp .env.example .env                  # fill in your keys (optional — the in-app vault also works)
cd go && go build -o bloxsmith . && ./bloxsmith   # → http://localhost:8080
```

For a live-reload dev loop instead, run `scripts/dev-serve.sh [port]` (rebuilds
`ui/` on change, serves from disk via `WEB_DIR`).

Set `HOST=0.0.0.0` to expose beyond localhost. See the README for the full env-var
table and the Docker quick start, and [go/BUILD.md](../go/BUILD.md) for cross-compiles.

## Running the tests

```bash
# UI freshness — go/web must match ui/ build output
cd ui && npm run build && cd .. && diff -r ui/dist go/web

# Go unit + integration tests
cd go && go test ./...
```

CI ([ci.yml](workflows/ci.yml)) runs the same checks plus a `goreleaser build
--snapshot` smoke on every push and PR. Add or update a Go test when you change a
behavior or add an endpoint.

## Code style

- Keep it simple and surgical — match the existing style; no large refactors bundled
  with feature work.
- Go: standard library first; only add a dependency when it earns its place.
- Frontend lives in `ui/` (Vite + React) and builds to the embedded `go/web/` —
  edit the source, never the generated `go/web/` output, and rerun the build.

## Branch / PR process

1. Branch off `master` (e.g. `fix/dns-zone-parsing`, `feat/widget-resize`).
2. Make focused commits; keep each PR scoped to one logical change.
3. Run the checks above locally before opening the PR and note the result.
4. Open a PR with a clear description of what changed and why. Link any related issue.

## Security & secrets

- **Never commit `.env` or real API tokens.** `.env` is gitignored — use
  `.env.example` as the template.
- Do not commit local state (`*.db`, `*.log`, cache files).
- If you accidentally expose an Infoblox token, **rotate it in the CSP portal** —
  scrubbing it from git history does not revoke it. See [SECURITY.md](SECURITY.md).
