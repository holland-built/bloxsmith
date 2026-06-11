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

# ── optional: vault auto-unlock passphrase (vault mode only) ──────────
# Stores the passphrase in a 0600 host file and mounts it read-only so the
# container auto-unlocks the encrypted vault on every (re)start — you never
# re-type it after an upgrade. Keys stay AES-encrypted at rest; whoever can
# read this file (host root / docker users) can decrypt the vault.
PASS_MOUNT=()
if [[ -z "$KEY" ]]; then                       # vault mode only (no single key)
  if [[ -n "${VAULT_PASSPHRASE_FILE:-}" ]]; then
    PASS_FILE="$VAULT_PASSPHRASE_FILE"          # caller supplied their own secret file
  else
    PASS_FILE="${VAULT_PASS_FILE:-$HOME/.noc-vault-pass}"
    PHRASE="${VAULT_PASSPHRASE:-}"
    if [[ -z "$PHRASE" && -t 0 ]]; then         # prompt only when interactive
      read -rsp "Vault auto-unlock passphrase (Enter to skip — you'll unlock in the browser): " PHRASE
      echo
    fi
    if [[ -n "$PHRASE" ]]; then
      ( umask 077; printf '%s' "$PHRASE" > "$PASS_FILE" ); chmod 600 "$PASS_FILE"
      echo "  saved passphrase to $PASS_FILE (0600) for auto-unlock"
    else
      PASS_FILE=""                              # skipped → stay manual
    fi
  fi
  if [[ -n "${PASS_FILE:-}" ]]; then
    PASS_MOUNT=(-v "${PASS_FILE}:/run/secrets/vault_pass:ro" -e VAULT_PASSPHRASE_FILE=/run/secrets/vault_pass)
  fi
fi

# ── one-click self-update (Watchtower sidecar) ───────────────────────
# Unless NO_SELF_UPDATE=1, run a Watchtower container that — when the in-app
# "Update now" button is pressed — pulls :latest and recreates the dashboard.
# Both containers share a private network so the app reaches Watchtower's HTTP
# API by name. Only Watchtower mounts the Docker socket (root-equivalent on the
# host); the dashboard never touches the daemon directly.
WT_NAME="${WT_NAME:-noc-watchtower}"
NET="${NET:-noc-net}"
SELF_UPDATE_ENV=()
WT_RUN=0
if [[ "${NO_SELF_UPDATE:-0}" != "1" ]]; then
  WT_RUN=1
  WT_TOKEN="${WATCHTOWER_TOKEN:-$(openssl rand -hex 24 2>/dev/null || head -c24 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
  docker network create "$NET" >/dev/null 2>&1 || true
  SELF_UPDATE_ENV=(
    --network "$NET"
    --label com.centurylinklabs.watchtower.enable=true
    -e WATCHTOWER_URL="http://${WT_NAME}:8080/v1/update"
    -e WATCHTOWER_TOKEN="$WT_TOKEN"
  )
fi

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
  ${PASS_MOUNT[@]+"${PASS_MOUNT[@]}"} \
  ${SELF_UPDATE_ENV[@]+"${SELF_UPDATE_ENV[@]}"} \
  --restart unless-stopped \
  "$IMAGE" >/dev/null

if [[ "$WT_RUN" == "1" ]]; then
  echo "Starting self-update sidecar '$WT_NAME'…"
  docker rm -f "$WT_NAME" >/dev/null 2>&1 || true
  # --label-enable: only touch containers we tagged (the dashboard), nothing else.
  # HTTP-API-update with no periodic polls: updates only when the button asks.
  docker run -d --name "$WT_NAME" \
    --network "$NET" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e WATCHTOWER_HTTP_API_UPDATE=true \
    -e WATCHTOWER_HTTP_API_TOKEN="$WT_TOKEN" \
    -e WATCHTOWER_LABEL_ENABLE=true \
    -e WATCHTOWER_CLEANUP=true \
    --restart unless-stopped \
    containrrr/watchtower >/dev/null \
    && echo "  ✓ in-app 'Update now' is enabled" \
    || echo "  ! could not start Watchtower — in-app update disabled (set NO_SELF_UPDATE=1 to silence)"
fi

echo
echo "✓ Running → http://localhost:${PORT}"
if [[ -z "$KEY" ]]; then
  echo "  Open it and set a passphrase + add your Infoblox tenant key (vault mode)."
fi
if [[ "$WT_RUN" == "1" ]]; then
  echo "  update:  click the version badge → 'Update now'  (or re-run ./run-image.sh)"
else
  echo "  update:  ./run-image.sh   (re-pulls :latest, keeps your vault volume)"
fi
echo "  logs:    docker logs -f $NAME"
echo "  stop:    docker rm -f $NAME${WT_RUN:+ $WT_NAME}   (vault persists in the '${VOLUME}' volume)"
