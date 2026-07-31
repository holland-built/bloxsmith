package vault

// Tests for the PER-TENANT WRITE LOCK (writelock.go) — the control that decides
// whether a destructive route may touch a tenant at all.
//
// WHY THIS FILE EXISTS. Every function in writelock.go was at 0.0% coverage
// while it was the thing standing between a teardown route and a customer's
// tenant. This repo has already shipped a fully green test suite with a control
// of exactly this class hard-wired open (`writable := true` in
// restorecli_apply.go) — a green suite proved the tests ran, not that any
// control was actually enforcing anything. So every assertion below is written
// against a specific way the lock could fail OPEN, and each one has a named
// production mutation that reddens it (recorded in the lane report).
//
// HONEST SCOPE — what these tests do and do NOT prove.
//   DO prove: given a Vault, the in-process answers to "is this identity
//   writable" are default-deny, exact-pair only, cleared by Lock, revoked when
//   the tenant is removed or its key replaced, and persisted across a
//   lock/reopen cycle.
//   Do NOT prove: that any HTTP route or CLI path actually CALLS WriteAllowed
//   before writing. A route that never asks is invisible to this file — that gap
//   is what scripts/control-guard.sh exists to catch, and it is a different
//   test. Nor do these tests make the lock a boundary against the operator:
//   anyone who can unlock the vault can mark a tenant writable, and anyone
//   holding the tenant's API key can write to it without this program at all
//   (writelock.go's own "HONEST SCOPE" paragraph).
//
// SAFETY RULES OBSERVED HERE — not style preferences:
//   - Every vault is created by newUnlockedVault inside t.TempDir(); no test
//     touches the real vault at ~/Library/Application Support/bloxsmith.
//   - HOME is sandboxed (see newUnlockedVault) because ResolveFile's fallback
//     probes <UserConfigDir>/bloxsmith and writable() MKDIRS AND WRITES there.
//   - No .vault-pass file is ever created and VAULT_PASSPHRASE_FILE is never
//     set or referenced: that env var wins over the macOS keychain, and that
//     precedence was a real shipped bug. The passphrase lives in the keychain
//     only; nothing here reads or writes the keychain.
//   - AddTenant is never called with a blank label (it would make a live HTTPS
//     request to csp.infoblox.com), and UpdateTenant is only ever given a new
//     key together with an explicit label, for the same reason.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newUnlockedVault builds an unlocked, freshly initialised vault on a throwaway
// path in t.TempDir(), optionally pre-loaded with the given tenants. Declared
// here (lane C1) and REUSED by the other vault test files — do not re-declare.
//
// Tenants are installed directly rather than through AddTenant on purpose:
// AddTenant mints a RANDOM id (tokenHex(6)), so a test could never name the
// identity it wants to grant, and with a blank label it calls
// portalLabelForKeyUnlocked — a live HTTPS call to csp.infoblox.com. Direct
// assignment is legal because these tests are in package vault, and it touches
// no network at all. The first tenant becomes active, mirroring AddTenant.
func newUnlockedVault(t *testing.T, tenants ...Tenant) *Vault {
	t.Helper()
	// HOME sandbox. Nothing in this file calls ResolveFile, but its fallback
	// branch mkdirs and writes a probe file into <UserConfigDir>/bloxsmith, which
	// on a developer Mac IS the real vault directory. Sandboxing unconditionally
	// means no test in this package can reach it by accident later.
	t.Setenv("HOME", t.TempDir())

	v := New(filepath.Join(t.TempDir(), "vault.json"))
	// A throwaway passphrase for a vault that exists only for this test. It is
	// never stored anywhere: not the keychain, not a file, not an env var.
	if err := v.Init("writelock-test-pass"); err != nil {
		t.Fatalf("init throwaway vault: %v", err)
	}
	if len(tenants) > 0 {
		v.tenants = append([]Tenant(nil), tenants...)
		first := tenants[0].ID
		v.active = &first
		if err := v.Save(); err != nil {
			t.Fatalf("save throwaway vault: %v", err)
		}
	}
	return v
}

// wlGrant marks id writable and fails the test unless the vault says it changed
// — a grant that silently did nothing would make every later assertion vacuous.
func wlGrant(t *testing.T, v *Vault, ids ...string) {
	t.Helper()
	for _, id := range ids {
		res := v.SetWritable(id, true)
		if okv, _ := res["ok"].(bool); !okv {
			t.Fatalf("SetWritable(%q, true) failed: %v", id, res)
		}
		if changed, _ := res["changed"].(bool); !changed {
			t.Fatalf("SetWritable(%q, true) reported no change; the grant did not take: %v", id, res)
		}
		if !v.WriteAllowed(id) {
			t.Fatalf("after granting %q the vault still refuses it — fixture is broken", id)
		}
	}
}

// wlList renders WriteAllowedList as a stable string for comparison.
func wlList(v *Vault) string { return strings.Join(v.WriteAllowedList(), ",") }

// --- WriteID ---------------------------------------------------------------

// TestWriteID_Normalizes pins the two-halves identity construction. The blank
// fills are the security-relevant part: if WriteID("","") did not become
// "env/-", an env-key run would ask about an identity ("/") that nobody could
// ever have granted — or worse, one that a stray grant could accidentally match.
func TestWriteID_Normalizes(t *testing.T) {
	cases := []struct{ tenant, account, want string }{
		{"", "", "env/-"},
		{"   ", "  ", "env/-"},
		{"t1", "", "t1/-"},
		{"", "acct9", "env/acct9"},
		{"  t1  ", "  acct9  ", "t1/acct9"},
		{"t1", "acct9", "t1/acct9"},
	}
	for _, c := range cases {
		if got := WriteID(c.tenant, c.account); got != c.want {
			t.Errorf("WriteID(%q, %q) = %q, want %q", c.tenant, c.account, got, c.want)
		}
	}
}

// --- WriteAllowed ----------------------------------------------------------

// TestWriteAllowed_DefaultDeny is the property the whole control rests on: a
// vault nobody has opted anything into refuses everything, including a tenant
// that was added a moment ago and including the env-key identity. This is the
// test that a fail-open `return true` in WriteAllowed reddens first.
func TestWriteAllowed_DefaultDeny(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})

	for _, id := range []string{
		"t1/-",             // the freshly added tenant, no switch
		"t1/acct9",         // the same tenant under a portal switch
		WriteID("", ""),    // env-key mode
		WriteID("t1", ""),  // built through the public constructor
		"unknown-tenant/-", // a tenant that does not exist at all
		"env/-",            // the literal env identity
	} {
		if v.WriteAllowed(id) {
			t.Errorf("fresh vault reports %q writable; the default must be READ-ONLY", id)
		}
	}
	if got := wlList(v); got != "" {
		t.Errorf("fresh vault WriteAllowedList = %q, want empty", got)
	}
}

// TestWriteAllowed_EmptyIdDenied pins the strongest refusal reason: the caller
// could not say where the write would land. A blank or whitespace-only id must
// never be writable, and — the trap — must never be satisfied by a substring or
// "contains" style comparison against an existing grant.
func TestWriteAllowed_EmptyIdDenied(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	wlGrant(t, v, "t1/-")

	for _, id := range []string{"", " ", "\t", "   \n  "} {
		if v.WriteAllowed(id) {
			t.Errorf("WriteAllowed(%q) = true; an unidentifiable write target must be refused", id)
		}
	}

	// Against a WELL-FORMED grant list the loop alone would already return false
	// for a blank id, so the guard at the top of WriteAllowed is unobservable —
	// removing it changes nothing and this test would stay green. The guard only
	// earns its keep against a MALFORMED payload. write_allowed is plain JSON
	// inside the encrypted blob: an older writer, a hand-edited vault, or a
	// partially-written list can hold a blank entry, and SetWritable (which
	// refuses blank ids) is not the only way entries get in — Unlock loads them
	// straight off disk. So the vault below is written with a blank entry and
	// reopened, which is the only shape in which "empty id is not writable" is a
	// decision rather than an accident.
	v.writeAllowed = []string{"", "   ", "t1/-"}
	if err := v.Save(); err != nil {
		t.Fatalf("save malformed-payload fixture: %v", err)
	}
	path := v.Path()
	v.Lock()
	reopened := New(path)
	if err := reopened.Unlock("writelock-test-pass"); err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := len(reopened.writeAllowed); got != 3 {
		t.Fatalf("fixture did not survive the reopen (%d entries); the rest proves nothing", got)
	}
	for _, id := range []string{"", "   ", "\t"} {
		if reopened.WriteAllowed(id) {
			t.Errorf("a blank entry in a malformed payload made %q writable", id)
		}
	}
	if !reopened.WriteAllowed("t1/-") {
		t.Error("the real grant alongside the blank entries stopped working")
	}
}

// TestWriteAllowed_ExactPairOnly is the identity test. The permission is the
// PAIR "<vault tenant>/<csp account>" and it is only ever compared, never
// parsed. Loosening that comparison to a prefix, suffix, substring or
// "same tenant half" match is how "Delta is writable" would carry over into a
// different CSP account the moment someone used the portal account switcher —
// which is the exact hole writelock.go's header says the pair exists to close.
//
// Every string below differs from the single grant "t1/-", so ANY loosening of
// the equality check turns at least one of them true.
func TestWriteAllowed_ExactPairOnly(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	wlGrant(t, v, "t1/-")

	if !v.WriteAllowed("t1/-") {
		t.Fatal("the exact granted pair must be writable — fixture is broken")
	}

	deny := []struct{ id, why string }{
		{"t1/acct9", "a portal account switch is in force; the grant was for the key's home account"},
		{"t1", "the tenant half alone is not an identity"},
		{"t1/", "a trailing-slash prefix of the grant"},
		{"t1/-x", "the grant is a prefix of this id"},
		{"xt1/-", "the grant is a suffix of this id"},
		{"1/-", "a suffix of the grant"},
		{"/-", "the account half alone"},
		{"-", "a substring of the grant"},
		{"T1/-", "case must not be folded — ids are opaque"},
		{" t1/- ", "an untrimmed id is a different string; only blankness is trimmed"},
		{"t10/-", "a longer tenant id sharing the granted id as a prefix"},
	}
	for _, c := range deny {
		if v.WriteAllowed(c.id) {
			t.Errorf("grant %q authorised %q (%s) — the identity must be the exact pair", "t1/-", c.id, c.why)
		}
	}
}

// TestWriteAllowed_GrantForOneTenantDoesNotAuthoriseAnother is the plain
// statement of the same rule between two real stored tenants: opting Delta in
// must not opt Echo in. A teardown aimed at the wrong tenant is precisely the
// failure this control was built for.
func TestWriteAllowed_GrantForOneTenantDoesNotAuthoriseAnother(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	wlGrant(t, v, "t1/-")

	if !v.WriteAllowed("t1/-") {
		t.Fatal("Delta should be writable — fixture is broken")
	}
	if v.WriteAllowed("t2/-") {
		t.Error("granting Delta made Echo writable; permission is per tenant, with no global override")
	}
	// And the reverse direction, so the test cannot pass by accident of ordering.
	wlGrant(t, v, "t2/acct9")
	if v.WriteAllowed("t2/-") {
		t.Error("granting Echo under a switched account also authorised its home account")
	}
}

// TestWriteGrantDoesNotSurviveLock: a locked vault holds no decrypted state, so
// it must not be able to answer "yes" to anything. Lock() clears writeAllowed
// along with the keys and tenants; if it did not, a locked vault would keep
// authorising writes from stale memory.
func TestWriteGrantDoesNotSurviveLock(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	wlGrant(t, v, "t1/-", "t1/acct9")

	v.Lock()

	if v.WriteAllowed("t1/-") || v.WriteAllowed("t1/acct9") {
		t.Error("a locked vault still reports a tenant writable; nothing is writable when nothing is unlocked")
	}
	if got := wlList(v); got != "" {
		t.Errorf("locked vault WriteAllowedList = %q, want empty", got)
	}
}

// --- SetWritable -----------------------------------------------------------

// TestSetWritable_PersistsAcrossReopen proves the grant is written into the
// encrypted payload, not just held in memory: a vault that "remembered" a grant
// only until the next lock would silently revoke it, and — the direction that
// matters more — a grant that was never persisted could not be revoked from
// disk either. The reopen uses a brand-new Vault instance so nothing in memory
// can carry the answer.
func TestSetWritable_PersistsAcrossReopen(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	wlGrant(t, v, "t1/acct9")
	path := v.Path()
	v.Lock()

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("vault file missing after a grant: %v", err)
	}

	reopened := New(path)
	if err := reopened.Unlock("writelock-test-pass"); err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if !reopened.WriteAllowed("t1/acct9") {
		t.Error("the grant did not survive a lock/reopen cycle — it was never persisted")
	}
	if reopened.WriteAllowed("t1/-") {
		t.Error("reopening the vault widened the grant to a different identity")
	}
}

// TestSetWritable_OffRevokes covers the revocation direction, including that it
// removes exactly one identity and leaves the others alone, and that the
// revocation is persisted (a revocation that only lived in memory would come
// back on the next unlock — a grant returning from the dead).
func TestSetWritable_OffRevokes(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	wlGrant(t, v, "t1/-", "t1/acct9")

	res := v.SetWritable("t1/-", false)
	if okv, _ := res["ok"].(bool); !okv {
		t.Fatalf("revoke failed: %v", res)
	}
	if changed, _ := res["changed"].(bool); !changed {
		t.Fatalf("revoke reported no change: %v", res)
	}
	if v.WriteAllowed("t1/-") {
		t.Error("revoked identity is still writable")
	}
	if !v.WriteAllowed("t1/acct9") {
		t.Error("revoking one identity also dropped an unrelated grant")
	}

	path := v.Path()
	v.Lock()
	reopened := New(path)
	if err := reopened.Unlock("writelock-test-pass"); err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if reopened.WriteAllowed("t1/-") {
		t.Error("the revocation was not persisted; the grant came back on reopen")
	}
}

// TestSetWritable_BlankIdRefused: an id nobody can name is not an identity.
func TestSetWritable_BlankIdRefused(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	for _, id := range []string{"", "   ", "\t\n"} {
		for _, on := range []bool{true, false} {
			res := v.SetWritable(id, on)
			if okv, _ := res["ok"].(bool); okv {
				t.Errorf("SetWritable(%q, %v) succeeded: %v", id, on, res)
			}
			if msg, _ := res["error"].(string); msg != "tenant id required" {
				t.Errorf("SetWritable(%q, %v) error = %q, want %q", id, on, msg, "tenant id required")
			}
		}
	}
	if got := wlList(v); got != "" {
		t.Errorf("a refused blank id still altered the grant list: %q", got)
	}
}

// TestSetWritable_LockedRefusedBothWays PINS OBSERVED BEHAVIOUR ONLY.
//
// FINDING C-F1 (reported, deliberately not fixed here): SetWritable's own
// comment says "Turning it OFF is deliberately allowed while the vault is
// locked ... revoking write permission must always be possible and must always
// succeed", but the code refuses BOTH directions when locked (the
// `if !v.unlocked { return fail("locked") }` guard runs before the on/off split).
// The doc and the code disagree, and which one is correct is a product decision,
// not a coverage task. This test asserts what the code does today so that
// whichever way the contradiction is resolved, the change is deliberate and
// visible in a diff. It takes no position on which reading is right.
func TestSetWritable_LockedRefusedBothWays(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	wlGrant(t, v, "t1/-")
	v.Lock()

	for _, on := range []bool{true, false} {
		res := v.SetWritable("t1/-", on)
		if okv, _ := res["ok"].(bool); okv {
			t.Errorf("SetWritable(on=%v) succeeded on a locked vault: %v", on, res)
		}
		if msg, _ := res["error"].(string); msg != "locked" {
			t.Errorf("SetWritable(on=%v) error = %q, want %q", on, msg, "locked")
		}
	}
	// Whatever the refusal means, it must not have made anything writable.
	if v.WriteAllowed("t1/-") {
		t.Error("a refused SetWritable on a locked vault left the identity writable")
	}
}

// TestSetWritable_NoOpReportsUnchanged covers the "already in that state" arm:
// re-granting an existing grant and revoking an identity that was never granted
// both succeed and report changed:false, without rewriting the vault file.
func TestSetWritable_NoOpReportsUnchanged(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	wlGrant(t, v, "t1/-")

	cases := []struct {
		id string
		on bool
	}{
		{"t1/-", true},             // already granted
		{"t1/acct9", false},        // never granted
		{"never-existed/-", false}, // not even a stored tenant
	}
	for _, c := range cases {
		res := v.SetWritable(c.id, c.on)
		if okv, _ := res["ok"].(bool); !okv {
			t.Errorf("SetWritable(%q, %v) = %v, want ok", c.id, c.on, res)
		}
		if changed, _ := res["changed"].(bool); changed {
			t.Errorf("SetWritable(%q, %v) reported changed:true for a no-op: %v", c.id, c.on, res)
		}
	}
	if got := wlList(v); got != "t1/-" {
		t.Errorf("no-op calls altered the grant list: %q", got)
	}
}

// TestSetWritable_SaveFailureRollsBackTheGrant: a grant that could not be
// persisted must not be live in memory either. Otherwise this process would
// keep authorising writes to a tenant that the vault on disk — and every future
// process — says nothing about.
//
// The failure is forced by pointing v.path at a file inside a directory that
// was never created, so os.WriteFile of the temp file fails deterministically.
// A chmod-based fixture was rejected: it behaves differently when the tests run
// as root, and a rollback test whose save actually SUCCEEDED is decoration —
// hence the explicit "the save really did fail" assertion first.
func TestSetWritable_SaveFailureRollsBackTheGrant(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	wlGrant(t, v, "t1/-")

	v.path = filepath.Join(filepath.Dir(v.path), "never-created", "vault.json")
	if err := v.Save(); err == nil {
		t.Fatal("the save-failure fixture did not fail; the rest of this test would prove nothing")
	}

	res := v.SetWritable("t1/acct9", true)
	if okv, _ := res["ok"].(bool); okv {
		t.Fatalf("SetWritable reported success despite an unwritable vault: %v", res)
	}
	if v.WriteAllowed("t1/acct9") {
		t.Error("a grant that could not be persisted is still live in memory")
	}
	if !v.WriteAllowed("t1/-") {
		t.Error("the failed grant rolled back too far and dropped a pre-existing grant")
	}
}

// --- WriteAllowedList ------------------------------------------------------

// TestWriteAllowedList_SortedCopy: the list feeds the settings UI and the audit
// detail on a refusal, so it must be sorted (stable rendering) and a COPY —
// handing out the live slice would let a caller silently widen or empty the
// permission set without going through SetWritable, i.e. without persisting.
func TestWriteAllowedList_SortedCopy(t *testing.T) {
	v := newUnlockedVault(t, Tenant{ID: "t1", Label: "Delta", Key: "Token k1"})
	wlGrant(t, v, "t2/-", "t1/acct9", "t1/-")

	got := v.WriteAllowedList()
	want := []string{"t1/-", "t1/acct9", "t2/-"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("WriteAllowedList = %v, want %v", got, want)
	}

	got[0] = "hijacked/-"
	if v.WriteAllowed("hijacked/-") {
		t.Error("mutating the returned slice changed what the vault authorises; the list must be a copy")
	}
	if !v.WriteAllowed("t1/-") {
		t.Error("mutating the returned slice dropped a real grant; the list must be a copy")
	}
}

// --- forgetTenantWrites, through its two public callers ---------------------

// TestRemoveTenantRevokesItsGrants: a permission must not outlive the tenant it
// was granted for. Tenant ids are random hex so a collision is not the worry —
// the worry is a stale grant sitting in the vault ready to apply to whatever
// later occupies that id, and a settings UI listing a permission for a tenant
// that no longer exists.
//
// The "t10" tenant is deliberate: forgetTenantWrites matches on the prefix
// "<tid>/", so removing "t1" must not take "t10/-" with it.
func TestRemoveTenantRevokesItsGrants(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
		Tenant{ID: "t10", Label: "Foxtrot", Key: "Token k10"},
	)
	wlGrant(t, v, "t1/-", "t1/acct9", "t2/-", "t10/-")

	res := v.RemoveTenant("t1")
	if okv, _ := res["ok"].(bool); !okv {
		t.Fatalf("RemoveTenant: %v", res)
	}

	if v.WriteAllowed("t1/-") || v.WriteAllowed("t1/acct9") {
		t.Error("a write permission outlived the tenant it was granted for")
	}
	if !v.WriteAllowed("t2/-") {
		t.Error("removing one tenant revoked an unrelated tenant's grant")
	}
	if !v.WriteAllowed("t10/-") {
		t.Error("removing t1 also revoked t10 — the tenant half was matched as a bare prefix")
	}
	if got := wlList(v); got != "t10/-,t2/-" {
		t.Errorf("grant list after removal = %q, want %q", got, "t10/-,t2/-")
	}
}

// TestNewKeyRevokesGrant_RenameKeeps: replacing a tenant's API key may point it
// at a completely different CSP account, so "Delta is writable" has to be
// granted again deliberately. A rename changes nothing about where a write
// lands, so it must keep the grant — otherwise operators would learn that
// re-granting after any edit is routine, which is how a control stops being
// read at all.
//
// Both UpdateTenant calls pass an explicit label: a new key with a blank label
// makes UpdateTenant resolve the name over live HTTPS against csp.infoblox.com.
func TestNewKeyRevokesGrant_RenameKeeps(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	wlGrant(t, v, "t1/-", "t1/acct9", "t2/-")

	// Rename only (blank key) — the grant must survive.
	if res := v.UpdateTenant("t2", "", strp("Echo Renamed")); !res["ok"].(bool) {
		t.Fatalf("rename-only UpdateTenant: %v", res)
	}
	if !v.WriteAllowed("t2/-") {
		t.Error("a rename revoked the grant; renaming does not change where a write lands")
	}
	if v.tenants[1].Key != "Token k2" {
		t.Errorf("rename clobbered the key: %q", v.tenants[1].Key)
	}

	// Key replacement — every grant for that tenant must be gone.
	if res := v.UpdateTenant("t1", "Token k1-replaced", strp("Delta")); !res["ok"].(bool) {
		t.Fatalf("key-swap UpdateTenant: %v", res)
	}
	if v.WriteAllowed("t1/-") || v.WriteAllowed("t1/acct9") {
		t.Error("a grant survived a key swap; the key may now belong to a different account entirely")
	}
	if !v.WriteAllowed("t2/-") {
		t.Error("swapping t1's key revoked t2's grant")
	}
	if v.tenants[0].Key != "Token k1-replaced" {
		t.Errorf("key was not replaced: %q", v.tenants[0].Key)
	}
}

// --- ActiveTenantID / LabelForTenantID -------------------------------------

// TestActiveTenantID_NoneThenActiveThenLocked pins all three answers. "" is a
// real answer (env-key mode), not a failure — the caller turns it into the
// "env" half of a WriteID rather than treating it as an error.
func TestActiveTenantID_NoneThenActiveThenLocked(t *testing.T) {
	empty := newUnlockedVault(t)
	if got := empty.ActiveTenantID(); got != "" {
		t.Errorf("vault with no tenants: ActiveTenantID = %q, want \"\"", got)
	}
	// "" is env-key mode, so the identity built from it is the env identity.
	if got := WriteID(empty.ActiveTenantID(), ""); got != "env/-" {
		t.Errorf("WriteID from an inactive vault = %q, want env/-", got)
	}

	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	if got := v.ActiveTenantID(); got != "t1" {
		t.Errorf("ActiveTenantID = %q, want t1", got)
	}
	if res := v.SetActive("t2"); !res["ok"].(bool) {
		t.Fatalf("SetActive: %v", res)
	}
	if got := v.ActiveTenantID(); got != "t2" {
		t.Errorf("after SetActive: ActiveTenantID = %q, want t2", got)
	}

	v.Lock()
	if got := v.ActiveTenantID(); got != "" {
		t.Errorf("locked vault: ActiveTenantID = %q, want \"\"", got)
	}
}

// TestLabelForTenantID_KnownUnknownLocked pins the label lookup used to NAME
// the tenant in a refusal message. "" for an unknown id is the whole contract:
// the refusal still refuses, it just cannot name the tenant. Nothing about the
// permission decision depends on this.
func TestLabelForTenantID_KnownUnknownLocked(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "Delta", Key: "Token k1"},
		Tenant{ID: "t2", Label: "Echo", Key: "Token k2"},
	)
	if got := v.LabelForTenantID("t1"); got != "Delta" {
		t.Errorf("LabelForTenantID(t1) = %q, want Delta", got)
	}
	if got := v.LabelForTenantID("t2"); got != "Echo" {
		t.Errorf("LabelForTenantID(t2) = %q, want Echo", got)
	}
	for _, id := range []string{"t3", "", "t1/-", "T1"} {
		if got := v.LabelForTenantID(id); got != "" {
			t.Errorf("LabelForTenantID(%q) = %q, want \"\" for an unknown id", id, got)
		}
	}

	v.Lock()
	if got := v.LabelForTenantID("t1"); got != "" {
		t.Errorf("locked vault: LabelForTenantID(t1) = %q, want \"\"", got)
	}
}
