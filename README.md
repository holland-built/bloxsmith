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

**Compose path (recommended for servers and always-on installs)** — Watchtower wiring persists across Docker restarts automatically:

```bash
git clone https://github.com/holland-built/infoblox-noc-dashboard && cd infoblox-noc-dashboard
cp .env.example .env   # fill in INFOBLOX_API_KEY (and optionally GROQ_API_KEY)
docker compose up -d   # → http://localhost:8080
```

**No-clone path (desktop / SE demo)** — no git required, just Docker:

```bash
curl -fsSL -O https://raw.githubusercontent.com/holland-built/infoblox-noc-dashboard/master/run-image.sh && chmod +x run-image.sh
./run-image.sh             # on your machine → http://localhost:8080
LAN=1 ./run-image.sh       # on a server → prints http://<server-ip>:8080
```

First open: pick a passphrase, add your [Infoblox API key](#get-your-infoblox-api-key) — keys are AES-encrypted in the `noc-vault` volume.

> ⚠️ **LAN mode has no login.** Anyone on the network can reach it — keep the vault **locked** when you're not presenting, or use the secure proxy (see deployment guide).

## Updating

Click the version badge → **Update now**. A Watchtower sidecar pulls the new image and restarts — no shell, no re-pull. Your vault survives. Or update manually:

```bash
docker compose pull && docker compose up -d
```

## Get your Infoblox API key

1. Sign in to <https://csp.infoblox.com>.
2. Top-right user menu → **User API Keys** → **Create**.
3. Copy the token, paste it into the dashboard setup.

<details>
<summary><b>More ways to run</b> (single-key env, Compose, secure proxy, build from source)</summary>

```bash
# Single key, skip the vault:
docker run -d --name infoblox-mcp -p 127.0.0.1:8080:8080 \
  -e INFOBLOX_API_KEY="Token <key>" ghcr.io/holland-built/infoblox-noc-dashboard:latest

# Compose (always-on servers / Proxmox):
BIND=0.0.0.0 docker compose up -d              # LAN
docker compose --profile secure up -d          # + Caddy TLS + basic-auth

# Build from source (dev):
git clone https://github.com/holland-built/infoblox-noc-dashboard && cd infoblox-noc-dashboard && ./run.sh
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
