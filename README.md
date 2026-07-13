# Bloxsmith

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.13-blue.svg)](https://www.python.org/)
[![Docker ready](https://img.shields.io/badge/Docker-ready-2496ED.svg)](Dockerfile)

**Bloxsmith** is a composable, self-hostable workbench for your **Infoblox Portal / CSP**
data — subnets, DHCP leases, DNS zones, hosts, security policies, threat feeds, and audit
logs, plus an optional natural-language query box. Build your own views instead of living in
a fixed monitoring dashboard. A small Python bridge talks to the Infoblox cloud over
**MCP** and serves a React workspace at `http://localhost:8080`.

![Bloxsmith](docs/dashboard.png)

```
browser ──HTTP──▶ bridge (server.py) ──MCP──▶ csp.infoblox.com/mcp
                       └── optional: LLM (Groq / OpenAI-compatible) for NL queries
```

(The bridge exists because browsers can't call the Infoblox MCP endpoint directly — CORS, and MCP is JSON-RPC/SSE. It's the server-side hop that holds your API key.)

---

## Quick start

Prereq: **Docker** — [Docker Desktop](https://www.docker.com/products/docker-desktop/) (macOS/Windows) or Docker Engine (Linux: `curl -fsSL https://get.docker.com | sh`).

### Path A — SE demo (laptop / LAN, no clone)

You're an Infoblox SE showing this on your laptop or a customer LAN in the next five minutes.

```bash
curl -fsSL -O https://raw.githubusercontent.com/holland-built/bloxsmith/master/run-image.sh && chmod +x run-image.sh
./run-image.sh             # your machine → http://localhost:8080
LAN=1 ./run-image.sh       # demo box → prints http://<host-ip>:8080 for the room
```

Re-running always pulls `:latest`. The script also offers a vault auto-unlock passphrase, saved to `~/.noc-vault-pass` (`0600`).

> ⚠️ **LAN mode has no login.** Anyone on the network can reach the dashboard and query your Infoblox tenant. Keep the vault **locked** when not presenting, or use Path B's secure proxy.

### Path B — Customer install (always-on server, compose)

You're self-hosting this permanently on a server/VM (Proxmox, NUC, cloud).

```bash
git clone https://github.com/holland-built/bloxsmith && cd bloxsmith
cp .env.example .env                       # optional: pre-set keys; blank = in-app vault
docker compose up -d                       # loopback only → http://localhost:8080
BIND=0.0.0.0 docker compose up -d          # expose on the LAN (no login — see warning)
docker compose --profile secure up -d      # + Caddy TLS + basic-auth on :8443 (recommended for LAN)
```

Tenant keys live AES-encrypted in the `noc-vault` Docker volume — they survive updates, restarts, and container recreation.

First open (either path): pick a passphrase, add your [Infoblox API key](#get-your-infoblox-api-key).

## Updating

Bloxsmith checks GitHub once a day in the background for a newer release (server-side; disable with `DISABLE_UPDATE_CHECK=1`). Nothing updates automatically — applying is always your call.

Click the version badge → **Update now**. The app pulls the new image over the Docker socket, health-checks it, and swaps itself — automatic rollback if the new version fails to start. Available whenever the Docker socket is mounted (run-image.sh and compose both do by default).

Or update manually:

```bash
docker compose pull && docker compose up -d    # customer/compose
./run-image.sh                                 # SE demo — re-running always pulls :latest
```

Your vault (tenant keys, passphrase) lives in the `noc-vault` volume and survives every update.

## Get your Infoblox API key

1. Sign in to <https://csp.infoblox.com>.
2. Top-right user menu → **User API Keys** → **Create**.
3. Copy the token, paste it into the dashboard setup.

<details>
<summary><b>More ways to run</b> (single-key env, Compose, secure proxy, build from source)</summary>

```bash
# Single key, skip the vault:
docker run -d --name bloxsmith -p 127.0.0.1:8080:8080 \
  -e INFOBLOX_API_KEY="Token <key>" ghcr.io/holland-built/bloxsmith:latest

# Compose (always-on servers / Proxmox):
BIND=0.0.0.0 docker compose up -d              # LAN
docker compose --profile secure up -d          # + Caddy TLS + basic-auth

# Build from source (dev):
git clone https://github.com/holland-built/bloxsmith && cd bloxsmith && ./run.sh
```

Full steps, the deploy matrix, auto-unlock, and pinning → **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.
</details>

<details>
<summary><b>AI query box</b> (optional)</summary>

The natural-language query box needs an LLM with tool-calling; everything else works without it. Default is **Groq** (free tier — fast, free models, good for demos): get a key at <https://console.groq.com> and set it in the dashboard (sidebar → **⚙ AI provider**) or via `GROQ_API_KEY`. Any OpenAI-compatible provider works — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#using-a-different-llm-provider).
</details>

---

- **Full deployment & env reference →** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- **Security policy →** [SECURITY.md](SECURITY.md) · **Contributing →** [CONTRIBUTING.md](CONTRIBUTING.md)
- Released under the [MIT License](LICENSE).
