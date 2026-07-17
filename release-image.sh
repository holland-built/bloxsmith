#!/usr/bin/env bash
# release-image.sh — build the Bloxsmith Docker image locally and publish it,
# by hand, when YOU choose. Replaces the automatic GitHub build (now off).
#
# One command:  ./release-image.sh
#
# Prereq (one time): log in to GitHub's container registry so you can push:
#   echo "$GITHUB_TOKEN" | docker login ghcr.io -u <your-github-username> --password-stdin
# (a token with write:packages scope — https://github.com/settings/tokens)
#
# What it does: builds the current code into an image, tags it :latest and a
# version, and pushes both to ghcr.io. After this, anyone can pull the new
# version; the in-app banner / update script will see it.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="ghcr.io/holland-built/bloxsmith"
VERSION="1.0.$(git rev-list --count HEAD)"

echo "▶ Building ${IMAGE}:${VERSION} (and :latest) from the current code…"
docker build --build-arg APP_VERSION="${VERSION}" -t "${IMAGE}:latest" -t "${IMAGE}:v${VERSION}" .

echo "▶ Pushing to the registry…"
docker push "${IMAGE}:latest"
docker push "${IMAGE}:v${VERSION}"

echo "✓ Published ${IMAGE}:v${VERSION} (and :latest). Users can now pull it."
