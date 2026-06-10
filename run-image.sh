#!/usr/bin/env bash
# Infoblox NOC Dashboard — run from the PREBUILT image (no source, no build).
# For end users (e.g. SEs): just needs Docker. Pulls the published image from
# GHCR and starts it. Re-run any time to update — it always pulls :latest first.
#
# By default it starts in VAULT MODE: no keys here; you set a passphrase and add
# your Infoblox tenant key(s) in the browser, AES-encrypted in the noc-vault
# volume. To skip the vault and use a single key, set INFOBLOX_API_KEY in your
# env before running (then it's passed straight through).
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/holland-built/infoblox-noc-dashboard:latest}"
NAME="infoblox-noc"
PORT="${PORT:-8080}"
BIND="${BIND:-127.0.0.1}"      # loopback by default; set BIND=0.0.0.0 to expose on the LAN
VOLUME="${VOLUME:-noc-vault}"  # named volume holding the encrypted vault
INFOBLOX_URL="${INFOBLOX_URL:-https://csp.infoblox.com}"

echo "── Infoblox NOC Dashboard (prebuilt image) ──────────────────────"
echo "Pulling latest image: $IMAGE"
docker pull "$IMAGE"
docker rm -f "$NAME" >/dev/null 2>&1 || true

# Optional single-key (env) mode — bypasses the vault when INFOBLOX_API_KEY is set.
KEY="${INFOBLOX_API_KEY:-}"
if [[ -n "$KEY" && "$KEY" != Token\ * && "$KEY" != Bearer\ * ]]; then KEY="Token $KEY"; fi

echo "Starting container '$NAME' on ${BIND}:${PORT}…"
docker run -d --name "$NAME" \
  -p "${BIND}:${PORT}:8080" \
  -v "${VOLUME}:/vault" \
  -e INFOBLOX_URL="$INFOBLOX_URL" \
  ${KEY:+-e INFOBLOX_API_KEY="$KEY"} \
  ${GROQ_API_KEY:+-e GROQ_API_KEY="$GROQ_API_KEY"} \
  ${LLM_API_KEY:+-e LLM_API_KEY="$LLM_API_KEY"} \
  ${LLM_MODEL:+-e LLM_MODEL="$LLM_MODEL"} \
  ${LLM_BASE_URL:+-e LLM_BASE_URL="$LLM_BASE_URL"} \
  --restart unless-stopped \
  "$IMAGE" >/dev/null

echo
echo "✓ Running → http://localhost:${PORT}"
if [[ -z "$KEY" ]]; then
  echo "  Open it and set a passphrase + add your Infoblox tenant key (vault mode)."
fi
echo "  update:  ./run-image.sh   (re-pulls :latest, keeps your vault volume)"
echo "  logs:    docker logs -f $NAME"
echo "  stop:    docker rm -f $NAME   (vault persists in the '${VOLUME}' volume)"
