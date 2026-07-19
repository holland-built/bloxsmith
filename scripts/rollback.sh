#!/usr/bin/env bash
# Bloxsmith — OUT-OF-BAND ROLLBACK (revert a bad update from the shell).
#
# Use this when a new image WON'T BOOT and the in-app "Update now" auto-rollback
# didn't save you (or the app process is unreachable). It recreates the container
# from the preserved previous image WITHOUT needing the app running, reusing the
# SAME named volume (noc-vault), port, and env as scripts/run-image.sh / docker-compose.yml
# so your encrypted vault and settings survive untouched.
#
# The app keeps the prior image tagged `bloxsmith:previous` on every self-update
# (see _do_recreate in server.py). This script recreates from that tag by default;
# pass a pinned digest as $1 to revert to a specific known-good build instead.
#
#   ./scripts/rollback.sh                                   # revert to bloxsmith:previous
#   ./scripts/rollback.sh ghcr.io/holland-built/bloxsmith@sha256:<digest>   # revert to a pinned build
#
# For a Compose deploy, prefer the env-var revert shown at the end of this script.
set -euo pipefail

NAME="${NAME:-bloxsmith}"                         # container name (matches scripts/run-image.sh / compose)
PORT="${PORT:-8080}"
BIND="${BIND:-127.0.0.1}"                          # loopback by default; BIND=0.0.0.0 for LAN
VOLUME="${VOLUME:-noc-vault}"                       # named volume holding the encrypted vault
INFOBLOX_URL="${INFOBLOX_URL:-https://csp.infoblox.com}"
IMAGE="${1:-bloxsmith:previous}"                   # target image: previous tag, or a pinned @sha256 digest

echo "── Bloxsmith rollback ──────────────────────────────"
echo "  target image : $IMAGE"
echo "  container    : $NAME    port: ${BIND}:${PORT}    volume: ${VOLUME}"

# Verify the target image exists locally before we tear down the running one.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "✗ Image '$IMAGE' not found locally."
  if [ "$IMAGE" = "bloxsmith:previous" ]; then
    echo "  The previous image is only preserved after an in-app self-update."
    echo "  Revert to a published build instead, e.g.:"
    echo "    ./scripts/rollback.sh ghcr.io/holland-built/bloxsmith@sha256:<known-good-digest>"
  else
    echo "  Pull it first:  docker pull \"$IMAGE\""
  fi
  exit 1
fi

# Preserve the same optional single-key / socket / passphrase wiring run-image.sh uses.
KEY="${INFOBLOX_API_KEY:-}"
if [ -n "$KEY" ] && [ "${KEY#Token }" = "$KEY" ] && [ "${KEY#Bearer }" = "$KEY" ]; then
  KEY="Token $KEY"
fi

RUN_ARGS=""
[ -n "$KEY" ]                        && RUN_ARGS="$RUN_ARGS -e INFOBLOX_API_KEY=$KEY"
[ -n "${GROQ_API_KEY:-}" ]           && RUN_ARGS="$RUN_ARGS -e GROQ_API_KEY=$GROQ_API_KEY"
[ -n "${LLM_API_KEY:-}" ]            && RUN_ARGS="$RUN_ARGS -e LLM_API_KEY=$LLM_API_KEY"
[ -n "${LLM_MODEL:-}" ]              && RUN_ARGS="$RUN_ARGS -e LLM_MODEL=$LLM_MODEL"
[ -n "${LLM_BASE_URL:-}" ]           && RUN_ARGS="$RUN_ARGS -e LLM_BASE_URL=$LLM_BASE_URL"
[ -n "${VAULT_PASSPHRASE:-}" ]       && RUN_ARGS="$RUN_ARGS -e VAULT_PASSPHRASE=$VAULT_PASSPHRASE"
[ -n "${VAULT_PASSPHRASE_FILE:-}" ]  && RUN_ARGS="$RUN_ARGS -e VAULT_PASSPHRASE_FILE=$VAULT_PASSPHRASE_FILE"

SOCK_ARGS=""
if [ "${NO_DOCKER_SOCKET:-0}" != "1" ] && [ -S /var/run/docker.sock ]; then
  SOCK_ARGS="-v /var/run/docker.sock:/var/run/docker.sock"   # keep in-app update/rollback working after revert
fi

echo "  stopping current container…"
docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "  starting '$NAME' from $IMAGE…"
# shellcheck disable=SC2086  # word-splitting of RUN_ARGS/SOCK_ARGS is intentional
docker run -d --name "$NAME" \
  -p "${BIND}:${PORT}:8080" \
  -v "${VOLUME}:/vault" \
  -e INFOBLOX_URL="$INFOBLOX_URL" \
  $RUN_ARGS \
  $SOCK_ARGS \
  --restart unless-stopped \
  "$IMAGE" >/dev/null

echo
echo "✓ Rolled back → http://localhost:${PORT}  (vault preserved in the '${VOLUME}' volume)"
echo "  verify:  docker ps --filter name=$NAME   &&   docker logs -f $NAME"
echo
echo "── Compose users: revert via the image pin instead ──"
echo "  1) Set the app image back to the known-good digest in docker-compose.yml:"
echo "       image: ghcr.io/holland-built/bloxsmith@sha256:<known-good-digest>"
echo "  2) Recreate from that pin (vault volume is reused automatically):"
echo "       docker compose up -d"
echo "  Or one-shot without editing the file:"
echo "       IMAGE=ghcr.io/holland-built/bloxsmith@sha256:<digest> docker compose up -d bloxsmith"
