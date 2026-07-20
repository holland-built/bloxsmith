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
mode it reads `<X.Y.Z+1>-snapshot-<commit>` (incpatch of the last semver tag).
Verify a produced binary:

```bash
./dist/bloxsmith_darwin_all/bloxsmith --version         # prints the stamped version
PORT=8099 ./dist/bloxsmith_darwin_all/bloxsmith &        # boot it
curl -s localhost:8099/api/update/check                  # "current" == stamped version
curl -s localhost:8099/ | head                           # embedded UI (index.html) loads
```

## Real release (publishes)

Canonical path is the **tag-triggered CI workflow** (`.github/workflows/release.yml`):
cut a **semver** tag on `master` and push it — CI runs goreleaser (see `docs/SHIP.md`).

```bash
git tag vX.Y.Z          # semver, e.g. v2.2.0
git push origin vX.Y.Z
```

Local fallback: stage the installers into `go/` first (goreleaser's
`release.extra_files` globs them without a `../` prefix, which its zglob rejects
at publish time — the copies are gitignored):

```bash
cd go && cp ../scripts/install.sh ../scripts/install.ps1 .
GITHUB_TOKEN=$(gh auth token) goreleaser release --clean
```

The release (CI, or the local `cd go && goreleaser release --clean` fallback)
produces and publishes:
- per-OS archives (`.tar.gz`, Windows `.zip`) + `checksums.txt` (go-selfupdate verifies against it)
- a **GitHub Release** (tag `vX.Y.Z`) — the in-app update banner keys off this
- the third-party demo/seed **templates**, fetched by goreleaser's `before` hook
  and bundled into each archive (next to the binary) and the image at `/templates`
- a **Homebrew formula** pushed to `holland-built/homebrew-tap`
  → `brew install holland-built/tap/bloxsmith` (CI: gated on `HOMEBREW_TAP_TOKEN`)
- **Windows**: no winget. Windows users run `scripts/install.ps1` (auto-attached
  to each release) or download the `_windows_amd64.zip` directly.
- both installers (`scripts/install.sh`, `scripts/install.ps1`) auto-attached via
  goreleaser `release.extra_files` — no manual upload.
- a **container image** to `ghcr.io/holland-built/bloxsmith` (`:latest` + `:vX.Y.Z`,
  distroless, multi-arch), **cosign keyless-signed** in CI — same env contract as
  before, drops into the existing `docker-compose.yml` + `noc-vault` volume unchanged.

## This REPLACED the old distribution path (Python retired 2026-07)

The Python image and its scripts are gone; the Go binary is the whole product.

| Old (Python image, deleted) | New (Go binary) |
|---|---|
| `release-image.sh` (local docker build+push) | `goreleaser release` (`dockers:` block) |
| `docker-publish.yml` CI build-push | tag-triggered `.github/workflows/release.yml` runs `goreleaser release` + cosign-signs images (local goreleaser is the fallback, see `docs/SHIP.md`); `ci.yml` only builds/tests + a snapshot |
| `Dockerfile` (`APP_VERSION` ARG) | `go/Dockerfile.goreleaser` + ldflags `-X main.version` |
| brew/Windows: none | goreleaser `brews:` block; Windows via `scripts/install.ps1` + direct zip |

## Secrets/tokens needed at real-release time (not for `--snapshot`)

- `GITHUB_TOKEN` — GitHub Release upload **and** the cross-repo push to
  `homebrew-tap` (needs `contents:write` + repo scope on that repo; a classic PAT
  if the default Actions token can't reach it).
- Registry auth for ghcr push (`docker login ghcr.io`, `write:packages`) — the
  release workflow uses the built-in `GITHUB_TOKEN`.
- `HOMEBREW_TAP_TOKEN` (CI, optional) — PAT with repo scope on `homebrew-tap` to
  enable the brew channel in CI; absent → CI runs `--skip=homebrew`, release still succeeds.
- ghcr **image** signing is **live**: `release.yml` cosign keyless-signs the images
  (GitHub OIDC, `id-token: write` — no stored key). Binary code signing (Apple
  notarization `$99/yr`, Windows Authenticode) stays deliberately deferred — the
  standalone binary and Homebrew/Windows installs remain unsigned (checksum-verified).
