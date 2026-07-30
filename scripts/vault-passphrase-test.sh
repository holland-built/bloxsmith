#!/usr/bin/env bash
# Runs the SHIPPED `bloxsmith vault-passphrase` commands against a REAL macOS
# keychain and a REAL encrypted vault. Nothing else does.
#
# WHY THIS EXISTS. internal/vault/keychain_test.go covers the package, and it
# skips on Linux with a stated reason — so on the Linux-only CI this repo had, the
# keychain code was never executed at all. The Go tests also cannot cover the
# thing an operator actually types: the CLI's own resolution of which vault, which
# source wins, and which exit code comes back. v3.30.1 was exactly that bug —
# `status` reported the opposite of what the server would do, and it shipped
# because no test ran the command.
#
# The same class of failure this repo has hit repeatedly: a parser is not a test,
# and a Go test of a package is not a test of the binary.
#
# SAFETY. Every keychain entry this creates is keyed on a vault path inside a
# throwaable temp directory, so it can never collide with a real install's entry
# (the account name IS the vault path — see internal/vault/keychain.go). The trap
# removes every entry it created and asserts it is gone. It never touches
# $HOME/Library/Application Support/bloxsmith.
#
# Usage: bash scripts/vault-passphrase-test.sh
# Exit:  0 all checks passed, 1 a check failed.

set -uo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
    echo "SKIP: this exercises the macOS keychain; nothing to run on $(uname -s)."
    echo "      (That skip is the reason this script exists — see the header.)"
    exit 0
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
BIN="$WORK/bloxsmith"
VAULT_DIRECTORY="$WORK/state"
VAULT="$VAULT_DIRECTORY/vault.json"
PASS='p a$s"w'"'"'o\rd	with	tabs and — dash'
SERVICE_NAME="bloxsmith-vault-passphrase"
BACKUP=""   # set once rotate creates one (checks 11+); declared here so the
            # cleanup trap can safely reference it even on an early exit.

pass_count=0
fail_count=0

ok()   { pass_count=$((pass_count + 1)); printf '  ok   %s\n' "$1"; }
bad()  { fail_count=$((fail_count + 1)); printf '  FAIL %s\n' "$1"; }

cleanup() {
    # Remove every entry this run could have created, then PROVE it is gone. A
    # test that leaves a keychain entry behind has changed the machine it ran on.
    security delete-generic-password -a "$VAULT" -s "$SERVICE_NAME" >/dev/null 2>&1
    if security find-generic-password -a "$VAULT" -s "$SERVICE_NAME" >/dev/null 2>&1; then
        printf '  FAIL cleanup left a keychain entry behind for %s\n' "$VAULT"
        fail_count=$((fail_count + 1))
    fi
    # The rotate checks stash a copy of the OLD passphrase under the backup
    # file's OWN path as a separate keychain account (proves the backup opens
    # independently of $VAULT's entry). Safety net in case an earlier failure
    # skipped that check's own inline removal.
    if [ -n "$BACKUP" ]; then
        security delete-generic-password -a "$BACKUP" -s "$SERVICE_NAME" >/dev/null 2>&1
        if security find-generic-password -a "$BACKUP" -s "$SERVICE_NAME" >/dev/null 2>&1; then
            printf '  FAIL cleanup left a keychain entry behind for %s\n' "$BACKUP"
            fail_count=$((fail_count + 1))
        fi
    fi
    rm -rf "$WORK"
}
trap cleanup EXIT

echo "building the real binary"
( cd "$REPO/go" && go build -o "$BIN" . ) || { echo "build failed"; exit 1; }
mkdir -p "$VAULT_DIRECTORY"

# --- create a REAL encrypted vault, by running the real server ---------------
# Not a hand-written fixture: the point is that the keychain passphrase opens a
# vault this program actually wrote. The server creates and seals it on first
# start when a passphrase is supplied (vault.AutoUnlock -> Init).
echo "creating a real vault by starting the real server"
PORT_T=8137
VAULT_DIR="$VAULT_DIRECTORY" VAULT_PASSPHRASE="$PASS" PORT="$PORT_T" \
    "$BIN" >"$WORK/server.log" 2>&1 &
SRV=$!
for _ in $(seq 1 40); do
    [ -f "$VAULT" ] && break
    sleep 0.25
done
kill "$SRV" 2>/dev/null
wait "$SRV" 2>/dev/null

if [ ! -f "$VAULT" ]; then
    echo "FAIL: the server did not create a vault at $VAULT"
    sed -n '1,40p' "$WORK/server.log"
    exit 1
fi
ok "the server created a real encrypted vault"

# The passphrase deliberately contains a tab and an em-dash. `security -w`
# returns a non-printable secret SILENTLY AS HEX, which would be used as the
# passphrase, fail to decrypt, and surface as "wrong passphrase" with nothing
# pointing at the cause. That is the operator-lockout bug v3.30.0 found, and this
# is the only place the whole path runs end to end with such a value.

# --- 1. nothing stored yet: status and check must both say so, distinctly -----
out="$("$BIN" vault-passphrase status --vault "$VAULT" 2>&1)"
if printf '%s' "$out" | grep -q "nothing stored for this vault"; then
    ok "status says nothing is stored, before anything is stored"
else
    bad "status did not report an empty keychain: $out"
fi

out="$("$BIN" vault-passphrase check --vault "$VAULT" 2>&1)"; code=$?
if [ "$code" -eq 2 ] && printf '%s' "$out" | grep -q "nothing is stored in the keychain"; then
    ok "check exits 2 (could not be checked) when nothing is stored"
else
    bad "check with nothing stored: exit $code, output: $out"
fi

# --- 2. set, via stdin (the automated-install path) --------------------------
if printf '%s' "$PASS" | "$BIN" vault-passphrase set --vault "$VAULT" >"$WORK/set.log" 2>&1; then
    ok "set stored an awkward passphrase (tab + em-dash) without erroring"
else
    bad "set failed: $(cat "$WORK/set.log")"
fi

# It must tell the operator the two things that make this worth anything.
if grep -q "Remove VAULT_PASSPHRASE" "$WORK/set.log"; then
    ok "set says the .env must be removed or nothing has changed"
else
    bad "set did not warn that an existing .env still wins"
fi
if grep -qi "ps" "$WORK/set.log" && grep -qi "command line" "$WORK/set.log"; then
    ok "set discloses the brief \`ps\` exposure it just created"
else
    bad "set did not disclose the ps exposure"
fi

# --- 3. the stored value is hex-marked on disk, not raw ----------------------
# This is the fix for the lockout bug, asserted at the layer it happens: what
# `security` holds must always be printable, so it always comes back raw.
raw="$(security find-generic-password -a "$VAULT" -s "$SERVICE_NAME" -w 2>/dev/null)"
case "$raw" in
    bxv1:*) ok "the keychain holds a bxv1: hex-marked value, so it always reads back raw" ;;
    "")     bad "nothing readable in the keychain after set" ;;
    *)      bad "the keychain holds an unmarked value ($(printf '%.20s' "$raw")...) — the hex encoding is not being applied" ;;
esac

# --- 4. check must now prove the stored value OPENS the vault ----------------
out="$("$BIN" vault-passphrase check --vault "$VAULT" 2>&1)"; code=$?
if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -q "opens this vault"; then
    ok "check exits 0 and confirms the stored passphrase opens the real vault"
else
    bad "check on a good passphrase: exit $code, output: $out"
fi

# The vault must be byte-identical afterwards: check reads, never writes.
before="$(shasum -a 256 "$VAULT" | cut -d' ' -f1)"
"$BIN" vault-passphrase check --vault "$VAULT" >/dev/null 2>&1
after="$(shasum -a 256 "$VAULT" | cut -d' ' -f1)"
if [ "$before" = "$after" ]; then
    ok "check left the vault byte-identical"
else
    bad "check MODIFIED the vault ($before -> $after)"
fi

# --- 5. status must now name the keychain as the winning source --------------
# Run from a scratch directory. Run from a directory that has its OWN .env (this
# repo does), status legitimately reports that .env's VAULT_PASSPHRASE — the env
# files are loaded unconditionally on purpose, which is the v3.30.1 fix. Which
# file it came from is asserted in check 6b below.
out="$(cd "$WORK" && "$BIN" vault-passphrase status --vault "$VAULT" 2>&1)"
if printf '%s' "$out" | grep -q "would come from: macOS keychain"; then
    ok "status names the keychain as the source, with no env var set"
else
    bad "status did not name the keychain: $out"
fi

# --- 6. THE v3.30.1 BUG. An env-supplied passphrase WINS over the keychain,
# and status must say so even though --vault was given explicitly. It once
# reported "macOS keychain" here, which is the opposite of what the server does.
out="$(VAULT_PASSPHRASE="something-else-entirely" "$BIN" vault-passphrase status --vault "$VAULT" 2>&1)"
if printf '%s' "$out" | grep -q "would come from: VAULT_PASSPHRASE"; then
    ok "status reports VAULT_PASSPHRASE winning over the keychain (the v3.30.1 bug)"
else
    bad "status claimed the keychain wins while VAULT_PASSPHRASE was set: $out"
fi
if printf '%s' "$out" | grep -q "keychain entry is being ignored"; then
    ok "status warns the keychain entry is being ignored"
else
    bad "status did not warn that the stored entry is ignored: $out"
fi
# 6a. A passphrase set in the real environment must be named as such, so an
# operator hunting for a file to edit is told there isn't one.
if printf '%s' "$out" | grep -q "shell's environment (not a .env file)"; then
    ok "status says the value came from the shell, not a file"
else
    bad "status did not say where VAULT_PASSPHRASE was read from: $out"
fi

# 6b. THE DEFECT THIS SCRIPT FOUND. Run from a directory whose own .env sets
# VAULT_PASSPHRASE, status reports "would come from: VAULT_PASSPHRASE" while
# naming a DIFFERENT vault — describing this shell's environment as though it
# were the environment of the server that opens that vault. The env files are
# loaded unconditionally on purpose (the v3.30.1 fix), so the fix is not to read
# fewer files; it is to NAME the file, so the mismatch is visible.
mkdir -p "$WORK/elsewhere"
printf 'VAULT_PASSPHRASE=a-totally-different-vaults-passphrase\n' > "$WORK/elsewhere/.env"
out="$(cd "$WORK/elsewhere" && "$BIN" vault-passphrase status --vault "$VAULT" 2>&1)"
if printf '%s' "$out" | grep -q "$WORK/elsewhere/.env"; then
    ok "status names the .env file its answer came from"
else
    bad "status blamed VAULT_PASSPHRASE without naming which .env set it: $out"
fi

# check must IGNORE the env var — it answers "will the keychain copy work once
# the plaintext one is gone", and consulting the env would answer using the very
# file the operator is about to delete.
out="$(VAULT_PASSPHRASE="something-else-entirely" "$BIN" vault-passphrase check --vault "$VAULT" 2>&1)"; code=$?
if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -q "opens this vault"; then
    ok "check ignores VAULT_PASSPHRASE and tests the keychain copy only"
else
    bad "check was influenced by VAULT_PASSPHRASE: exit $code, output: $out"
fi

# --- 7. A WRONG stored passphrase must exit 1 and refuse to bless it ---------
printf '%s' "definitely-not-the-passphrase" | "$BIN" vault-passphrase set --vault "$VAULT" >/dev/null 2>&1
out="$("$BIN" vault-passphrase check --vault "$VAULT" 2>&1)"; code=$?
if [ "$code" -eq 1 ] && printf '%s' "$out" | grep -q "does NOT open"; then
    ok "check exits 1 on a stored passphrase that does not open the vault"
else
    bad "check on a wrong passphrase: exit $code, output: $out"
fi
if printf '%s' "$out" | grep -q "Do not remove your plaintext copy"; then
    ok "the failure tells the operator not to delete their plaintext copy"
else
    bad "the failure did not warn against deleting the plaintext copy: $out"
fi

# --- 8. an entry this tool did NOT write must be refused, not guessed at -----
security add-generic-password -a "$VAULT" -s "$SERVICE_NAME" -w "written-by-keychain-access-by-hand" -U >/dev/null 2>&1
out="$("$BIN" vault-passphrase status --vault "$VAULT" 2>&1)"
if printf '%s' "$out" | grep -q "not written by"; then
    ok "a foreign keychain entry is refused rather than guessed at"
else
    bad "a foreign entry was not refused: $out"
fi

# --- 9. remove, and prove it is gone -----------------------------------------
if "$BIN" vault-passphrase remove --vault "$VAULT" >/dev/null 2>&1; then
    ok "remove exited 0"
else
    bad "remove failed"
fi
if security find-generic-password -a "$VAULT" -s "$SERVICE_NAME" >/dev/null 2>&1; then
    bad "remove left the entry in the keychain"
else
    ok "the entry is actually gone from the keychain"
fi
# Removing again is not an error: the requested end state already holds.
if "$BIN" vault-passphrase remove --vault "$VAULT" >/dev/null 2>&1; then
    ok "remove is idempotent (removing nothing is not a failure)"
else
    bad "a second remove reported a failure"
fi

# --- 10. bad usage is exit 3, distinct from every verdict --------------------
"$BIN" vault-passphrase >/dev/null 2>&1; code=$?
if [ "$code" -eq 3 ]; then ok "no subcommand exits 3 (bad usage)"; else bad "no subcommand exited $code, want 3"; fi
"$BIN" vault-passphrase wat >/dev/null 2>&1; code=$?
if [ "$code" -eq 3 ]; then ok "an unknown subcommand exits 3"; else bad "unknown subcommand exited $code, want 3"; fi
"$BIN" vault-passphrase --help >/dev/null 2>&1; code=$?
if [ "$code" -eq 0 ]; then ok "--help exits 0"; else bad "--help exited $code, want 0"; fi

# =====================================================================
# ROTATE — re-encrypts vault.json under a new passphrase. Get this wrong and
# the operator loses every tenant key permanently, so it gets the same
# treatment as everything above: the real binary, against the real vault,
# with keychain entries reached by hand only where the test needs state the
# CLI itself would never produce.
#
# `rotate` (unlike `check`) DOES consult VAULT_PASSPHRASE / .env (see check 6
# above), and $REPO/.env sets a real one for a real install. Run it from cwd
# unguarded and that value — not the keychain entry under test — would win
# and get "verified" against the wrong vault entirely. Every rotate call
# below runs from $WORK instead, which has no .env of its own.
# =====================================================================

NEWPASS='rotated-2026-passphrase!'

# --- 11. store the CURRENT passphrase, then rotate to a NEW one --------------
printf '%s' "$PASS" | "$BIN" vault-passphrase set --vault "$VAULT" >/dev/null 2>&1
out="$("$BIN" vault-passphrase check --vault "$VAULT" 2>&1)"
before_tenants="$(printf '%s' "$out" | grep -oE '[0-9]+ tenants? inside' | grep -oE '^[0-9]+')"

out="$(cd "$WORK" && printf '%s' "$NEWPASS" | "$BIN" vault-passphrase rotate --vault "$VAULT" 2>&1)"; code=$?
if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -q "opens ONLY with the new passphrase"; then
    ok "rotate exits 0 and says the vault opens only with the new passphrase"
else
    bad "rotate: exit $code, output: $out"
fi
BACKUP="$(printf '%s' "$out" | sed -n 's/^  backup (still opens with the OLD passphrase): //p')"
if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
    ok "rotate created a backup file: $BACKUP"
else
    bad "rotate did not report a backup file that actually exists: $out"
fi

# --- 12. THE POINT: check must now PASS with the keychain holding the NEW
# passphrase — proving rotate updated the keychain, not just vault.json.
out="$("$BIN" vault-passphrase check --vault "$VAULT" 2>&1)"; code=$?
if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -q "opens this vault"; then
    ok "check passes against the keychain after rotate"
else
    bad "check after rotate: exit $code, output: $out"
fi
after_tenants="$(printf '%s' "$out" | grep -oE '[0-9]+ tenants? inside' | grep -oE '^[0-9]+')"
if [ -n "$before_tenants" ] && [ "$before_tenants" = "$after_tenants" ]; then
    ok "tenant count is preserved across rotate ($before_tenants -> $after_tenants)"
else
    bad "tenant count changed across rotate (before: '$before_tenants', after: '$after_tenants')"
fi

# --- 13. the backup is 0600 and still opens with the OLD passphrase ----------
perm="$(stat -f '%Lp' "$BACKUP" 2>/dev/null)"
if [ "$perm" = "600" ]; then
    ok "the backup file is mode 0600"
else
    bad "the backup file has mode '$perm', want 600"
fi
# Proven via `check` itself, pointed AT the backup, with the OLD passphrase
# stashed under a SEPARATE keychain account keyed on the backup's own path —
# the account name IS the vault path (internal/vault/keychain.go), so this
# cannot collide with, or be satisfied by, $VAULT's own entry.
OLD_HEX="$(printf '%s' "$PASS" | xxd -p | tr -d '\n')"
security add-generic-password -a "$BACKUP" -s "$SERVICE_NAME" -w "bxv1:$OLD_HEX" -U >/dev/null 2>&1
out="$("$BIN" vault-passphrase check --vault "$BACKUP" 2>&1)"; code=$?
if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -q "opens this vault"; then
    ok "the backup still opens with the OLD passphrase"
else
    bad "the backup did not open with the OLD passphrase: exit $code, output: $out"
fi
security delete-generic-password -a "$BACKUP" -s "$SERVICE_NAME" >/dev/null 2>&1
if security find-generic-password -a "$BACKUP" -s "$SERVICE_NAME" >/dev/null 2>&1; then
    bad "the backup's keychain entry was not actually removed"
else
    ok "the backup's keychain entry is removed"
fi

# --- 14. the OLD passphrase must NO LONGER open the (rotated) main vault -----
security add-generic-password -a "$VAULT" -s "$SERVICE_NAME" -w "bxv1:$OLD_HEX" -U >/dev/null 2>&1
out="$("$BIN" vault-passphrase check --vault "$VAULT" 2>&1)"; code=$?
if [ "$code" -eq 1 ] && printf '%s' "$out" | grep -q "does NOT open"; then
    ok "the OLD passphrase no longer opens the rotated vault"
else
    bad "old passphrase after rotate: exit $code, output: $out"
fi
# Restore the real post-rotate state before anything downstream depends on it.
NEW_HEX="$(printf '%s' "$NEWPASS" | xxd -p | tr -d '\n')"
security add-generic-password -a "$VAULT" -s "$SERVICE_NAME" -w "bxv1:$NEW_HEX" -U >/dev/null 2>&1

# --- 15. a too-short new passphrase is refused, vault.json untouched ---------
before="$(shasum -a 256 "$VAULT" | cut -d' ' -f1)"
out="$(cd "$WORK" && printf '%s' "short1" | "$BIN" vault-passphrase rotate --vault "$VAULT" 2>&1)"; code=$?
after="$(shasum -a 256 "$VAULT" | cut -d' ' -f1)"
if [ "$code" -eq 1 ] && printf '%s' "$out" | grep -q "at least 8 characters"; then
    ok "a too-short new passphrase is refused"
else
    bad "too-short new passphrase: exit $code, output: $out"
fi
if [ "$before" = "$after" ]; then
    ok "vault.json is byte-identical after a refused too-short rotate"
else
    bad "vault.json CHANGED after a refused too-short rotate ($before -> $after)"
fi

# --- 16. rotate with NO current passphrase available (every source unset) ----
before="$(shasum -a 256 "$VAULT" | cut -d' ' -f1)"
security delete-generic-password -a "$VAULT" -s "$SERVICE_NAME" >/dev/null 2>&1
out="$(cd "$WORK" && printf '%s' "another-new-passphrase" | "$BIN" vault-passphrase rotate --vault "$VAULT" 2>&1)"; code=$?
after="$(shasum -a 256 "$VAULT" | cut -d' ' -f1)"
if [ "$code" -eq 1 ] && printf '%s' "$out" | grep -q "no current passphrase is configured"; then
    ok "rotate refuses when no current passphrase is configured anywhere"
else
    bad "rotate with no current passphrase source: exit $code, output: $out"
fi
if [ "$before" = "$after" ]; then
    ok "vault.json is byte-identical after the no-current-passphrase refusal"
else
    bad "vault.json CHANGED after a refused rotate with no current passphrase ($before -> $after)"
fi
# Restore the keychain entry so the trap's removal-and-proof at the end has
# the real post-rotate state to remove, same as every check above it left it.
security add-generic-password -a "$VAULT" -s "$SERVICE_NAME" -w "bxv1:$NEW_HEX" -U >/dev/null 2>&1

echo
echo "vault-passphrase: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
