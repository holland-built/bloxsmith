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
"Update now"). A release is a **goreleaser** run that publishes the binary
tarballs + `checksums.txt` the installer and self-update consume:

1. Tag on `master`: `git tag vX.Y.Z && git push origin vX.Y.Z`.
2. `cd go && GITHUB_TOKEN=$(gh auth token) goreleaser release --clean`
   → GitHub Release (per-OS tarballs + `checksums.txt`), Homebrew tap, winget
   PR, and the ghcr image.
3. `install.sh` is NOT built by goreleaser (it lives at repo-root `scripts/`);
   attach it so `releases/latest/download/install.sh` keeps working:
   `gh release upload vX.Y.Z scripts/install.sh`.

Prerequisites (each an independent channel — a missing one only skips that
channel, use `--skip=docker,winget,homebrew` to bypass):
- **ghcr image**: `docker login ghcr.io -u holland-built` with a PAT that has
  `write:packages` (the gh CLI token does NOT carry this scope).
- **Homebrew**: a `holland-built/homebrew-tap` repo must exist.
- **winget**: a `holland-built/winget-pkgs` fork of `microsoft/winget-pkgs`
  must exist.

## Enterprise deploy hardening
> **Signing status (truth):** releases are cut **locally** and are currently
> **unsigned** — there is no CI signing. The retired `docker-publish.yml` did keyless
> cosign signing; that step was removed with the Python/Docker path. Signature
> verification (cosign) is a **planned** hardening step, not a shipped guarantee. The
> installer/self-update still verify the release **checksum** (`checksums.txt`), which
> catches corruption/truncation but not publisher identity.

- **Verify the checksum** — the installer and `bloxsmith update` do this automatically
  against the release's `checksums.txt` (fail-closed on mismatch).
- **Pin by digest** in `docker-compose.yml` (`image: ghcr.io/holland-built/bloxsmith@sha256:<digest>`) for a reproducible deploy. Resolve the digest with `docker buildx imagetools inspect …:latest`.
- **Updating.** The Go binary self-updates: the ⋯ menu shows "Update now", which downloads the release tarball, verifies its checksum, atomically swaps the binary and restarts (a stepped modal shows check → download → verify → apply → restart); `bloxsmith update` does the same headless. The Docker image path is explicit — `docker compose pull && docker compose up -d`, or the `update.command`/`update.bat`/`update.sh` scripts. Enterprise Docker updates deliberately on a pinned schedule.
- **Rollback:** if a new image fails its health check, the in-app updater auto-reverts to the previous image (tagged `bloxsmith:rollback`, reusing the `noc-vault` volume).
