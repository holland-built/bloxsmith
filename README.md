# Bloxsmith

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.26-00ADD8.svg)](https://go.dev/)
[![Docker ready](https://img.shields.io/badge/Docker-ready-2496ED.svg)](docker-compose.yml)

**Bloxsmith** is a self-hosted workbench for your Infoblox Portal / CSP data — subnets, DHCP leases, DNS zones, hosts, security policies, threat feeds, and audit logs. It ships as a single Go binary with an embedded React UI at `http://localhost:8080`.

![Bloxsmith](docs/dashboard.png)

## Install

Pick one. Full options and deployment guidance are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

**macOS / Linux** — inspect, then install; it opens the dashboard for you:

```bash
curl --proto '=https' --tlsv1.2 -fsSLo install.sh \
  https://github.com/holland-built/bloxsmith/releases/latest/download/install.sh
less install.sh   # read it before running
sh install.sh
```

**Homebrew** (macOS / Linux) — installs the binary; then run `bloxsmith`:

```bash
brew install holland-built/tap/bloxsmith
```

**Windows** — open **PowerShell** (Start → type `PowerShell`), then paste; it downloads, you inspect, then it installs and opens the dashboard:

```powershell
iwr -UseBasicParsing -OutFile install.ps1 `
  https://github.com/holland-built/bloxsmith/releases/latest/download/install.ps1
notepad install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Use **PowerShell**, not Command Prompt — `iwr` is a PowerShell command (cmd.exe gives "iwr is not recognized"). Close Notepad after reading to continue.

**Docker** — then open http://localhost:8080 yourself:

```bash
docker run -d --name bloxsmith \
  -p 127.0.0.1:8080:8080 -v noc-vault:/vault \
  --restart unless-stopped \
  ghcr.io/holland-built/bloxsmith:latest
```

**First open:** pick a passphrase, then paste your [Infoblox API key](#get-your-infoblox-api-key).

## Get your Infoblox API key

1. Sign in to <https://csp.infoblox.com>.
2. Top-right user menu → **User API Keys** → **Create**.
3. Copy the token, paste it into the dashboard setup.

<details>
<summary><b>How the installers verify downloads &amp; where they land</b></summary>

Read it before you run it — that's what inspecting the script first is for. Both installers verify the release's SHA-256 checksum and refuse to install on a mismatch. The checksum proves the download is intact, not that the publisher is who they claim — the binary is unsigned.

- **macOS/Linux:** drops `bloxsmith` in `~/.local/bin` (no sudo; override with `--prefix DIR`, pin with `--version vX.Y.Z`).
- **Windows:** drops `bloxsmith.exe` in `%LOCALAPPDATA%\Programs\Bloxsmith` and adds it to your user PATH. Reopen the shell, then run `bloxsmith`.

Later, from a terminal:

```bash
bloxsmith                  # start it → http://localhost:8080
bloxsmith service install  # run it in the background at login
bloxsmith update           # upgrade in place
```

</details>

<details>
<summary><b>Run as an always-on server (LAN, compose, secure proxy)</b></summary>

> ⚠️ **LAN mode has no login.** Anyone on the network can reach the dashboard and query your Infoblox tenant. Keep the vault **locked** when not presenting, or use a secure proxy.

Binding `0.0.0.0` (Docker) or `BIND=0.0.0.0` (compose) instead of `127.0.0.1` exposes the dashboard on the LAN with no auth in front of it. Pin a release with a tag (e.g. `:v2.0.0`) instead of `:latest`. Tenant keys live AES-encrypted in the `noc-vault` volume and survive updates, restarts, and container recreation.

Full compose / secure-proxy / Customer-install steps → [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

</details>

<details>
<summary><b>Updating</b></summary>

Bloxsmith checks GitHub daily; nothing updates without your click. Standalone: version badge → **Update now**, or `bloxsmith update`. Docker: **Update now** button, or `docker compose pull && docker compose up -d`.

Full update modes → [docs/DEPLOYMENT.md#updating](docs/DEPLOYMENT.md#updating).

</details>

<details>
<summary><b>How it works</b></summary>

```
browser ──HTTP──▶ bloxsmith (Go binary) ──MCP──▶ csp.infoblox.com/mcp
                       └── optional: LLM (Groq / OpenAI-compatible) for NL queries
```

The binary exists because browsers can't call the Infoblox MCP endpoint directly — CORS, and MCP is JSON-RPC/SSE. It's the server-side hop that holds your API key.

</details>

<details>
<summary><b>More ways to run</b> (single-key env, Compose, secure proxy, build from source)</summary>

```bash
# Single key, skip the vault:
docker run -d --name bloxsmith -p 127.0.0.1:8080:8080 \
  -e INFOBLOX_API_KEY="Token <key>" ghcr.io/holland-built/bloxsmith:latest

# Compose (always-on servers / Proxmox):
BIND=0.0.0.0 docker compose up -d              # LAN
docker compose --profile secure up -d          # + Caddy TLS + basic-auth

# Build from source (dev) — Go 1.26+:
git clone https://github.com/holland-built/bloxsmith && cd bloxsmith
cd ui && npm ci && npm run build && cd ..        # Vite build → refreshes the embedded UI (go/web/)
cd go && go build -o bloxsmith . && ./bloxsmith  # → http://localhost:8080

scripts/dev-serve.sh [port]                     # LIVE dev (default :8090): edit ui/src → Vite
                                                #   rebuild → go/web, binary serves from disk via WEB_DIR
```

Full steps, the deploy matrix, auto-unlock, and pinning → **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.
</details>

<details>
<summary><b>AI query box</b> (optional)</summary>

The natural-language query box needs an LLM with tool-calling; everything else works without it. Default is **Groq** (free tier — fast, free models, good for demos): get a key at <https://console.groq.com> and set it in the dashboard (sidebar → **⚙ AI provider**) or via `GROQ_API_KEY`. Any OpenAI-compatible provider works — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#using-a-different-llm-provider).
</details>

---

- **Full deployment & env reference →** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- **Security policy →** [SECURITY.md](.github/SECURITY.md) · **Contributing →** [CONTRIBUTING.md](.github/CONTRIBUTING.md)
- Released under the [MIT License](LICENSE).
