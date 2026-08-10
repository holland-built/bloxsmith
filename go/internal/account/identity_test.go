package account

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

// cspStub is a fake CSP that records the Authorization header of every request
// and answers /v2/current_user/accounts + /v2/current_user. reject, when set,
// makes it 401 everything instead — a genuine rejection of a real key.
type cspStub struct {
	mu     sync.Mutex
	seen   []string
	reject bool
}

func (s *cspStub) start(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.seen = append(s.seen, r.Header.Get("Authorization"))
		reject := s.reject
		s.mu.Unlock()
		if reject {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/v2/current_user/accounts":
			w.Write([]byte(`{"results":[{"id":"acct-1","name":"Alpha","state":"active"},{"id":"acct-2","name":"Bravo","state":"active"}]}`))
		case "/v2/current_user":
			w.Write([]byte(`{"result":{"account_id":"acct-1"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func (s *cspStub) headers() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.seen...)
}

// TestVaultModeIdentityUsesActiveKey is the bug this change fixes. In vault mode
// there is no env INFOBLOX_API_KEY, so the Manager used to sign every CSP
// identity call with an empty Authorization header and the portal answered 401 —
// "account switching unavailable" on a dashboard whose every other feed worked,
// because those resolve through rest.Auth instead.
func TestVaultModeIdentityUsesActiveKey(t *testing.T) {
	stub := &cspStub{}
	url := stub.start(t)

	// Vault mode: fallback is "" by definition (config.Load sets VaultMode when
	// APIKey == ""), and the active key comes from the unlocked vault.
	auth := rest.NewAuth("", func() string { return "VAULTKEY" })
	m := New(url, auth, cache.New())

	res, err := m.ListAccounts()
	if err != nil {
		t.Fatalf("vault mode still fails: %v", err)
	}
	accounts, _ := res["accounts"].([]any)
	if len(accounts) != 2 {
		t.Fatalf("want 2 accounts, got %d (%v)", len(accounts), res["accounts"])
	}
	if res["active"] != "acct-1" {
		t.Fatalf("active = %v, want acct-1 (the verified home)", res["active"])
	}
	for _, h := range stub.headers() {
		if h != "VAULTKEY" {
			t.Fatalf("identity call sent %q, want VAULTKEY", h)
		}
	}
	if len(stub.headers()) == 0 {
		t.Fatal("no upstream call was made")
	}
}

// TestEnvModeStillSendsEnvKey guards the byte-identical claim: main.go builds the
// Auth with cfg.APIKey as the fallback, so env-key mode must send exactly what
// the old m.apiKey field sent, including when a vault active key also exists.
func TestEnvModeStillSendsEnvKey(t *testing.T) {
	stub := &cspStub{}
	url := stub.start(t)

	auth := rest.NewAuth("ENVKEY", func() string { return "VAULTKEY" })
	m := New(url, auth, cache.New())

	if _, err := m.ListAccounts(); err != nil {
		t.Fatalf("env mode: %v", err)
	}
	for _, h := range stub.headers() {
		if h != "ENVKEY" {
			t.Fatalf("env mode sent %q, want ENVKEY — behaviour changed", h)
		}
	}
}

// TestIdentityCallsIgnoreSwitchOverride is the regression guard that stops a
// future edit from "simplifying" cspJSON back to auth.Value(). This package's
// doc comment requires identity calls to use the original long-lived key so an
// expired switched-account JWT cannot lock the user out of switching back; a
// switched-in Bearer JWT must therefore never appear on these requests.
func TestIdentityCallsIgnoreSwitchOverride(t *testing.T) {
	stub := &cspStub{}
	url := stub.start(t)

	auth := rest.NewAuth("", func() string { return "VAULTKEY" })
	m := New(url, auth, cache.New())

	// A portal account switch is in force: every REST proxy call must use the
	// JWT, and every identity call must not.
	auth.SetOverride("Bearer SWITCHED-JWT")
	if got := auth.Value(); got != "Bearer SWITCHED-JWT" {
		t.Fatalf("precondition: proxy calls must follow the switch, got %q", got)
	}

	if _, err := m.ListAccounts(); err != nil {
		t.Fatalf("list under an active switch: %v", err)
	}
	for _, h := range stub.headers() {
		if h != "VAULTKEY" {
			t.Fatalf("identity call sent %q — the switched-account JWT leaked into an identity call", h)
		}
	}
}

// TestGenuine401StillSurfaces keeps the fix honest: a real key that genuinely
// lacks multi-account scope still yields HTTPError{401}, so the UI keeps telling
// the truth instead of assuming the empty-header bug was the only cause.
func TestGenuine401StillSurfaces(t *testing.T) {
	stub := &cspStub{reject: true}
	url := stub.start(t)

	auth := rest.NewAuth("", func() string { return "REAL-BUT-UNSCOPED-KEY" })
	m := New(url, auth, cache.New())

	_, err := m.ListAccounts()
	if err == nil {
		t.Fatal("a 401 must still be an error")
	}
	he, ok := err.(*HTTPError)
	if !ok {
		t.Fatalf("want *HTTPError, got %T (%v)", err, err)
	}
	if he.Code != 401 {
		t.Fatalf("want 401, got %d", he.Code)
	}
	// The key was non-empty, so this 401 is the portal's real answer, not the
	// empty-header bug.
	for _, h := range stub.headers() {
		if h == "" {
			t.Fatal("sent an empty Authorization header — the original bug")
		}
	}
}
