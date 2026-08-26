package account

// A PORTAL ACCOUNT SWITCH RACING A VAULT TENANT SWITCH.
//
// Found while fixing the 2026-08-26 tenant-switch deadlock (see
// vault/deadlock_test.go) and deliberately shipped separately, because it is a
// different fault with a different failure mode: not a hang, a CREDENTIAL THAT
// OUTLIVES ITS TENANT.
//
// SwitchAccount holds m.mu across its whole body, and the last thing it does is
// m.auth.SetOverride("Bearer "+jwt). The vault's coordinated reset used to clear
// that override from OUTSIDE m.mu, which means the two could interleave exactly
// once, in exactly one order, with a permanent consequence:
//
//	SwitchAccount            authReset
//	-------------            ---------
//	take m.mu
//	POST account_switch
//	                         SetOverride("")     <- clears nothing yet
//	SetOverride("Bearer X")  <- lands AFTER the clear
//	release m.mu
//	                         ResetActive()       <- cleared home/active, not the JWT
//
// The override wins over the vault's active key in Auth.Value by design, so
// every subsequent proxy call goes out with a JWT minted for an account
// belonging to the tenant the operator just switched AWAY from. Nothing clears
// it afterwards: ResetActive had already run, and the next thing to touch the
// override is the next account switch. The dashboard reads as the new tenant
// and the API calls are the old one.
//
// THE FIX is that ResetActive clears the override itself, under m.mu, which
// makes the two mutually exclusive. There is no interleaving left to test for —
// only a before and an after, and both are correct.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/vault"
)

// A CSP stand-in whose account_switch response is held open until the test says
// otherwise. Holding the HTTP response is what holds m.mu, which is the whole
// mechanism: this reproduces the window without any sleep or scheduling luck.
// The handler also selects on the request context so it cannot block forever.
// Without that, any t.Fatal on a path BEFORE close(release) leaves the
// account_switch handler parked, and the deferred srv.Close() waits on it — a
// failing test becomes a hung package, which on CI reads as an infrastructure
// problem rather than as this test failing. Codex's finding 3.
func gatedCSP(t *testing.T, inSwitch chan<- struct{}, release <-chan struct{}) *httptest.Server {
	t.Helper()
	// Guarded: httptest serves concurrently, so a plain bool here is a data race
	// that -race would report against the test rather than the code.
	var once sync.Once
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/current_user/accounts":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"results": []map[string]any{
					{"id": "home-acct", "name": "Home"},
					{"id": "other-acct", "name": "Other"},
				},
			})
		case "/v2/current_user":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"result": map[string]any{"account_id": "home-acct"},
			})
		case "/v2/session/account_switch":
			// Signal that m.mu is held, then stall inside the request so the
			// reset below has to contend with a switch that is genuinely
			// mid-flight rather than one that has already finished.
			first := false
			once.Do(func() { first = true })
			if first {
				close(inSwitch)
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"jwt": "STALE-TENANT-JWT"})
		default:
			http.NotFound(w, r)
		}
	}))
}

func TestVaultResetClearsAnOverrideSetByAnInFlightAccountSwitch(t *testing.T) {
	inSwitch := make(chan struct{})
	release := make(chan struct{})
	srv := gatedCSP(t, inSwitch, release)
	defer srv.Close()

	// Wired here rather than through wire(), because this test needs a hook
	// BETWEEN the callback's early SetOverride and its ResetActive. That gap is
	// the race, and a shared helper cannot expose it without changing what every
	// other test in this package is testing.
	c := cache.New()
	v := vault.New(filepath.Join(t.TempDir(), "vault.json"))
	if err := v.Init("passphrase-123"); err != nil {
		t.Fatalf("init vault: %v", err)
	}
	auth := rest.NewAuth("ENVKEY", v.ActiveKey)
	m := New(srv.URL, auth, c)
	if r := v.AddTenant("Tenant A", "Token aaa", nil); !r["ok"].(bool) {
		t.Fatalf("add A: %v", r)
	}
	rB := v.AddTenant("Tenant B", "Token bbb", nil)
	if !rB["ok"].(bool) {
		t.Fatalf("add B: %v", rB)
	}
	idB := rB["id"].(string)

	// Registered AFTER the tenants exist, not before: adding the FIRST tenant to
	// an empty vault makes it active, which fires this same callback and closed
	// the channel a second time. The panic that produced was the test's fault
	// and not the code's, and it is worth the two lines to say so — a reader who
	// moves this back up gets a "close of closed channel" with no explanation.
	clearedEarly := make(chan struct{})
	v.SetAuthReset(func() {
		// Exactly main.go's order, with a seam after the early clear.
		auth.SetOverride("")
		c.Rotate()
		close(clearedEarly)
		m.ResetActive()
		c.Rotate()
	})

	// A portal switch to a NON-home account, so it takes the branch that mints a
	// JWT and writes it to the override. The home branch only clears, and would
	// prove nothing.
	switchDone := make(chan error, 1)
	go func() {
		_, err := m.SwitchAccount("other-acct")
		switchDone <- err
	}()

	select {
	case <-inSwitch:
	case <-time.After(10 * time.Second):
		t.Fatal("the account switch never reached account_switch, so the race under test never happened")
	}

	// The vault switch runs now, with the account switch holding m.mu and its
	// SetOverride still ahead of it. Under the old code the reset's clear lands
	// FIRST and the switch's JWT lands after it, surviving; under the fix,
	// ResetActive cannot run until the switch has finished, and then clears it.
	resetDone := make(chan map[string]any, 1)
	go func() { resetDone <- v.SetActive(idB) }()

	// WAIT FOR THE EARLY CLEAR BEFORE RELEASING THE SWITCH. Without this the
	// test closes `release` immediately, the switch finishes first, and the
	// callback's own SetOverride("") tidies up after it — the BENIGN ordering,
	// which the pre-fix code passes in 0.18s. That is what this test did on its
	// first run, and it is the reason it is written this way now: the race needs
	// the reset's clear to land BEFORE the switch's SetOverride, not after.
	select {
	case <-clearedEarly:
	case <-time.After(10 * time.Second):
		t.Fatal("the vault reset never reached its early override clear, so the dangerous ordering never happened")
	}

	close(release)

	select {
	case err := <-switchDone:
		if err != nil {
			t.Fatalf("SwitchAccount: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("SwitchAccount never returned")
	}
	select {
	case r := <-resetDone:
		if r["ok"] != true {
			t.Fatalf("SetActive failed: %v", r)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("SetActive never returned")
	}

	// THE ASSERTION. Auth.Value returns the override first when one is set, so
	// this reads what the REST proxy would actually send.
	got := auth.Value()
	if got == "Bearer STALE-TENANT-JWT" {
		t.Fatal("the account-switch JWT survived the vault tenant switch: every proxy call now goes out " +
			"with a credential minted for an account belonging to the PREVIOUS tenant, and nothing will clear it")
	}
	if got != "Token bbb" {
		t.Fatalf("after the tenant switch the proxy would send %q, want the new tenant's key %q", got, "Token bbb")
	}
	// The rest of the account context has to be gone too — a surviving home
	// would let the next SwitchAccount take its home-branch for an account the
	// new tenant's key may not belong to.
	if m.Active() != "" {
		t.Fatalf("account active survived the tenant switch: %q", m.Active())
	}
}

// The boundary on its own, so a failure says WHICH property broke. The test
// above passes if the override is cleared for any reason; this one fails
// specifically when ResetActive stops doing the clearing itself and goes back to
// trusting a caller that cannot be mutually exclusive with SwitchAccount.
func TestResetActiveClearsTheOverrideItself(t *testing.T) {
	_, auth, m, _ := wire(t)
	auth.SetOverride("Bearer SOMETHING")

	// ResetActive alone, NOT through the vault's coordinated callback — the
	// callback also clears the override, so going through it would pass with
	// this function doing nothing at all.
	m.ResetActive()

	if auth.Value() == "Bearer SOMETHING" {
		t.Fatal("ResetActive left the auth override in place. Only a clear taken under m.mu is mutually " +
			"exclusive with SwitchAccount's own SetOverride; a caller doing it outside the lock can be " +
			"undone by an in-flight switch")
	}
}

// THE EPOCH FENCE, which is the property the two tests above cannot see.
//
// Both of them pass as long as the override ends up empty, and it would end up
// empty even if the stale JWT were published first and cleared a moment later.
// What matters operationally is that it is never PUBLISHED at all: between a
// publish and a clear, withPinnedTenant can bind that credential to an inbound
// request, which then runs to completion against the tenant the operator just
// left. Clearing afterwards does not recall it.
//
// So this asserts the refusal directly, at the seam where it happens.
func TestAnAccountSwitchSpanningATenantChangeCannotPublishItsJWT(t *testing.T) {
	auth := rest.NewAuth("ENVKEY", func() string { return "tenant-key" })

	// What SwitchAccount does: read the epoch, go to the network, come back.
	epoch := auth.OverrideEpoch()

	// The tenant transition lands while that round trip is in flight.
	auth.InvalidateOverride()

	if auth.SetOverrideAt("Bearer STALE-TENANT-JWT", epoch) {
		t.Fatal("a JWT minted before the tenant changed was published after it: every proxy call would go " +
			"out against the previous tenant until something else cleared the override")
	}
	if got := auth.Value(); got != "tenant-key" {
		t.Fatalf("after the refused publish the proxy would send %q, want the new tenant's key", got)
	}

	// And the fence is not a one-way latch: a switch started AFTER the
	// transition is legitimate and must still work, or the feature is broken
	// rather than fixed.
	fresh := auth.OverrideEpoch()
	if !auth.SetOverrideAt("Bearer FRESH-JWT", fresh) {
		t.Fatal("an account switch begun after the tenant change was refused; the fence has latched shut")
	}
	if got := auth.Value(); got != "Bearer FRESH-JWT" {
		t.Fatalf("the fresh override did not take: %q", got)
	}
}
