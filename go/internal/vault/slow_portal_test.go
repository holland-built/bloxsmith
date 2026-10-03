package vault

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// slowPortal answers every request only after release is closed, and says when
// the first one has arrived. It stands in for the Infoblox portal on a bad day:
// the vault's name lookups can take up to 12 seconds each.
type slowPortal struct {
	arrived chan struct{}
	release chan struct{}
	once    sync.Once
}

func newSlowPortal(t *testing.T) (*slowPortal, *httptest.Server) {
	t.Helper()
	p := &slowPortal{arrived: make(chan struct{}), release: make(chan struct{})}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.once.Do(func() { close(p.arrived) })
		select {
		case <-p.release:
		case <-r.Context().Done():
		}
		_, _ = w.Write([]byte(`{"results":[]}`))
	}))
	t.Cleanup(func() { close(p.release); srv.Close() })
	return p, srv
}

func (p *slowPortal) waitForRequest(t *testing.T) {
	t.Helper()
	select {
	case <-p.arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("the vault never asked the portal for a name")
	}
}

func unlockedVault(t *testing.T, baseURL string) *Vault {
	t.Helper()
	v := New(filepath.Join(t.TempDir(), "vault.json"))
	v.BaseURL = baseURL
	if err := v.Init("correct horse battery"); err != nil {
		t.Fatal(err)
	}
	return v
}

// finishesWithin reports whether fn returns inside d. A call that does not is
// left running; the portal is released by cleanup.
func finishesWithin(d time.Duration, fn func()) bool {
	done := make(chan struct{})
	go func() { fn(); close(done) }()
	select {
	case <-done:
		return true
	case <-time.After(d):
		return false
	}
}

// Init marks the vault unlocked and holds a key before it writes anything. When
// that first write fails, Init returned an error and left the vault open: the
// caller was told "no vault was created" while the process held a live key and
// every later call behaved as if one existed.
func TestInitLeavesTheVaultLockedWhenItCannotWrite(t *testing.T) {
	v := New(filepath.Join(t.TempDir(), "missing-dir", "vault.json"))
	if err := v.Init("correct horse battery"); err == nil {
		t.Fatal("Init must fail when the vault file cannot be written")
	}
	if v.IsUnlocked() {
		t.Error("a failed Init left the vault unlocked, holding a key for a vault that was never written")
	}
}

// Adding or re-keying a connection with no name asks the portal for one. That
// ask took up to two 12-second calls while holding the vault's lock, so every
// request that needed the active key (all of them) waited behind it.
func TestAddTenantDoesNotHoldTheVaultLockOnTheNetwork(t *testing.T) {
	p, srv := newSlowPortal(t)
	v := unlockedVault(t, srv.URL)

	go v.AddTenant("", "Token k", nil)
	p.waitForRequest(t)

	if !finishesWithin(time.Second, func() { v.ActiveKey() }) {
		t.Fatal("the vault was locked for everyone while it waited for the portal to name a new connection")
	}
}

func TestUpdateTenantDoesNotHoldTheVaultLockOnTheNetwork(t *testing.T) {
	// A portal that answers at once for the add, then slowly for the re-key.
	slow := make(chan struct{})
	arrived := make(chan struct{})
	var once sync.Once
	var gate sync.Mutex
	slowOn := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gate.Lock()
		s := slowOn
		gate.Unlock()
		if s {
			once.Do(func() { close(arrived) })
			select {
			case <-slow:
			case <-r.Context().Done():
			}
		}
		_, _ = w.Write([]byte(`{"results":[]}`))
	}))
	t.Cleanup(func() { close(slow); srv.Close() })
	v := unlockedVault(t, srv.URL)

	res := v.AddTenant("one", "Token a", nil)
	tid, _ := res["id"].(string)
	if tid == "" {
		t.Fatalf("setup: AddTenant failed: %v", res)
	}
	gate.Lock()
	slowOn = true
	gate.Unlock()

	go v.UpdateTenant(tid, "Token b", nil)
	select {
	case <-arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("the vault never asked the portal for a name")
	}
	if !finishesWithin(time.Second, func() { v.ActiveKey() }) {
		t.Fatal("the vault was locked for everyone while it waited for the portal to name a re-keyed connection")
	}
}

// Unlocking refreshes names for connections still called "Tenant N". That ran
// while the tenant-switch lock was held, so switching tenants waited for every
// name lookup, 12 seconds each, after each unlock.
func TestUnlockDoesNotHoldTheSwitchLockWhileNamesRefresh(t *testing.T) {
	p, srv := newSlowPortal(t)
	v := unlockedVault(t, srv.URL)
	// Two connections: the second is the one to switch to. Both keep the
	// placeholder name, so the refresh after unlock has something to look up.
	// (The slow portal is released only at cleanup, so these adds wait on it
	// too: give them a name so they do not ask.)
	a := v.AddTenant("named-a", "Token a", nil)
	b := v.AddTenant("named-b", "Token b", nil)
	tidB, _ := b["id"].(string)
	if _, ok := a["id"].(string); !ok || tidB == "" {
		t.Fatalf("setup failed: %v %v", a, b)
	}
	v.mu.Lock()
	v.tenants[0].Label = "Tenant 1"
	v.mu.Unlock()
	if err := v.Save(); err != nil {
		t.Fatal(err)
	}
	v.Lock()

	go v.UnlockR("correct horse battery")
	p.waitForRequest(t)

	if !finishesWithin(time.Second, func() { v.SetActive(tidB) }) {
		t.Fatal("switching tenants waited for the name refresh that follows an unlock")
	}
}
