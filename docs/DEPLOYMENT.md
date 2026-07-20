# Deployment & reference

Full reference for **Bloxsmith**. For the 30-second start see the
[README](../README.md#quick-start); this doc covers every install path, the
environment variables, LLM providers, and security.

- [Standalone binary (no Docker)](#standalone-binary-no-docker)
- [SE demo path (docker run)](#se-demo-path-docker-run)
- [Customer path (compose)](#customer-path-compose)
- [Updating](#updating)
- [Install from the prebuilt image](#install-from-the-prebuilt-image)
- [Build from source (dev)](#build-from-source-dev)
- [Provisioning templates](#provisioning-templates)
- [Getting the keys](#getting-the-keys)
- [Using a different LLM provider](#using-a-different-llm-provider)
- [Environment variables](#environment-variables)
- [Auto-unlock after an upgrade](#auto-unlock-after-an-upgrade)
- [Security notes](#security-notes)

---

## Standalone binary (no Docker)

A single self-contained binary, published on GitHub Releases. Nothing else is
required — no Docker, no Python, no checkout. macOS and Linux:

```bash
curl --proto '=https' --tlsv1.2 -fsSLo install.sh https://github.com/holland-built/bloxsmith/releases/latest/download/install.sh && less install.sh && sh install.sh
```

The two-step form is deliberate: you read the script before it runs. The
installer detects your OS/arch, downloads the matching release asset, verifies
its SHA-256 against the release's `checksums.txt` (**fail-closed** — a mismatch
aborts without installing), and installs to `$HOME/.local/bin`. No sudo.

| Flag | Effect |
|------|--------|
| `--version vX.Y.Z` | Pin an exact release instead of `latest` |
| `--prefix DIR` | Install somewhere other than `$HOME/.local/bin` |
| `--help` | Usage |

Then `bloxsmith` starts it, `bloxsmith service install` registers it to run in
the background at login, and `bloxsmith update` upgrades in place.

> Checksum verification detects a corrupt or truncated download; it does **not**
> prove publisher identity, since checksums ship alongside the archive.
> The multi-arch **ghcr images** are now cosign keyless-signed in CI (GitHub OIDC
> identity — verify with `cosign verify ghcr.io/holland-built/bloxsmith:<tag>
> --certificate-identity-regexp '^https://github\.com/holland-built/bloxsmith/\.github/workflows/release\.yml@refs/tags/'
> --certificate-oidc-issuer https://token.actions.githubusercontent.com`); the
> standalone binary remains checksum-only.

### Windows

No winget. The primary path is **download-inspect-run** `install.ps1` — no admin,
no Docker:

```powershell
iwr -UseBasicParsing -OutFile install.ps1 https://github.com/holland-built/bloxsmith/releases/latest/download/install.ps1
# review install.ps1, then run it (for this process only):
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` resolves the latest version from `checksums.txt`, downloads
`bloxsmith_<ver>_windows_amd64.zip`, verifies its SHA-256 (**fail-closed**),
installs `bloxsmith.exe` to `%LOCALAPPDATA%\Programs\Bloxsmith`, and adds that
dir to your **user** PATH (reopen the shell to pick it up). Flags: `-Version
vX.Y.Z` to pin, `-Prefix DIR` to install elsewhere.

Secondary path — skip the script and download the
`bloxsmith_<ver>_windows_amd64.zip` directly from the
[latest release](https://github.com/holland-built/bloxsmith/releases/latest),
unzip it, and run `bloxsmith.exe`.

The app self-updates in place (in-app **Update now** / `bloxsmith update`) — there
is no `winget upgrade` step. As with the shell installer, the SHA-256 check proves
integrity, not publisher identity; the binary is unsigned (the container images
are cosign-signed in CI, but the standalone binary is not).

> **Note:** install.ps1 is new and tested on PowerShell 5.1+/7 — run it once on a
> real Windows machine to confirm before advertising it for wide use.

---

## SE demo path (docker run)

You're an Infoblox SE showing this on a laptop or a customer LAN with Docker.
Pull and run the prebuilt Go image directly:

```bash
# localhost → http://localhost:8080
docker run -d --name bloxsmith -p 127.0.0.1:8080:8080 \
  -v noc-vault:/vault -v /var/run/docker.sock:/var/run/docker.sock \
  --restart unless-stopped ghcr.io/holland-built/bloxsmith:latest

# LAN → bind all interfaces, reachable at http://<host-ip>:8080
#   swap 127.0.0.1: for 0.0.0.0: in the -p flag above
```

Mounting `/var/run/docker.sock` lets the in-app self-update work; drop that `-v` to
disable it. For an unattended vault auto-unlock passphrase, see
[Auto-unlock](#auto-unlock-after-an-upgrade). Re-running with `:latest` after a
`docker pull` picks up the newest release — see [Updating](#updating).

> ⚠️ **No login on LAN.** Anyone who can reach the port can use the dashboard.
> On a trusted LAN, keep the vault **locked** when not presenting (don't set an
> auto-unlock passphrase). On an untrusted network, use the `secure` Caddy profile
> or a VPN.

---

## Customer path (compose)

You're self-hosting this permanently on a server/VM (Proxmox, NUC, cloud).
**Compose** is recommended — env vars (including the Watchtower fallback wiring)
survive Docker restarts automatically, and the compose file mounts the Docker
socket so the in-app self-update works.

```bash
git clone https://github.com/holland-built/bloxsmith && cd bloxsmith
cp .env.example .env        # fill in INFOBLOX_API_KEY; WATCHTOWER_TOKEN is pre-set
docker compose up -d                       # dashboard (loopback)
BIND=0.0.0.0 docker compose up -d          # expose on the LAN
docker compose --profile secure up -d      # + Caddy reverse proxy (TLS + basic-auth)
```

> **Updating `.env`:** after `git pull`, compare `.env` with `.env.example` — add any
> new variables shown in the example; your existing values are preserved.

For the `secure` profile set `BIND=127.0.0.1` (dashboard stays loopback, all access
goes through Caddy on `:8443`) and a basic-auth hash in `.env`:

```bash
docker run --rm caddy caddy hash-password -p 'yourpassword'   # paste into BASIC_AUTH_HASH
```

| Scenario | Command | URL |
|----------|---------|-----|
| Localhost (compose) | `docker compose up -d` | http://localhost:8080 |
| Server (LAN, compose) | `BIND=0.0.0.0 docker compose up -d` | http://host-ip:8080 |
| Server (secure) | `docker compose --profile secure up -d` | https://host-ip:8443 (login) |
| Desktop / no-clone | `docker run … ghcr.io/holland-built/bloxsmith:latest` | http://localhost:8080 |
| Laptop / no Docker | `bloxsmith` (standalone binary) | http://localhost:8080 |

Tenant keys live AES-encrypted in the `noc-vault` Docker volume — they survive
updates, restarts, and container recreation. For unattended restarts (no browser
step to re-enter the passphrase), see `VAULT_PASSPHRASE_FILE` in
[Auto-unlock](#auto-unlock-after-an-upgrade).

---

## Updating

**Standalone binary:** `bloxsmith update` (or the in-app **Update now** button) —
downloads the release tarball, verifies its checksum, and swaps the binary in place.

**SE demo (Docker):** `docker pull ghcr.io/holland-built/bloxsmith:latest && docker
restart bloxsmith`, or use the in-app **Update now** button.

**Customer:** `docker compose pull && docker compose up -d`, or use the in-app
**Update now** button.

The server checks GitHub Releases for `holland-built/bloxsmith` once a day in the
background (current version is `1.0.<commit-count>`) and exposes
`update:{current,latest,available,url,selfUpdate,cooldown}` in
`GET /api/vault/status`. `GET /api/update/check` forces an immediate check;
`DISABLE_UPDATE_CHECK=1` opts out entirely. The browser never contacts GitHub
directly — the server does the check and the browser just reads the status.

Clicking **Update now** pre-pulls the `:latest` image over the mounted Docker
socket, health-checks the candidate before switching to it, and recreates itself.
If the new image fails its health check, it auto-rolls back to the previous image
(tagged `bloxsmith:rollback`). This requires `/var/run/docker.sock` to be mounted,
which compose does by default (remove the socket line to disable it).

Compose also ships a Watchtower sidecar in HTTP-API mode (no polling) as an
alternate trigger; the in-app button does not require it.

There is **no unattended auto-update and no polling updater** — the daily check
only surfaces availability. Applying an update is always a user action, whether
that's the button click or the manual command above.

---

## Install from the prebuilt image

No source checkout, no build — just Docker. Releases are cut by the tag-triggered
CI workflow ([release.yml](../.github/workflows/release.yml)), which runs goreleaser
to publish AND cosign keyless-sign the multi-arch image to GitHub Container Registry
(GHCR) alongside the binary tarballs (see [SHIP.md](SHIP.md)); local goreleaser is
the manual fallback. The push/PR CI ([ci.yml](../.github/workflows/ci.yml)) only
builds and tests the tree — it does not publish or sign images.

```bash
docker run -d --name bloxsmith -p 127.0.0.1:8080:8080 \
  -v noc-vault:/vault \
  --restart unless-stopped \
  ghcr.io/holland-built/bloxsmith:latest
# → http://localhost:8080   (loopback only; use BIND=0.0.0.0 / the script to expose on the LAN)
```

No keys on the command line. On first open the dashboard walks you through a
quick **setup**: pick a passphrase, then add one or more **tenants** (a name + its
Infoblox API key, with an optional Groq key for the AI box). Keys are
**AES-encrypted at rest** in the `noc-vault` volume under your passphrase. Switch
between tenants any time from the sidebar.

Pin a release with a tag (`:v1.0.0`, `:1.0.0`, or `:1.0`) instead of `:latest`.

> **Single key via env (skip the vault):** pass `-e INFOBLOX_API_KEY="Token <key>"`
> (and optionally `-e GROQ_API_KEY=...`); the dashboard loads straight to data.
> Drop `-v noc-vault:/vault` in that case.

> **Make the GHCR package public (one-time)** so others pull without a login:
> `github.com/users/holland-built/packages/container/bloxsmith/settings`
> → *Change visibility* → **Public**. The source repo can stay private; package
> visibility is independent. (Otherwise each user runs `docker login ghcr.io` with a
> token that has `read:packages`.)

This manual `docker run` is the always-works fallback behind both the
[SE demo path](#se-demo-path-docker-run) and the
[Customer path](#customer-path-compose) above.

---

## Build from source (dev)

Use this if you're developing or want to build the binary locally instead of pulling
the image. Requires **Go 1.26+** and **Node** (to rebuild the embedded UI).

```bash
git clone https://github.com/holland-built/bloxsmith && cd bloxsmith
node scripts/build_ui.js              # compile src/*.jsx → go/web/app.bundle.js (embedded)
cd go && go build -o bloxsmith .      # single self-contained binary with the UI baked in
./bloxsmith                           # → http://localhost:8080
```

Keys are read from the environment or the in-app vault at runtime — nothing is baked
into the binary. Point at a `.env` by exporting the vars (`set -a; . ../.env; set +a`)
before launching, or set the provider and tenant keys in the dashboard on first open.
See [go/BUILD.md](../go/BUILD.md) for cross-compilation and the goreleaser build.

### Build the container image locally

```bash
cd go && go build -o bloxsmith .
docker build -f Dockerfile.goreleaser -t bloxsmith .   # distroless image around the binary
```

### Manage

```bash
docker logs -f bloxsmith     # watch logs
docker rm -f bloxsmith       # stop + remove
docker start bloxsmith       # restart existing
PORT=8090 ./bloxsmith        # standalone binary on a different port
```

---

## Getting the keys

### Infoblox API key (required)

1. Sign in to <https://csp.infoblox.com>.
2. Top-right user menu → **User API Keys** → **Create**.
3. Copy the token. Use it as-is — the dashboard adds the `Token ` prefix automatically.

> **Interactive vs service keys:** an interactive *User API Key* carries your user's
> full account list and enables the in-dashboard account switcher. A *Service API
> Key* is bound to a single account — the dashboard works, but the switcher hides.

### Account switching

If your key's user belongs to more than one CSP account, the sidebar footer shows a
**⇄ Switch account** menu with search. Switching mints a scoped session JWT via the
CSP `account_switch` API — the dashboard reloads with that tenant's data and the JWT
auto-refreshes before its ~1 h expiry. The home account always uses the long-lived
key, so you can never be locked out. With a single-account key the footer shows
`single-account key — switching off`.

---

## Using a different LLM provider

The natural-language query box uses an LLM with tool-calling. Everything else works
**without** it. In vault mode, set the provider in the dashboard (sidebar →
**⚙ AI provider**); the env vars below are for single-key (env) mode.

**Default: Groq free tier** (recommended for demos — fast LPU inference, free models
with tool-calling, generous demo limits). Get a key at <https://console.groq.com> →
**API Keys → Create**.

Any **OpenAI-compatible** provider works via three env vars (`LLM_API_KEY` overrides
`GROQ_API_KEY`):

| Var            | Default            | Purpose                      |
|----------------|--------------------|------------------------------|
| `LLM_API_KEY`  | `GROQ_API_KEY`     | API key for the provider     |
| `LLM_MODEL`    | `qwen/qwen3-32b`   | Model name                   |
| `LLM_BASE_URL` | _(blank = Groq)_   | OpenAI-compatible base URL   |

```bash
# Groq (default) — leave LLM_BASE_URL blank
GROQ_API_KEY=gsk_...
LLM_MODEL=qwen/qwen3-32b

# OpenAI
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
LLM_BASE_URL=https://api.openai.com/v1

# Together.ai
LLM_API_KEY=...
LLM_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo
LLM_BASE_URL=https://api.together.xyz/v1

# Local Ollama (from inside Docker, reach the host)
LLM_MODEL=llama3.1
LLM_BASE_URL=http://host.docker.internal:11434/v1
```

The provider must support OpenAI-style **function/tool calling** — the query box
routes through tools (`get_subnets`, `get_hosts`, `search_entity`, …). The native
Anthropic API uses a different tool-call shape and is not drop-in; use an
OpenAI-compatible gateway for Claude.

---

## Provisioning templates

The provisioning tools read their YAML/JSON templates from disk at `TEMPLATES_DIR`
(default `/templates` in the container, the binary's own directory standalone).
**These templates are not yet packaged into the distroless container image** — a
known follow-up. Until then, provisioning that relies on bundled templates needs a
`TEMPLATES_DIR` mounted from the host (e.g. `-v ./templates:/templates`).

---

## Environment variables

| Var                | Required | Default                  | Notes                                        |
|--------------------|----------|--------------------------|----------------------------------------------|
| `INFOBLOX_API_KEY` |          | —                        | `Token <key>`, sent as `Authorization`. Optional — blank uses the in-app vault |
| `INFOBLOX_URL`     |          | `https://csp.infoblox.com` | Portal base URL                            |
| `GROQ_API_KEY`     |          | _(empty)_                | Enables the AI query box (Groq)              |
| `LLM_API_KEY`      |          | `GROQ_API_KEY`           | Overrides for any OpenAI-compatible provider |
| `LLM_MODEL`        |          | `qwen/qwen3-32b`         | Model name                                   |
| `LLM_BASE_URL`     |          | _(blank = Groq)_         | OpenAI-compatible endpoint                   |
| `VAULT_DIR`        |          | `/vault`                 | Where `vault.json` is stored (mount a volume here) |
| `VAULT_PASSPHRASE` |          | —                        | Vault-mode auto-unlock at boot (see below)   |
| `VAULT_PASSPHRASE_FILE` |     | —                        | Path to a secret file holding the passphrase; preferred over `VAULT_PASSPHRASE` |
| `BIND`             |          | `127.0.0.1`              | Host bind for the script/compose; `0.0.0.0` = LAN |
| `HOST`             |          | `localhost` (`0.0.0.0` in Docker) | App bind address                    |
| `PORT`             |          | `8080`                   | HTTP port                                    |
| `DISABLE_UPDATE_CHECK` |      | _(unset)_                | Set to `1` to opt out of the daily GitHub Releases update check |
| `WATCHTOWER_TOKEN` |          | _(generated/default)_    | Shared secret for the optional Watchtower sidecar's HTTP API (alternate update trigger) |

---

## Auto-unlock after an upgrade

The encrypted vault survives upgrades **as long as the volume stays mounted**
(`-v noc-vault:/vault`) — `docker rm -f` removes the container, not the volume. What
you'd otherwise re-type after each upgrade is the **passphrase** to decrypt it.
Supply it at boot and the dashboard comes up live with no browser step:

```bash
# Preferred: a mounted secret file (kept out of `docker inspect` / process env)
printf '%s' 'your-vault-passphrase' > ~/.noc-vault-pass && chmod 600 ~/.noc-vault-pass
docker run -d --name bloxsmith -p 127.0.0.1:8080:8080 \
  -v noc-vault:/vault \
  -v ~/.noc-vault-pass:/run/secrets/vault_pass:ro \
  -e VAULT_PASSPHRASE_FILE=/run/secrets/vault_pass \
  --restart unless-stopped \
  ghcr.io/holland-built/bloxsmith:latest

# Simpler (less secure — visible in `docker inspect`):
#   -e VAULT_PASSPHRASE='your-vault-passphrase'
```

**First run:** with no vault yet, the supplied passphrase **auto-creates** and
unlocks the vault — a brand-new install never shows the passphrase screen; the
browser only asks for your tenant key. Later restarts auto-unlock the same vault.

Keys stay AES-encrypted on disk; whoever can read the passphrase source can decrypt
the vault, so a stolen `vault.json` alone is useless. A wrong/missing passphrase
just falls back to manual unlock in the browser.

For unattended restarts on the [Customer path](#customer-path-compose), set
`VAULT_PASSPHRASE_FILE` in `.env` so a server reboot doesn't require a browser visit.

---

## Security notes

- **Never commit `.env`** (gitignored). Use `.env.example` as the template.
- The image ships no secrets — `.dockerignore` excludes `.env`, `.mcp.json`, and local state.
- The app has **no client auth** on its read/query/account endpoints (only
  `block`/`unblock` writes are gated by `DASHBOARD_TOKEN`). CORS is restricted to the
  loopback origin, but that only restrains browsers — anyone who can reach the port
  can use your Infoblox key indirectly. The binary/compose publish on **`127.0.0.1`
  by default**; `BIND=0.0.0.0` exposes on the LAN, and only then behind your own
  auth/TLS (the `secure` Caddy profile, or a VPN).
- The compose file mounts the Docker socket into the app for self-update; remove
  that line if you don't want the dashboard to have Docker control.
- If a token is ever exposed, **rotate it** in the CSP portal — scrubbing files does not revoke it.

See [SECURITY.md](../.github/SECURITY.md) for the policy and how to report a vulnerability,
and [CONTRIBUTING.md](../.github/CONTRIBUTING.md) for local setup and the test suite.
