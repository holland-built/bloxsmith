#!/usr/bin/env bash
# Runs go/tools/relsign — the tool that signs every release — including the
# refusals nothing else exercises.
#
# WHY. relsign is the trust anchor for the automated update path: the public half
# is compiled into the binary (go/signing.go), so a bad signature is the one thing
# that stops install.sh and `bloxsmith update` accepting an attacker's archive.
#
# It runs exactly twice in its life, both inside release.yml at tag time: once to
# sign, once to verify what it just signed. So:
#
#   * a break is found at RELEASE time, not push time -- and v3.23.2 already
#     published without its SSH signature, so that path does fail in practice; and
#   * only the HAPPY case is ever executed. Nothing anywhere checks that
#     `relsign verify` REFUSES a tampered file or a wrong key. A verifier that
#     cannot fail is decoration, and this one guards the update chain.
#
# Usage: bash scripts/relsign-test.sh
# Exit:  0 all checks passed, 1 a check failed.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass_count=0
fail_count=0
ok()  { pass_count=$((pass_count + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail_count=$((fail_count + 1)); printf '  FAIL %s\n' "$1"; }

BIN="$WORK/relsign"
( cd "$REPO/go" && go build -o "$BIN" ./tools/relsign ) || { echo "build failed"; exit 1; }

# --- keygen -------------------------------------------------------------------
"$BIN" keygen > "$WORK/keys.txt" 2>&1 || { echo "keygen failed"; cat "$WORK/keys.txt"; exit 1; }
PUB="$(awk '/^public/{print $2}'  "$WORK/keys.txt")"
PRIV="$(awk '/^private/{print $2}' "$WORK/keys.txt")"
# 32-byte public / 64-byte private, as hex. The private value must be the
# expanded form ed25519.Sign takes, or the CI secret would need a derivation step
# that nothing performs.
if [ "${#PUB}" -eq 64 ] && [ "${#PRIV}" -eq 128 ]; then
    ok "keygen printed a 32-byte public and 64-byte private key as hex"
else
    bad "keygen key sizes wrong: public ${#PUB} hex chars, private ${#PRIV}"
fi
# Two runs must not produce the same key.
"$BIN" keygen > "$WORK/keys2.txt" 2>&1
if [ "$(awk '/^public/{print $2}' "$WORK/keys2.txt")" != "$PUB" ]; then
    ok "keygen produces a different key each run"
else
    bad "keygen produced the SAME key twice — it is not random"
fi

# --- sign, then verify: the happy path release.yml runs ----------------------
printf 'abc123  bloxsmith_9.9.9_linux_amd64.tar.gz\n' > "$WORK/checksums.txt"
printf '%s' "$PRIV" > "$WORK/key.hex"

if "$BIN" sign -key "@$WORK/key.hex" -in "$WORK/checksums.txt" -out "$WORK/checksums.txt.ed25519" >/dev/null 2>&1; then
    ok "sign accepted the key from a @file (so CI keeps it off the command line)"
else
    bad "sign with @file key failed"
fi
if "$BIN" verify -pub "$PUB" -in "$WORK/checksums.txt" -sig "$WORK/checksums.txt.ed25519" >/dev/null 2>&1; then
    ok "verify accepts a genuine signature"
else
    bad "verify rejected a signature relsign had just produced"
fi

# --- THE REFUSALS. None of these run anywhere else. --------------------------

# 1. The actual attack: the signed file is edited after signing.
cp "$WORK/checksums.txt" "$WORK/tampered.txt"
printf 'deadbeef  extra_asset.tar.gz\n' >> "$WORK/tampered.txt"
out="$("$BIN" verify -pub "$PUB" -in "$WORK/tampered.txt" -sig "$WORK/checksums.txt.ed25519" 2>&1)"; code=$?
if [ "$code" -ne 0 ]; then
    ok "verify REFUSES a file edited after signing"
else
    bad "verify accepted a tampered file — the update chain has no signature check"
fi
if printf '%s' "$out" | grep -q "SIGNATURE DOES NOT VERIFY"; then
    ok "the refusal names the signature as the reason"
else
    bad "the refusal did not name the signature: $out"
fi

# 2. A signature made with a DIFFERENT key. This is the case where an attacker
# signs their own archive with their own key and hopes nobody checks whose key.
PUB2="$(awk '/^public/{print $2}' "$WORK/keys2.txt")"
if ! "$BIN" verify -pub "$PUB2" -in "$WORK/checksums.txt" -sig "$WORK/checksums.txt.ed25519" >/dev/null 2>&1; then
    ok "verify REFUSES a signature made with a different key"
else
    bad "verify accepted a signature from the wrong key"
fi

# 3. A corrupt signature file.
printf 'not base64 at all !!!\n' > "$WORK/bad.sig"
if ! "$BIN" verify -pub "$PUB" -in "$WORK/checksums.txt" -sig "$WORK/bad.sig" >/dev/null 2>&1; then
    ok "verify REFUSES a signature file that is not base64"
else
    bad "verify accepted a non-base64 signature"
fi

# 4. A truncated but validly-base64 signature.
printf 'AAAA\n' > "$WORK/short.sig"
if ! "$BIN" verify -pub "$PUB" -in "$WORK/checksums.txt" -sig "$WORK/short.sig" >/dev/null 2>&1; then
    ok "verify REFUSES a truncated signature"
else
    bad "verify accepted a truncated signature"
fi

# 5. A missing signature file -- the v3.23.1 attack shape: delete the signature
# and hope the verifier treats absent as acceptable.
if ! "$BIN" verify -pub "$PUB" -in "$WORK/checksums.txt" -sig "$WORK/nope.ed25519" >/dev/null 2>&1; then
    ok "verify REFUSES when the signature file is missing"
else
    bad "verify accepted a MISSING signature — absent must never mean acceptable"
fi

# 6. A wrong-sized key must be refused by size, not silently used.
if ! "$BIN" verify -pub "aabbcc" -in "$WORK/checksums.txt" -sig "$WORK/checksums.txt.ed25519" >/dev/null 2>&1; then
    ok "verify REFUSES a public key of the wrong size"
else
    bad "verify accepted a 3-byte public key"
fi
if ! "$BIN" sign -key "aabbcc" -in "$WORK/checksums.txt" -out "$WORK/x.sig" >/dev/null 2>&1; then
    ok "sign REFUSES a private key of the wrong size"
else
    bad "sign accepted a 3-byte private key"
fi

# 7. Bad usage is exit 2, not a silent success.
"$BIN" >/dev/null 2>&1; code=$?
if [ "$code" -eq 2 ]; then ok "no subcommand exits 2"; else bad "no subcommand exited $code, want 2"; fi
"$BIN" sign >/dev/null 2>&1; code=$?
if [ "$code" -eq 2 ]; then ok "sign with no flags exits 2"; else bad "sign with no flags exited $code, want 2"; fi

echo
echo "relsign: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
