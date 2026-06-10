#!/usr/bin/env bash
# Infoblox NOC Dashboard — run from the PREBUILT image (no source, no build).
# For end users (e.g. SEs): just needs Docker. Pulls the published image from
# GHCR, prompts for the API key at run time, and starts the container.
# Re-run any time to update — it always pulls :latest first.
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/barney34/infoblox-noc-dashboard:latest}"
NAME="infoblox-noc"
PORT="${PORT:-8080}"
BIND="${BIND:-127.0.0.1}"   # loopback by default; set BIND=0.0.0.0 to expose on the LAN
INFOBLOX_URL="${INFOBLOX_URL:-https://csp.infoblox.com}"

echo "── Infoblox NOC Dashboard (prebuilt image) ──────────────────────"

# ── Infoblox API key (hidden input; required) ────────────────────────
if [[ -z "${INFOBLOX_API_KEY:-}" ]]; then
  read -rsp "Infoblox API key (paste token, with or without 'Token ' prefix): " KEY; echo
else
  KEY="$INFOBLOX_API_KEY"
fi
[[ -z "$KEY" ]] && { echo "ERROR: no API key entered." >&2; exit 1; }
if [[ "$KEY" != Token\ * && "$KEY" != Bearer\ * ]]; then KEY="Token $KEY"; fi

# ── Groq key (optional; enables the AI query box) ────────────────────
if [[ -z "${GROQ_API_KEY:-}" ]]; then
  read -rsp "Groq API key (optional, press Enter to skip): " GKEY; echo
else
  GKEY="$GROQ_API_KEY"
fi

echo "Pulling latest image: $IMAGE"
docker pull "$IMAGE"

docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "Starting container '$NAME' on port $PORT…"
docker run -d --name "$NAME" \
  -p "${BIND}:${PORT}:8080" \
  -e INFOBLOX_API_KEY="$KEY" \
  -e INFOBLOX_URL="$INFOBLOX_URL" \
  ${GKEY:+-e GROQ_API_KEY="$GKEY"} \
  ${LLM_API_KEY:+-e LLM_API_KEY="$LLM_API_KEY"} \
  ${LLM_MODEL:+-e LLM_MODEL="$LLM_MODEL"} \
  ${LLM_BASE_URL:+-e LLM_BASE_URL="$LLM_BASE_URL"} \
  --restart unless-stopped \
  "$IMAGE" >/dev/null

echo
echo "✓ Running → http://localhost:${PORT}"
echo "  update:  ./run-image.sh   (re-pulls :latest and restarts)"
echo "  logs:    docker logs -f $NAME"
echo "  stop:    docker rm -f $NAME"
