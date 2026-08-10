package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"bloxsmith/internal/account"
	cachepkg "bloxsmith/internal/cache"
	"bloxsmith/internal/config"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/rest"
)

// accountsDeps wires the minimum /api/accounts needs, in VAULT MODE: the env
// API_KEY is empty (rest.NewAuth's fallback) and the credential comes from the
// active vault tenant, exactly as main.go builds it when INFOBLOX_API_KEY is
// unset.
func accountsDeps(t *testing.T, cspURL, activeKey string) http.Handler {
	t.Helper()
	auth := rest.NewAuth("", func() string { return activeKey })
	c := cachepkg.New()
	return New(&Deps{
		Cfg:     &config.Config{Port: "8080", VaultMode: true},
		Auth:    auth,
		Guard:   &httpx.Guard{Port: "8080", MutatingPaths: httpx.DefaultMutatingPaths()},
		Cache:   c,
		Account: account.New(cspURL, auth, c),
		Static:  http.NotFoundHandler(),
	})
}

// TestAccountsRouteVaultModeReturnsAccounts is the end-to-end shape of the bug
// report: in vault mode the Settings sheet showed "CSP accounts unavailable —
// CSP rejected this key (401)" while every other feed on the same credential
// worked. The route must now return a populated list and no error field.
func TestAccountsRouteVaultModeReturnsAccounts(t *testing.T) {
	var gotAuth string
	csp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		switch r.URL.Path {
		case "/v2/current_user/accounts":
			w.Write([]byte(`{"results":[{"id":"a1","name":"Alpha","state":"active"},{"id":"a2","name":"Bravo","state":"active"}]}`))
		case "/v2/current_user":
			w.Write([]byte(`{"result":{"account_id":"a1"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer csp.Close()

	rec := httptest.NewRecorder()
	accountsDeps(t, csp.URL, "VAULTKEY").ServeHTTP(rec, httptest.NewRequest("GET", "/api/accounts", nil))

	if rec.Code != 200 {
		t.Fatalf("status %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	if body["error"] != nil {
		t.Fatalf("vault mode still reports an error: %v", body["error"])
	}
	accts, _ := body["accounts"].([]any)
	if len(accts) != 2 {
		t.Fatalf("want 2 accounts, got %d (%v)", len(accts), body["accounts"])
	}
	if gotAuth != "VAULTKEY" {
		t.Fatalf("upstream saw Authorization %q, want VAULTKEY", gotAuth)
	}
}

// TestAccountsRouteHonest401Message keeps the failure path honest AND readable:
// a real key can genuinely lack multi-account scope, and when it does the user
// gets plain words that say what still works — no status code, no "CSP".
func TestAccountsRouteHonest401Message(t *testing.T) {
	csp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer csp.Close()

	rec := httptest.NewRecorder()
	accountsDeps(t, csp.URL, "REAL-BUT-UNSCOPED").ServeHTTP(rec, httptest.NewRequest("GET", "/api/accounts", nil))

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := "This key cannot list your Infoblox accounts. Everything else works; only account switching is off."
	if body["error"] != want {
		t.Fatalf("error = %q, want %q", body["error"], want)
	}
	if body["status"] != float64(401) {
		t.Fatalf("status field = %v, want 401", body["status"])
	}
}

// TestAccountsRouteUpstream500Message covers the other-4xx/5xx branch.
func TestAccountsRouteUpstream500Message(t *testing.T) {
	csp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer csp.Close()

	rec := httptest.NewRecorder()
	accountsDeps(t, csp.URL, "VAULTKEY").ServeHTTP(rec, httptest.NewRequest("GET", "/api/accounts", nil))

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := "Could not reach Infoblox to list your accounts. Try again."
	if body["error"] != want {
		t.Fatalf("error = %q, want %q", body["error"], want)
	}
}

// TestAccountsRouteUnreachableMessage covers the transport-failure branch: the
// CSP server is closed before the request, so there is no HTTP status at all.
func TestAccountsRouteUnreachableMessage(t *testing.T) {
	csp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	dead := csp.URL
	csp.Close()

	rec := httptest.NewRecorder()
	accountsDeps(t, dead, "VAULTKEY").ServeHTTP(rec, httptest.NewRequest("GET", "/api/accounts", nil))

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["error"] != "Could not reach Infoblox." {
		t.Fatalf("error = %q, want %q", body["error"], "Could not reach Infoblox.")
	}
	if body["status"] != nil {
		t.Fatalf("status = %v, want null (there was no HTTP response)", body["status"])
	}
}
