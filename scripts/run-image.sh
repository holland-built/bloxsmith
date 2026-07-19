#!/usr/bin/env bash
# Bloxsmith — run from the PREBUILT image (no source, no build).
# For end users (e.g. SEs): just needs Docker. Pulls the published image from
# GHCR and starts it. Re-run any time to update — it always pulls :latest first.
#
# By default it starts in VAULT MODE: no keys here; you set a passphrase and add
# your Infoblox tenant key(s) in the browser, AES-encrypted in the noc-vault
# volume. To skip the vault and use a single key, set INFOBLOX_API_KEY in your
# env before running (then it's passed straight through).
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/holland-built/bloxsmith:latest}"
NAME="bloxsmith"
PORT="${PORT:-8080}"
BIND="${BIND:-127.0.0.1}"      # loopback by default; set BIND=0.0.0.0 to expose on the LAN
[[ "${LAN:-0}" == "1" ]] && BIND=0.0.0.0   # LAN=1 shortcut: expose on the local network
VOLUME="${VOLUME:-noc-vault}"  # named volume holding the encrypted vault
INFOBLOX_URL="${INFOBLOX_URL:-https://csp.infoblox.com}"

echo "── Bloxsmith (prebuilt image) ──────────────────────"
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

# ── Docker socket self-update ─────────────────────────────────────────
# Unless NO_DOCKER_SOCKET=1, mount the Docker socket so the dashboard can
# pull its own image and recreate itself without a sidecar. Set
# NO_DOCKER_SOCKET=1 if you prefer not to grant socket access.
DOCKER_SOCK_MOUNT=()
if [[ "${NO_DOCKER_SOCKET:-0}" != "1" ]] && [[ -S /var/run/docker.sock ]]; then
  DOCKER_SOCK_MOUNT=(-v /var/run/docker.sock:/var/run/docker.sock)
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
  ${DOCKER_SOCK_MOUNT[@]+"${DOCKER_SOCK_MOUNT[@]}"} \
  --restart unless-stopped \
  "$IMAGE" >/dev/null

echo
echo "✓ Running → http://localhost:${PORT}"
if [[ "$BIND" == "0.0.0.0" ]]; then
  HOSTIP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
  [[ -n "$HOSTIP" ]] && echo "  LAN     → http://${HOSTIP}:${PORT}   (reachable by other devices on this network)"
  echo "  ⚠ no login — keep the vault LOCKED when not presenting (skip auto-unlock on shared networks)."
fi
if [[ -z "$KEY" ]]; then
  echo "  Open it and set a passphrase + add your Infoblox tenant key (vault mode)."
fi
echo "  update:  click the version badge → 'Update now'  (NO_DOCKER_SOCKET=1 to disable)"
echo "  logs:    docker logs -f $NAME"
echo "  stop:    docker rm -f $NAME   (vault persists in the '${VOLUME}' volume)"
