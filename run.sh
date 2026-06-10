#!/usr/bin/env bash
# Infoblox NOC Dashboard — Docker installer.
# Builds the image and runs it, prompting the installer for the API key at run time.
# The key is NEVER baked into the image; it is passed as a runtime env var.
set -euo pipefail

IMAGE="infoblox-noc"
NAME="infoblox-noc"
PORT="${PORT:-8080}"
BIND="${BIND:-127.0.0.1}"   # host interface to publish on; loopback by default. Set BIND=0.0.0.0 to expose on the LAN.
VOLUME="${VOLUME:-noc-vault}"   # named volume holding the encrypted vault
INFOBLOX_URL="${INFOBLOX_URL:-https://csp.infoblox.com}"

cd "$(dirname "$0")"

echo "── Infoblox NOC Dashboard installer ─────────────────────────────"

# ── Infoblox API key (optional) ──────────────────────────────────────
# Leave blank to use the in-app encrypted vault (set a passphrase + add tenant
# keys in the browser). Provide a key here to bypass the vault (single-key mode).
if [[ -z "${INFOBLOX_API_KEY:-}" ]]; then
  read -rsp "Infoblox API key (Enter to skip and use the in-app vault): " KEY
  echo
else
  KEY="$INFOBLOX_API_KEY"
fi
# Normalise: server expects the full Authorization value, e.g. "Token <key>"
if [[ -n "$KEY" && "$KEY" != Token\ * && "$KEY" != Bearer\ * ]]; then
  KEY="Token $KEY"
fi

# ── optional: Groq key (enables the AI query box) ────────────────────
if [[ -z "${GROQ_API_KEY:-}" ]]; then
  read -rsp "Groq API key (optional, press Enter to skip AI query box): " GKEY
  echo
else
  GKEY="$GROQ_API_KEY"
fi

# ── build ────────────────────────────────────────────────────────────
echo "Building image '$IMAGE'…"
docker build -t "$IMAGE" .

# ── (re)start container ──────────────────────────────────────────────
docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "Starting container '$NAME' on port $PORT…"
docker run -d --name "$NAME" \
  -p "${BIND}:${PORT}:8080" \
  -v "${VOLUME}:/vault" \
  -e INFOBLOX_URL="$INFOBLOX_URL" \
  ${KEY:+-e INFOBLOX_API_KEY="$KEY"} \
  ${GKEY:+-e GROQ_API_KEY="$GKEY"} \
  ${LLM_API_KEY:+-e LLM_API_KEY="$LLM_API_KEY"} \
  ${LLM_MODEL:+-e LLM_MODEL="$LLM_MODEL"} \
  ${LLM_BASE_URL:+-e LLM_BASE_URL="$LLM_BASE_URL"} \
  --restart unless-stopped \
  "$IMAGE" >/dev/null

echo
echo "✓ Running → http://localhost:${PORT}  (published on ${BIND}; set BIND=0.0.0.0 to expose on the LAN)"
echo "  logs:  docker logs -f $NAME"
echo "  stop:  docker rm -f $NAME"
