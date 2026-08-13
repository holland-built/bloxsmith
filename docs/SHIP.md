# SHIP.md — release playbook for Bloxsmith

Repo: `github.com/holland-built/bloxsmith`. Run `/release` from anywhere in the repo.

**This file is the detail. The repo-root `SHIP.md` is the steps** — and it is the
only one `/release` executes (it resolves `$REPO_ROOT/SHIP.md`). Read that one to
ship; read this one to understand what shipping does.

## Environments
| Env | Branch | Default | Notes |
|-----|--------|---------|-------|
| prod | master | * | single-branch repo; push straight to master |

## Steps

Summarised from the root `SHIP.md`, which is authoritative. Do not follow this
section instead of that one — this copy exists so the reference below has
something to attach to.

1. **Rebuild the UI into `go/web` before anything else.**
   `cd ui && npm run build && rm -rf ../go/web/* && cp -R dist/* ../go/web/`, then
   commit `go/web` if it changed. The Go binary embeds `go/web` (`go:embed all:web`
   in `go/embed.go`), so a release built without this step ships the *previous*
   UI while every local check passes. `ci.yml`'s first job diffs `ui/dist` against
   `go/web` and fails the build if they differ — its error message is this exact
   command. This step was missing from this file entirely until 2026-08-11.
2. Commit + push to `master`. Single-branch repo: the Go single-binary app
   (plan 030) lives on `master` and releases are cut from it via goreleaser.
3. Ask `bash scripts/needs-tag.sh` whether this push is a release, and do what it
   says. `tag` → `git tag vX.Y.Z && git push origin vX.Y.Z`; `skip` → the push is
   the whole thing, stop. Pushing `master` alone publishes nothing; the tag is what
   fires `release.yml` — which is the point, because a change that ships nothing to
   a customer should not fire it. The rule is a path list rather than a judgment
   call, it lives in the script, and `--selftest` pins it. Root `SHIP.md` step 4
   carries the full reasoning and the two releases that prompted it (`v3.65.3`, a
   README edit, and `6bc5ee3`, test files) — do not restate it here and let the two
   drift again.

**On "the Python/Docker path was removed".** What went away is the *Python* app and
its container — there is no `requirements.txt`, no FastAPI image, and the only
Dockerfile left is `go/Dockerfile.goreleaser`. Docker itself is very much alive:
`docker-compose.yml` runs `ghcr.io/holland-built/bloxsmith:latest`, and the whole
image, signing and rollback story below is current. An earlier wording of this line
read as though all Docker had been retired, which contradicted the rest of the file.

## Guards

Kept identical to the root `SHIP.md`'s copy. Both lists previously named different
things and neither contained the other; worse, this one named `.env.*` and
`secrets/` as guarded when `.gitignore` covered only `.env` — a promise the repo
did not keep until 2026-08-11.

Never committed — enforced by `.gitignore`, not by remembering. Check any one of
them with `git check-ignore -v <path>`:
- `.env`, and `.env.*` — except `.env.example`, the tracked template
- `secrets/`
- `vault.json` — the encrypted tenant key store
- `.vault-passphrase`

Never touched by a release, and outside the repo, so git cannot see them anyway:
- `~/Library/LaunchAgents/*.plist` — the machine-local service definition
- `/tmp/bloxsmith-dev` — the dev binary `scripts/dev-serve.sh` builds and owns

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
- **Rollback:** manual only — there is no automatic image rollback. `docker-compose.yml` does define a healthcheck (`CMD /app/bloxsmith healthcheck`), but nothing acts on it: `restart: unless-stopped` fires on exit, not on health, so an unhealthy container is reported and left running. The updater never touches the Docker socket either (see `go/apply.go`: it only swaps its own binary). To revert, pin the previous tag or digest in `docker-compose.yml` and run `docker compose up -d`; the `noc-vault` volume is untouched by the swap, so tenant keys survive it.
