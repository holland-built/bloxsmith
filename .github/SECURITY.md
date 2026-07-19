# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
vulnerability.

- Use GitHub **Security → Report a vulnerability** (private vulnerability reporting)
  on this repository.

Please include steps to reproduce, affected version/commit, and impact. Reports are
handled on a best-effort basis.

## Scope

In scope: the Python bridge (`server.py`), the bundled dashboard (`index.html`), the
Docker packaging, and the documented configuration surface. Out of scope: the Infoblox
CSP / Infoblox Portal platform itself (report those to Infoblox) and third-party LLM providers.

## Token handling — read this

- **Never commit `.env` or a real Infoblox token.** `.env` is gitignored; the Docker
  image ships no secrets (`.dockerignore` excludes `.env`, `.mcp.json`, and local state).
- **If a token is ever exposed, rotate it in the CSP portal**
  (<https://csp.infoblox.com> → User API Keys). Scrubbing the token from files or git
  history does **not** revoke it — only rotation in the portal does.

## Deployment warnings

- **The bridge has no client auth on its read/query/account endpoints.** It reflects
  CORS only for the same-origin loopback allowlist (`http://localhost:<port>` /
  `127.0.0.1:<port>`), but CORS only restrains *browsers* — any local process (curl,
  another container) that can reach the port can use your Infoblox key indirectly,
  including switching CSP accounts. Only the destructive `block`/`unblock` writes are
  gated, by the `DASHBOARD_TOKEN` (`X-Auth-Token`) shared secret.
- **Publish on `127.0.0.1` (the default).** `scripts/run.sh`/`scripts/run-image.sh` map the container
  to `127.0.0.1:<port>` so it is loopback-only; set `BIND=0.0.0.0` to expose it on the
  LAN, and only do that behind your own auth/TLS boundary. (`HOST=0.0.0.0` inside the
  image is correct — it lets the host port-mapping work; exposure is controlled by the
  host-side `-p` bind, not the in-container bind.)
