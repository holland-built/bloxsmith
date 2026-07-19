#!/usr/bin/env bash
# Dev loop: rebuild the image from CURRENT source and restart the container,
# using your local .env (no prompts), bound to loopback. Run after each edit
# to test before you commit/publish.  Usage:  ./scripts/dev.sh
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "ERROR: no .env — copy .env.example to .env and add your INFOBLOX_API_KEY." >&2; exit 1; }

NAME=bloxsmith
PORT="${PORT:-8080}"
BIND="${BIND:-127.0.0.1}"   # loopback by default; BIND=0.0.0.0 to expose on the LAN

VER="1.0.$(git rev-list --count HEAD 2>/dev/null || echo 0)"
echo "Building image from current source… (version ${VER})"
docker build -t "$NAME" --build-arg APP_VERSION="${VER}" .

docker rm -f "$NAME" >/dev/null 2>&1 || true
echo "Starting container on ${BIND}:${PORT}…"
SOCK_MOUNT=()
[[ "${NO_DOCKER_SOCKET:-0}" != "1" ]] && [[ -S /var/run/docker.sock ]] && \
  SOCK_MOUNT=(-v /var/run/docker.sock:/var/run/docker.sock)

# Auto-unlock vault on container start if .vault-passphrase exists locally.
# Create it once:  echo 'your-passphrase' > .vault-passphrase
# It is gitignored — never committed.
PASS_MOUNT=()
[[ -f .vault-passphrase ]] && \
  PASS_MOUNT=(-v "$PWD/.vault-passphrase:/vault-passphrase:ro" \
              -e VAULT_PASSPHRASE_FILE=/vault-passphrase)

docker run -d --name "$NAME" \
  -p "${BIND}:${PORT}:8080" \
  --env-file .env \
  -e HOST=0.0.0.0 \
  -e INFOBLOX_URL="${INFOBLOX_URL:-https://csp.infoblox.com}" \
  -v noc-vault:/vault \
  ${SOCK_MOUNT[@]+"${SOCK_MOUNT[@]}"} \
  ${PASS_MOUNT[@]+"${PASS_MOUNT[@]}"} \
  --restart unless-stopped \
  "$NAME" >/dev/null

echo "✓ http://localhost:${PORT}"
echo "  logs:  docker logs -f $NAME"
