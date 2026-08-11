# ui — Bloxsmith dashboard frontend

The Vite + React single-page app behind the Bloxsmith NOC dashboard. `src/App.jsx`
lazy-loads the 15 tabs in `src/tabs/`, so each one arrives as its own chunk on
first visit.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on `:8095`, proxying `/api` to the Go dev server on `:8090` |
| `npm test` | Client unit tests via `node --test` |
| `npm run lint` | oxlint |
| `npm run build` | Production build into `dist/` |

## Building for the binary

The Go binary serves the frontend from `go/web` (`go:embed all:web` in
`go/embed.go`), so a build only reaches the app once it is copied there. Step 1 of
the repo-root `SHIP.md`:

```bash
cd ui && npm run build && rm -rf ../go/web/* && cp -R dist/* ../go/web/
```

`ci.yml` rebuilds and diffs `ui/dist` against `go/web`, and fails if they differ.
