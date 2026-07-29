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
SERVICE=auto   # auto = prompt if interactive; set by --service / --no-service
UNINSTALL=no
PURGE=no

usage() {
    cat <<EOF
Bloxsmith installer

Usage: sh install.sh [options]

Options:
  --version vX.Y.Z   Install a specific release (default: latest)
  --prefix DIR       Install directory (default: \$HOME/.local/bin)
  --service          Also register the login service (no prompt)
  --no-service       Skip the login-service step (no prompt)
  --uninstall        Remove bloxsmith (binary, templates, login service)
  --purge            With --uninstall, also delete config + encrypted vault
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
        --service)    SERVICE=yes; shift ;;
        --no-service) SERVICE=no;  shift ;;
        --uninstall)  UNINSTALL=yes; shift ;;
        --purge)      PURGE=yes; shift ;;
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

# Wait up to ~20s for the dashboard to answer, then return 0/1.
wait_for_url() {
    _i=0
    while [ "$_i" -lt 40 ]; do
        if curl -fsS -o /dev/null "$1" 2>/dev/null; then return 0; fi
        _i=$((_i + 1)); sleep 0.5
    done
    return 1
}

# Best-effort browser open; never fails the script.
open_url() {
    if command -v open >/dev/null 2>&1; then
        open "$1" >/dev/null 2>&1 || true
    elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$1" >/dev/null 2>&1 || true
    else
        echo "Open this in your browser: $1"
    fi
}

# --- detect platform --------------------------------------------------------
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64|amd64)  ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "error: unsupported architecture '$ARCH'" >&2; exit 1 ;;
esac

# --- uninstall (no download needed) -----------------------------------------
if [ "$UNINSTALL" = yes ]; then
    echo "Bloxsmith uninstaller"
    BIN="$PREFIX/bloxsmith"
    if [ -x "$BIN" ]; then
        # unregister + stop the login service if it was ever set up (best-effort)
        "$BIN" service uninstall >/dev/null 2>&1 || true
    fi
    if [ -e "$BIN" ]; then
        rm -f "$BIN" && echo "  removed  : $BIN"
    else
        echo "  (no binary at $BIN — nothing to remove there)"
    fi
    if [ -d "$PREFIX/templates" ]; then
        rm -rf "$PREFIX/templates" && echo "  removed  : $PREFIX/templates"
    fi
    case "$OS" in
        darwin) CFG="$HOME/Library/Application Support/bloxsmith" ;;
        *)      CFG="${XDG_CONFIG_HOME:-$HOME/.config}/bloxsmith" ;;
    esac
    if [ "$PURGE" = yes ]; then
        if [ -d "$CFG" ]; then rm -rf "$CFG" && echo "  removed  : $CFG (config + vault)"; fi
    elif [ -d "$CFG" ]; then
        echo ""
        echo "Config + encrypted vault left in place at:"
        echo "    $CFG"
        echo "Delete it too with:  sh install.sh --uninstall --purge   (or: rm -rf \"$CFG\")"
    fi
    echo ""
    echo "Bloxsmith uninstalled."
    exit 0
fi

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
# TWO CHECKS, and they are not the same check.
#
# 1. SIGNATURE. checksums.txt is signed with an Ed25519 key held only in this
#    repository's GitHub Actions secrets. The public half is pinned in this
#    script, so the thing that decides whether a release is genuine does NOT
#    travel with the release — which is exactly what a checksum sitting beside
#    the archive it validates can never do. Verified here when openssl supports
#    raw Ed25519 (OpenSSL 3.x); macOS ships LibreSSL, which does not, so this
#    degrades to a stated fact rather than a silent pass. The installed binary
#    ALWAYS verifies this signature before a self-update, whatever openssl is on
#    the machine (go/signing.go), so the automated path is never the weak one.
#
# 2. CHECKSUM. Proves the archive matches what was signed. On its own it catches
#    a corrupt or truncated download and a broken mirror — nothing more.
SIG_PUBKEY_PEM="-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAL0O2g8iJMvkw7ZxIw1NGsD8Cb6X2H+LbFs3e/GYRG4k=
-----END PUBLIC KEY-----"

if curl --proto '=https' --tlsv1.2 -fsSLo "$WORK/checksums.txt.ed25519" \
        "${BASE}/checksums.txt.ed25519" 2>/dev/null; then
    if command -v openssl >/dev/null 2>&1 && openssl pkeyutl -help 2>&1 | grep -q -- '-rawin'; then
        printf '%s\n' "$SIG_PUBKEY_PEM" > "$WORK/relsign.pem"
        if ! base64 -d < "$WORK/checksums.txt.ed25519" > "$WORK/checksums.sig" 2>/dev/null \
           && ! base64 -D < "$WORK/checksums.txt.ed25519" > "$WORK/checksums.sig" 2>/dev/null; then
            echo "error: could not decode checksums.txt.ed25519 — refusing to install" >&2
            exit 1
        fi
        if openssl pkeyutl -verify -pubin -inkey "$WORK/relsign.pem" -rawin \
                -in "$WORK/checksums.txt" -sigfile "$WORK/checksums.sig" >/dev/null 2>&1; then
            echo "  signature: ok (ed25519, key pinned in this script)"
        else
            echo "error: RELEASE SIGNATURE DOES NOT VERIFY — refusing to install." >&2
            echo "  checksums.txt was not signed by this project's release key." >&2
            echo "  Do not retry blindly; report it at https://github.com/${REPO}/issues" >&2
            exit 1
        fi
    else
        echo "  signature: present but NOT checked (this openssl cannot verify raw ed25519)"
        echo "             the installed binary verifies it on every self-update"
    fi
else
    echo "  signature: none published for this release — checksum only"
    echo "             (a checksum from the same release proves the download is intact,"
    echo "              not that this project published it)"
fi

EXPECTED"$(awk -v f="$ASSET" '$2 == f || $2 == "*" f {print $1}' "$WORK/checksums.txt" | head -1)"
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

# The archive bundles a templates/ dir next to the binary; the default
# TemplatesDir is <binary-dir>/templates, so copy it beside the installed
# binary or Seed Demo / Provision report "templates not installed".
TEMPLATES_SRC="$(dirname "$BIN")/templates"
if [ -d "$TEMPLATES_SRC" ]; then
    rm -rf "$PREFIX/templates"
    cp -R "$TEMPLATES_SRC" "$PREFIX/templates" \
        || echo "warning: could not install templates -> ${PREFIX}/templates (Seed Demo will be unavailable)" >&2
fi

echo ""
echo "Installed bloxsmith ${NUM} -> ${PREFIX}/bloxsmith"

# --- optional login service -------------------------------------------------
# The background service does NOT read your shell env — it loads keys from
#   ~/Library/Application Support/bloxsmith/.env  (macOS)
# so set INFOBLOX_API_KEY there for it to start authenticated.
DO_SERVICE="$SERVICE"
if [ "$DO_SERVICE" = "auto" ]; then
    if [ -t 0 ]; then
        printf 'Run Bloxsmith at login as a background service? [y/N] '
        REPLY=""
        read REPLY || REPLY=""
        case "$REPLY" in
            y|Y|yes) DO_SERVICE=yes ;;
            *)       DO_SERVICE=no ;;
        esac
    else
        DO_SERVICE=no   # non-interactive (CI/piped): never hang, default to no
    fi
fi

if [ "$DO_SERVICE" = "yes" ]; then
    echo ""
    if "$PREFIX/bloxsmith" service install; then
        echo "Registered the login service."
        echo "NOTE: the service loads keys from ~/Library/Application Support/bloxsmith/.env"
        echo "      (macOS), not your shell — set INFOBLOX_API_KEY there so it starts authenticated."
    else
        echo "WARNING: 'bloxsmith service install' failed — the binary is installed; retry later" >&2
        echo "         with: ${PREFIX}/bloxsmith service install" >&2
    fi
else
    echo ""
    echo "Skipped the login service. Register it later with: ${PREFIX}/bloxsmith service install"
fi

# --- get the user to the dashboard, zero extra steps ------------------------
URL="http://localhost:8080"
if [ "$DO_SERVICE" = "yes" ]; then
    # `service install` registers the unit but does NOT start it — start it now.
    "$PREFIX/bloxsmith" service start >/dev/null 2>&1 || true
    echo ""
    echo "Starting Bloxsmith and opening ${URL} ..."
    if wait_for_url "$URL"; then open_url "$URL"; else
        echo "Bloxsmith did not answer on ${URL} yet — open it manually once it's up."
    fi
elif [ -t 0 ]; then
    # No service, interactive install: launch detached so the terminal returns.
    echo ""
    echo "Starting Bloxsmith and opening ${URL} ..."
    nohup "$PREFIX/bloxsmith" >/dev/null 2>&1 </dev/null &
    if wait_for_url "$URL"; then open_url "$URL"; else
        echo "Bloxsmith is starting — open ${URL} in your browser."
    fi
fi
# Non-interactive + no service: fall through to "Next steps" unchanged.

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
