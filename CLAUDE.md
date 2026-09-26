# Bloxsmith

Two rules here have cost real hours. Both are about *where* a change is measured, not how it
is written.

## Two servers, and only one of them is you

| Port | What it is | What it serves |
|---|---|---|
| `:8090` | `scripts/dev-serve.sh`, rebuilds on save | The working tree |
| `:8080` | The installed binary at `~/.local/bin/bloxsmith` | Assets compiled into it by `//go:embed all:web` |

`cd ui && npm run build && cp -R dist/* ../go/web/` updates the repo and changes **nothing**
about what `:8080` serves until the binary is rebuilt and reinstalled, or the app self-updates
from a published release.

Measuring a UI change against `:8080` therefore reports the OLD build as though it were the
new one. On 2026-08-10 that produced about an hour of "the optimisation had no effect"
readings for a change that had a large effect. The tell was the chunk filename: `:8080` was
serving `Infra-OHkYDyaP.js` while the fresh build had produced `Infra-_S4iqo_A.js`.

Measure UI changes on `:8090`. Use `:8080` only to check the *published* build, and check
which version that is first:

```bash
curl -s "http://localhost:8080/api/update/check?force=1"
```

## The dev server is the owner's, and it is watching

`scripts/dev-serve.sh` watches two input sets (`scripts/dev-serve.sh:64` and `:71`), not one:

| Set | Paths | Effect on save |
|---|---|---|
| UI | `ui/src`, `ui/public`, `ui/index.html`, `ui/vite.config.js` | Rebuild, copy into `go/web` |
| Go | `go/**/*.go` excluding `go/web`, `go/go.mod`, `go/go.sum` | Rebuild the binary, restart the server |

So a **Go** edit in the main checkout restarts the owner's live server with half-finished
code. It is not only a UI concern.

Do mutation work in a worktree, which the watcher cannot see:

```bash
git worktree add -b <branch> /tmp/<dir> master
```

Go-only work needs no `node_modules` there. A worktree that runs the UI or Playwright needs
**both** `node_modules` trees copied in, `ui/node_modules` and the repo-root one that holds
`@playwright/test`, plus the root `package.json`. Without them Playwright cannot load and
zero tests run, which looks like a pass.

Files under `go/` that are not `*.go`, for example `go/templates/**/*.yaml`, are outside both
watch lists and are safe to edit in the main checkout. So are config files like
`.github/dependabot.yml`.

`docs/TABS.md` is outside both watch lists too, but not outside the build.
`ui/src/components/DocsPanel.jsx` imports it into the in-app help, so editing it changes the UI
bundle. `:8090` keeps showing the old help text until something else triggers a rebuild, and a
docs-only PR fails CI's `build` check until `go/web` is rebuilt from `ui/dist`, as #243 did.
Run `scripts/needs-tag.sh` after that rebuild is committed, not before: it skips `docs/*` and
`*.md`, so on the doc edit alone it says `skip`, and only the rebuilt `go/web` makes it say
`tag`. Customers see the new help text only once it is released.

## E2E_SKIP_LIVE=1 is mandatory

Worktree or not:

```bash
E2E_SKIP_LIVE=1 npx playwright test
```

`tests/layout-persist.spec.ts` finds a server by `pgrep` across the whole machine and SIGTERMs
it. A worktree does not protect the owner's `:8090` from that; only the flag does.

## Agent skills

### Issue tracker

Issues live as GitHub issues in this repo, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical labels, each named after its role. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
