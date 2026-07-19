# SHIP.md — release playbook for Bloxsmith

Repo: `github.com/holland-built/bloxsmith`. Run `/release` from anywhere in the repo.

## Environments
| Env | Branch | Default | Notes |
|-----|--------|---------|-------|
| prod | master | * | single-branch repo; push straight to master |

## Steps
1. Commit + push `master`. (Automatic GitHub builds are OFF — pushing code no
   longer builds an image; the image is published in the Release step below.)

## Guards
- .env
- .env.*
- secrets/
- config with real API keys, tokens, or Infoblox credentials

## Release
Publish the runnable image so users can update to it — this is what makes
`/release` a single command that ships both code AND a new version:

1. `./scripts/release-image.sh` — builds the image with the version baked in and pushes
   it to `ghcr.io/holland-built/bloxsmith:latest` + `:v1.0.<n>`.
2. `gh release create v1.0.<n> --generate-notes --target master` — cuts the
   GitHub release so the in-app "update available" banner sees the new version.

One-time prerequisite: log in to the registry with a token that has
`write:packages` scope — `docker login ghcr.io -u holland-built` (paste a PAT
from github.com/settings/tokens at the prompt). After that, `/release` publishes
in one shot.

## Enterprise deploy hardening
CI signs every pushed image (keyless cosign / Sigstore OIDC) and type-checks the UI before building.

- **Verify the signature** before trusting an image:
  ```
  cosign verify ghcr.io/holland-built/bloxsmith:latest \
    --certificate-identity-regexp 'https://github.com/holland-built/bloxsmith/.+' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```
- **Pin by digest** in `docker-compose.yml` (`image: ghcr.io/holland-built/bloxsmith@sha256:<digest>`) for a reproducible, verifiable deploy. Resolve the digest with `docker buildx imagetools inspect …:latest`.
- **Updating is explicit and script-driven.** The app only *signals* a newer version (banner in the ⋯ menu with a release-notes link); it never touches Docker. To apply, double-click the update script that ships next to the app (`update.command` on macOS, `update.bat` on Windows, `update.sh` on Linux), or run `docker compose pull && docker compose up -d`. Enterprise updates deliberately on a pinned, verified schedule.
- **Rollback:** `./rollback.sh` reverts a boot-failed image out-of-band (recreates from `bloxsmith:previous` or a pinned digest, reusing the `noc-vault` volume) — no running app required.
