package account

import (
	"path/filepath"
	"testing"
	"time"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/vault"
)

// wire builds the same coordinated auth reset main.go installs: an unlocked
// vault, the shared rest.Auth (active = vault.ActiveKey), the account.Manager,
// and the callback that clears the portal override + resets the account state +
// rotates the cache on a vault mutation.
func wire(t *testing.T) (*vault.Vault, *rest.Auth, *Manager, *cache.Cache) {
	t.Helper()
	c := cache.New()
	v := vault.New(filepath.Join(t.TempDir(), "vault.json"))
	if err := v.Init("passphrase-123"); err != nil {
		t.Fatalf("init vault: %v", err)
	}
	auth := rest.NewAuth("ENVKEY", v.ActiveKey)
	m := New("https://csp.example", auth, c)
	v.SetAuthReset(func() {
		auth.SetOverride("")
		m.ResetActive()
		c.Rotate()
	})
	return v, auth, m, c
}

// TestResetActive checks the account.Manager reset in isolation: active, home,
// homeVerified and the JWT timestamp are all cleared.
//
// home/homeVerified belong to the OLD tenant's key. Leaving them set (the
// original behaviour) meant the next tenant inherited the previous tenant's home
// account, so SwitchAccount could take its home-branch and report ok:true for an
// account the new key may not belong to. That was unreachable while vault mode
// 401'd on every identity call and became live the moment cspJSON started
// sending a real credential.
func TestResetActive(t *testing.T) {
	_, _, m, _ := wire(t)
	m.home = "home-acct"
	m.homeVerified = true
	m.active = "other-acct"
	m.jwtIssue = time.Now()

	m.ResetActive()

	if m.Active() != "" {
		t.Fatalf("active not cleared: %q", m.Active())
	}
	if m.home != "" {
		t.Fatalf("home not cleared — the previous tenant's home leaked: %q", m.home)
	}
	if m.homeVerified {
		t.Fatal("homeVerified not cleared: the new tenant's identity was never checked")
	}
	if !m.jwtIssue.IsZero() {
		t.Fatal("jwtIssue not cleared")
	}
}

// TestVaultSwitchClearsPortalOverrideAndAccount is the override-interaction case:
// a portal override is in effect, then a vault SetActive must WIN — Auth.Value
// returns the new active tenant key (override cleared), account.Manager active is
// reset, and the cache is rotated.
func TestVaultSwitchClearsPortalOverrideAndAccount(t *testing.T) {
	v, auth, m, c := wire(t)

	if r := v.AddTenant("Tenant A", "Token aaa", nil); !r["ok"].(bool) {
		t.Fatalf("add A: %v", r)
	}
	rB := v.AddTenant("Tenant B", "Token bbb", nil)
	if !rB["ok"].(bool) {
		t.Fatalf("add B: %v", rB)
	}
	idB := rB["id"].(string)

	// Simulate a live portal account switch: override installed + account active.
	m.home = "home-acct"
	m.active = "portal-acct"
	m.jwtIssue = time.Now()
	auth.SetOverride("Bearer PORTAL-JWT")
	if got := auth.Value(); got != "Bearer PORTAL-JWT" {
		t.Fatalf("override should win before the vault switch: %q", got)
	}
	c.Set("stale", "portal-tenant-row")

	// The vault tenant switch coordinates the reset.
	if res := v.SetActive(idB); !res["ok"].(bool) {
		t.Fatalf("set active B: %v", res)
	}
	if got := auth.Value(); got != "Token bbb" {
		t.Fatalf("Auth.Value must be the new tenant key, got %q", got)
	}
	if m.Active() != "" {
		t.Fatalf("account.Manager active not reset: %q", m.Active())
	}
	if m.home != "" || m.homeVerified {
		t.Fatalf("previous tenant's home survived the vault switch: home=%q verified=%v", m.home, m.homeVerified)
	}
	if !m.jwtIssue.IsZero() {
		t.Fatal("account JWT timestamp not reset")
	}
	if _, ok := c.Get("stale"); ok {
		t.Fatal("cache not rotated on the vault switch")
	}
}

// TestFirstTenantAddRotatesAndActivates is the first-tenant-add regression: an
// AddTenant into an empty vault becomes active, which must rotate the cache and
// point Auth.Value at the new key.
func TestFirstTenantAddRotatesAndActivates(t *testing.T) {
	v, auth, _, c := wire(t)

	gen0 := c.Gen()
	c.Set("pre", "row")

	r := v.AddTenant("First", "Token first", nil)
	if !r["ok"].(bool) {
		t.Fatalf("add first: %v", r)
	}
	if c.Gen() == gen0 {
		t.Fatal("first tenant add did not rotate the cache")
	}
	if _, ok := c.Get("pre"); ok {
		t.Fatal("cache not cleared on first tenant add")
	}
	if got := auth.Value(); got != "Token first" {
		t.Fatalf("Auth.Value not the new tenant key: %q", got)
	}
}
