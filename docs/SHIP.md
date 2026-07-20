# SHIP.md — release playbook for Bloxsmith

Repo: `github.com/holland-built/bloxsmith`. Run `/release` from anywhere in the repo.

## Environments
| Env | Branch | Default | Notes |
|-----|--------|---------|-------|
| prod | master | * | single-branch repo; push straight to master |

## Steps
1. Commit + push code. The Go single-binary app is built on `feat/go-poc` (the
   Go migration, plan 030) and releases are cut from there via goreleaser — the
   same branch v2.0.0 and v2.0.1 were tagged on. The Python/Docker path still
   lives on `master`. When the Go migration merges to master, this collapses
   back to one branch.

## Guards
- .env
- .env.*
- secrets/
- config with real API keys, tokens, or Infoblox credentials

## Release
The app is a self-updating Go binary (embedded UI, `bloxsmith update` / in-app
"Update now"). A release is a **goreleaser** run that publishes the binary
tarballs + `checksums.txt` the installer and self-update consume:

1. Tag on the release branch: `git tag vX.Y.Z && git push origin vX.Y.Z`.
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
CI signs every pushed image (keyless cosign / Sigstore OIDC) and type-checks the UI before building.

- **Verify the signature** before trusting an image:
  ```
  cosign verify ghcr.io/holland-built/bloxsmith:latest \
    --certificate-identity-regexp 'https://github.com/holland-built/bloxsmith/.+' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```
- **Pin by digest** in `docker-compose.yml` (`image: ghcr.io/holland-built/bloxsmith@sha256:<digest>`) for a reproducible, verifiable deploy. Resolve the digest with `docker buildx imagetools inspect …:latest`.
- **Updating.** The Go binary self-updates: the ⋯ menu shows "Update now", which downloads the release tarball, verifies its checksum, atomically swaps the binary and restarts (a stepped modal shows check → download → verify → apply → restart); `bloxsmith update` does the same headless. The Docker image path is still explicit/script-driven — `docker compose pull && docker compose up -d`, or the `update.command`/`update.bat`/`update.sh` scripts. Enterprise Docker updates deliberately on a pinned, verified schedule.
- **Rollback:** `./scripts/rollback.sh` reverts a boot-failed image out-of-band (recreates from `bloxsmith:previous` or a pinned digest, reusing the `noc-vault` volume) — no running app required.
