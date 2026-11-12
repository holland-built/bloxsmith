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
> Release files are also protected by an Ed25519 signature on `checksums.txt`. The public key
> is built into the program (`go/signing.go`) and pinned in both installer scripts, and the
> installer and `bloxsmith update` refuse a release whose signature is missing or wrong. See
> **Code signing** in the [README](../README.md).

- **Verify the checksum and signature**: the installer and `bloxsmith update` do both automatically
  against the release's `checksums.txt` and fail closed on a mismatch.
- **Pin by digest** in `docker-compose.yml` (`image: ghcr.io/holland-built/bloxsmith@sha256:<digest>`) for a reproducible deploy. Resolve the digest with `docker buildx imagetools inspect …:latest`.
- **Updating.** The Go binary self-updates: the ⋯ menu shows "Update now", which downloads the release tarball, verifies its checksum, atomically swaps the binary and restarts (a stepped modal shows check → download → verify → apply → restart); `bloxsmith update` does the download, verify and swap headless, but restarts nothing — that process is not a server, so a server already running keeps the old binary until you restart it (`bloxsmith service restart`, or stop and start it). The Docker image path is explicit — `docker compose pull && docker compose up -d`, or the `update.command`/`update.bat`/`update.sh` scripts. Enterprise Docker updates deliberately on a pinned schedule.
- **Rollback:** manual only — there is no automatic image rollback. `docker-compose.yml` does define a healthcheck (`CMD /app/bloxsmith healthcheck`), but nothing acts on it: `restart: unless-stopped` fires on exit, not on health, so an unhealthy container is reported and left running. The updater never touches the Docker socket either (see `go/apply.go`: it only swaps its own binary). To revert, pin the previous tag or digest in `docker-compose.yml` and run `docker compose up -d`; the `noc-vault` volume is untouched by the swap, so tenant keys survive it.

> **Make the GHCR package public (one-time)** so others pull without a login:
> `github.com/users/holland-built/packages/container/bloxsmith/settings`
> → *Change visibility* → **Public**. The source repo can stay private; package
> visibility is independent. (Otherwise each user runs `docker login ghcr.io` with a
> token that has `read:packages`.)

## How the update check works

The server checks GitHub Releases for `holland-built/bloxsmith` **only when
asked** — there is no background timer, so an idle server makes no requests at
all. `GET /api/update/check` is the check; the dashboard calls it on page load
and every 6 hours per open tab, and `bloxsmith update` calls it from the command
line. The browser never contacts GitHub directly — the server does the check and
the browser just reads the result.

The answer is remembered in memory for **30 minutes (±3 minutes)** so repeat page
loads do not each spend a request against GitHub's unauthenticated limit of 60
requests/hour, which is shared by every machine behind the same public IP. The
response says which it is: `cached` (true/false) and `checkedAt` (when GitHub was
actually contacted). A failed check reports `error` and is never replaced by the
last good answer — "the check failed" and "you are up to date" are different
answers and render differently. Applying an update always fetches fresh; the
cache is on the check only. The cache is per process — restarting the server
clears it.

`GET /api/vault/status` also embeds an `update` object, but only
`{current, checkDisabled, selfUpdate}` in it carry information; its `latest`,
`available` and `url` are always empty/false placeholders because that endpoint
does no network call. `/api/update/check` is the only source of a real answer.

`DISABLE_UPDATE_CHECK=1` stops `GET /api/update/check` contacting GitHub. It
returns the running version plus `checkDisabled: true` and no `latest` —
**deliberately not the same as "you are on the newest version"**, since nothing
was looked up; the dashboard then shows no update UI at all. Honest scope: this
switches off the automatic/browser-driven check only. Explicitly running
`bloxsmith update`, or `POST /api/update/apply`, still contacts GitHub — those
are direct operator requests to update, not background polling.

## What's inside a release (SBOM)

### The SBOM (what's inside the release)

Every release also publishes an **SBOM** — a machine-readable list of the
libraries compiled into the binary — one per archive, named
`<archive-name>.sbom.json`. That is what to hand a security review that asks
what the software is made of, and what to grep the morning a CVE lands in a Go
module.

Format is **SPDX 2.3 JSON**, produced by [syft](https://github.com/anchore/syft).
Contents are the Go module graph read back out of the compiled binary — direct
and transitive dependencies with exact versions, plus a `stdlib` entry pinning
the Go toolchain the release was built with.

Fetch one and read it:

```bash
# the release version to check, without the leading v
V=3.70.6
# the download folder for that release
BASE=https://github.com/holland-built/bloxsmith/releases/download/v$V
# download the Linux amd64 dependency list (SBOM)
curl -fsSLO "$BASE/bloxsmith_${V}_linux_amd64.tar.gz.sbom.json"

# every dependency and its version
jq -r '.packages[] | "\(.name) \(.versionInfo)"' "bloxsmith_${V}_linux_amd64.tar.gz.sbom.json"
```

The SBOM is signed the same way everything else in the release is — cosign
keyless, with the release workflow's GitHub OIDC identity, no key stored
anywhere. Verify it before trusting it:

```bash
# download the SBOM's signature
curl -fsSLO "$BASE/bloxsmith_${V}_linux_amd64.tar.gz.sbom.json.sig"
# download the certificate that goes with the signature
curl -fsSLO "$BASE/bloxsmith_${V}_linux_amd64.tar.gz.sbom.json.pem"

# check the SBOM was signed by this repo's release workflow
cosign verify-blob \
  --certificate "bloxsmith_${V}_linux_amd64.tar.gz.sbom.json.pem" \
  --signature   "bloxsmith_${V}_linux_amd64.tar.gz.sbom.json.sig" \
  --certificate-identity-regexp '^https://github\.com/holland-built/bloxsmith/\.github/workflows/release\.yml@refs/tags/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "bloxsmith_${V}_linux_amd64.tar.gz.sbom.json"
```

Each SBOM is also listed in `checksums.txt`, so it is covered by that file's
Ed25519 and `ssh-keygen` signatures as well. The standalone `.sig`/`.pem` pair
exists because an SBOM is the one artifact that gets forwarded on its own —
attached to a ticket, uploaded to a vendor portal — where `checksums.txt` is
nowhere in sight.

#### The dashboard UI's npm dependencies

The archive SBOMs above are read out of the **compiled binary**, and the web UI
inside it (`go/web/`, an `index.html` plus hashed `assets/*.js`) is the built UI,
embedded with `go:embed`.
Nothing in a Go module list can see React, recharts or tailwind, so a fifth
document is published alongside them:

```bash
# download the web UI's dependency list
curl -fsSLO "$BASE/bloxsmith_${V}_ui_npm.sbom.json"
# list every UI package and its version, sorted
jq -r '.packages[] | "\(.name) \(.versionInfo)"' "bloxsmith_${V}_ui_npm.sbom.json" | sort
```

Same format, same signing, same `checksums.txt` entry as the archive SBOMs. It is
built from `ui/package-lock.json` rather than from the bundle, and it is the
**production dependency closure** — the packages whose code can reach the bundle.
`devDependencies` are excluded, so the linter and the type stubs are not in it.

One thing that looks wrong and is not: `vite` and its `@rolldown/*` bindings
*are* listed even though `vite` sits in `devDependencies`. `@tailwindcss/vite` is
a production dependency and peer-depends on vite, so npm does not mark vite
dev-only and it is genuinely part of the production closure. The set is therefore
a **superset** of what literally ends up in `go/web/assets/` — it also carries
build-time tools reachable from a production dependency, such as tailwind itself.
That is the deliberate direction to err in: it over-reports rather than hiding
something that shipped.

### The container image's SBOM (attestation)

`docker run` is the first install path in the README, and until now it was the
one artifact with no ingredients list at all. The pushed image now carries its
SBOM as a **cosign attestation** — signed with the same keyless GitHub OIDC
identity as the image signature, stored in the registry beside the image, and
covering **every architecture separately**.

`ghcr.io/holland-built/bloxsmith:<tag>` is a multi-arch index, and `cosign attest`
has no recursive mode, so an attestation on the tag would be one architecture's
SBOM claiming to describe both. Nothing is attached to the index for that reason.
**Resolve the architecture digest first:**

```bash
# the release version to check, without the leading v
V=3.70.6
# the image to check
IMAGE=ghcr.io/holland-built/bloxsmith
# your computer type: amd64, or arm64 for Apple silicon and ARM servers
ARCH=amd64

# find the image ID for your computer type
DIGEST=$(docker buildx imagetools inspect --raw "$IMAGE:$V" \
  | jq -r --arg a "$ARCH" '.manifests[] | select(.platform.architecture == $a) | .digest')

# check the attached dependency lists were signed by the release workflow, then print them
cosign verify-attestation --type spdxjson \
  --certificate-identity-regexp '^https://github\.com/holland-built/bloxsmith/\.github/workflows/release\.yml@refs/tags/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$IMAGE@$DIGEST" \
  | jq -r '.payload | @base64d | fromjson | .predicate
           | "\(.name):", (.packages[] | "  \(.name) \(.versionInfo)")'
```

Two attestations come back per architecture, and the `.predicate.name` tells them
apart:

| `.predicate.name` | What it lists |
|---|---|
| `ghcr.io/holland-built/bloxsmith` | The image scanned in the registry — the Go module graph **and** the distroless base's own packages (`base-files`, `media-types`, `netbase`, `tzdata`, `tzdata-legacy`) with their Debian versions |
| `bloxsmith-ui-npm` | The same UI npm closure published as a release artifact above — attached here too, because the bundle is inside the binary inside this image |

Together those two are the whole image. `<tag>` and `latest` resolve to the same
index, so both are covered by the same per-architecture attestations.

> **What is still not covered.** Two things, and neither is hidden by a green
> check elsewhere:
>
> The **UI SBOM is derived from the lockfile, not from the shipped bundle.** It
> says what the bundle was built from; it does not prove `go/web/assets/` was built
> from exactly that. The check that ties the two together is a different one — the
> "UI dist up to date" step in [ci.yml](../.github/workflows/ci.yml) rebuilds the
> bundle from `ui/` and fails if `go/web/` differs.
>
> The **`ghcr.io` image attestation only exists for releases cut after this
> change**. Tags published earlier have a cosign image *signature* but no SBOM
> attestation, and `cosign verify-attestation` against them will correctly find
> nothing. For those, generate one yourself:
> `syft ghcr.io/holland-built/bloxsmith:<tag> -o spdx-json`.
