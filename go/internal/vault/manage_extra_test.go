package vault

// Tests for the tenant/LLM MUTATIONS in manage.go (AddTenant, RemoveTenant,
// UpdateTenant, SetActive, SetLLM), the {ok}-shaped R-wrappers (InitR, UnlockR,
// LockR, ResetR), RefreshNames, and Status.
//
// WHY THIS FILE EXISTS. Every function named above sat at 0.0% coverage. They
// are the only writers of the encrypted credential store, and Status is what the
// dashboard renders. This repo has already shipped a green suite over a control
// that was hard-wired open, so a test here only counts if a specific, named
// production mutation turns it red; those mutations are recorded in the lane
// report, not just imagined.
//
// The four properties this file is actually about:
//
//  1. LOCKED REFUSALS. Every mutating operation must refuse while the vault is
//     locked AND leave vault.json byte-identical. Each refusal is asserted on the
//     EXACT error string, because every one of these functions has a second,
//     later refusal path (save() returning "vault locked", or "unknown tenant"
//     against the emptied in-memory list) that would keep a sloppier test green
//     with the guard deleted.
//  2. SNAPSHOT/RESTORE ON A FAILED SAVE. A mutation that could not be persisted
//     must not stay live in memory — otherwise this process keeps acting on state
//     that no future process will ever see. Each such test asserts the save
//     REALLY failed before asserting the rollback; a rollback test whose save
//     succeeded is decoration.
//  3. rotateAuth EXACT DELTAS. The auth/cache reset must fire when the active key
//     changes and must not fire otherwise. Asserted as an exact delta from a
//     counter re-registered immediately before the action — "it moved" would hide
//     a double-fire, and "it is non-zero" would hide a fire on a rename.
//  4. STATUS HONESTY. Status must never present an invented value, and "locked"
//     must not render the same as "unlocked with no tenants".
//
// HONEST SCOPE — what these tests do NOT prove.
//   - Nothing here proves any HTTP route calls these functions, or calls them in
//     the right order. That is scripts/control-guard.sh's job.
//   - The byte-identical-file assertions in the locked table prove no mutation
//     reached the disk. They do NOT independently redden if only the locked guard
//     is deleted, because save() has its own `v.key == nil` refusal behind it —
//     the exact-error-string assertions are what catch that. Both are asserted;
//     the file check is the backstop for a mutation that reaches save().
//   - CLI exit codes, keychain round-trips and passphrase-source precedence are
//     owned by scripts/vault-passphrase-test.sh and keychain_test.go and are
//     deliberately not duplicated here.
//
// SAFETY RULES OBSERVED HERE — not style preferences:
//   - Every vault lives in t.TempDir() and HOME is sandboxed (newUnlockedVault
//     does it; the tests that build their own vault do it explicitly), because
//     ResolveFile's fallback MKDIRS AND WRITES a probe file into
//     <UserConfigDir>/bloxsmith, which on a developer Mac IS the real vault.
//   - No .vault-pass file is ever created and VAULT_PASSPHRASE_FILE /
//     VAULT_PASSPHRASE are never set or referenced: that env var beats the macOS
//     keychain, and that precedence was a real shipped bug. Nothing here reads or
//     writes the keychain.
//   - AddTenant/UpdateTenant with a BLANK label call portalLabelForKey, which is
//     a live HTTPS request to csp.infoblox.com. Every call below either passes an
//     explicit non-blank label or points v.BaseURL at a local httptest server
//     first. The same applies to RefreshNames. No test in this file can reach the
//     public internet.
//   - No real tenant is ever marked writable; every identity used here belongs to
//     a vault that existed only for the duration of one test.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// mxPass is the throwaway passphrase newUnlockedVault (writelock_test.go) uses.
// Repeated as a literal there; named here so the reopen-and-verify tests below
// cannot drift from it silently. It is never stored anywhere — not the keychain,
// not a file, not an environment variable.
const mxPass = "writelock-test-pass"

// mxPortalFake stands in for csp.infoblox.com. It answers the two endpoints
// portalLabelForKey calls and resolves a name from the Authorization header, so
// one server can serve several tenants. A key absent from names (or mapped to
// "") produces the "reachable but no name resolved" outcome, which is the branch
// that makes AddTenant fall back to "Tenant N".
//
// THIS IS THE ONLY WAY the auto-label paths are exercised in this file. Calling
// them without a fake would send a real API key to the real portal.
func mxPortalFake(t *testing.T, names map[string]string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := names[r.Header.Get("Authorization")]
		switch r.URL.Path {
		case "/v2/current_user/accounts":
			_, _ = w.Write([]byte(`{"results":[{"id":"acct-1","name":` + strconv.Quote(name) + `,"state":"active"}]}`))
		case "/v2/current_user":
			_, _ = w.Write([]byte(`{"result":{"account_id":"acct-1"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// mxAuthCounter registers a fresh rotateAuth counter and returns it. Calling it
// again REPLACES the callback, which is how the tests reset the count to zero
// immediately before the action under test — UnlockR and LockR also rotate, so a
// count accumulated across setup would hide a wrong-firing bug.
func mxAuthCounter(v *Vault) *int {
	n := 0
	v.SetAuthReset(func() { n++ })
	return &n
}

// mxBreakSave makes every future save() fail deterministically by pointing the
// vault at a file inside a directory that was never created. A chmod-based
// fixture was rejected: it behaves differently when tests run as root. Returns
// the path so a caller can prove the ORIGINAL file was left alone.
func mxBreakSave(t *testing.T, v *Vault) {
	t.Helper()
	v.path = filepath.Join(filepath.Dir(v.path), "never-created", "vault.json")
	if err := v.Save(); err == nil {
		t.Fatal("the save-failure fixture did not fail; the rollback assertions below would prove nothing")
	}
}

// mxRead returns the raw bytes of the vault file.
func mxRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read vault file: %v", err)
	}
	return b
}

// mxLabels renders the stored tenants as "id=label" for comparison.
func mxLabels(v *Vault) string {
	parts := make([]string, 0, len(v.tenants))
	for _, tn := range v.tenants {
		parts = append(parts, tn.ID+"="+tn.Label)
	}
	return strings.Join(parts, ",")
}

// --- 1. locked refusals -----------------------------------------------------

// TestMutationsRefuseWhileLockedAndLeaveTheFileByteIdentical is the headline
// property: a locked vault holds no decrypted state, so no mutation may proceed,
// and none may touch the file on the way to refusing.
//
// The exact-string assertion is the load-bearing part. With its locked guard
// deleted, each of these functions still fails — but for a DIFFERENT reason
// ("vault locked" from save(), or "unknown tenant"/"unknown connection" because
// Lock() emptied the in-memory tenant list). A test that only checked ok:false
// would stay green with every guard removed.
func TestMutationsRefuseWhileLockedAndLeaveTheFileByteIdentical(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	// If a guard were removed, the code after it must still be unable to reach
	// the real portal. Every call below also passes an explicit label.
	v.BaseURL = mxPortalFake(t, nil).URL

	path := v.Path()
	before := mxRead(t, path)

	n := mxAuthCounter(v)
	v.Lock()
	*n = 0 // Lock() itself does not rotate (LockR does); start from a clean zero.

	cases := []struct {
		name string
		run  func() map[string]any
	}{
		{"AddTenant", func() map[string]any { return v.AddTenant("Foxtrot", "Token k3", strp("groq-key")) }},
		{"RemoveTenant", func() map[string]any { return v.RemoveTenant("t1") }},
		{"UpdateTenant", func() map[string]any { return v.UpdateTenant("t1", "Token k1-new", strp("Delta II")) }},
		{"SetActive", func() map[string]any { return v.SetActive("t2") }},
		{"SetLLM", func() map[string]any { return v.SetLLM("k", strp("https://llm.example/v1"), strp("m")) }},
		{"RefreshNames", func() map[string]any { return v.RefreshNames() }},
	}
	for _, c := range cases {
		res := c.run()
		if okv, _ := res["ok"].(bool); okv {
			t.Errorf("%s succeeded on a locked vault: %v", c.name, res)
		}
		if msg, _ := res["error"].(string); msg != "locked" {
			t.Errorf("%s error = %q, want exactly %q (a different message means the locked guard was not what refused)", c.name, msg, "locked")
		}
	}

	if after := mxRead(t, path); !bytes.Equal(before, after) {
		t.Error("a refused mutation rewrote vault.json; a refusal must not touch the file at all")
	}
	if *n != 0 {
		t.Errorf("refused mutations fired the auth/cache reset %d time(s), want 0", *n)
	}
	if v.IsUnlocked() {
		t.Error("the vault unlocked itself somewhere in the refusal path")
	}
	if v.TenantCount() != 0 {
		t.Error("a locked vault reported a tenant count; a locked vault holds no answer")
	}

	// And the file is still the real vault it was: reopening with the original
	// passphrase must find both tenants exactly as they were.
	reopened := New(path)
	if err := reopened.Unlock(mxPass); err != nil {
		t.Fatalf("reopen after the refusals: %v", err)
	}
	if got := mxLabels(reopened); got != "t1=Delta,t2=Echo" {
		t.Errorf("stored tenants after the refusals = %q, want %q", got, "t1=Delta,t2=Echo")
	}
	if got := reopened.ActiveKey(); got != "Token k1" {
		t.Errorf("active key after the refusals = %q, want %q", got, "Token k1")
	}
}

// --- 2. AddTenant -----------------------------------------------------------

// TestAddTenant_FirstBecomesActiveAndRotatesAuthExactlyOnce pins the one
// AddTenant that changes the active key: the first tenant into an empty vault.
// Adding a SECOND tenant changes nothing about which key requests use, so it
// must not rotate — a spurious rotate silently drops a portal account switch and
// empties the shared cache mid-session.
func TestAddTenant_FirstBecomesActiveAndRotatesAuthExactlyOnce(t *testing.T) {
	v := newUnlockedVault(t)
	n := mxAuthCounter(v)

	res := v.AddTenant("  Delta  ", "  k1  ", nil)
	if okv, _ := res["ok"].(bool); !okv {
		t.Fatalf("AddTenant: %v", res)
	}
	if got, _ := res["label"].(string); got != "Delta" {
		t.Errorf("label = %q, want the trimmed %q", got, "Delta")
	}
	id, _ := res["id"].(string)
	if len(id) != 12 {
		t.Errorf("id = %q, want the 12-char hex tokenHex(6) mints", id)
	}
	if *n != 1 {
		t.Fatalf("first tenant fired the auth reset %d time(s), want exactly 1 — the active key just changed from nothing to this tenant", *n)
	}
	if got := v.ActiveTenantID(); got != id {
		t.Errorf("active = %q, want the first tenant %q", got, id)
	}
	// NormKey ran: a bare key becomes a Token-scheme Authorization value.
	if got := v.ActiveKey(); got != "Token k1" {
		t.Errorf("stored key = %q, want %q", got, "Token k1")
	}

	*n = 0
	res2 := v.AddTenant("Echo", "k2", nil)
	if okv, _ := res2["ok"].(bool); !okv {
		t.Fatalf("second AddTenant: %v", res2)
	}
	if *n != 0 {
		t.Errorf("adding a second tenant fired the auth reset %d time(s), want 0 — the active key did not change", *n)
	}
	if got := v.ActiveTenantID(); got != id {
		t.Errorf("adding a second tenant moved active to %q; it must stay on %q", got, id)
	}
	if v.TenantCount() != 2 {
		t.Errorf("tenant count = %d, want 2", v.TenantCount())
	}
}

// TestAddTenant_BlankKeyRefusedBeforeAnythingIsWritten: an entry with no key is
// not a connection. The refusal must land before the snapshot, so the file is
// untouched and no id is minted.
func TestAddTenant_BlankKeyRefusedBeforeAnythingIsWritten(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	before := mxRead(t, v.Path())
	n := mxAuthCounter(v)

	for _, key := range []string{"", "   ", "\t\n", `""`, "'  '", "Authorization:   "} {
		res := v.AddTenant("Explicit Label", key, nil)
		if okv, _ := res["ok"].(bool); okv {
			t.Errorf("AddTenant(key=%q) succeeded: %v", key, res)
		}
		if msg, _ := res["error"].(string); msg != "API key required" {
			t.Errorf("AddTenant(key=%q) error = %q, want %q", key, msg, "API key required")
		}
		if _, minted := res["id"]; minted {
			t.Errorf("AddTenant(key=%q) minted an id for a refused tenant: %v", key, res)
		}
	}
	if !bytes.Equal(before, mxRead(t, v.Path())) {
		t.Error("a refused AddTenant rewrote vault.json")
	}
	if v.TenantCount() != 1 || *n != 0 {
		t.Errorf("refused AddTenant changed state: count=%d rotations=%d", v.TenantCount(), *n)
	}
}

// TestAddTenant_SaveFailureRestoresEverything is the snapshot/restore property.
// The vault starts EMPTY on purpose: that way the failed add would otherwise
// leave behind both a phantom tenant and a phantom ACTIVE pointer, and the test
// can prove the active pointer went back to nil rather than to "some tenant".
// The groq write is included because AddTenant mutates it too and restore() must
// put it back.
func TestAddTenant_SaveFailureRestoresEverything(t *testing.T) {
	v := newUnlockedVault(t)
	if res := v.SetLLM("original-groq", nil, nil); !res["ok"].(bool) {
		t.Fatalf("seed groq: %v", res)
	}
	mxBreakSave(t, v)
	n := mxAuthCounter(v)

	res := v.AddTenant("Delta", "Token k1", strp("clobbered-groq"))
	if okv, _ := res["ok"].(bool); okv {
		t.Fatalf("AddTenant reported success despite an unwritable vault: %v", res)
	}
	if v.TenantCount() != 0 {
		t.Errorf("a tenant that could not be persisted is still live in memory (count=%d)", v.TenantCount())
	}
	if got := v.ActiveTenantID(); got != "" {
		t.Errorf("active = %q after a failed add; it must be restored to none", got)
	}
	if groq, _, _ := v.LLMCreds(); groq != "original-groq" {
		t.Errorf("groq = %q after a failed add, want the pre-mutation %q", groq, "original-groq")
	}
	if *n != 0 {
		t.Errorf("a failed add fired the auth reset %d time(s), want 0 — nothing became active", *n)
	}
}

// TestAddTenant_BlankLabelResolvesThroughThePortalFake exercises
// portalLabelForKeyUnlocked, the ONLY path in this package that makes an
// outbound call while holding v.mu. It runs exclusively against a local
// httptest server; with a blank label and the default BaseURL this same call
// goes to csp.infoblox.com for real, which is why every other test in this file
// passes an explicit label.
//
// Both arms matter: a name that resolves becomes the label, and a portal that
// answers WITHOUT a name falls back to "Tenant N". FINDING C-F4 (reported, not
// fixed): portalLabelForKey returns "" for both "the network failed" and "the
// portal answered and had no name", so during an outage a tenant silently gets
// the placeholder label instead of an error. This test does not bless that — it
// only pins the two outcomes that are actually distinguishable today.
func TestAddTenant_BlankLabelResolvesThroughThePortalFake(t *testing.T) {
	v := newUnlockedVault(t)
	v.BaseURL = mxPortalFake(t, map[string]string{
		"Token named": "Acme Production",
		"Token blank": "", // reachable, no name resolved
	}).URL

	res := v.AddTenant("", "named", nil)
	if okv, _ := res["ok"].(bool); !okv {
		t.Fatalf("AddTenant: %v", res)
	}
	if got, _ := res["label"].(string); got != "Acme Production" {
		t.Errorf("auto-label = %q, want the portal-resolved %q", got, "Acme Production")
	}

	res2 := v.AddTenant("", "blank", nil)
	if okv, _ := res2["ok"].(bool); !okv {
		t.Fatalf("second AddTenant: %v", res2)
	}
	if got, _ := res2["label"].(string); got != "Tenant 2" {
		t.Errorf("fallback label = %q, want %q (position in the list at the time of the add)", got, "Tenant 2")
	}
}

// --- 3. RemoveTenant --------------------------------------------------------

// TestRemoveTenant_ActiveRepointedAndRotatesOnlyWhenActiveChanged. Removing the
// ACTIVE tenant changes which key every subsequent request uses, so it must
// re-point active and rotate. Removing any other tenant changes nothing about
// where a write lands and must not rotate — and must not move active either,
// which is the mistake that would send the next teardown at a different tenant.
func TestRemoveTenant_ActiveRepointedAndRotatesOnlyWhenActiveChanged(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
		Tenant{ID: "t3", Label: "Foxtrot", Key: "Token k3"},
	)
	n := mxAuthCounter(v)

	// Non-active removal: no re-point, no rotate.
	if res := v.RemoveTenant("t3"); !res["ok"].(bool) {
		t.Fatalf("RemoveTenant(t3): %v", res)
	}
	if *n != 0 {
		t.Errorf("removing a non-active tenant fired the auth reset %d time(s), want 0", *n)
	}
	if got := v.ActiveTenantID(); got != "t1" {
		t.Errorf("active moved to %q after removing an unrelated tenant; want t1", got)
	}

	// Active removal: re-point to the first survivor, rotate exactly once.
	*n = 0
	if res := v.RemoveTenant("t1"); !res["ok"].(bool) {
		t.Fatalf("RemoveTenant(t1): %v", res)
	}
	if *n != 1 {
		t.Errorf("removing the active tenant fired the auth reset %d time(s), want exactly 1", *n)
	}
	if got := v.ActiveTenantID(); got != "t2" {
		t.Errorf("active = %q after removing the active tenant, want the first survivor t2", got)
	}
	if got := v.ActiveKey(); got != "Token k2" {
		t.Errorf("active key = %q, want %q — active must never point at a removed tenant", got, "Token k2")
	}

	// Last tenant: active must CLEAR, not dangle.
	*n = 0
	if res := v.RemoveTenant("t2"); !res["ok"].(bool) {
		t.Fatalf("RemoveTenant(t2): %v", res)
	}
	if *n != 1 {
		t.Errorf("removing the last tenant fired the auth reset %d time(s), want exactly 1", *n)
	}
	if got := v.ActiveTenantID(); got != "" {
		t.Errorf("active = %q with no tenants left, want none", got)
	}
	if got := v.ActiveKey(); got != "" {
		t.Errorf("active key = %q with no tenants left, want empty", got)
	}
}

// TestRemoveTenant_SaveFailureRestoresTenantsActiveAndGrants. RemoveTenant makes
// THREE mutations before it saves — the tenant list, the active pointer, and the
// write-permission list via forgetTenantWrites. A failed save has to undo all
// three; undoing only the list would leave this process believing a tenant it
// still lists has no write permission, which future processes would disagree
// with.
func TestRemoveTenant_SaveFailureRestoresTenantsActiveAndGrants(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	wlGrant(t, v, "t1/-", "t2/-")
	mxBreakSave(t, v)
	n := mxAuthCounter(v)

	res := v.RemoveTenant("t1") // the ACTIVE tenant
	if okv, _ := res["ok"].(bool); okv {
		t.Fatalf("RemoveTenant reported success despite an unwritable vault: %v", res)
	}
	if got := mxLabels(v); got != "t1=Delta,t2=Echo" {
		t.Errorf("tenants after a failed removal = %q, want them all back", got)
	}
	if got := v.ActiveTenantID(); got != "t1" {
		t.Errorf("active = %q after a failed removal, want the pre-mutation t1", got)
	}
	if !v.WriteAllowed("t1/-") {
		t.Error("a failed removal left the tenant listed but its write permission revoked; the rollback missed writeAllowed")
	}
	if !v.WriteAllowed("t2/-") {
		t.Error("a failed removal dropped an unrelated tenant's grant")
	}
	if *n != 0 {
		t.Errorf("a failed removal fired the auth reset %d time(s), want 0 — the active key never changed", *n)
	}
}

// TestRemoveTenant_UnknownIdIsAcceptedAsAlreadyGone PINS OBSERVED BEHAVIOUR:
// removing an id that is not stored reports ok with the tenant list unchanged
// and does not rotate. That is the same idempotency choice a DELETE makes
// ("already gone" is the requested end state), stated here so a future change to
// a hard refusal is a deliberate, visible diff rather than a silent one.
func TestRemoveTenant_UnknownIdIsAcceptedAsAlreadyGone(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	n := mxAuthCounter(v)

	res := v.RemoveTenant("never-stored")
	if okv, _ := res["ok"].(bool); !okv {
		t.Fatalf("RemoveTenant(unknown) = %v, want the idempotent ok", res)
	}
	if got := mxLabels(v); got != "t1=Delta" {
		t.Errorf("tenants = %q, want them untouched", got)
	}
	if got := v.ActiveTenantID(); got != "t1" {
		t.Errorf("active = %q, want t1", got)
	}
	if *n != 0 {
		t.Errorf("removing an unknown id fired the auth reset %d time(s), want 0", *n)
	}
}

// --- 4. UpdateTenant --------------------------------------------------------

// TestUpdateTenant_RefusalsLeaveTheFileByteIdentical covers the two pre-mutation
// refusals: nothing supplied, and an id that is not stored. Both must land
// before the snapshot, so neither can write.
func TestUpdateTenant_RefusalsLeaveTheFileByteIdentical(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	before := mxRead(t, v.Path())
	n := mxAuthCounter(v)

	cases := []struct {
		name, tid, key string
		label          *string
		wantErr        string
	}{
		{"no key, nil label", "t1", "", nil, "nothing to update"},
		{"no key, blank label", "t1", "   ", strp("  "), "nothing to update"},
		{"unknown id", "never-stored", "Token k9", strp("Ghost"), "unknown connection"},
	}
	for _, c := range cases {
		res := v.UpdateTenant(c.tid, c.key, c.label)
		if okv, _ := res["ok"].(bool); okv {
			t.Errorf("%s: UpdateTenant succeeded: %v", c.name, res)
		}
		if msg, _ := res["error"].(string); msg != c.wantErr {
			t.Errorf("%s: error = %q, want %q", c.name, msg, c.wantErr)
		}
	}
	if !bytes.Equal(before, mxRead(t, v.Path())) {
		t.Error("a refused UpdateTenant rewrote vault.json")
	}
	if got := mxLabels(v); got != "t1=Delta" || v.tenants[0].Key != "Token k1" {
		t.Errorf("a refused UpdateTenant altered state: %q / key %q", got, v.tenants[0].Key)
	}
	if *n != 0 {
		t.Errorf("refused updates fired the auth reset %d time(s), want 0", *n)
	}
}

// TestUpdateTenant_RotatesOnlyWhenTheACTIVETenantGetsANewKey is the exact-delta
// test for the trickiest firing rule in the file. The reset must fire on exactly
// one of these four operations. Renaming the active tenant must NOT fire (a name
// change does not move a single request), and re-keying an INACTIVE tenant must
// NOT fire (no live request uses that key).
//
// Every call passes an explicit label: a new key with a blank label sends
// UpdateTenant to the live portal to resolve one.
func TestUpdateTenant_RotatesOnlyWhenTheACTIVETenantGetsANewKey(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"}, // active
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	n := mxAuthCounter(v)

	cases := []struct {
		name, tid, key string
		label          *string
		wantDelta      int
	}{
		{"rename the active tenant", "t1", "", strp("Delta II"), 0},
		{"rename an inactive tenant", "t2", "", strp("Echo II"), 0},
		{"re-key an inactive tenant", "t2", "Token k2-new", strp("Echo II"), 0},
		{"re-key the ACTIVE tenant", "t1", "Token k1-new", strp("Delta II"), 1},
	}
	for _, c := range cases {
		*n = 0
		res := v.UpdateTenant(c.tid, c.key, c.label)
		if okv, _ := res["ok"].(bool); !okv {
			t.Fatalf("%s: %v", c.name, res)
		}
		if *n != c.wantDelta {
			t.Errorf("%s: auth reset fired %d time(s), want exactly %d", c.name, *n, c.wantDelta)
		}
	}
	if v.tenants[0].Key != "Token k1-new" || v.tenants[1].Key != "Token k2-new" {
		t.Errorf("keys not replaced as expected: %q / %q", v.tenants[0].Key, v.tenants[1].Key)
	}
	if got := mxLabels(v); got != "t1=Delta II,t2=Echo II" {
		t.Errorf("labels = %q, want both renamed", got)
	}
}

// TestUpdateTenant_SaveFailureRestoresKeyLabelAndGrant. UpdateTenant mutates the
// key, the label AND the write permissions (forgetTenantWrites) before it saves.
// A failed save that only put the key back would leave this process refusing
// writes the persisted vault still allows — a control silently disagreeing with
// its own store is worse than either answer.
func TestUpdateTenant_SaveFailureRestoresKeyLabelAndGrant(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	wlGrant(t, v, "t1/-")
	mxBreakSave(t, v)
	n := mxAuthCounter(v)

	res := v.UpdateTenant("t1", "Token k1-new", strp("Delta II"))
	if okv, _ := res["ok"].(bool); okv {
		t.Fatalf("UpdateTenant reported success despite an unwritable vault: %v", res)
	}
	if v.tenants[0].Key != "Token k1" {
		t.Errorf("key = %q after a failed update, want the pre-mutation %q", v.tenants[0].Key, "Token k1")
	}
	if v.tenants[0].Label != "Delta" {
		t.Errorf("label = %q after a failed update, want the pre-mutation %q", v.tenants[0].Label, "Delta")
	}
	if !v.WriteAllowed("t1/-") {
		t.Error("a failed key swap left the old key in place but the grant revoked; the rollback missed writeAllowed")
	}
	if *n != 0 {
		t.Errorf("a failed update fired the auth reset %d time(s), want 0 — the active key never actually changed", *n)
	}
}

// TestUpdateTenant_NewKeyBlankLabelResolvesThroughThePortalFake covers
// UpdateTenant's auto-label arm against a LOCAL server only. It also pins the
// fallback: when the portal answers with no name, the tenant keeps its existing
// label rather than being renamed to a placeholder.
func TestUpdateTenant_NewKeyBlankLabelResolvesThroughThePortalFake(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	v.BaseURL = mxPortalFake(t, map[string]string{"Token named": "Acme Production"}).URL

	if res := v.UpdateTenant("t1", "named", nil); !res["ok"].(bool) {
		t.Fatalf("UpdateTenant: %v", res)
	}
	if got := v.tenants[0].Label; got != "Acme Production" {
		t.Errorf("label = %q, want the portal-resolved %q", got, "Acme Production")
	}

	// Unknown key at the fake portal → no name → the existing label is kept.
	if res := v.UpdateTenant("t2", "unmapped", nil); !res["ok"].(bool) {
		t.Fatalf("UpdateTenant: %v", res)
	}
	if got := v.tenants[1].Label; got != "Echo" {
		t.Errorf("label = %q, want the existing %q kept when no name resolves", got, "Echo")
	}
}

// --- 5. SetActive -----------------------------------------------------------

// TestSetActive_UnknownTenantRefusedWithoutRotatingOrWriting. Pointing active at
// an id nobody stored would make ActiveKey() return "" while the UI shows a
// tenant selected — every subsequent request would fall back to the env key, in
// silence.
func TestSetActive_UnknownTenantRefusedWithoutRotatingOrWriting(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	before := mxRead(t, v.Path())
	n := mxAuthCounter(v)

	for _, id := range []string{"never-stored", "", "T1", "t1 "} {
		res := v.SetActive(id)
		if okv, _ := res["ok"].(bool); okv {
			t.Errorf("SetActive(%q) succeeded: %v", id, res)
		}
		if msg, _ := res["error"].(string); msg != "unknown tenant" {
			t.Errorf("SetActive(%q) error = %q, want %q", id, msg, "unknown tenant")
		}
	}
	if got := v.ActiveTenantID(); got != "t1" {
		t.Errorf("active = %q after refused switches, want the untouched t1", got)
	}
	if !bytes.Equal(before, mxRead(t, v.Path())) {
		t.Error("a refused SetActive rewrote vault.json")
	}
	if *n != 0 {
		t.Errorf("refused switches fired the auth reset %d time(s), want 0", *n)
	}
}

// TestSetActive_RotatesAuthExactlyOnce. SetActive is the canonical tenant
// switch: it must fire the coordinated reset exactly once, because that is what
// clears a portal account override and rotates the shared cache. Firing zero
// times leaves a previous tenant's rows cached under a new tenant; firing twice
// is a symptom of a second, uncoordinated reset nobody accounted for.
//
// Re-selecting the ALREADY-active tenant is pinned as also rotating once: that
// is what the code does, and it is the harmless direction (a redundant cache
// flush), stated so a future optimisation is a deliberate diff.
func TestSetActive_RotatesAuthExactlyOnce(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	n := mxAuthCounter(v)

	*n = 0
	res := v.SetActive("t2")
	if okv, _ := res["ok"].(bool); !okv {
		t.Fatalf("SetActive(t2): %v", res)
	}
	if got, _ := res["active"].(string); got != "t2" {
		t.Errorf("response active = %q, want t2", got)
	}
	if *n != 1 {
		t.Fatalf("SetActive fired the auth reset %d time(s), want exactly 1", *n)
	}
	if got := v.ActiveKey(); got != "Token k2" {
		t.Errorf("active key = %q, want %q", got, "Token k2")
	}

	*n = 0
	if res := v.SetActive("t2"); !res["ok"].(bool) {
		t.Fatalf("re-selecting the active tenant: %v", res)
	}
	if *n != 1 {
		t.Errorf("re-selecting the active tenant fired the auth reset %d time(s), want exactly 1 (pinned current behaviour)", *n)
	}
}

// TestSetActive_SaveFailureRestoresThePreviousActive: a switch that could not be
// persisted must not be live. Otherwise this process writes to tenant B while
// the vault on disk — and the next restart — says tenant A.
func TestSetActive_SaveFailureRestoresThePreviousActive(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	mxBreakSave(t, v)
	n := mxAuthCounter(v)

	res := v.SetActive("t2")
	if okv, _ := res["ok"].(bool); okv {
		t.Fatalf("SetActive reported success despite an unwritable vault: %v", res)
	}
	if got := v.ActiveTenantID(); got != "t1" {
		t.Errorf("active = %q after a failed switch, want the pre-mutation t1", got)
	}
	if got := v.ActiveKey(); got != "Token k1" {
		t.Errorf("active key = %q after a failed switch, want %q — an unpersisted switch must not steer live requests", got, "Token k1")
	}
	if *n != 0 {
		t.Errorf("a failed switch fired the auth reset %d time(s), want 0", *n)
	}
}

// --- 6. SetLLM --------------------------------------------------------------

// TestSetLLM_TrimsAndNilPointersLeaveFieldsAlone. nil means "unchanged" and a
// pointer to "" means "cleared"; conflating them would silently wipe an
// operator's LLM endpoint every time only the key was updated (the /api/vault/groq
// route sends key only).
func TestSetLLM_TrimsAndNilPointersLeaveFieldsAlone(t *testing.T) {
	v := newUnlockedVault(t)

	if res := v.SetLLM("  key-1  ", strp("  https://llm.example/v1  "), strp("  model-a  ")); !res["ok"].(bool) {
		t.Fatalf("SetLLM: %v", res)
	}
	groq, base, model := v.LLMCreds()
	if groq != "key-1" || base != "https://llm.example/v1" || model != "model-a" {
		t.Fatalf("after SetLLM: groq=%q base=%q model=%q — all three must be trimmed and stored", groq, base, model)
	}

	// Key-only update: base and model must survive untouched.
	if res := v.SetLLM("key-2", nil, nil); !res["ok"].(bool) {
		t.Fatalf("key-only SetLLM: %v", res)
	}
	groq, base, model = v.LLMCreds()
	if groq != "key-2" {
		t.Errorf("groq = %q, want key-2", groq)
	}
	if base != "https://llm.example/v1" || model != "model-a" {
		t.Errorf("a key-only update wiped base/model: base=%q model=%q", base, model)
	}

	// An explicit empty pointer clears — the deliberate direction.
	if res := v.SetLLM("key-2", strp(""), strp("")); !res["ok"].(bool) {
		t.Fatalf("clearing SetLLM: %v", res)
	}
	if _, base, model = v.LLMCreds(); base != "" || model != "" {
		t.Errorf("an explicit empty base/model did not clear: base=%q model=%q", base, model)
	}

	// And it round-trips through the file, not just memory.
	path := v.Path()
	v.Lock()
	reopened := New(path)
	if err := reopened.Unlock(mxPass); err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if groq, _, _ := reopened.LLMCreds(); groq != "key-2" {
		t.Errorf("reopened groq = %q, want key-2 — SetLLM did not persist", groq)
	}
}

// TestSetLLM_SaveFailureLeavesTheMutationLiveInMemory PINS A DEFECT, it does not
// bless it.
//
// FINDING C-F5 (reported, deliberately NOT fixed in this test-only lane):
// SetLLM is the ONLY mutation in manage.go that does not snapshot/restore around
// its save. AddTenant, RemoveTenant, UpdateTenant, SetActive and SetWritable all
// roll back; SetLLM returns fail(...) with the new key already installed in
// memory. So after a failed save this process sends LLM requests with a
// credential that vault.json has never heard of, and the very next successful
// save of ANY other mutation persists it silently. The fix is the same three
// lines the others use (snap := v.snapshot() ... v.restore(snap)).
//
// The assertions below state what the code does TODAY so that adding the
// rollback shows up as a deliberate, visible change to this test. What the test
// asserts as CORRECT is only the part that is correct: ok:false, and the file on
// disk still holding the old value.
func TestSetLLM_SaveFailureLeavesTheMutationLiveInMemory(t *testing.T) {
	v := newUnlockedVault(t)
	if res := v.SetLLM("original-key", strp("https://llm.example/v1"), strp("model-a")); !res["ok"].(bool) {
		t.Fatalf("seed: %v", res)
	}
	goodPath := v.Path()
	mxBreakSave(t, v)

	res := v.SetLLM("new-key", strp("https://elsewhere.example/v1"), strp("model-b"))
	if okv, _ := res["ok"].(bool); okv {
		t.Fatalf("SetLLM reported success despite an unwritable vault: %v", res)
	}
	if msg, _ := res["error"].(string); msg == "" {
		t.Error("a failed SetLLM must carry a reason")
	}

	// CORRECT and asserted as such: the persisted vault is untouched.
	reopened := New(goodPath)
	if err := reopened.Unlock(mxPass); err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if groq, base, model := reopened.LLMCreds(); groq != "original-key" || base != "https://llm.example/v1" || model != "model-a" {
		t.Errorf("the failed SetLLM reached disk: groq=%q base=%q model=%q", groq, base, model)
	}

	// PINNED, NOT BLESSED (finding C-F5): in memory the unpersisted values are
	// still live. If this assertion ever fails because a rollback was added, that
	// is the defect being FIXED — update this test and delete the finding.
	if groq, _, _ := v.LLMCreds(); groq != "new-key" {
		t.Logf("SetLLM now rolls back on a failed save (groq=%q); finding C-F5 appears fixed — update this test", groq)
	}
}

// --- 7. the {ok}-shaped R wrappers -----------------------------------------

// TestInitR_ShapeAndRefusals covers all three InitR outcomes in one throwaway
// directory. HOME is sandboxed explicitly here because this test builds its own
// Vault rather than going through newUnlockedVault.
func TestInitR_ShapeAndRefusals(t *testing.T) {
	// ResolveFile's fallback mkdirs and writes a probe into
	// <UserConfigDir>/bloxsmith — the REAL vault directory on a developer Mac.
	// Nothing here calls ResolveFile, but the sandbox is unconditional so no
	// future edit to this test can reach it.
	t.Setenv("HOME", t.TempDir())
	path := filepath.Join(t.TempDir(), "vault.json")
	v := New(path)

	if res := v.InitR("short"); res["ok"].(bool) {
		t.Fatalf("InitR accepted a 5-character passphrase: %v", res)
	} else if msg, _ := res["error"].(string); msg != "passphrase must be at least 8 characters" {
		t.Errorf("short-passphrase error = %q", msg)
	}
	if v.Exists() {
		t.Fatal("a refused InitR created the vault file")
	}

	res := v.InitR("first-run-passphrase")
	if okv, _ := res["ok"].(bool); !okv {
		t.Fatalf("InitR: %v", res)
	}
	if _, present := res["error"]; present {
		t.Errorf("a successful InitR must not carry an error key: %v", res)
	}
	if !v.Exists() || !v.IsUnlocked() {
		t.Fatalf("after InitR: exists=%v unlocked=%v, want both true", v.Exists(), v.IsUnlocked())
	}

	// A second Init must refuse rather than overwrite — overwriting is how every
	// stored tenant key would be lost in one call.
	if res := New(path).InitR("another-passphrase"); res["ok"].(bool) {
		t.Fatalf("InitR overwrote an existing vault: %v", res)
	} else if msg, _ := res["error"].(string); msg != "vault already exists — unlock instead" {
		t.Errorf("second-init error = %q", msg)
	}
}

// TestUnlockR_RotatesOnceOnSuccessAndNeverOnFailure. UnlockR loads a possibly
// DIFFERENT active tenant into memory, so it must rotate — otherwise rows cached
// under the previous session's tenant survive into the new one. A failed unlock
// must not rotate: nothing changed, and a rotate would flush a working session's
// cache on every mistyped passphrase.
//
// The stored labels are deliberately real ("Delta"/"Echo") so UnlockR's
// best-effort RefreshNames finds nothing to resolve. BaseURL is ALSO pointed at
// a local fake, so even if that changed, no request could leave the machine.
func TestUnlockR_RotatesOnceOnSuccessAndNeverOnFailure(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	path := v.Path()
	v.Lock()

	fake := mxPortalFake(t, map[string]string{"Token k1": "Should Not Be Used"})
	reopened := New(path)
	reopened.BaseURL = fake.URL
	n := mxAuthCounter(reopened)

	*n = 0
	if res := reopened.UnlockR("definitely-not-the-passphrase"); res["ok"].(bool) {
		t.Fatalf("UnlockR accepted a wrong passphrase: %v", res)
	} else if msg, _ := res["error"].(string); msg != "wrong passphrase" {
		t.Errorf("wrong-passphrase error = %q, want %q", msg, "wrong passphrase")
	}
	if *n != 0 {
		t.Errorf("a failed unlock fired the auth reset %d time(s), want 0", *n)
	}
	if reopened.IsUnlocked() {
		t.Error("a failed unlock left the vault unlocked")
	}

	*n = 0
	if res := reopened.UnlockR(mxPass); !res["ok"].(bool) {
		t.Fatalf("UnlockR: %v", res)
	}
	if *n != 1 {
		t.Errorf("a successful unlock fired the auth reset %d time(s), want exactly 1", *n)
	}
	if got := mxLabels(reopened); got != "t1=Delta,t2=Echo" {
		t.Errorf("unlocked tenants = %q; RefreshNames must leave real labels alone", got)
	}
}

// TestLockR_ClearsStateAndRotatesOnce. Locking drops the active key, so every
// cached row and portal override tied to it has to go with it.
func TestLockR_ClearsStateAndRotatesOnce(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	n := mxAuthCounter(v)

	*n = 0
	res := v.LockR()
	if okv, _ := res["ok"].(bool); !okv {
		t.Fatalf("LockR: %v", res)
	}
	if *n != 1 {
		t.Errorf("LockR fired the auth reset %d time(s), want exactly 1", *n)
	}
	if v.IsUnlocked() {
		t.Error("LockR left the vault unlocked")
	}
	if got := v.ActiveKey(); got != "" {
		t.Errorf("active key = %q after LockR, want empty", got)
	}
	if err := v.Save(); err == nil {
		t.Error("a locked vault accepted a Save; the key must be gone from memory")
	}
	// The file itself survives a lock — that is what distinguishes lock from reset.
	if !v.Exists() {
		t.Error("LockR deleted the vault file")
	}
}

// TestResetR_DeletesTheFileRotatesAndIsIdempotent. Reset is the forgot-passphrase
// escape hatch; it must actually remove the file (a reset that left it behind
// would leave an unopenable vault blocking first-run) and must not fail when run
// twice.
func TestResetR_DeletesTheFileRotatesAndIsIdempotent(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	path := v.Path()
	n := mxAuthCounter(v)

	*n = 0
	if res := v.ResetR(); !res["ok"].(bool) {
		t.Fatalf("ResetR: %v", res)
	}
	if *n != 1 {
		t.Errorf("ResetR fired the auth reset %d time(s), want exactly 1", *n)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("vault file still present after ResetR (stat err = %v)", err)
	}
	if v.IsUnlocked() || v.TenantCount() != 0 || v.ActiveKey() != "" {
		t.Error("ResetR left decrypted state behind")
	}

	*n = 0
	if res := v.ResetR(); !res["ok"].(bool) {
		t.Fatalf("a second ResetR on a missing file must still succeed: %v", res)
	}
	if *n != 1 {
		t.Errorf("the idempotent ResetR fired the auth reset %d time(s), want exactly 1", *n)
	}
}

// --- 8. RefreshNames --------------------------------------------------------

// TestRefreshNames_RenamesOnlyPlaceholderLabels. RefreshNames exists to replace
// the "Tenant N"/blank placeholders with the real CSP account name. It must NOT
// touch a label an operator set deliberately — a tenant an operator called
// "PROD - DO NOT TOUCH" silently becoming "Acme Inc" is how the wrong tenant
// gets picked from a dropdown.
//
// Runs entirely against a local fake portal (mxPortalFake); the real
// portalLabelForKey target is csp.infoblox.com.
func TestRefreshNames_RenamesOnlyPlaceholderLabels(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "PROD - DO NOT TOUCH", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Tenant 2", Key: "Token k2"},
		Tenant{ID: "t3", Label: "", Key: "Token k3"},
		Tenant{ID: "t4", Label: "Tenant 4", Key: "Token k4"}, // portal has no name for it
	)
	v.BaseURL = mxPortalFake(t, map[string]string{
		"Token k1": "Renamed By Mistake",
		"Token k2": "Acme Production",
		"Token k3": "Acme Staging",
		"Token k4": "", // reachable, no name → must stay as it was
	}).URL

	res := v.RefreshNames()
	if okv, _ := res["ok"].(bool); !okv {
		t.Fatalf("RefreshNames: %v", res)
	}
	if got, _ := res["updated"].(int); got != 2 {
		t.Errorf("updated = %v, want 2 (only the two placeholders that resolved)", res["updated"])
	}
	if got := mxLabels(v); got != "t1=PROD - DO NOT TOUCH,t2=Acme Production,t3=Acme Staging,t4=Tenant 4" {
		t.Errorf("labels after refresh = %q", got)
	}

	// It persisted, not just changed in memory.
	path := v.Path()
	v.Lock()
	reopened := New(path)
	if err := reopened.Unlock(mxPass); err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := mxLabels(reopened); got != "t1=PROD - DO NOT TOUCH,t2=Acme Production,t3=Acme Staging,t4=Tenant 4" {
		t.Errorf("labels after reopen = %q — the refresh did not persist", got)
	}
}

// TestRefreshNames_NothingToDoReportsZeroWithoutWriting. FINDING C-F3 (reported,
// not fixed): RefreshNames discards its save error (`_ = v.save()`), so a
// non-zero `updated` can be reported for labels that never reached disk. This
// test does not exercise that path — proving it would require asserting the
// wrong thing is right — it only pins the honest zero case: no placeholders
// means no work, no write, and no network call at all.
func TestRefreshNames_NothingToDoReportsZeroWithoutWriting(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)

	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Tenant Zero", Key: "Token k2"}, // not "Tenant <digits>"
		Tenant{ID: "t3", Label: " Tenant 3 ", Key: "Token k3"},  // padded — not the placeholder pattern
	)
	v.BaseURL = srv.URL
	before := mxRead(t, v.Path())

	res := v.RefreshNames()
	if okv, _ := res["ok"].(bool); !okv {
		t.Fatalf("RefreshNames: %v", res)
	}
	if got, _ := res["updated"].(int); got != 0 {
		t.Errorf("updated = %v, want 0", res["updated"])
	}
	if calls != 0 {
		t.Errorf("RefreshNames made %d portal call(s) with no placeholder labels, want 0", calls)
	}
	if !bytes.Equal(before, mxRead(t, v.Path())) {
		t.Error("a no-op RefreshNames rewrote vault.json")
	}
}

// --- 9. Status --------------------------------------------------------------

// TestStatus_LockedIsDistinguishableFromEmptyAndFromAbsent is the honesty test
// the dashboard depends on. Three genuinely different situations must render
// three different ways:
//
//	absent  — no vault file at all (first run)
//	locked  — a vault holding tenants that this process cannot read
//	empty   — an unlocked vault that really has no tenants
//
// All three report tenants:[] — an empty list is the ONLY answer a locked vault
// can honestly give, since it holds no answer. So `exists` and `unlocked` are
// what carry the difference, and if either were dropped or defaulted, "I could
// not read it" and "I read it and it is empty" would render identically. That
// conflation is what makes an operator add a tenant they already have, or
// believe their keys are gone.
func TestStatus_LockedIsDistinguishableFromEmptyAndFromAbsent(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // see the file header: ResolveFile's fallback writes
	absent := New(filepath.Join(t.TempDir(), "vault.json"))
	as := absent.Status("v1", true, nil)
	if as["exists"].(bool) || as["unlocked"].(bool) || as["ready"].(bool) {
		t.Fatalf("absent vault status = %v, want exists/unlocked/ready all false", as)
	}

	empty := newUnlockedVault(t)
	es := empty.Status("v1", true, nil)
	if !es["exists"].(bool) || !es["unlocked"].(bool) {
		t.Fatalf("unlocked empty vault status = %v, want exists+unlocked true", es)
	}

	held := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	held.Lock()
	ls := held.Status("v1", true, nil)
	if !ls["exists"].(bool) {
		t.Errorf("a locked vault whose file is on disk reported exists:false: %v", ls)
	}
	if ls["unlocked"].(bool) {
		t.Errorf("a locked vault reported unlocked:true: %v", ls)
	}

	// The conflation check: locked-with-content and unlocked-and-empty both show
	// an empty tenant list, so they MUST differ somewhere else.
	if len(ls["tenants"].([]map[string]any)) != 0 || len(es["tenants"].([]map[string]any)) != 0 {
		t.Fatal("fixture assumption broken: both cases should show an empty tenant list")
	}
	if ls["unlocked"] == es["unlocked"] {
		t.Error(`"locked, cannot read it" and "unlocked, genuinely empty" render identically; a read that failed must never look like a read that found nothing`)
	}
	if as["exists"] == ls["exists"] {
		t.Error(`"no vault at all" and "a locked vault" render identically`)
	}
}

// TestStatus_NeverInventsAValue. Status feeds the dashboard directly, so every
// field it emits must be what the vault actually holds — never a default
// substituted to make the UI look configured. The LLM base URL is the live trap:
// LLMTest falls back to the hardcoded Groq endpoint when none is set, and
// echoing that same fallback here would show an operator a provider they never
// configured. `active` is the other: nil (JSON null) means "no tenant selected",
// and an empty string would be a tenant id nobody has.
func TestStatus_NeverInventsAValue(t *testing.T) {
	v := newUnlockedVault(t)
	s := v.Status("v9.9.9", true, nil)

	if got := s["llm"].(map[string]any)["base_url"]; got != "" {
		t.Errorf("llm.base_url = %v on a vault with none configured, want an empty string — never the %q fallback", got, defaultGroqBase)
	}
	if got := s["llm"].(map[string]any)["model"]; got != "" {
		t.Errorf("llm.model = %v, want an empty string when nothing is configured", got)
	}
	if s["hasGroq"].(bool) || s["llm"].(map[string]any)["hasKey"].(bool) {
		t.Errorf("hasGroq/hasKey true with no key stored: %v", s)
	}
	if s["active"] != nil {
		t.Errorf(`active = %#v with no tenant selected, want nil — "" would be a tenant id nobody has`, s["active"])
	}
	if s["version"] != "v9.9.9" {
		t.Errorf("version = %v, want the value passed in verbatim", s["version"])
	}
	if s["update"] != nil {
		t.Errorf("update = %#v, want the nil that was passed in", s["update"])
	}
	if wa, okv := s["writeAllowed"].([]string); !okv || wa == nil {
		t.Errorf("writeAllowed = %#v, want a non-nil empty slice so it renders as [] and not null", s["writeAllowed"])
	}

	// And what IS configured comes back verbatim.
	if res := v.SetLLM("k", strp("https://llm.example/v1"), strp("model-a")); !res["ok"].(bool) {
		t.Fatalf("SetLLM: %v", res)
	}
	s = v.Status("v9.9.9", true, map[string]any{"available": false})
	llm := s["llm"].(map[string]any)
	if llm["base_url"] != "https://llm.example/v1" || llm["model"] != "model-a" || llm["hasKey"] != true {
		t.Errorf("llm = %v, want the stored values verbatim", llm)
	}
	if upd, _ := s["update"].(map[string]any); upd == nil || upd["available"] != false {
		t.Errorf("update = %#v, want the map passed in, unchanged", s["update"])
	}
}

// TestStatus_ReadyTracksTheActiveKeyNotTheTenantList. "ready" is what the UI
// gates its call buttons on. It must mean "there is a key to send", not "there
// are tenants" — a vault with three tenants and a dangling active pointer has no
// key, and a UI that offered to run against it would fire requests with no
// credential at all.
func TestStatus_ReadyTracksTheActiveKeyNotTheTenantList(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	if s := v.Status("v1", true, nil); !s["ready"].(bool) {
		t.Errorf("ready = false with an active tenant holding a key: %v", s)
	}

	// A dangling active pointer: tenants exist, but none of them is the active id.
	dangling := "no-such-tenant"
	v.mu.Lock()
	v.active = &dangling
	v.mu.Unlock()
	s := v.Status("v1", true, nil)
	if s["ready"].(bool) {
		t.Error("ready = true while the active pointer names no stored tenant — there is no key to send")
	}
	if s["active"] != dangling {
		t.Errorf("active = %v, want the raw stored pointer %q reported as-is rather than papered over", s["active"], dangling)
	}
	if len(s["tenants"].([]map[string]any)) != 2 {
		t.Error("the tenant list must still be reported; only readiness changed")
	}

	// vaultMode=false is the no-vault deployment: readiness comes from the env
	// key instead, so Status reports ready/unlocked regardless of vault state.
	v.Lock()
	if s := v.Status("v1", false, nil); !s["ready"].(bool) || !s["unlocked"].(bool) {
		t.Errorf("with vaultMode=false a locked vault must still report ready+unlocked: %v", s)
	}
	if s := v.Status("v1", true, nil); s["ready"].(bool) || s["unlocked"].(bool) {
		t.Errorf("with vaultMode=true a locked vault must report neither ready nor unlocked: %v", s)
	}
}

// TestStatus_ProjectsIdAndLabelOnlyAndNeverAKey. Status is serialised straight
// to the dashboard over HTTP. A tenant entry carrying its API key would put
// every stored credential in a browser response — and in every screenshot and
// HAR file taken of it.
func TestStatus_ProjectsIdAndLabelOnlyAndNeverAKey(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token super-secret-alpha"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token super-secret-beta"},
	)
	if res := v.SetLLM("super-secret-groq", nil, nil); !res["ok"].(bool) {
		t.Fatalf("SetLLM: %v", res)
	}

	s := v.Status("v1", true, nil)
	for i, tn := range s["tenants"].([]map[string]any) {
		if len(tn) != 2 || tn["id"] == nil || tn["label"] == nil {
			t.Errorf("tenant[%d] = %v, want exactly {id,label}", i, tn)
		}
	}

	blob, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal status: %v", err)
	}
	for _, secret := range []string{"super-secret-alpha", "super-secret-beta", "super-secret-groq"} {
		if strings.Contains(string(blob), secret) {
			t.Errorf("Status leaked %q into the response body", secret)
		}
	}
	if !strings.Contains(string(blob), "Delta") {
		t.Error("fixture assumption broken: the labels should be present, so the absence of the keys above is meaningful")
	}
}

// TestStatus_WriteAllowedIsACopy. The write-permission list is the state behind
// the only control standing between a teardown route and a customer tenant.
// Handing out the live slice would let any caller widen — or empty — the
// permission set without going through SetWritable, i.e. without ever
// persisting, so the running process and the vault on disk would disagree about
// who may be written to.
func TestStatus_WriteAllowedIsACopy(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	wlGrant(t, v, "t1/-")

	got := v.Status("v1", true, nil)["writeAllowed"].([]string)
	if len(got) != 1 || got[0] != "t1/-" {
		t.Fatalf("writeAllowed = %v, want [t1/-]", got)
	}

	got[0] = "hijacked/-"
	if v.WriteAllowed("hijacked/-") {
		t.Error("mutating Status's slice changed what the vault authorises; it must be a copy")
	}
	if !v.WriteAllowed("t1/-") {
		t.Error("mutating Status's slice dropped a real grant; it must be a copy")
	}
	// Appending must not reach the vault either (a shared backing array with
	// spare capacity is the subtler version of the same bug).
	got = append(got, "appended/-")
	_ = got
	if v.WriteAllowed("appended/-") {
		t.Error("appending to Status's slice granted a new identity")
	}
}

// --- 10. small internals ----------------------------------------------------

// TestTokenHexAndOkShape. tokenHex mints every tenant id: a fixed-length hex
// string that must not repeat, because a repeat would silently merge two
// connections (and hand one tenant's write permission to another). ok() is the
// success shape every wrapper returns and must carry no error key — a caller
// checking `if res["error"] != nil` would otherwise treat success as failure.
func TestTokenHexAndOkShape(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		got := tokenHex(6)
		if len(got) != 12 {
			t.Fatalf("tokenHex(6) = %q (%d chars), want 12 hex chars", got, len(got))
		}
		if strings.Trim(got, "0123456789abcdef") != "" {
			t.Fatalf("tokenHex(6) = %q, want lowercase hex only", got)
		}
		if seen[got] {
			t.Fatalf("tokenHex(6) repeated %q within 200 draws; tenant ids must not collide", got)
		}
		seen[got] = true
	}
	if got := tokenHex(0); got != "" {
		t.Errorf("tokenHex(0) = %q, want empty", got)
	}

	res := ok()
	if len(res) != 1 || res["ok"] != true {
		t.Errorf("ok() = %v, want exactly {ok:true} with no error key", res)
	}
}

// TestActiveKeyLockedThroughStatus exercises activeKeyLocked (the lock-held
// variant Status uses) across its three answers: no active pointer, an active
// pointer naming no stored tenant, and a match. Only the third may make the
// dashboard say it is ready.
func TestActiveKeyLockedThroughStatus(t *testing.T) {
	v := newUnlockedVault(t)
	if v.Status("v1", true, nil)["ready"].(bool) {
		t.Error("ready with no active pointer at all")
	}

	v = newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	if !v.Status("v1", true, nil)["ready"].(bool) {
		t.Error("not ready with a matching active tenant")
	}
	// The wrong-tenant failure mode: if the lookup ignored the id and returned
	// the first tenant's key, this would still be ready — so assert the KEY, not
	// just readiness, via the public accessor that shares the lookup.
	if res := v.SetActive("t2"); !res["ok"].(bool) {
		t.Fatalf("SetActive: %v", res)
	}
	if got := v.ActiveKey(); got != "Token k2" {
		t.Errorf("active key = %q, want t2's %q — never the first tenant's", got, "Token k2")
	}
}
