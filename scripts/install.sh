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
#    the archive it validates can never do.
#
#    Two independent tools can check that signature, tried in this order:
#      a) ssh-keygen -Y verify against an SSH-format signature
#         (checksums.txt.sshsig). Preferred, because ssh-keygen ships by
#         default on macOS, Linux, and Windows 10+ — that's what makes the
#         check actually RUN on the platform most installs happen on, instead
#         of being silently skipped.
#      b) openssl pkeyutl -rawin against a raw Ed25519 signature
#         (checksums.txt.ed25519). Kept as a fallback for hosts without a
#         usable ssh-keygen, but it needs OpenSSL 3.x — macOS ships LibreSSL,
#         which cannot do this, so (a) is what actually covers a stock Mac.
#
#    Releases from 3.23.0 onward always carry a signature (CI refuses to
#    publish without one), so for "latest" or any pinned version >= 3.23.0 the
#    signature is REQUIRED: no signature asset at all, a download that can't
#    be checked (neither tool above is usable), or a signature that fails to
#    verify all REFUSE the install rather than fall back to checksum-only.
#    Falling back is not a degrade, it is the control turned off — an
#    attacker who can write release assets would simply arrange the fallback
#    by deleting the signature. The installed binary ALWAYS verifies this
#    signature before a self-update (go/apply.go, go/signing.go); refusing
#    here just brings the one-time install up to the same bar.
#
#    The one legitimate exception: a release pinned with --version to an exact
#    tag OLDER than 3.23.0 genuinely predates signing. That is stated as a fact
#    about that specific old release, never as "signing is unavailable."
#
# 2. CHECKSUM. Proves the archive matches what was signed (or, for a pinned
#    pre-3.23.0 release, matches what was published). On its own it catches a
#    corrupt or truncated download and a broken mirror — nothing more.
SIG_SSH_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILh1e4Aj8VwLy+7PBMzfkwqDa7amfqAgpSmF1sq4S+g9"

SIG_PUBKEY_PEM="-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAL0O2g8iJMvkw7ZxIw1NGsD8Cb6X2H+LbFs3e/GYRG4k=
-----END PUBLIC KEY-----"

# 3.23.0 is when CI started refusing to publish a release without a signature.
SIGNING_SINCE="3.23.0"

# A bare "X.Y.Z" (optionally with a -suffix) at the front of $NUM; anything
# else (a malformed --version, an unexpected checksums.txt format) cannot be
# compared, so callers must fail closed rather than assume it's old.
is_valid_semver() {
    printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+'
}

# True (exit 0) if semver $1 >= semver $2. sort -V ships on both macOS and
# Linux; whichever version sorts last is the greater one.
version_ge() {
    [ "$1" = "$2" ] && return 0
    [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ]
}

# Decide once, up front, whether this install may proceed without a verified
# signature. "latest" and anything >= SIGNING_SINCE must have one; an
# unparseable $NUM is treated the same as "must have one" — fail closed, never
# open.
if [ "$VERSION" = "latest" ]; then
    SIG_REQUIRED=yes
elif ! is_valid_semver "$NUM"; then
    SIG_REQUIRED=yes
elif version_ge "$NUM" "$SIGNING_SINCE"; then
    SIG_REQUIRED=yes
else
    SIG_REQUIRED=no
fi

# A failed download and a genuinely absent asset are different outcomes and
# must not print the same way: curl -f exits 22 specifically on an HTTP error
# (a real 404 — the asset does not exist), anything else is a network/local
# failure that tells us nothing about whether the asset exists. Both
# signature assets get the same treatment, fetched independently — a release
# could in principle carry one format without the other.
if curl --proto '=https' --tlsv1.2 -fsSLo "$WORK/checksums.txt.sshsig" \
        "${BASE}/checksums.txt.sshsig" 2>/dev/null; then
    SSHSIG_FETCH_RC=0
else
    SSHSIG_FETCH_RC=$?
fi

if curl --proto '=https' --tlsv1.2 -fsSLo "$WORK/checksums.txt.ed25519" \
        "${BASE}/checksums.txt.ed25519" 2>/dev/null; then
    SIG_FETCH_RC=0
else
    SIG_FETCH_RC=$?
fi

if command -v ssh-keygen >/dev/null 2>&1 && [ "$SSHSIG_FETCH_RC" -eq 0 ]; then
    printf '%s %s\n' "bloxsmith-release-signing" "$SIG_SSH_PUBKEY" > "$WORK/allowed_signers"
    if ssh-keygen -Y verify -f "$WORK/allowed_signers" -I bloxsmith-release-signing \
            -n bloxsmith-release -s "$WORK/checksums.txt.sshsig" \
            < "$WORK/checksums.txt" >/dev/null 2>&1; then
        echo "  signature: ok (ssh-ed25519, key pinned in this script)"
    else
        echo "error: RELEASE SIGNATURE DOES NOT VERIFY — refusing to install." >&2
        echo "  checksums.txt was not signed by this project's release key." >&2
        echo "  Do not retry blindly; report it at https://github.com/${REPO}/issues" >&2
        exit 1
    fi
elif command -v openssl >/dev/null 2>&1 && openssl pkeyutl -help 2>&1 | grep -q -- '-rawin' \
        && [ "$SIG_FETCH_RC" -eq 0 ]; then
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
elif [ "$SSHSIG_FETCH_RC" -eq 0 ] || [ "$SIG_FETCH_RC" -eq 0 ]; then
    # At least one signature asset downloaded, but no available tool could
    # check it: ssh-keygen is missing for .sshsig, or this openssl can't do
    # raw Ed25519 for .ed25519. The signature exists — it's just unverifiable
    # here, which is not the same thing as absent.
    if [ "$SIG_REQUIRED" = yes ]; then
        echo "error: release ${NUM} is signed, but nothing here can verify it —" >&2
        echo "  refusing to install unverified." >&2
        command -v ssh-keygen >/dev/null 2>&1 \
            || echo "  ssh-keygen not found (ships by default on macOS/Linux/Windows 10+)" >&2
        if ! command -v openssl >/dev/null 2>&1 || ! openssl pkeyutl -help 2>&1 | grep -q -- '-rawin'; then
            echo "  openssl here cannot verify raw Ed25519 (needs OpenSSL 3.x); on macOS:" >&2
            echo "    brew install openssl@3" >&2
        fi
        echo "  Do not retry blindly if this persists; report it at https://github.com/${REPO}/issues" >&2
        exit 1
    else
        echo "  signature: present but NOT checked (no usable ssh-keygen or openssl here)"
        echo "             the installed binary verifies it on every self-update"
    fi
elif [ "$SSHSIG_FETCH_RC" -eq 22 ] && [ "$SIG_FETCH_RC" -eq 22 ]; then
    # Both signature assets are genuinely absent (real 404s, not fetch
    # failures) — this release was never signed at all.
    if [ "$SIG_REQUIRED" = yes ]; then
        echo "error: release ${NUM} has no signature asset (checksums.txt.sshsig or" >&2
        echo "  checksums.txt.ed25519) — refusing to install." >&2
        echo "  Releases from ${SIGNING_SINCE} onward are always signed, so a signed" >&2
        echo "  release with no signature asset cannot be authenticated." >&2
        echo "  Do not retry blindly if this persists; report it at https://github.com/${REPO}/issues" >&2
        exit 1
    else
        echo "  signature: none — release ${NUM} predates release signing (introduced in"
        echo "             ${SIGNING_SINCE}); checksum only for this specific old release"
    fi
else
    # Neither asset downloaded, and at least one failure wasn't a 404 — a
    # fetch problem (network/local), not evidence the release lacks a
    # signature. Must not be reported the same way as a genuine absence.
    if [ "$SIG_REQUIRED" = yes ]; then
        echo "error: could not download the release signature (checksums.txt.sshsig" >&2
        echo "  exit ${SSHSIG_FETCH_RC}, checksums.txt.ed25519 exit ${SIG_FETCH_RC}) —" >&2
        echo "  refusing to install without verifying the signature. This is a fetch" >&2
        echo "  failure, not a release that lacks a signature; check your network and retry." >&2
        echo "  Do not retry blindly if this persists; report it at https://github.com/${REPO}/issues" >&2
        exit 1
    else
        echo "  signature: could not be downloaded (checksums.txt.sshsig exit ${SSHSIG_FETCH_RC},"
        echo "             checksums.txt.ed25519 exit ${SIG_FETCH_RC}); release ${NUM}"
        echo "             predates release signing anyway (introduced in ${SIGNING_SINCE}),"
        echo "             so continuing checksum only"
    fi
fi

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
