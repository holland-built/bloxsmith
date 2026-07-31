package vault

// Tests for the VAULT LIFECYCLE in vault.go — Rotate, Lock, Reset, AutoUnlock,
// the active-tenant accessors, ResolveFile/writable, TenantCount, and the
// snapshot/restore pair every mutation's rollback is built on.
//
// WHY THIS FILE EXISTS. All of the above sat at 0.0% coverage while holding the
// customer API keys. scripts/vault-passphrase-test.sh already drives the SHIPPED
// CLI through 36 checks (exit codes, the on-disk bxv1: marking, keychain
// round-trips, source precedence, the 0600 rotate backup, refusals leaving
// vault.json byte-identical), so nothing here re-tests any of that. This file
// targets what a script driving the CLI structurally CANNOT reach: in-process
// state after a call that FAILED — above all Rotate's rollback when save() fails,
// which the script cannot see because it has no way to make a save fail.
//
// HONEST SCOPE — what these tests do and do NOT prove.
//   DO prove: in one process, against a throwaway vault, that a rotate re-keys
//   the file, that a FAILED rotate leaves the vault openable by the passphrase
//   the operator still has, that Lock drops the key material, that Reset removes
//   the file, that AutoUnlock creates-vs-unlocks-vs-refuses correctly, and that
//   ResolveFile never silently lands outside the locations it was given.
//   Do NOT prove: anything about the real keychain, the shipped CLI's exit codes,
//   the encryption's strength, or that any caller checks these return values.
//   A rotate is not a secret-rotation control either — the OLD passphrase still
//   opens the backup copy the CLI keeps, by design (the script owns that).
//
// SAFETY RULES OBSERVED HERE — not style preferences:
//   - Every vault lives under t.TempDir(). No test touches the real vault at
//     ~/Library/Application Support/bloxsmith.
//   - HOME (and XDG_CONFIG_HOME, for the non-darwin build) is sandboxed to a
//     t.TempDir() in EVERY test, because ResolveFile's fallback resolves
//     os.UserConfigDir() and writable() MKDIRS AND WRITES A PROBE FILE there —
//     on a developer Mac that is exactly the real vault directory.
//   - No .vault-pass / .vault-passphrase file is ever created, and neither
//     VAULT_PASSPHRASE nor VAULT_PASSPHRASE_FILE is ever set or read. That env
//     var wins over the macOS keychain and that precedence was a real shipped
//     bug; the passphrase lives in the keychain only. Nothing here reads or
//     writes the keychain.
//   - AddTenant is never called (a blank label makes it resolve the name over
//     live HTTPS against csp.infoblox.com); tenants are installed directly by
//     newUnlockedVault, which is why that helper exists.

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// lcInitPass is the passphrase newUnlockedVault (writelock_test.go) initialises
// its throwaway vaults with. Reopening one of those vaults with a FRESH Vault
// instance is the only way to prove a rotate or a save changed what is ON DISK
// rather than only in memory, so this file has to name it. It is a fixture
// literal, not a secret: it is never written to the keychain, to a file, or to
// an env var, and the vault it opens exists only for the duration of one test.
// If writelock_test.go ever changes its passphrase every reopen below fails
// loudly, which is the intended failure mode.
const lcInitPass = "writelock-test-pass"

// lcSandboxHome points HOME (and, for the non-darwin build, XDG_CONFIG_HOME) at
// a throwaway directory. See the SAFETY RULES above: os.UserConfigDir() derives
// from these, and ResolveFile's fallback branch WRITES there.
func lcSandboxHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	return home
}

// lcTempVaultPath returns a vault.json path inside a fresh temp dir, with HOME
// already sandboxed. The file itself does not exist yet.
func lcTempVaultPath(t *testing.T) string {
	t.Helper()
	lcSandboxHome(t)
	return filepath.Join(t.TempDir(), "vault.json")
}

// lcBreakPath repoints v at a file inside a directory that was never created, so
// save()'s os.WriteFile of the .tmp file fails with ENOENT, and returns the
// original path. It then PROVES the fixture actually fails: a rollback test whose
// save quietly succeeded is decoration, not a test.
//
// A chmod-based fixture was rejected deliberately — file mode bits do not deny
// writes to root, so on a CI runner that runs as root the save would succeed and
// every assertion after it would be vacuous.
func lcBreakPath(t *testing.T, v *Vault) (original string) {
	t.Helper()
	original = v.path
	v.path = filepath.Join(filepath.Dir(original), "never-created", "vault.json")
	if err := v.Save(); err == nil {
		t.Fatal("the save-failure fixture did not fail; every assertion after it would prove nothing")
	}
	return original
}

// --- Rotate ------------------------------------------------------------------

// TestRotate_OldPassphraseStopsOpening is the plain success property: after a
// rotate the file on disk is sealed under the NEW passphrase and the OLD one no
// longer opens it, with every tenant, LLM setting and write grant carried across
// unchanged. Both halves matter — a rotate that re-encrypted but lost the
// payload would be silently catastrophic, and a rotate that kept the old key
// usable would not have rotated anything.
//
// Reopening is done with brand-new Vault instances so nothing in memory can
// answer for the file.
func TestRotate_OldPassphraseStopsOpening(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	v.groq, v.llmBase, v.llmModel = "gsk_fixture_not_real", "https://api.groq.com/openai/v1", "qwen/qwen3-32b"
	if err := v.Save(); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	wlGrant(t, v, "t1/acct9")
	path := v.Path()

	const newPass = "rotated-test-pass"
	if err := v.Rotate(newPass); err != nil {
		t.Fatalf("Rotate: %v", err)
	}

	// The new passphrase opens it, with the payload intact.
	reopened := New(path)
	if err := reopened.Unlock(newPass); err != nil {
		t.Fatalf("the rotated-to passphrase does not open the vault: %v", err)
	}
	if reopened.TenantCount() != 2 {
		t.Errorf("rotate lost tenants: got %d, want 2", reopened.TenantCount())
	}
	if got := reopened.ActiveKey(); got != "Token k1" {
		t.Errorf("rotate lost the active tenant key: %q", got)
	}
	if got := reopened.ActiveLabel(); got != "Delta" {
		t.Errorf("rotate lost the active tenant label: %q", got)
	}
	if g, b, m := reopened.LLMCreds(); g != "gsk_fixture_not_real" || b != "https://api.groq.com/openai/v1" || m != "qwen/qwen3-32b" {
		t.Errorf("rotate lost the LLM settings: groq=%q base=%q model=%q", g, b, m)
	}
	if !reopened.WriteAllowed("t1/acct9") {
		t.Error("rotate dropped a write grant; re-keying the file must not change what is writable")
	}
	if reopened.WriteAllowed("t1/-") {
		t.Error("rotate widened the write grants")
	}

	// The old passphrase does not.
	if err := New(path).Unlock(lcInitPass); err != ErrWrongPassphrase {
		t.Errorf("the pre-rotate passphrase still opens the vault (err=%v); nothing was rotated", err)
	}
}

// TestRotate_LockedRefused: Rotate re-encrypts what is IN MEMORY, so a locked
// vault has nothing to rotate. Letting it proceed would seal an EMPTY payload
// over a file that still holds every tenant — a data-loss bug that looks like a
// success.
func TestRotate_LockedRefused(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	path := v.Path()
	v.Lock()

	err := v.Rotate("some-new-passphrase")
	if err == nil {
		t.Fatal("Rotate succeeded on a locked vault; it would have sealed an empty payload over the real one")
	}
	if !strings.Contains(err.Error(), "locked") {
		t.Errorf("refusal does not say the vault is locked: %q", err)
	}
	// The file must be untouched: the ORIGINAL passphrase still opens it, with
	// the tenant still there.
	reopened := New(path)
	if err := reopened.Unlock(lcInitPass); err != nil {
		t.Fatalf("a refused rotate damaged the vault file: %v", err)
	}
	if reopened.TenantCount() != 1 {
		t.Errorf("a refused rotate changed the stored tenants: count=%d", reopened.TenantCount())
	}
}

// TestRotate_ShortPassphraseRefused pins the same 8-character floor Init
// enforces. Without it an operator could quietly downgrade their own protection
// on a rotate — the one path where no fresh-vault friction would flag it.
//
// This is NOT a duplicate of the shell script's too-short check: that one
// asserts the CLI's exit code and that vault.json stayed byte-identical; this
// asserts the in-process key was never swapped, which the script cannot see.
func TestRotate_ShortPassphraseRefused(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	path := v.Path()

	for _, short := range []string{"", "a", "1234567"} {
		if err := v.Rotate(short); err == nil {
			t.Fatalf("Rotate(%q) was accepted; the 8-character floor is not enforced", short)
		}
	}
	// The in-memory key was not swapped: a save now must still be readable with
	// the ORIGINAL passphrase.
	if err := v.Save(); err != nil {
		t.Fatalf("save after refused rotates: %v", err)
	}
	if err := New(path).Unlock(lcInitPass); err != nil {
		t.Fatalf("a refused rotate changed the in-memory key: %v", err)
	}
}

// TestRotate_FailedSaveRestoresKeyAndSalt is the single most valuable test in
// this file, and the one thing scripts/vault-passphrase-test.sh structurally
// cannot reach: it drives the shipped CLI, which has no way to make a save fail.
//
// THE FAILURE BEING GUARDED AGAINST. Rotate swaps the in-memory key and salt
// BEFORE calling save(), because save() serialises whatever is in memory. If the
// write then fails and the key/salt are left swapped, the live Vault believes it
// holds the NEW key while vault.json on disk is still sealed under the OLD one.
// The next save in that process seals the file with a key that matches neither
// the passphrase the operator still has NOR anything in the keychain — the vault
// becomes unopenable by the old passphrase and by the new one alike, and every
// tenant API key in it is gone.
//
// So the assertion is exactly that: after a rotate whose save failed, a
// subsequent successful save is still readable with the ORIGINAL passphrase, and
// is NOT readable with the passphrase the failed rotate tried to move to.
//
// HONEST SCOPE: this proves the in-memory rollback for one process. It does not
// prove anything about a crash mid-write (the tmp+rename in save() is what
// covers that, and it is not what this test exercises).
func TestRotate_FailedSaveRestoresKeyAndSalt(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	wlGrant(t, v, "t1/-")
	good := lcBreakPath(t, v) // proves the save really fails before we rely on it

	const attempted = "rotate-that-never-lands"
	if err := v.Rotate(attempted); err == nil {
		t.Fatal("Rotate reported success although its save could not possibly have written anything")
	}

	// The mutation itself is still in memory and must be the OLD key/salt. Put
	// the real path back and persist — if the rollback did not happen, THIS save
	// is the one that seals the file with a key nobody holds.
	v.path = good
	if err := v.Save(); err != nil {
		t.Fatalf("save after restoring the path: %v", err)
	}

	reopened := New(good)
	if err := reopened.Unlock(lcInitPass); err != nil {
		t.Fatalf("after a FAILED rotate the ORIGINAL passphrase no longer opens the vault (%v) — "+
			"the in-memory key/salt were not rolled back, so the file is now sealed under a key "+
			"that neither the operator nor the keychain has", err)
	}
	if reopened.TenantCount() != 1 || reopened.ActiveKey() != "Token k1" {
		t.Errorf("the rolled-back vault lost its payload: count=%d activeKey=%q",
			reopened.TenantCount(), reopened.ActiveKey())
	}
	if !reopened.WriteAllowed("t1/-") {
		t.Error("the rolled-back vault lost its write grants")
	}

	// And the passphrase the failed rotate ATTEMPTED must not open it — that
	// catches a half-rollback that restored the key but kept the new salt (or
	// vice versa), which would be just as unopenable in the field.
	if err := New(good).Unlock(attempted); err == nil {
		t.Error("the passphrase from a FAILED rotate opens the vault; the rotate partly took effect")
	}

	// The failed rotate must not have disturbed the live state either.
	if !v.IsUnlocked() {
		t.Error("a failed rotate locked the vault")
	}
	if got := v.ActiveKey(); got != "Token k1" {
		t.Errorf("a failed rotate disturbed the in-memory tenants: activeKey=%q", got)
	}
}

// --- Lock --------------------------------------------------------------------

// TestLock_ClearsEverything: locking must leave the process unable to answer any
// question that needs the decrypted payload — no key to sign a save with, no
// tenant keys to send upstream, no write permissions to authorise a teardown.
//
// PINNED, NOT ENDORSED (finding C2-F2): Lock clears the groq API key but leaves
// llmBase and llmModel in memory (vault.go:399-412), while Reset clears both.
// Neither is a credential, so this is asserted as observed behaviour rather than
// treated as a leak; the inconsistency with Reset is reported, not blessed.
func TestLock_ClearsEverything(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	v.groq, v.llmBase, v.llmModel = "gsk_fixture_not_real", "https://api.groq.com/openai/v1", "qwen/qwen3-32b"
	if err := v.Save(); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	wlGrant(t, v, "t1/-")

	v.Lock()

	if v.IsUnlocked() {
		t.Error("IsUnlocked() is true after Lock()")
	}
	if got := v.TenantCount(); got != 0 {
		t.Errorf("TenantCount() = %d after Lock(); a locked vault holds no answer", got)
	}
	if got := v.ActiveKey(); got != "" {
		t.Errorf("ActiveKey() = %q after Lock(); a locked vault must not hand out a tenant key", got)
	}
	if got := v.ActiveLabel(); got != "" {
		t.Errorf("ActiveLabel() = %q after Lock()", got)
	}
	if v.WriteAllowed("t1/-") {
		t.Error("a locked vault still authorises a write")
	}
	if g, _, _ := v.LLMCreds(); g != "" {
		t.Errorf("the LLM API key survived Lock(): %q", g)
	}

	// The derived key is gone, so nothing in this process can seal the file
	// again. This is the assertion that a Lock which forgot `v.key = nil`
	// reddens: everything above would still pass, because the payload fields are
	// cleared separately.
	err := v.Save()
	if err == nil {
		t.Fatal("Save() succeeded on a locked vault; the derived key was not cleared")
	}
	if err.Error() != "vault locked" {
		t.Errorf("Save() after Lock: err = %q, want %q", err, "vault locked")
	}

	// Lock is memory-only: the file is untouched and reopens unchanged.
	reopened := New(v.Path())
	if err := reopened.Unlock(lcInitPass); err != nil {
		t.Fatalf("Lock() damaged the vault file: %v", err)
	}
	if reopened.TenantCount() != 1 {
		t.Errorf("Lock() changed what is stored: count=%d", reopened.TenantCount())
	}
	if !reopened.WriteAllowed("t1/-") {
		t.Error("Lock() erased a persisted write grant")
	}
}

// --- Reset -------------------------------------------------------------------

// TestReset_DeletesFileAndClearsState covers the forgot-passphrase escape hatch:
// the file goes, and the process is back to first-run state. A Reset that
// cleared memory but left the file would leave an unopenable vault in place and
// block the next Init ("vault already exists"), which is precisely the corner
// the operator is trying to escape.
func TestReset_DeletesFileAndClearsState(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	v.groq, v.llmBase, v.llmModel = "gsk_fixture_not_real", "https://api.groq.com/openai/v1", "qwen/qwen3-32b"
	if err := v.Save(); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	wlGrant(t, v, "t1/-")
	path := v.Path()

	if err := v.Reset(); err != nil {
		t.Fatalf("Reset: %v", err)
	}

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("the vault file is still on disk after Reset (stat err = %v)", err)
	}
	if v.Exists() {
		t.Error("Exists() still reports a vault after Reset")
	}
	if v.IsUnlocked() || v.TenantCount() != 0 || v.ActiveKey() != "" || v.ActiveLabel() != "" {
		t.Errorf("Reset left state behind: unlocked=%v count=%d key=%q label=%q",
			v.IsUnlocked(), v.TenantCount(), v.ActiveKey(), v.ActiveLabel())
	}
	if v.WriteAllowed("t1/-") {
		t.Error("a write grant survived Reset")
	}
	if g, b, m := v.LLMCreds(); g != "" || b != "" || m != "" {
		t.Errorf("Reset left LLM settings behind: groq=%q base=%q model=%q", g, b, m)
	}
	if err := v.Save(); err == nil {
		t.Error("Save() succeeded after Reset; the derived key was not cleared")
	}

	// First-run state means Init works again on the same path.
	if err := v.Init("post-reset-test-pass"); err != nil {
		t.Fatalf("Init after Reset: %v", err)
	}
}

// TestReset_MissingFileIsNotAnError: reset is idempotent. "There is no vault" is
// the requested end state, so reaching it by doing nothing is success, not a
// failure to report.
func TestReset_MissingFileIsNotAnError(t *testing.T) {
	v := New(lcTempVaultPath(t)) // never initialised — no file at all
	if err := v.Reset(); err != nil {
		t.Fatalf("Reset on a vault that never existed: %v", err)
	}
	if v.Exists() {
		t.Error("Reset created something")
	}
	// And again, after a real one has already been removed.
	v2 := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	if err := v2.Reset(); err != nil {
		t.Fatalf("first Reset: %v", err)
	}
	if err := v2.Reset(); err != nil {
		t.Fatalf("second Reset is not idempotent: %v", err)
	}
}

// TestReset_RemoveFailureReportsAndKeepsState pins the I/O-failure arm.
//
// FINDING C2-F1 (reported, deliberately not fixed here): when the file cannot be
// removed, Reset returns the error and leaves the vault UNLOCKED with every
// tenant key still in memory. The error is returned rather than swallowed, so
// the caller is told — but an operator who asked to wipe the vault and got an
// error may reasonably assume the secrets were at least dropped from memory,
// and they were not. Whether Reset should clear memory on a failed unlink is a
// product decision, not a coverage task; this asserts today's behaviour so any
// change to it is deliberate and visible in a diff.
//
// The failure is forced by pointing the vault at a NON-EMPTY DIRECTORY: os.Stat
// succeeds so Exists() is true, and os.Remove then fails with "directory not
// empty" on every platform and for root as well — unlike a chmod fixture, which
// root ignores.
func TestReset_RemoveFailureReportsAndKeepsState(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})

	blocked := filepath.Join(t.TempDir(), "vault.json")
	if err := os.MkdirAll(blocked, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(blocked, "occupant"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	v.path = blocked

	err := v.Reset()
	if err == nil {
		t.Fatal("Reset reported success although the vault file could not be removed")
	}
	if !v.IsUnlocked() || v.TenantCount() != 1 {
		t.Errorf("state after a FAILED Reset: unlocked=%v count=%d — pinning today's behaviour (finding C2-F1)",
			v.IsUnlocked(), v.TenantCount())
	}
}

// --- ActiveKey / ActiveLabel -------------------------------------------------

// TestActiveKey_UnknownActiveIsEmpty is the wrong-tenant test. ActiveKey feeds
// the Authorization header of every outbound call, so "no active tenant" and
// "the active id names a tenant that is no longer stored" must BOTH answer with
// no key at all. Falling back to whatever tenant happens to be first in the list
// would send a customer's key to a request meant for a different account —
// silently, and with a 200 back.
func TestActiveKey_UnknownActiveIsEmpty(t *testing.T) {
	// Match: the ordinary case.
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	if got := v.ActiveKey(); got != "Token k1" {
		t.Errorf("ActiveKey = %q, want the active tenant's key", got)
	}
	if got := v.ActiveLabel(); got != "Delta" {
		t.Errorf("ActiveLabel = %q, want Delta", got)
	}

	// Active names a tenant that is not stored. Reachable in the field when a
	// vault is edited or partly written; the answer must be "no key", never
	// "some key".
	ghost := "t-does-not-exist"
	v.active = &ghost
	if got := v.ActiveKey(); got != "" {
		t.Errorf("ActiveKey = %q for an unknown active id; a stranger's key must never be substituted", got)
	}
	if got := v.ActiveLabel(); got != "" {
		t.Errorf("ActiveLabel = %q for an unknown active id", got)
	}

	// No active tenant at all (env-key mode) — "" is a real answer, not a fault.
	v.active = nil
	if got := v.ActiveKey(); got != "" {
		t.Errorf("ActiveKey = %q with no active tenant", got)
	}
	if got := v.ActiveLabel(); got != "" {
		t.Errorf("ActiveLabel = %q with no active tenant", got)
	}

	// A vault holding no tenants at all.
	empty := newUnlockedVault(t)
	if got, lbl := empty.ActiveKey(), empty.ActiveLabel(); got != "" || lbl != "" {
		t.Errorf("empty vault: ActiveKey=%q ActiveLabel=%q", got, lbl)
	}
}

// --- TenantCount -------------------------------------------------------------

// TestTenantCount_LockedIsZero. TenantCount exists so `vault-passphrase check`
// can say WHAT it opened: "unlocked" alone does not distinguish the real vault
// from an empty one, and an empty one is what a wrongly-created vault looks
// like. A locked vault must therefore answer 0 — it holds no answer to give.
//
// HOW THE LOCKED GUARD IS MADE OBSERVABLE. Lock() also nils v.tenants, so a
// fixture built by calling Lock() would still report 0 with the guard deleted
// and the test would prove nothing. The state that isolates the guard is a vault
// that HAS tenants in memory while unlocked is false — which is what a Vault
// looks like before Unlock has run. It is synthesised directly here (legal: this
// test is in package vault) for exactly that reason.
func TestTenantCount_LockedIsZero(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	if got := v.TenantCount(); got != 2 {
		t.Fatalf("unlocked TenantCount = %d, want 2 — fixture is broken", got)
	}
	path := v.Path()

	// The isolating state: tenants present, unlocked false.
	notYetUnlocked := New(path)
	notYetUnlocked.tenants = []Tenant{{ID: "t1", Label: "Delta", Key: "Token k1"}}
	if got := notYetUnlocked.TenantCount(); got != 0 {
		t.Errorf("a locked vault reported %d tenants; a locked vault holds no answer", got)
	}

	// And the real round trip: locking, then unlocking, restores the count.
	v.Lock()
	if got := v.TenantCount(); got != 0 {
		t.Errorf("after Lock(): TenantCount = %d, want 0", got)
	}
	reopened := New(path)
	if err := reopened.Unlock(lcInitPass); err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := reopened.TenantCount(); got != 2 {
		t.Errorf("after Unlock: TenantCount = %d, want 2", got)
	}
}

// --- AutoUnlock --------------------------------------------------------------

// TestAutoUnlock_EmptyPassphraseNoop: no passphrase available is the normal
// no-auto-unlock case, not a fault. The dangerous failure is the opposite one —
// running on with an empty passphrase and CREATING a vault, which would seal a
// brand-new empty vault into place and make every later unlock attempt with the
// real passphrase fail against a file that is not the operator's.
func TestAutoUnlock_EmptyPassphraseNoop(t *testing.T) {
	path := lcTempVaultPath(t)
	v := New(path)

	created, err := v.AutoUnlock("")
	if err != nil {
		t.Fatalf("AutoUnlock(\"\") returned an error: %v", err)
	}
	if created {
		t.Error("AutoUnlock(\"\") created a vault; no passphrase means do nothing")
	}
	if v.Exists() {
		t.Error("AutoUnlock(\"\") wrote a vault file")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("a file appeared at the vault path: stat err = %v", err)
	}
	if v.IsUnlocked() {
		t.Error("AutoUnlock(\"\") left the vault unlocked")
	}
}

// TestAutoUnlock_CreatesWhenMissing: with a passphrase and no file, the boot
// path creates the vault. created=true is the flag the startup log uses to say
// so — reporting a creation as an unlock is how an operator ends up staring at
// an empty vault wondering where their tenants went.
func TestAutoUnlock_CreatesWhenMissing(t *testing.T) {
	path := lcTempVaultPath(t)
	const pass = "autounlock-test-pass"

	v := New(path)
	created, err := v.AutoUnlock(pass)
	if err != nil {
		t.Fatalf("AutoUnlock on a missing vault: %v", err)
	}
	if !created {
		t.Error("AutoUnlock reported created=false although there was no vault file")
	}
	if !v.Exists() {
		t.Fatal("AutoUnlock reported success but wrote no file")
	}
	if !v.IsUnlocked() {
		t.Error("the freshly created vault is not unlocked")
	}
	if got := v.TenantCount(); got != 0 {
		t.Errorf("a freshly created vault holds %d tenants, want 0", got)
	}
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if perm := fi.Mode().Perm(); perm != 0o600 {
			t.Errorf("vault file mode = %04o, want 0600 — it holds every tenant's API key", perm)
		}
	}
	// The file it wrote really is sealed under that passphrase.
	if err := New(path).Unlock(pass); err != nil {
		t.Fatalf("the created vault does not open with the passphrase that created it: %v", err)
	}
}

// TestAutoUnlock_UnlocksExisting: with a file already there, the same call must
// OPEN it and report created=false, carrying the stored tenants into memory.
func TestAutoUnlock_UnlocksExisting(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	path := v.Path()
	v.Lock()

	fresh := New(path)
	created, err := fresh.AutoUnlock(lcInitPass)
	if err != nil {
		t.Fatalf("AutoUnlock on an existing vault: %v", err)
	}
	if created {
		t.Error("AutoUnlock reported created=true for a vault that already existed")
	}
	if !fresh.IsUnlocked() || fresh.TenantCount() != 1 || fresh.ActiveKey() != "Token k1" {
		t.Errorf("the existing vault was not really opened: unlocked=%v count=%d key=%q",
			fresh.IsUnlocked(), fresh.TenantCount(), fresh.ActiveKey())
	}
}

// TestAutoUnlock_WrongPassphraseIsAnError: a wrong stored passphrase must surface
// as an error and leave the vault LOCKED. Silently continuing would strand the
// process with no tenants and no reason given — and must never fall through to
// the create branch, which would overwrite a vault the operator can still open.
func TestAutoUnlock_WrongPassphraseIsAnError(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	path := v.Path()
	v.Lock()

	fresh := New(path)
	created, err := fresh.AutoUnlock("not-the-right-passphrase")
	if err != ErrWrongPassphrase {
		t.Errorf("AutoUnlock with a wrong passphrase: err = %v, want ErrWrongPassphrase", err)
	}
	if created {
		t.Error("AutoUnlock reported created=true after failing to unlock an existing vault")
	}
	if fresh.IsUnlocked() {
		t.Error("the vault is unlocked after a wrong passphrase")
	}
	// The real passphrase must still work — the failed attempt changed nothing.
	if err := New(path).Unlock(lcInitPass); err != nil {
		t.Fatalf("a failed AutoUnlock damaged the vault: %v", err)
	}
}

// --- ResolveFile / writable --------------------------------------------------

// TestResolveFile_FirstWritableWins pins the ORDER: VAULT_DIR first, then the
// binary's directory. Reversing it would move a container's vault off the
// mounted noc-vault volume and into the image's ephemeral filesystem — the
// tenants would survive exactly until the next restart.
func TestResolveFile_FirstWritableWins(t *testing.T) {
	lcSandboxHome(t)
	vaultDir := filepath.Join(t.TempDir(), "vault-dir")
	binDir := filepath.Join(t.TempDir(), "bin-dir")

	if got, want := ResolveFile(vaultDir, binDir), filepath.Join(vaultDir, "vault.json"); got != want {
		t.Errorf("ResolveFile(vaultDir, dir) = %q, want %q — VAULT_DIR must win", got, want)
	}
	// An unset VAULT_DIR is skipped rather than treated as "".
	if got, want := ResolveFile("", binDir), filepath.Join(binDir, "vault.json"); got != want {
		t.Errorf("ResolveFile(\"\", dir) = %q, want %q", got, want)
	}
	// An UNWRITABLE VAULT_DIR falls through to dir. The unwritable path is one
	// whose parent is a regular file, so MkdirAll fails with ENOTDIR — a
	// deterministic failure on every platform, including for root.
	blocker := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if got, want := ResolveFile(filepath.Join(blocker, "nested"), binDir), filepath.Join(binDir, "vault.json"); got != want {
		t.Errorf("ResolveFile(unwritable, dir) = %q, want %q", got, want)
	}
}

// TestResolveFile_FallsBackInsideTheSandboxedHome covers the laptop branch: when
// neither location is writable the vault lands in <UserConfigDir>/bloxsmith,
// because a binary's cwd is not a durable state dir.
//
// SAFETY: this is the branch that, unsandboxed, would MKDIR AND WRITE A PROBE
// FILE into the REAL vault directory on this machine. HOME is repointed at a
// t.TempDir() first and the assertion is that the result is INSIDE that sandbox —
// so if the sandbox ever stops working, this test fails instead of quietly
// touching the operator's vault.
func TestResolveFile_FallsBackInsideTheSandboxedHome(t *testing.T) {
	home := lcSandboxHome(t)
	blocker := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	got := ResolveFile(filepath.Join(blocker, "vaultdir"), filepath.Join(blocker, "bindir"))

	if !strings.HasPrefix(got, home+string(os.PathSeparator)) {
		t.Fatalf("ResolveFile fell back to %q, which is OUTSIDE the sandboxed HOME %q — "+
			"unsandboxed this branch writes a probe file into the real vault directory", got, home)
	}
	if !strings.Contains(got, "bloxsmith") || filepath.Base(got) != "vault.json" {
		t.Errorf("fallback path = %q, want <UserConfigDir>/bloxsmith/vault.json", got)
	}
}

// TestResolveFile_LastResortIsDir: with nothing writable AND no resolvable user
// config dir, ResolveFile still returns a path rather than "" — callers treat
// the result as a path unconditionally, so an empty string would put vault.json
// at the filesystem root. Emptying HOME/XDG_CONFIG_HOME is what makes
// os.UserConfigDir fail; it is set only for this test.
func TestResolveFile_LastResortIsDir(t *testing.T) {
	t.Setenv("HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	blocker := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(blocker, "bindir")

	if got, want := ResolveFile(filepath.Join(blocker, "vaultdir"), dir), filepath.Join(dir, "vault.json"); got != want {
		t.Errorf("ResolveFile with nothing writable = %q, want %q", got, want)
	}
}

// TestWritable_ReportsHonestly covers writable() directly: it must say no both
// when the directory cannot be CREATED and when it exists but cannot be WRITTEN
// into. The second arm is the one that matters — a directory that exists is not
// the same as a directory the vault can be saved into, and treating it as such
// would pick a location where every save then fails.
func TestWritable_ReportsHonestly(t *testing.T) {
	lcSandboxHome(t)

	// Creatable and writable.
	good := filepath.Join(t.TempDir(), "fresh")
	if !writable(good) {
		t.Errorf("writable(%q) = false for a creatable directory", good)
	}
	// It must leave no probe file behind.
	entries, err := os.ReadDir(good)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("writable() left %d file(s) behind in %q", len(entries), good)
	}

	// Not creatable: the parent is a regular file (ENOTDIR, deterministic for
	// root too).
	blocker := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if writable(filepath.Join(blocker, "nested")) {
		t.Error("writable() said yes for a path whose parent is a regular file")
	}

	// Exists but not writable. Mode bits do not deny root, and they do not mean
	// the same thing on Windows, so this arm is skipped rather than asserted
	// falsely there.
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("read-only-directory arm needs a non-root POSIX run: mode bits do not deny writes to root")
	}
	ro := filepath.Join(t.TempDir(), "read-only")
	if err := os.MkdirAll(ro, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(ro, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(ro, 0o755) }) // so TempDir cleanup can remove it
	if writable(ro) {
		t.Error("writable() said yes for an existing directory it cannot write into")
	}
}

// --- accessors ---------------------------------------------------------------

// TestAccessors_PathIsUnlockedAndLLMCreds pins the three lock-guarded readers
// external packages are required to use instead of the private fields. Path is
// fixed at construction and is NOT cleared by Lock or Reset — callers use it to
// reopen the same vault, so a Reset that also forgot the path would leave the
// process unable to point at the file it just deleted.
func TestAccessors_PathIsUnlockedAndLLMCreds(t *testing.T) {
	path := lcTempVaultPath(t)
	v := New(path)

	if got := v.Path(); got != path {
		t.Errorf("Path() = %q, want %q", got, path)
	}
	if v.IsUnlocked() {
		t.Error("a brand-new Vault reports unlocked")
	}
	if g, b, m := v.LLMCreds(); g != "" || b != "" || m != "" {
		t.Errorf("a brand-new Vault has LLM creds: %q %q %q", g, b, m)
	}

	if err := v.Init("accessor-test-pass"); err != nil {
		t.Fatalf("init: %v", err)
	}
	if !v.IsUnlocked() {
		t.Error("IsUnlocked() is false right after Init")
	}
	v.groq, v.llmBase, v.llmModel = "gsk_fixture_not_real", "https://api.groq.com/openai/v1", "qwen/qwen3-32b"
	g, b, m := v.LLMCreds()
	if g != "gsk_fixture_not_real" || b != "https://api.groq.com/openai/v1" || m != "qwen/qwen3-32b" {
		t.Errorf("LLMCreds() = %q %q %q", g, b, m)
	}

	if err := v.Reset(); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if got := v.Path(); got != path {
		t.Errorf("Path() = %q after Reset, want it unchanged (%q)", got, path)
	}
}

// --- snapshot / restore ------------------------------------------------------

// TestSnapshotRestore_DeepCopies. snapshot/restore is the rollback every vault
// mutation depends on: AddTenant, RemoveTenant, UpdateTenant, SetActive and
// SetWritable all snapshot, mutate, save, and restore if the save failed. If the
// snapshot were SHALLOW, restoring would put back a slice whose contents the
// failed mutation had already overwritten — the rollback would run, report
// success, and change nothing. That failure is invisible in every one of those
// callers, so it is tested here directly.
//
// The vault is used from a single goroutine, so calling these lock-expecting
// internals without holding v.mu cannot race anything.
func TestSnapshotRestore_DeepCopies(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	v.groq, v.llmBase, v.llmModel = "gsk_fixture_not_real", "https://base", "model-a"
	v.writeAllowed = []string{"t1/-"}

	snap := v.snapshot()

	// Mutate everything, INCLUDING through the pointer and into the slice
	// elements — the two things a shallow copy would fail to protect.
	v.tenants[0].Key = "Token tampered"
	v.tenants = append(v.tenants, Tenant{ID: "t3", Label: "Foxtrot", Key: "Token k3"})
	*v.active = "t2"
	v.groq, v.llmBase, v.llmModel = "gsk_other", "https://elsewhere", "model-b"
	v.writeAllowed = append(v.writeAllowed, "t2/-")

	v.restore(snap)

	if len(v.tenants) != 2 {
		t.Fatalf("after restore: %d tenants, want 2", len(v.tenants))
	}
	if v.tenants[0].Key != "Token k1" {
		t.Errorf("restore did not undo an in-place tenant edit: key = %q (shallow copy)", v.tenants[0].Key)
	}
	if v.active == nil || *v.active != "t1" {
		t.Errorf("restore did not undo the active-tenant change: %v (the *string was not deep-copied)", v.active)
	}
	if v.groq != "gsk_fixture_not_real" || v.llmBase != "https://base" || v.llmModel != "model-a" {
		t.Errorf("restore did not undo the LLM fields: %q %q %q", v.groq, v.llmBase, v.llmModel)
	}
	if strings.Join(v.writeAllowed, ",") != "t1/-" {
		t.Errorf("restore did not undo the grant list: %v", v.writeAllowed)
	}

	// The nil-active arm: a vault with no active tenant snapshots and restores
	// without inventing one.
	empty := newUnlockedVault(t)
	esnap := empty.snapshot()
	if esnap.active != nil {
		t.Error("snapshot of a vault with no active tenant produced a non-nil active")
	}
	id := "t9"
	empty.active = &id
	empty.tenants = []Tenant{{ID: "t9", Label: "Ghost", Key: "Token k9"}}
	empty.restore(esnap)
	if empty.active != nil || len(empty.tenants) != 0 {
		t.Errorf("restore of an empty snapshot left state behind: active=%v tenants=%d", empty.active, len(empty.tenants))
	}
}

// --- SetAuthReset / rotateAuth -----------------------------------------------

// TestSetAuthReset_OptionalAndFires covers the coordinated auth reset hook
// itself, independently of which mutation calls it. Two properties:
//
//   - it is OPTIONAL. A Vault built without SetAuthReset (every test vault, and
//     any embedding that does not wire one) must not panic when a mutation fires
//     the hook. A nil-callback panic here would take down the process on the
//     first tenant switch.
//   - it FIRES, and the most recently registered callback is the one that runs —
//     the hook is what clears the portal Bearer override and rotates the shared
//     cache, so a hook that silently stopped running would let a switched-in
//     portal account outlive the tenant change it was supposed to end.
//
// This does not test WHICH mutations fire it; those exact deltas belong with the
// mutations themselves.
func TestSetAuthReset_OptionalAndFires(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})

	// No callback registered: must be a no-op, not a panic.
	v.rotateAuth()

	first, second := 0, 0
	v.SetAuthReset(func() { first++ })
	v.rotateAuth()
	if first != 1 {
		t.Errorf("registered callback ran %d times, want 1", first)
	}

	v.SetAuthReset(func() { second++ })
	v.rotateAuth()
	if second != 1 || first != 1 {
		t.Errorf("re-registering did not replace the callback: first=%d second=%d", first, second)
	}
}
