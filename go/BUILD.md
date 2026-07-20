# BUILD.md — building & releasing the Go single binary

Bloxsmith ships as one static Go binary that embeds its frontend (`go:embed all:web`)
and cross-compiles to every OS from a single `goreleaser` run. This file documents
the distribution layer (Phase 2 of `plans/030-go-single-binary-migration.md`).

## Prerequisites

- Go toolchain (see `go/go.mod` — currently `go 1.26.3`).
- goreleaser v2: `brew install goreleaser` **or**
  `go install github.com/goreleaser/goreleaser/v2@latest`.
- For the container image only: Docker with buildx (release step, not build step).

All commands run **from the `go/` directory** (the config lives at `go/.goreleaser.yaml`
because the module and the embedded `web/` assets both live here).

## Local test build (NO publish)

```bash
cd go
goreleaser build --snapshot --clean
```

Produces, under `go/dist/`, cross-compiled binaries for:
- macOS **universal** (darwin amd64+arm64 merged, `replace: true`)
- windows/amd64
- linux/amd64 and linux/arm64

The version is stamped via ldflags `-X main.version={{ .Version }}`; in snapshot
mode it reads `1.0.<n+1>-snapshot-<commit>`. Verify a produced binary:

```bash
./dist/bloxsmith_darwin_all/bloxsmith --version         # prints the stamped version
PORT=8099 ./dist/bloxsmith_darwin_all/bloxsmith &        # boot it
curl -s localhost:8099/api/update/check                  # "current" == stamped version
curl -s localhost:8099/ | head                           # embedded UI (index.html) loads
```

## Real release (publishes)

Cut a tag matching the `1.0.<git-commit-count>` scheme, then run goreleaser:

```bash
git tag "v1.0.$(git rev-list --count HEAD)"
git push --tags
cd go && goreleaser release --clean
```

`goreleaser release` produces and publishes:
- per-OS archives (`.tar.gz`, Windows `.zip`) + `checksums.txt` (go-selfupdate verifies against it)
- a **GitHub Release** (tag `v1.0.<n>`) — the in-app update banner keys off this
- a **Homebrew formula** pushed to `holland-built/homebrew-tap`
  → `brew install holland-built/tap/bloxsmith`
- **Windows**: no winget. Windows users run `scripts/install.ps1` (auto-attached
  to each release) or download the `_windows_amd64.zip` directly.
- both installers (`scripts/install.sh`, `scripts/install.ps1`) auto-attached via
  goreleaser `release.extra_files` — no manual upload.
- a **container image** to `ghcr.io/holland-built/bloxsmith` (`:latest` + `:v1.0.<n>`,
  distroless, multi-arch) — same env contract as before, drops into the existing
  `docker-compose.yml` + `noc-vault` volume unchanged.

## This REPLACED the old distribution path (Python retired 2026-07)

The Python image and its scripts are gone; the Go binary is the whole product.

| Old (Python image, deleted) | New (Go binary) |
|---|---|
| `release-image.sh` (local docker build+push) | `goreleaser release` (`dockers:` block) |
| `docker-publish.yml` CI build-push | `goreleaser release` run **locally** from `master` (see `docs/SHIP.md`); `ci.yml` only builds/tests + a snapshot |
| `Dockerfile` (`APP_VERSION` ARG) | `go/Dockerfile.goreleaser` + ldflags `-X main.version` |
| brew/Windows: none | goreleaser `brews:` block; Windows via `scripts/install.ps1` + direct zip |

## Secrets/tokens needed at real-release time (not for `--snapshot`)

- `GITHUB_TOKEN` — GitHub Release upload **and** the cross-repo push to
  `homebrew-tap` (needs `contents:write` + repo scope on that repo; a classic PAT
  if the default Actions token can't reach it).
- Registry auth for ghcr push (`docker login ghcr.io`, `write:packages`) — the
  release workflow uses the built-in `GITHUB_TOKEN`.
- Code signing (Phase 4, optional, **costs money**): Apple notarization
  (`notarize:` block, $99/yr) and Windows Authenticode are deliberately deferred —
  Homebrew and the Windows installer both install unsigned.
