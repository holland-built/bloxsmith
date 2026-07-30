package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bloxsmith/internal/vault"
)

// THE WRITE LOCK, EXERCISED THROUGH THE REAL CLI WIRING.
//
// restorecli_apply_test.go drives applyRestore directly, with `writable`
// handed in as a plain bool parameter. That proves applyRestore honors
// whatever bool it is given — it proves nothing about where that bool comes
// from in the real command. runRestoreApplyCLI (restorecli_apply.go:242) is
// the only code that resolves it for real:
//
//	currentID := vault.WriteID(v.ActiveTenantID(), vault.NoSwitch)
//	writable := v.WriteAllowed(currentID)
//
// A CLI process never passes through internal/server/writelock.go, so that
// one line IS the write lock for `restore-plan --apply`. It was completely
// unexercised: replacing it with `writable := true` left every test in this
// package green, including every refusal test in restorecli_apply_test.go —
// because none of them call runRestoreApplyCLI. These tests do, against a
// real on-disk vault built the same way passcli_rotate_test.go builds one
// (vault.New + Init + AddTenant), asserting on a fake upstream's write count
// — never on applyRestore's return value.

// applylockFakeUpstream stands in for the tenant. Every scenario in this file
// is expected to be refused before applyRestore's create loop ever runs, so
// this never needs to serve a real GET/POST shape — it only needs to count
// non-GET requests, so a refusal that quietly wrote anyway would be caught.
func applylockFakeUpstream(t *testing.T) (baseURL string, writes *int) {
	t.Helper()
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			n++
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not found"}`))
	}))
	t.Cleanup(srv.Close)
	return srv.URL, &n
}

// applylockEnv points a from-scratch runRestoreApplyCLI at an isolated vault
// directory and the fake upstream, via the exact env vars config.Load itself
// reads (VAULT_DIR, VAULT_PASSPHRASE, INFOBLOX_URL). t.Setenv restores the
// previous value automatically at test end, so these never leak between
// tests in this file or into other test files in the package.
func applylockEnv(t *testing.T, vaultDir, passphrase, baseURL string) {
	t.Helper()
	t.Setenv("VAULT_DIR", vaultDir)
	t.Setenv("VAULT_PASSPHRASE", passphrase)
	t.Setenv("VAULT_PASSPHRASE_FILE", "")
	t.Setenv("INFOBLOX_URL", baseURL)
	t.Setenv("INFOBLOX_API_KEY", "")
}

// newApplylockVault builds a real sealed vault with one tenant — via Init and
// AddTenant, the same real writer newSealedVault (passcli_test.go) uses, not
// a hand-authored fixture — and returns that tenant's id. The first tenant
// added to an empty vault becomes the active one (vault/manage.go AddTenant),
// which is what makes it "the tenant resolved right now" once this process
// auto-unlocks it.
func newApplylockVault(t *testing.T, vaultDir, passphrase string) (tenantID string) {
	t.Helper()
	v := vault.New(filepath.Join(vaultDir, "vault.json"))
	if err := v.Init(passphrase); err != nil {
		t.Fatalf("Init: %v", err)
	}
	r := v.AddTenant("Applylock Tenant", "tenant-key-1", nil)
	if r["ok"] != true {
		t.Fatalf("AddTenant: %v", r)
	}
	tenantID, _ = r["id"].(string)
	if tenantID == "" {
		t.Fatalf("AddTenant returned no id: %v", r)
	}
	v.Lock()
	return tenantID
}

// addApplylockTenant adds a SECOND tenant to an already-built vault (used by
// the wrong-identity test) and returns its id. It does not become active —
// only the first tenant added to an empty vault does.
func addApplylockTenant(t *testing.T, vaultDir, passphrase string) (tenantID string) {
	t.Helper()
	v := vault.New(filepath.Join(vaultDir, "vault.json"))
	if err := v.Unlock(passphrase); err != nil {
		t.Fatalf("Unlock to add second tenant: %v", err)
	}
	r := v.AddTenant("Applylock Decoy Tenant", "tenant-key-2", nil)
	if r["ok"] != true {
		t.Fatalf("AddTenant (decoy): %v", r)
	}
	tenantID, _ = r["id"].(string)
	if tenantID == "" {
		t.Fatalf("AddTenant (decoy) returned no id: %v", r)
	}
	v.Lock()
	return tenantID
}

// markApplylockWritable unlocks the vault, marks id writable, and locks it
// again — reusing vault.SetWritable, the exact same call the Settings UI
// makes, rather than writing to writeAllowed directly.
func markApplylockWritable(t *testing.T, vaultDir, passphrase, id string) {
	t.Helper()
	v := vault.New(filepath.Join(vaultDir, "vault.json"))
	if err := v.Unlock(passphrase); err != nil {
		t.Fatalf("Unlock to mark writable: %v", err)
	}
	if r := v.SetWritable(id, true); r["ok"] != true {
		t.Fatalf("SetWritable(%q): %v", id, r)
	}
	v.Lock()
}

// captureApplylockStderr runs fn with os.Stderr redirected and returns what
// it wrote. Refusal messages (printApplyOutcome) go to stderr, not stdout —
// captureStdout (restorecli_test.go) would see none of them.
func captureApplylockStderr(t *testing.T, fn func() int) (stderr string, code int) {
	t.Helper()
	old := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	done := make(chan string)
	go func() {
		var b strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			b.Write(buf[:n])
			if err != nil {
				break
			}
		}
		done <- b.String()
	}()
	code = fn()
	w.Close()
	os.Stderr = old
	return <-done, code
}

// --- 1. not writable: the real path must refuse, and must refuse for the
// write-lock reason specifically. -------------------------------------------

func TestRunRestoreApplyCLIRefusesWhenNotWritable(t *testing.T) {
	vaultDir := t.TempDir()
	const passphrase = "applylock-pass-1"
	baseURL, writes := applylockFakeUpstream(t)
	applylockEnv(t, vaultDir, passphrase, baseURL)

	tenantID := newApplylockVault(t, vaultDir, passphrase) // never marked writable
	currentID := vault.WriteID(tenantID, vault.NoSwitch)
	doc := applyFixtureDoc(currentID, fixtureTarget)
	steps := planSteps(t, doc)

	stderr, code := captureApplylockStderr(t, func() int {
		return runRestoreApplyCLI("fixture-export.json", doc, steps, fixtureTarget)
	})
	if code == 0 {
		t.Fatalf("expected a non-zero exit refusing the write, got 0. stderr: %s", stderr)
	}
	if !strings.Contains(stderr, "not marked writable") {
		t.Fatalf("refusal does not cite the write lock: %q", stderr)
	}
	if !strings.Contains(stderr, currentID) {
		t.Fatalf("refusal does not name the identity that was refused: %q", stderr)
	}
	if *writes != 0 {
		t.Fatalf("a non-writable tenant reached the fake upstream %d time(s), want 0", *writes)
	}
}

// --- 2. marking the RIGHT identity writable gets past the write-lock check
// specifically (it may still refuse for another reason). --------------------

func TestRunRestoreApplyCLIWritableProceedsPastWriteLock(t *testing.T) {
	vaultDir := t.TempDir()
	const passphrase = "applylock-pass-2"
	baseURL, writes := applylockFakeUpstream(t)
	applylockEnv(t, vaultDir, passphrase, baseURL)

	tenantID := newApplylockVault(t, vaultDir, passphrase)
	currentID := vault.WriteID(tenantID, vault.NoSwitch)
	markApplylockWritable(t, vaultDir, passphrase, currentID)

	doc := applyFixtureDoc(currentID, fixtureTarget)
	steps := planSteps(t, doc)

	// Deliberately no --confirm, so this is refused at the confirm check
	// (applyRestore step 3) rather than actually creating anything — the
	// point of this test is only that it got PAST the write-lock check
	// (step 2), not that it succeeds end to end.
	stderr, code := captureApplylockStderr(t, func() int {
		return runRestoreApplyCLI("fixture-export.json", doc, steps, "")
	})
	if code == 0 {
		t.Fatalf("expected a refusal (no --confirm given), got exit 0")
	}
	if strings.Contains(stderr, "not marked writable") {
		t.Fatalf("refused on the write lock even though the right identity was marked writable: %q", stderr)
	}
	if !strings.Contains(stderr, "--confirm") {
		t.Fatalf("expected the confirm refusal, got: %q", stderr)
	}
	if *writes != 0 {
		t.Fatalf("fake upstream saw %d write(s), want 0", *writes)
	}
}

// --- 3. the IDENTITY is checked, not just "is anything writable": marking a
// DIFFERENT identity writable must not let this one through. ----------------

func TestRunRestoreApplyCLIWrongIdentityWritableStillRefuses(t *testing.T) {
	vaultDir := t.TempDir()
	const passphrase = "applylock-pass-3"
	baseURL, writes := applylockFakeUpstream(t)
	applylockEnv(t, vaultDir, passphrase, baseURL)

	// tenantID becomes the ACTIVE tenant (first one added) — this is the one
	// currentID will resolve to. decoyID is a second, distinct identity.
	tenantID := newApplylockVault(t, vaultDir, passphrase)
	decoyID := addApplylockTenant(t, vaultDir, passphrase)
	if tenantID == decoyID {
		t.Fatalf("test setup produced identical tenant ids: %q", tenantID)
	}

	// Mark the DECOY writable, not the active tenant.
	markApplylockWritable(t, vaultDir, passphrase, vault.WriteID(decoyID, vault.NoSwitch))

	currentID := vault.WriteID(tenantID, vault.NoSwitch)
	doc := applyFixtureDoc(currentID, fixtureTarget)
	steps := planSteps(t, doc)

	stderr, code := captureApplylockStderr(t, func() int {
		return runRestoreApplyCLI("fixture-export.json", doc, steps, fixtureTarget)
	})
	if code == 0 {
		t.Fatalf("expected a refusal — the active tenant's identity was never marked writable, only a decoy's")
	}
	if !strings.Contains(stderr, "not marked writable") {
		t.Fatalf("refusal is not the write-lock refusal: %q", stderr)
	}
	if !strings.Contains(stderr, currentID) {
		t.Fatalf("refusal does not name the active identity %q: %q", currentID, stderr)
	}
	if *writes != 0 {
		t.Fatalf("wrong-identity-writable case reached the fake upstream %d time(s), want 0", *writes)
	}
}

// --- 4. a vault this process cannot unlock must refuse outright — "cannot
// tell whether it's writable" must never be treated as permission. ---------

func TestRunRestoreApplyCLILockedVaultRefuses(t *testing.T) {
	vaultDir := t.TempDir()
	const realPassphrase = "applylock-pass-4-real"
	baseURL, writes := applylockFakeUpstream(t)
	// Point this process at the WRONG passphrase, so its own AutoUnlock call
	// — the same call runRestoreApplyCLI makes before it can ever resolve
	// v.ActiveTenantID() or v.WriteAllowed() — fails. The vault stays locked
	// from this process's point of view for the whole run.
	applylockEnv(t, vaultDir, "not-"+realPassphrase, baseURL)

	tenantID := newApplylockVault(t, vaultDir, realPassphrase)
	currentID := vault.WriteID(tenantID, vault.NoSwitch)
	markApplylockWritable(t, vaultDir, realPassphrase, currentID) // even though writable, this process can't get in to see it
	doc := applyFixtureDoc(currentID, fixtureTarget)
	steps := planSteps(t, doc)

	stderr, code := captureApplylockStderr(t, func() int {
		return runRestoreApplyCLI("fixture-export.json", doc, steps, fixtureTarget)
	})
	if code == 0 {
		t.Fatalf("expected a refusal — this process cannot unlock the vault at all, got exit 0")
	}
	if !strings.Contains(stderr, "could not unlock") {
		t.Fatalf("refusal does not say the vault could not be unlocked: %q", stderr)
	}
	if *writes != 0 {
		t.Fatalf("a vault this process could not unlock still reached the fake upstream %d time(s), want 0", *writes)
	}
}
