package account

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

// wireLive is like switch_test.go's wire() but points the Manager at a real
// httptest server instead of a fake vault, so cspJSON's HTTP round trip is
// exercised end to end.
func wireLive(t *testing.T, baseURL string) (*rest.Auth, *Manager) {
	t.Helper()
	c := cache.New()
	auth := rest.NewAuth("ENVKEY", func() string { return "" })
	m := New(baseURL, auth, c)
	return auth, m
}

// TestUndecodableCurrentUserSurfacesErrorAndDoesNotMemoizeHome is the CRITICAL
// regression: /v2/current_user answers 200 with a body that isn't valid JSON
// (a decode failure on a 2xx) while /v2/current_user/accounts is healthy. Home
// resolution must not silently succeed with an empty/garbage value and lock it
// in for the process lifetime — the next call must retry, and a switch back to
// the (wrongly) guessed home must refuse rather than reporting ok:true for a
// switch that never happened.
func TestUndecodableCurrentUserSurfacesErrorAndDoesNotMemoizeHome(t *testing.T) {
	var currentUserCalls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/current_user/accounts":
			w.Write([]byte(`{"results":[{"id":"acct-b","name":"Bravo","state":"active"},{"id":"acct-a","name":"Alpha","state":"active"}]}`))
		case "/v2/current_user":
			currentUserCalls++
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`not json {{{`)) // 2xx with an undecodable body
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	_, m := wireLive(t, srv.URL)

	lst, err := m.ListAccounts()
	if err != nil {
		t.Fatalf("ListAccounts should tolerate a bad /v2/current_user and still list accounts: %v", err)
	}
	if m.homeVerified {
		t.Fatal("home must NOT be marked verified when /v2/current_user failed to decode")
	}
	// The alphabetically-first account ("Alpha"/acct-a) is only a display guess.
	if m.home != "acct-a" {
		t.Fatalf("expected the display-guess fallback acct-a, got %q", m.home)
	}
	active, _ := lst["active"].(string)
	if active != "acct-a" {
		t.Fatalf("active guess mismatch: %q", active)
	}

	// A subsequent call must retry the identity check, not skip it because home
	// is already "set" from the failed attempt.
	if _, err := m.ListAccounts(); err != nil {
		t.Fatalf("second ListAccounts: %v", err)
	}
	if currentUserCalls < 2 {
		t.Fatalf("home resolution was memoized from a failed read instead of retried: /v2/current_user called %d times", currentUserCalls)
	}

	// Switching to the guessed "home" (acct-a) must NOT silently clear the
	// override and report ok:true — home was never actually verified.
	res, err := m.SwitchAccount("acct-a")
	if err != nil {
		t.Fatalf("SwitchAccount returned a hard error: %v", err)
	}
	if ok, _ := res["ok"].(bool); ok {
		t.Fatalf("switch to an unverified home must not report ok:true, got %v", res)
	}
}

// TestBothEndpointsHealthySwitchWorks pins the unchanged-behavior case: when
// both /v2/current_user and /v2/current_user/accounts succeed, home resolves
// once, is verified, and switching to it (and back) works exactly as before.
func TestBothEndpointsHealthySwitchWorks(t *testing.T) {
	var currentUserCalls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/current_user/accounts":
			w.Write([]byte(`{"results":[{"id":"acct-home","name":"Home","state":"active"},{"id":"acct-other","name":"Other","state":"active"}]}`))
		case "/v2/current_user":
			currentUserCalls++
			w.Write([]byte(`{"result":{"account_id":"acct-home"}}`))
		case "/v2/session/account_switch":
			w.Write([]byte(`{"jwt":"signed.jwt.token"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	auth, m := wireLive(t, srv.URL)

	if _, err := m.ListAccounts(); err != nil {
		t.Fatalf("ListAccounts: %v", err)
	}
	if !m.homeVerified {
		t.Fatal("home should be verified when /v2/current_user succeeds")
	}
	if m.home != "acct-home" {
		t.Fatalf("home = %q, want acct-home", m.home)
	}

	// Switch to the other account: mints a JWT and installs the override.
	res, err := m.SwitchAccount("acct-other")
	if err != nil {
		t.Fatalf("switch to other: %v", err)
	}
	if ok, _ := res["ok"].(bool); !ok {
		t.Fatalf("switch to other should succeed: %v", res)
	}
	if got := auth.Value(); got != "Bearer signed.jwt.token" {
		t.Fatalf("auth override not installed: %q", got)
	}

	// Switch back home: clears the override, ok:true.
	res, err = m.SwitchAccount("acct-home")
	if err != nil {
		t.Fatalf("switch home: %v", err)
	}
	if ok, _ := res["ok"].(bool); !ok {
		t.Fatalf("switch home should succeed: %v", res)
	}
	if got := auth.Value(); got != "ENVKEY" {
		t.Fatalf("override not cleared on home switch: %q", got)
	}
	if currentUserCalls == 0 {
		t.Fatal("expected /v2/current_user to have been called at least once")
	}
}
