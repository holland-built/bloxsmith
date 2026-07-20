# SHIP.md — release playbook for Bloxsmith

Repo: `github.com/holland-built/bloxsmith`. Run `/release` from anywhere in the repo.

## Environments
| Env | Branch | Default | Notes |
|-----|--------|---------|-------|
| prod | master | * | single-branch repo; push straight to master |

## Steps
1. Commit + push code to `master`. This is a single-branch repo: the Go
   single-binary app (plan 030) lives on `master` and releases are cut from
   `master` via goreleaser. The retired Python/Docker path has been removed.

## Guards
- .env
- .env.*
- secrets/
- config with real API keys, tokens, or Infoblox credentials

## Release
The app is a self-updating Go binary (embedded UI, `bloxsmith update` / in-app
"Update now"). A release publishes the binary tarballs + `checksums.txt` the
installer and self-update consume, plus a multi-arch ghcr image.

### Canonical: tag-triggered CI (`.github/workflows/release.yml`)
1. Tag on `master`: `git tag vX.Y.Z && git push origin vX.Y.Z`.
2. The push fires `release.yml`, which runs goreleaser in CI and produces:
   - **GitHub Release**: per-OS tarballs + `checksums.txt` + both install
     scripts (`install.sh`, `install.ps1`) via `release.extra_files`.
   - **ghcr image**: multi-arch (amd64+arm64), **cosign keyless-signed** (GitHub
     OIDC identity, `id-token: write` — no stored key).
   - **Templates**: third-party demo/seed templates are fetched by goreleaser's
     `before` hook and bundled into every archive (next to the binary) and into
     the image at `/templates`.
   - **Homebrew tap**: published **iff** the `HOMEBREW_TAP_TOKEN` repo secret
     exists (PAT with repo scope on `holland-built/homebrew-tap`). Absent → CI
     runs `--skip=homebrew` and the release still succeeds; only brew is skipped.

### Manual fallback (local goreleaser)
`cd go && cp ../scripts/install.sh ../scripts/install.ps1 . && GITHUB_TOKEN=$(gh auth token) goreleaser release --clean`

(The `cp` stages the installers into `go/` for `release.extra_files` — a `../`
glob trips goreleaser's zglob at publish time; the copies are gitignored.)

Requires:
- `docker login ghcr.io -u holland-built` with a PAT that has `write:packages`
  (the gh CLI token does NOT carry this scope).
- **python3 + network** for the template-fetch `before` hook.
- **cosign installed** (`brew install cosign`) — the `docker_signs:` stage runs
  on any real `release`. If you can't/won't sign locally, pass `--skip=sign`.
- Homebrew push uses `GITHUB_TOKEN` unless `HOMEBREW_TAP_TOKEN` is exported.
- Bypass any channel with `--skip=docker,homebrew,sign` as needed.

## Enterprise deploy hardening
> **Signing status (truth):** the tag-triggered CI (`release.yml`) **cosign
> keyless-signs the multi-arch ghcr images** (GitHub OIDC identity — no stored
> key). Verify with:
> ```
> cosign verify ghcr.io/holland-built/bloxsmith:<tag> \
>   --certificate-identity-regexp '^https://github\.com/holland-built/bloxsmith/\.github/workflows/release\.yml@refs/tags/' \
>   --certificate-oidc-issuer https://token.actions.githubusercontent.com
> ```
> **Binary tarballs remain checksum-verified only** (`checksums.txt`), not
> signature-signed — the installer/self-update verify the checksum, which catches
> corruption/truncation but not publisher identity.

- **Verify the checksum** — the installer and `bloxsmith update` do this automatically
  against the release's `checksums.txt` (fail-closed on mismatch).
- **Pin by digest** in `docker-compose.yml` (`image: ghcr.io/holland-built/bloxsmith@sha256:<digest>`) for a reproducible deploy. Resolve the digest with `docker buildx imagetools inspect …:latest`.
- **Updating.** The Go binary self-updates: the ⋯ menu shows "Update now", which downloads the release tarball, verifies its checksum, atomically swaps the binary and restarts (a stepped modal shows check → download → verify → apply → restart); `bloxsmith update` does the same headless. The Docker image path is explicit — `docker compose pull && docker compose up -d`, or the `update.command`/`update.bat`/`update.sh` scripts. Enterprise Docker updates deliberately on a pinned schedule.
- **Rollback:** if a new image fails its health check, the in-app updater auto-reverts to the previous image (tagged `bloxsmith:rollback`, reusing the `noc-vault` volume).
