#!/usr/bin/env bash
# For each named SECURITY CONTROL below: snapshot the file that implements it,
# apply the EXACT mutation that would disable it, run the smallest test
# command that should catch that, require the suite to go RED, then restore
# the file and prove the restore is byte-identical. If the suite stays GREEN
# with the control deleted, this script fails the build.
#
# WHY. Three times in one day a security control was silently unprotected:
# the test suite stayed fully GREEN while the control was disabled, because
# the tests drove a stub instead of the production wiring.
#   * restorecli_apply.go: `writable := v.WriteAllowed(currentID)` ->
#     `writable := true` disabled the per-tenant write lock for
#     `restore-plan --apply`. The ENTIRE suite stayed green.
#   * passcli_rotate.go: the vault-rotate verification result was ignored.
#   * internal/store/store.go: the AI budget fabricated a daily limit it had
#     never been told.
# All three were found only because a human happened to try the mutation by
# hand. The fourth one nobody thinks to try is the one that ships. This
# script makes "the tests protect this control" a fact the build checks,
# instead of a belief nobody has verified since the test was written.
#
# THREE PROPERTIES THAT ARE THE WHOLE POINT:
#   1. ASSERT THE MUTATION LANDED. Every mutation is an EXACT, byte-for-byte
#      substring match (via python3, not a regex — Go source is full of the
#      quotes/brackets/parens that make sed/perl regex escaping its own bug
#      farm) that must occur EXACTLY ONCE. If it occurs zero or more than one
#      time, this script FAILS LOUDLY naming the control — it never silently
#      skips or passes a control whose anchor text has drifted.
#   2. RESTORE ALWAYS. Every file is snapshotted before any mutation, restored
#      immediately after its own test runs, and re-verified byte-identical by
#      sha256 both then AND from a trap that fires on any exit (including
#      Ctrl-C) — so an interrupted run can never leave a mutated source file
#      behind.
#   3. REFUSE A DIRTY TREE. Before mutating anything, every target file is
#      checked with `git diff --quiet HEAD -- <file>`; if any of them already
#      has uncommitted changes, this script refuses to run at all rather than
#      risk clobbering work that was never committed, and says which file.
#
# Usage: bash scripts/control-guard.sh
# Exit:  0 every control's test correctly went red, 1 any control did not.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO="$ROOT/go"
WORK="$(mktemp -d)"

pass_count=0
fail_count=0
ok()  { pass_count=$((pass_count + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail_count=$((fail_count + 1)); printf '  FAIL %s\n' "$1"; }
say() { printf '\n=== %s\n' "$1"; }

# --- the files this run will mutate, one at a time --------------------------
TARGET_RELS=(
  "go/restorecli_apply.go"
  "go/passcli_rotate.go"
  "go/internal/provision/decommission.go"
  "go/internal/store/store.go"
  "scripts/install.sh"
  "go/internal/audit/audit.go"
  "go/internal/server/provision.go"
)

sha() { shasum -a 256 "$1" | awk '{print $1}'; }

snapshot_path() {
  printf '%s/%s.snapshot' "$WORK" "$(printf '%s' "$1" | tr '/' '_')"
}

# restore_all is the trap: fires on normal exit, an error, or Ctrl-C. Restores
# every target file that still differs from its pristine snapshot. A control
# that already restored itself cleanly costs this nothing (cmp says identical,
# nothing to copy); a control interrupted mid-mutation gets its file put back.
restore_all() {
  local rel abs snap
  for rel in "${TARGET_RELS[@]}"; do
    abs="$ROOT/$rel"
    snap="$(snapshot_path "$rel")"
    if [ -f "$snap" ] && ! cmp -s "$abs" "$snap"; then
      cp "$snap" "$abs"
      echo "control-guard: restored $rel on exit (was left mutated)" >&2
    fi
  done
  rm -rf "$WORK"
}
trap restore_all EXIT INT TERM

# --- refuse a dirty tree for anything this script is about to mutate --------
say "pre-flight: refuse to run on a dirty tree for any target file"
dirty=0
for rel in "${TARGET_RELS[@]}"; do
  if ! git -C "$ROOT" diff --quiet HEAD -- "$rel"; then
    echo "REFUSING: $rel has uncommitted changes — this script would mutate and " \
         "restore it, and any interruption could clobber work that was never " \
         "committed. Commit or stash it first." >&2
    dirty=1
  fi
done
if [ "$dirty" -ne 0 ]; then
  exit 1
fi
ok "every target file is clean per git diff HEAD"

# --- snapshot every target file up front -------------------------------------
for rel in "${TARGET_RELS[@]}"; do
  cp "$ROOT/$rel" "$(snapshot_path "$rel")"
done

# verify_pristine is a self-check: the file must still match its snapshot
# before THIS control mutates it. If it does not, a previous control's
# restore failed silently, and continuing would mutate on top of that — so
# this refuses outright rather than compounding the problem.
verify_pristine() {
  local rel="$1" abs snap
  abs="$ROOT/$rel"
  snap="$(snapshot_path "$rel")"
  if [ "$(sha "$abs")" != "$(sha "$snap")" ]; then
    echo "INTERNAL ERROR: $rel is not byte-identical to its snapshot before " \
         "mutating it — a previous control's restore did not hold. Refusing " \
         "to continue." >&2
    exit 1
  fi
}

# finish_control runs the scoped test command against the just-mutated tree,
# requires it to fail, then restores the file and proves the restore by
# sha256. Shared tail for every control below.
#   $1 = control id   $2 = file's repo-relative path   $3 = workdir
#   $4.. = the test command
finish_control() {
  local id="$1" rel="$2" workdir="$3" abs snap before after
  shift 3
  abs="$ROOT/$rel"
  snap="$(snapshot_path "$rel")"

  if ( cd "$workdir" && "$@" ) >"$WORK/test-$id.out" 2>&1; then
    bad "$id: the test suite STAYED GREEN with the control disabled — it is not protecting this control"
    echo "  --- test output (scoped command: $* ) ---"
    tail -n 25 "$WORK/test-$id.out" | sed 's/^/    /'
  else
    ok "$id: the test suite correctly went RED with the control disabled (scoped command: $*)"
  fi

  cp "$snap" "$abs"
  before="$(sha "$snap")"
  after="$(sha "$abs")"
  if [ "$before" = "$after" ]; then
    ok "$id: $rel restored byte-identical (sha256 $after)"
  else
    bad "$id: $rel NOT restored byte-identical — before=$before after=$after"
  fi
}

# apply_py runs a python3 program (given on stdin) against one file. The
# program must define OLD and NEW, and is expected to: read the file, assert
# OLD occurs EXACTLY ONCE, write back with OLD replaced by NEW. Exits nonzero
# (and prints ANCHOR_COUNT=<n>) if OLD occurs zero or more than one time —
# this is property 1, made mechanical instead of a promise.
apply_py() {
  python3 - "$1"
}

# g_install_sig_refusal_test is the scoped "test command" for control g. There
# is no Go test for install.sh's refusal — ci.yml proves it against the real
# GitHub release over the network (job install-sh, step "install.sh refuses a
# tampered or unsigned checksums.txt"), which is impractical to redo inside
# this script. So this reimplements the SAME curl-shim technique that step
# uses — a fake `curl` on PATH that serves files from a local directory
# instead of hitting the network — against a synthetic, fully local release: a
# forged archive, a matching checksums.txt, and a signature made with a
# THROWAWAY keypair that is never the project's real one. install.sh's pinned
# public key cannot verify a throwaway signature, so an intact check must
# refuse exactly as it would refuse a tampered checksums.txt.
#
# Exit 0 (a PASS) when install.sh correctly refuses; exit nonzero when it
# installs the unverifiable release anyway — which is what must happen once
# the signature check itself is disabled, and is what proves this test was
# ever exercising that check.
g_install_sig_refusal_test() {
  local w os asset_fmt asset hash out_log
  w="$(mktemp -d)"
  mkdir -p "$w/bin" "$w/rel" "$w/payload" "$w/out"

  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$os" in
    darwin) asset_fmt='bloxsmith_%s_macOS_universal.tar.gz' ;;
    linux)  asset_fmt='bloxsmith_%s_linux_amd64.tar.gz' ;;
    *) echo "g: unsupported OS $os for this offline fixture" >&2; rm -rf "$w"; return 1 ;;
  esac
  asset="$(printf "$asset_fmt" "9.9.9")"

  printf '#!/bin/sh\necho FORGED\n' > "$w/payload/bloxsmith"
  chmod +x "$w/payload/bloxsmith"
  tar -czf "$w/rel/$asset" -C "$w/payload" bloxsmith
  hash="$(sha "$w/rel/$asset")"
  printf '%s  %s\n' "$hash" "$asset" > "$w/rel/checksums.txt"

  ssh-keygen -q -t ed25519 -N '' -f "$w/throwaway" >/dev/null
  ssh-keygen -Y sign -f "$w/throwaway" -n bloxsmith-release "$w/rel/checksums.txt" >/dev/null 2>&1
  mv "$w/rel/checksums.txt.sig" "$w/rel/checksums.txt.sshsig"

  printf '%s\n' '#!/bin/sh' 'out=""; url=""' \
    'while [ $# -gt 0 ]; do case "$1" in -*o) out="$2"; shift 2;; -*) case "$1" in *o) out="$2"; shift 2;; *) shift;; esac;; *) url="$1"; shift;; esac; done' \
    'f="$(basename "$url")"; [ -f "$REL/$f" ] || exit 22; cp "$REL/$f" "$out"' > "$w/bin/curl"
  chmod +x "$w/bin/curl"

  out_log="$w/install.log"
  if PATH="$w/bin:$PATH" REL="$w/rel" bash "$ROOT/scripts/install.sh" \
      --version v9.9.9 --prefix "$w/out" --no-service >"$out_log" 2>&1; then
    echo "g: install.sh installed a release whose signature does NOT verify:" >&2
    cat "$out_log" >&2
    rm -rf "$w"
    return 1
  fi
  if [ -e "$w/out/bloxsmith" ]; then
    echo "g: a binary was written despite the refusal" >&2
    rm -rf "$w"
    return 1
  fi
  if ! grep -q "SIGNATURE DOES NOT VERIFY" "$out_log"; then
    echo "g: install.sh refused, but not for the right reason:" >&2
    cat "$out_log" >&2
    rm -rf "$w"
    return 1
  fi
  rm -rf "$w"
  return 0
}

# =============================================================================
# a. restore --apply write lock — go/restorecli_apply.go
#    `writable := v.WriteAllowed(currentID)` -> `writable := true`
#    A CLI process never passes through internal/server/writelock.go's HTTP
#    middleware; this one line IS the write lock for `restore-plan --apply`.
#    v3.31.0 found this hardcoded true left the ENTIRE suite green.
# =============================================================================
say "a. restore --apply write lock -- go/restorecli_apply.go"
REL="go/restorecli_apply.go"
verify_pristine "$REL"
if apply_py "$ROOT/$REL" <<'PY'
import sys
path = sys.argv[1]
OLD = "\twritable := v.WriteAllowed(currentID)"
NEW = "\twritable := true // MUTATED by control-guard.sh: per-tenant write lock disabled"
content = open(path, encoding="utf-8").read()
n = content.count(OLD)
if n != 1:
    sys.stderr.write("ANCHOR_COUNT=%d\n" % n)
    sys.exit(1)
open(path, "w", encoding="utf-8").write(content.replace(OLD, NEW, 1))
PY
then
  ok "a: mutation applied (write lock forced true)"
  finish_control "a" "$REL" "$GO" go test . -run '^TestRunRestoreApplyCLIRefusesWhenNotWritable$' -v
else
  bad "a: anchor not found (writable := v.WriteAllowed(currentID)) — this guard is no longer testing anything"
fi

# =============================================================================
# b. restore --apply tenant match — go/restorecli_apply.go
#    `case exportID != currentID:` -> `case false && exportID != currentID:`
#    Re-creating an export into the wrong tenant is the same disaster as
#    tearing down the wrong one.
# =============================================================================
say "b. restore --apply tenant match -- go/restorecli_apply.go"
verify_pristine "$REL"
if apply_py "$ROOT/$REL" <<'PY'
import sys
path = sys.argv[1]
OLD = "\tcase exportID != currentID:"
NEW = "\tcase false && exportID != currentID: // MUTATED by control-guard.sh: tenant match disabled"
content = open(path, encoding="utf-8").read()
n = content.count(OLD)
if n != 1:
    sys.stderr.write("ANCHOR_COUNT=%d\n" % n)
    sys.exit(1)
open(path, "w", encoding="utf-8").write(content.replace(OLD, NEW, 1))
PY
then
  ok "b: mutation applied (tenant-match check disabled)"
  finish_control "b" "$REL" "$GO" go test . -run '^TestApplyRefusesOnTenantMismatch$' -v
else
  bad "b: anchor not found (case exportID != currentID:) — this guard is no longer testing anything"
fi

# =============================================================================
# c. vault rotate verification — go/passcli_rotate.go
#    `if verr != nil || afterCount != beforeCount {` ->
#    `if false && (verr != nil || afterCount != beforeCount) {`
#    Without this, a rotate that failed to verify would report success while
#    the vault silently held whatever Rotate actually wrote.
# =============================================================================
say "c. vault rotate verification -- go/passcli_rotate.go"
REL="go/passcli_rotate.go"
verify_pristine "$REL"
if apply_py "$ROOT/$REL" <<'PY'
import sys
path = sys.argv[1]
OLD = "\tif verr != nil || afterCount != beforeCount {"
NEW = "\tif false && (verr != nil || afterCount != beforeCount) { // MUTATED by control-guard.sh: verification result ignored"
content = open(path, encoding="utf-8").read()
n = content.count(OLD)
if n != 1:
    sys.stderr.write("ANCHOR_COUNT=%d\n" % n)
    sys.exit(1)
open(path, "w", encoding="utf-8").write(content.replace(OLD, NEW, 1))
PY
then
  ok "c: mutation applied (rotate verification result ignored)"
  finish_control "c" "$REL" "$GO" go test . -run '^TestRotateVerifyFailureRestoresBackupByteIdentical$' -v
else
  bad "c: anchor not found (if verr != nil || afterCount != beforeCount {) — this guard is no longer testing anything"
fi

# =============================================================================
# d. teardown export refusal — go/internal/provision/decommission.go
#    the recordPlan error must abort the teardown; disabled so a failed
#    export only warns. A teardown that could not be recorded must not run —
#    see export.go's own doc comment: "A TEARDOWN THAT COULD NOT BE RECORDED
#    DOES NOT RUN."
# =============================================================================
say "d. teardown export refusal -- go/internal/provision/decommission.go"
REL="go/internal/provision/decommission.go"
verify_pristine "$REL"
if apply_py "$ROOT/$REL" <<'PY'
import sys
path = sys.argv[1]
OLD = (
    "\texportPath, err := d.recordPlan(zoneFQDN, zoneID, zoneBody, subnets, ranges, reverseZones, hosts)\n"
    "\tif err != nil {\n"
    "\t\treturn nil, err\n"
    "\t}"
)
NEW = (
    "\texportPath, err := d.recordPlan(zoneFQDN, zoneID, zoneBody, subnets, ranges, reverseZones, hosts)\n"
    "\tif err != nil {\n"
    "\t\t// MUTATED by control-guard.sh: a failed export used to abort the teardown; now it only warns.\n"
    "\t\tfmt.Println(\"warning: could not record export:\", err)\n"
    "\t}"
)
content = open(path, encoding="utf-8").read()
n = content.count(OLD)
if n != 1:
    sys.stderr.write("ANCHOR_COUNT=%d\n" % n)
    sys.exit(1)
open(path, "w", encoding="utf-8").write(content.replace(OLD, NEW, 1))
PY
then
  ok "d: mutation applied (recordPlan failure downgraded to a warning)"
  finish_control "d" "$REL" "$GO" go test ./internal/provision/ -run '^TestSiteTeardownRefusesAndDeletesNothingWhenExportCannotBeWritten$' -v
else
  bad "d: anchor not found (recordPlan(...) followed by if err != nil { return nil, err }) — this guard is no longer testing anything"
fi

# =============================================================================
# e. AI budget never-invents-a-limit — go/internal/store/store.go
#    Status's no-limit-ever-recorded branch made to hand back a fabricated
#    limit instead of hasLimit=false. RecordLimit's own doc comment: "Never
#    call this with a guessed or default value."
# =============================================================================
say "e. AI budget never-invents-a-limit -- go/internal/store/store.go"
REL="go/internal/store/store.go"
verify_pristine "$REL"
if apply_py "$ROOT/$REL" <<'PY'
import sys
path = sys.argv[1]
OLD = "\treturn tokens, today, 0, false"
NEW = "\treturn tokens, today, 999999, true // MUTATED by control-guard.sh: fabricated a limit that was never recorded"
content = open(path, encoding="utf-8").read()
n = content.count(OLD)
if n != 1:
    sys.stderr.write("ANCHOR_COUNT=%d\n" % n)
    sys.exit(1)
open(path, "w", encoding="utf-8").write(content.replace(OLD, NEW, 1))
PY
then
  ok "e: mutation applied (Status fabricates a limit)"
  finish_control "e" "$REL" "$GO" go test ./internal/store/ -run '^TestBudget_NeverInventsLimit$' -v
else
  bad "e: anchor not found (return tokens, today, 0, false) — this guard is no longer testing anything"
fi

# =============================================================================
# f. teardown export ordering — go/internal/provision/decommission.go
#    The RECORD step is moved to run AFTER every EXECUTE (delete) step
#    instead of before. export.go's whole reason to exist is that the record
#    lands before the first delete leaves this machine — the exact ordering
#    proved by TestSiteTeardownWritesExportBeforeFirstDelete's
#    exportsAtFirstDelete check.
# =============================================================================
say "f. teardown export ordering -- go/internal/provision/decommission.go"
REL="go/internal/provision/decommission.go"
verify_pristine "$REL"
if apply_py "$ROOT/$REL" <<'PY'
import sys
path = sys.argv[1]
OLD = (
    "\t// --- RECORD: the plan is complete and nothing has been deleted yet, so this\n"
    "\t// is the only moment at which the full \"before\" state exists. Written here\n"
    "\t// rather than at the top of the function because at the top there is nothing\n"
    "\t// to write, and rather than per-step because a per-step record cannot be\n"
    "\t// refused (the first delete has already run by the second step).\n"
    "\t//\n"
    "\t// A failure to record STOPS the teardown. See export.go.\n"
    "\texportPath, err := d.recordPlan(zoneFQDN, zoneID, zoneBody, subnets, ranges, reverseZones, hosts)\n"
    "\tif err != nil {\n"
    "\t\treturn nil, err\n"
    "\t}\n"
    "\tresult[\"export_path\"] = exportPath\n"
    "\t// Reported for the dry run too — where the record WOULD go, so the operator\n"
    "\t// can check the location before the run that actually deletes something.\n"
    "\tresult[\"export_written\"] = !d.cfg.DryRun\n"
    "\n"
    "\t// --- EXECUTE: deletions run only from the plan above, in the original\n"
    "\t// order (forward zone, ranges, reverse zones, subnets, hosts). Any\n"
    "\t// failure here emits an incomplete-teardown event naming what was already\n"
    "\t// deleted before the error propagates.\n"
    "\tzoneDeleted, err := d.execDeleteDNSZone(zoneFQDN, zoneID)\n"
    "\tresult[\"dns_zone_deleted\"] = zoneDeleted\n"
    "\tif err != nil {\n"
    "\t\td.emitIncomplete(result, \"delete forward DNS zone\", err)\n"
    "\t\treturn nil, err\n"
    "\t}\n"
    "\n"
    "\trangesDeleted, err := d.execDeleteRanges(ranges)\n"
    "\tresult[\"dhcp_ranges_deleted\"] = rangesDeleted\n"
    "\tif err != nil {\n"
    "\t\td.emitIncomplete(result, \"delete DHCP ranges\", err)\n"
    "\t\treturn nil, err\n"
    "\t}\n"
    "\n"
    "\treverseDeleted, err := d.execDeleteReverseZones(reverseZones)\n"
    "\tresult[\"reverse_zones_deleted\"] = reverseDeleted\n"
    "\tif err != nil {\n"
    "\t\td.emitIncomplete(result, \"delete reverse DNS zones\", err)\n"
    "\t\treturn nil, err\n"
    "\t}\n"
    "\n"
    "\tsubnetsDeleted, err := d.execDeleteSubnets(subnets)\n"
    "\tresult[\"subnets_deleted\"] = subnetsDeleted\n"
    "\tif err != nil {\n"
    "\t\td.emitIncomplete(result, \"delete subnets\", err)\n"
    "\t\treturn nil, err\n"
    "\t}\n"
    "\n"
    "\thostsDeleted, err := d.execDeleteHosts(hosts)\n"
    "\tresult[\"hosts_deleted\"] = hostsDeleted\n"
    "\tif err != nil {\n"
    "\t\td.emitIncomplete(result, \"delete hosts\", err)\n"
    "\t\treturn nil, err\n"
    "\t}\n"
    "\n"
    "\treturn result, nil\n"
)
NEW = (
    "\t// --- EXECUTE: deletions run only from the plan above, in the original\n"
    "\t// order (forward zone, ranges, reverse zones, subnets, hosts). Any\n"
    "\t// failure here emits an incomplete-teardown event naming what was already\n"
    "\t// deleted before the error propagates.\n"
    "\tzoneDeleted, err := d.execDeleteDNSZone(zoneFQDN, zoneID)\n"
    "\tresult[\"dns_zone_deleted\"] = zoneDeleted\n"
    "\tif err != nil {\n"
    "\t\td.emitIncomplete(result, \"delete forward DNS zone\", err)\n"
    "\t\treturn nil, err\n"
    "\t}\n"
    "\n"
    "\trangesDeleted, err := d.execDeleteRanges(ranges)\n"
    "\tresult[\"dhcp_ranges_deleted\"] = rangesDeleted\n"
    "\tif err != nil {\n"
    "\t\td.emitIncomplete(result, \"delete DHCP ranges\", err)\n"
    "\t\treturn nil, err\n"
    "\t}\n"
    "\n"
    "\treverseDeleted, err := d.execDeleteReverseZones(reverseZones)\n"
    "\tresult[\"reverse_zones_deleted\"] = reverseDeleted\n"
    "\tif err != nil {\n"
    "\t\td.emitIncomplete(result, \"delete reverse DNS zones\", err)\n"
    "\t\treturn nil, err\n"
    "\t}\n"
    "\n"
    "\tsubnetsDeleted, err := d.execDeleteSubnets(subnets)\n"
    "\tresult[\"subnets_deleted\"] = subnetsDeleted\n"
    "\tif err != nil {\n"
    "\t\td.emitIncomplete(result, \"delete subnets\", err)\n"
    "\t\treturn nil, err\n"
    "\t}\n"
    "\n"
    "\thostsDeleted, err := d.execDeleteHosts(hosts)\n"
    "\tresult[\"hosts_deleted\"] = hostsDeleted\n"
    "\tif err != nil {\n"
    "\t\td.emitIncomplete(result, \"delete hosts\", err)\n"
    "\t\treturn nil, err\n"
    "\t}\n"
    "\n"
    "\t// MUTATED by control-guard.sh: the export is now written AFTER every\n"
    "\t// delete instead of before -- exactly the ordering bug control f exists\n"
    "\t// to catch.\n"
    "\texportPath, err := d.recordPlan(zoneFQDN, zoneID, zoneBody, subnets, ranges, reverseZones, hosts)\n"
    "\tif err != nil {\n"
    "\t\treturn nil, err\n"
    "\t}\n"
    "\tresult[\"export_path\"] = exportPath\n"
    "\tresult[\"export_written\"] = !d.cfg.DryRun\n"
    "\n"
    "\treturn result, nil\n"
)
content = open(path, encoding="utf-8").read()
n = content.count(OLD)
if n != 1:
    sys.stderr.write("ANCHOR_COUNT=%d\n" % n)
    sys.exit(1)
open(path, "w", encoding="utf-8").write(content.replace(OLD, NEW, 1))
PY
then
  ok "f: mutation applied (export write moved after every delete)"
  finish_control "f" "$REL" "$GO" go test ./internal/provision/ -run '^(TestSiteTeardownWritesExportBeforeFirstDelete|TestBlockTeardownWritesExportBeforeFirstDeleteAndRefusesWithout)$' -v
else
  bad "f: anchor not found (the RECORD-then-EXECUTE block in Decommission) — this guard is no longer testing anything"
fi

# =============================================================================
# g. install.sh refuses a signature that does not verify -- scripts/install.sh
#    `< "$WORK/checksums.txt" >/dev/null 2>&1; then` -> `... || true; then`
#    forces the ssh-keygen -Y verify branch to always take the "signature: ok"
#    path. checksums.txt is signed with a key held only in this repo's release
#    secrets; the public half is pinned in install.sh so the thing that decides
#    a release is genuine does not travel with the release. Covered in CI only
#    by steps that hit the real GitHub release over the network (install-sh
#    job) -- nothing proves the refusal still fires if the check is edited
#    out. g_install_sig_refusal_test (above) reuses that job's curl-shim
#    technique against a fully local, synthetic release instead.
# =============================================================================
say "g. install.sh refuses a signature that does not verify -- scripts/install.sh"
REL="scripts/install.sh"
verify_pristine "$REL"
if apply_py "$ROOT/$REL" <<'PY'
import sys
path = sys.argv[1]
OLD = '            < "$WORK/checksums.txt" >/dev/null 2>&1; then'
NEW = '            < "$WORK/checksums.txt" >/dev/null 2>&1 || true; then  # MUTATED by control-guard.sh: signature verification failure ignored'
content = open(path, encoding="utf-8").read()
n = content.count(OLD)
if n != 1:
    sys.stderr.write("ANCHOR_COUNT=%d\n" % n)
    sys.exit(1)
open(path, "w", encoding="utf-8").write(content.replace(OLD, NEW, 1))
PY
then
  ok "g: mutation applied (ssh-keygen -Y verify failure ignored)"
  finish_control "g" "$REL" "$ROOT" g_install_sig_refusal_test
else
  bad "g: anchor not found (< \"\$WORK/checksums.txt\" >/dev/null 2>&1; then) — this guard is no longer testing anything"
fi

# =============================================================================
# h. offline audit verifier never generates a key -- go/internal/audit/audit.go
#    `opt.NoGenerate = true` -> `opt.NoGenerate = false` in OpenReadOnly.
#    A verifier that generated a missing key would mint the very trust root it
#    is supposed to be checking against, seal nothing, and then have no way to
#    tell an untouched chain from a forged one. readonly_test.go's own header
#    comment: "Each of these was watched failing with its guard removed."
# =============================================================================
say "h. offline audit verifier never generates a key -- go/internal/audit/audit.go"
REL="go/internal/audit/audit.go"
verify_pristine "$REL"
if apply_py "$ROOT/$REL" <<'PY'
import sys
path = sys.argv[1]
OLD = "\topt.NoGenerate = true"
NEW = "\topt.NoGenerate = false // MUTATED by control-guard.sh: offline verifier allowed to mint its own key"
content = open(path, encoding="utf-8").read()
n = content.count(OLD)
if n != 1:
    sys.stderr.write("ANCHOR_COUNT=%d\n" % n)
    sys.exit(1)
open(path, "w", encoding="utf-8").write(content.replace(OLD, NEW, 1))
PY
then
  ok "h: mutation applied (OpenReadOnly no longer forbids generating a key)"
  finish_control "h" "$REL" "$GO" go test ./internal/audit/ -run '^TestOpenReadOnlyNeverCreatesAKey$' -v
else
  bad "h: anchor not found (opt.NoGenerate = true) — this guard is no longer testing anything"
fi

# =============================================================================
# i. SSE panic guard -- go/internal/server/provision.go
#    removes the `defer d.recoverStream(&emit, r)` line from
#    teardownSeedDemoStream (identified by its unique next line, since the
#    same defer also guards the other four streams). Without it, a panic
#    inside a teardown killed the whole server process mid-run, with a
#    partially deleted tenant.
#    stream_panic_test.go deliberately carries NO recover() of its own, so
#    with the guard removed the TEST BINARY ITSELF DIES from the unrecovered
#    panic rather than reporting an ordinary test failure. finish_control
#    still treats this correctly: it only checks the exit status of the test
#    command, and a crashed `go test` process exits nonzero exactly like a
#    normal failure does -- verified by hand (a panicking, guard-removed run
#    here printed the crash and exited nonzero, same as any other FAIL).
# =============================================================================
say "i. SSE panic guard -- go/internal/server/provision.go"
REL="go/internal/server/provision.go"
verify_pristine "$REL"
if apply_py "$ROOT/$REL" <<'PY'
import sys
path = sys.argv[1]
OLD = '\tdefer d.recoverStream(&emit, r)\n\tif !dry && confirm != "DELETE" {'
NEW = '\t// MUTATED by control-guard.sh: panic guard removed for the teardown/seed-demo stream\n\tif !dry && confirm != "DELETE" {'
content = open(path, encoding="utf-8").read()
n = content.count(OLD)
if n != 1:
    sys.stderr.write("ANCHOR_COUNT=%d\n" % n)
    sys.exit(1)
open(path, "w", encoding="utf-8").write(content.replace(OLD, NEW, 1))
PY
then
  ok "i: mutation applied (recoverStream defer removed from teardown/seed-demo stream)"
  finish_control "i" "$REL" "$GO" go test ./internal/server/ -run '^TestStreamPanicDoesNotKillTheServer$' -v
else
  bad "i: anchor not found (defer d.recoverStream(&emit, r) immediately followed by the confirm==DELETE check) — this guard is no longer testing anything"
fi

printf '\n'
if [ "$fail_count" = 0 ]; then
  printf 'control-guard: %d passed, %d failed\n' "$pass_count" "$fail_count"
  exit 0
fi
printf 'control-guard: %d passed, %d failed\n' "$pass_count" "$fail_count"
exit 1
