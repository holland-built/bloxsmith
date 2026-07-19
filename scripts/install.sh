#!/bin/sh
# Bloxsmith installer — downloads the standalone binary from GitHub Releases,
# verifies its SHA-256, and installs it to ~/.local/bin (no Docker, no sudo).
#
#   sh install.sh                       # latest release, ~/.local/bin
#   sh install.sh --version v2.0.0      # pin an exact release
#   sh install.sh --prefix /usr/local/bin
set -eu

REPO="holland-built/bloxsmith"
PREFIX="${HOME}/.local/bin"
VERSION="latest"

usage() {
    cat <<EOF
Bloxsmith installer

Usage: sh install.sh [options]

Options:
  --version vX.Y.Z   Install a specific release (default: latest)
  --prefix DIR       Install directory (default: \$HOME/.local/bin)
  --help             Show this help

Installs the single self-contained bloxsmith binary. No Docker required.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version) [ $# -ge 2 ] || { echo "error: --version needs a value" >&2; exit 2; }
                   VERSION="$2"; shift 2 ;;
        --prefix)  [ $# -ge 2 ] || { echo "error: --prefix needs a value" >&2; exit 2; }
                   PREFIX="$2"; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) echo "error: unknown option '$1' (try --help)" >&2; exit 2 ;;
    esac
done

command -v curl >/dev/null 2>&1 || { echo "error: curl is required" >&2; exit 1; }
command -v tar  >/dev/null 2>&1 || { echo "error: tar is required" >&2; exit 1; }

# --- pick the checksum tool -------------------------------------------------
if command -v shasum >/dev/null 2>&1; then
    sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v sha256sum >/dev/null 2>&1; then
    sha256() { sha256sum "$1" | awk '{print $1}'; }
else
    echo "error: need shasum or sha256sum to verify the download" >&2
    exit 1
fi

# --- detect platform --------------------------------------------------------
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64|amd64)  ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "error: unsupported architecture '$ARCH'" >&2; exit 1 ;;
esac

# Version number without the leading 'v' — goreleaser asset names use the bare form.
if [ "$VERSION" = "latest" ]; then
    NUM=""   # resolved after we read checksums.txt
else
    NUM="$(printf '%s' "$VERSION" | sed 's/^v//')"
fi

case "$OS" in
    # macOS ships ONE universal archive covering both Intel and Apple Silicon.
    darwin) ASSET_FMT='bloxsmith_%s_macOS_universal.tar.gz' ;;
    linux)  ASSET_FMT="bloxsmith_%s_linux_${ARCH}.tar.gz" ;;
    *) echo "error: unsupported OS '$OS' (this installer covers macOS and Linux)" >&2; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
    BASE="https://github.com/${REPO}/releases/latest/download"
else
    BASE="https://github.com/${REPO}/releases/download/${VERSION}"
fi

# --- work dir, always cleaned ----------------------------------------------
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

echo "Bloxsmith installer"
echo "  platform : ${OS}/${ARCH}"
echo "  release  : ${VERSION}"

# checksums.txt first — for 'latest' it also tells us the real version number.
echo "  fetching : checksums.txt"
curl --proto '=https' --tlsv1.2 -fsSLo "$WORK/checksums.txt" "${BASE}/checksums.txt" \
    || { echo "error: could not download checksums.txt from ${BASE}" >&2; exit 1; }

if [ -z "$NUM" ]; then
    NUM="$(sed -n 's/.*bloxsmith_\([0-9][^_]*\)_.*/\1/p' "$WORK/checksums.txt" | head -1)"
    [ -n "$NUM" ] || { echo "error: could not determine release version from checksums.txt" >&2; exit 1; }
fi

ASSET="$(printf "$ASSET_FMT" "$NUM")"
echo "  asset    : ${ASSET}"

curl --proto '=https' --tlsv1.2 -fsSLo "$WORK/$ASSET" "${BASE}/${ASSET}" \
    || { echo "error: could not download ${ASSET} from ${BASE}" >&2; exit 1; }

# --- verify -----------------------------------------------------------------
# HONEST SCOPE: checksums.txt comes from the SAME release as the archive, so this
# catches a corrupt or truncated download and a broken mirror — it does NOT protect
# against a compromised publisher or a hijacked release, since an attacker who can
# replace the tarball can replace the checksums beside it. Real publisher
# authentication needs signature verification (cosign / Sigstore) against a key
# that does not live in the release; that is the planned hardening step.
EXPECTED="$(awk -v f="$ASSET" '$2 == f || $2 == "*" f {print $1}' "$WORK/checksums.txt" | head -1)"
[ -n "$EXPECTED" ] || { echo "error: ${ASSET} has no entry in checksums.txt — refusing to install" >&2; exit 1; }

ACTUAL="$(sha256 "$WORK/$ASSET")"
if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "error: CHECKSUM MISMATCH for ${ASSET} — refusing to install." >&2
    echo "  expected: ${EXPECTED}" >&2
    echo "  actual  : ${ACTUAL}" >&2
    echo "  The download is corrupt or has been tampered with. Try again; if it keeps" >&2
    echo "  failing, open an issue at https://github.com/${REPO}/issues" >&2
    exit 1
fi
echo "  checksum : ok (sha256)"

# --- extract + install ------------------------------------------------------
tar -xzf "$WORK/$ASSET" -C "$WORK" || { echo "error: could not extract ${ASSET}" >&2; exit 1; }

BIN="$(find "$WORK" -type f -name bloxsmith -perm -u+x 2>/dev/null | head -1)"
[ -n "$BIN" ] || { echo "error: no 'bloxsmith' binary inside ${ASSET}" >&2; exit 1; }

mkdir -p "$PREFIX" || { echo "error: could not create ${PREFIX}" >&2; exit 1; }
install -m 0755 "$BIN" "$PREFIX/bloxsmith" 2>/dev/null \
    || { cp "$BIN" "$PREFIX/bloxsmith" && chmod 0755 "$PREFIX/bloxsmith"; } \
    || { echo "error: could not write to ${PREFIX} (choose another with --prefix DIR)" >&2; exit 1; }

echo ""
echo "Installed bloxsmith ${NUM} -> ${PREFIX}/bloxsmith"

# --- PATH advice (we never edit your shell rc) ------------------------------
case ":${PATH}:" in
    *":${PREFIX}:"*) ;;
    *)
        RC="your shell rc"
        case "$(basename "${SHELL:-sh}")" in
            zsh)  RC="~/.zshrc" ;;
            bash) RC="~/.bashrc" ;;
        esac
        echo ""
        echo "NOTE: ${PREFIX} is not on your PATH. Add this line to ${RC}, then reopen your shell:"
        echo ""
        echo "    export PATH=\"${PREFIX}:\$PATH\""
        ;;
esac

cat <<EOF

Next steps:
  ${PREFIX}/bloxsmith --version         # confirm the install
  ${PREFIX}/bloxsmith service install   # run Bloxsmith in the background at login
  ${PREFIX}/bloxsmith update            # upgrade in place, later

EOF
