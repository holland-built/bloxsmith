# Deployment & reference

Full reference for **Bloxsmith**. For the 30-second start see the
[README](../README.md#quick-start); this doc covers every install path, the
environment variables, LLM providers, and security.

- [Standalone binary (no Docker)](#standalone-binary-no-docker)
- [SE demo path (run-image.sh)](#se-demo-path-run-imagesh)
- [Customer path (compose)](#customer-path-compose)
- [Updating](#updating)
- [Install from the prebuilt image](#install-from-the-prebuilt-image)
- [Build from source (dev)](#build-from-source-dev)
- [Getting the keys](#getting-the-keys)
- [Using a different LLM provider](#using-a-different-llm-provider)
- [Running without Docker](#running-without-docker)
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
> Signature verification (cosign) is the planned hardening step.

---

## SE demo path (run-image.sh)

You're an Infoblox SE showing this on a laptop or a customer LAN with Docker.
`scripts/run-image.sh` wraps pull + run:

```bash
git clone https://github.com/holland-built/bloxsmith && cd bloxsmith
./scripts/run-image.sh              # localhost → http://localhost:8080
LAN=1 ./scripts/run-image.sh        # LAN → binds 0.0.0.0, prints http://<host-ip>:8080
```

It also prompts for an optional vault auto-unlock passphrase, saving it to
`~/.noc-vault-pass` (`0600`) and mounting it (see [Auto-unlock](#auto-unlock-after-an-upgrade)),
and it mounts `/var/run/docker.sock` so the in-app self-update works (set
`NO_DOCKER_SOCKET=1` to disable).

Re-running `./scripts/run-image.sh` always re-pulls `:latest` — see [Updating](#updating)
for the full picture.

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
| Desktop / no-clone | `./scripts/run-image.sh` | http://localhost:8080 |

Tenant keys live AES-encrypted in the `noc-vault` Docker volume — they survive
updates, restarts, and container recreation. For unattended restarts (no browser
step to re-enter the passphrase), see `VAULT_PASSPHRASE_FILE` in
[Auto-unlock](#auto-unlock-after-an-upgrade).

---

## Updating

**SE demo:** re-run `./scripts/run-image.sh` (always pulls `:latest`), or use the in-app
**Update now** button.

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
which `scripts/run-image.sh` and compose both do by default (`NO_DOCKER_SOCKET=1` or
removing the socket line disables it).

Compose also ships a Watchtower sidecar in HTTP-API mode (no polling) as an
alternate trigger; the in-app button does not require it.

There is **no unattended auto-update and no polling updater** — the daily check
only surfaces availability. Applying an update is always a user action, whether
that's the button click or the manual command above.

---

## Install from the prebuilt image

No source checkout, no build — just Docker. Every push to `master` and every
`vX.Y.Z` tag publishes an image to GitHub Container Registry (GHCR) and cuts a
release via [CI](../.github/workflows/docker-publish.yml).

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
[SE demo path](#se-demo-path-run-imagesh) and the
[Customer path](#customer-path-compose) above.

---

## Build from source (dev)

Use this if you're developing or want to build locally instead of pulling the image.

```bash
git clone https://github.com/holland-built/bloxsmith && cd bloxsmith
./scripts/run.sh
# update later:  git pull && ./scripts/run.sh
```

`scripts/run.sh` will:
1. Prompt for an **Infoblox API key** (optional — Enter to use the in-app vault).
2. Prompt for a **Groq API key** (optional — only the AI query box needs it).
3. In vault mode, prompt for a **vault auto-unlock passphrase** (optional — Enter to unlock in the browser). If given, saved to `~/.noc-vault-pass` (`0600`) and mounted read-only.
4. Build the image and start the container.
5. Print `→ http://localhost:8080`.

The API key is **never baked into the image** — injected at runtime as an env var.

### Non-interactive (use a `.env`)

```bash
cp .env.example .env        # then edit .env with your keys
docker build -t bloxsmith .
docker run -d --name bloxsmith -p 127.0.0.1:8080:8080 --env-file .env -e HOST=0.0.0.0 \
  --restart unless-stopped bloxsmith   # loopback only; drop 127.0.0.1: to expose on the LAN
```

### Manage

```bash
docker logs -f bloxsmith     # watch logs
docker rm -f bloxsmith       # stop + remove
docker start bloxsmith       # restart existing
PORT=8090 ./scripts/run.sh              # run on a different port
```

---

## Getting the keys

### Infoblox API key (required)

1. Sign in to <https://csp.infoblox.com>.
2. Top-right user menu → **User API Keys** → **Create**.
3. Copy the token. Use it as-is — `scripts/run.sh` adds the `Token ` prefix automatically.

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

## Running without Docker

Requires **Python ≥ 3.11** (tested on 3.13). Node/npx is only needed for the
`.mcp.json` / `mcp-remote` path; the default `python server.py` bridge uses the
`mcp` pip package and needs no Node.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # fill in keys
python server.py            # → http://localhost:8080
```

Set `HOST=0.0.0.0` to expose beyond localhost (the Docker image does this for you).

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
- The bridge has **no client auth** on its read/query/account endpoints (only
  `block`/`unblock` writes are gated by `DASHBOARD_TOKEN`). CORS is restricted to the
  loopback origin, but that only restrains browsers — anyone who can reach the port
  can use your Infoblox key indirectly. The script/compose publish on **`127.0.0.1`
  by default**; `BIND=0.0.0.0` exposes on the LAN, and only then behind your own
  auth/TLS (the `secure` Caddy profile, or a VPN).
- The compose file mounts the Docker socket into the app for self-update; remove
  that line if you don't want the dashboard to have Docker control.
- If a token is ever exposed, **rotate it** in the CSP portal — scrubbing files does not revoke it.

See [SECURITY.md](../.github/SECURITY.md) for the policy and how to report a vulnerability,
and [CONTRIBUTING.md](../.github/CONTRIBUTING.md) for local setup and the test suite.
