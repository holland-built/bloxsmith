package dashboard

import (
	"net/http"
	"strings"
	"net/http/httptest"
	"testing"
	"time"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

// axurService builds a Service whose Axur client points at h, with a real
// cache. The Infoblox Rest client is left nil on purpose: if any Axur code path
// ever reaches for it, these tests panic rather than quietly passing.
func axurService(t *testing.T, h http.HandlerFunc) (*Service, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &Service{
		Cache: cache.New(),
		Axur:  rest.New(srv.URL, rest.NewAuth("Bearer test-token", nil)),
	}, srv
}

// TestAxurRequestURL is Codex FINDING 1 and FINDING 8 together: from/to are
// required by Axur and must be real dates, and the gateway prefix in the base
// URL must survive being joined to the request path.
func TestAxurRequestURL(t *testing.T) {
	var gotPath, gotFrom, gotTo, gotAuth string
	s, _ := axurService(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotFrom = r.URL.Query().Get("from")
		gotTo = r.URL.Query().Get("to")
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"totalByTicketType":[]}`))
	})
	s.FetchAxurTickets()

	if gotPath != axurTicketTypesPath {
		t.Errorf("path = %q, want %q", gotPath, axurTicketTypesPath)
	}
	if gotAuth != "Bearer test-token" {
		t.Errorf("Authorization = %q, want the value verbatim", gotAuth)
	}
	// Both required parameters must be non-empty and parse as Axur's format.
	from, err := time.Parse("2006-01-02", gotFrom)
	if err != nil {
		t.Fatalf("from = %q, want YYYY-MM-DD: %v", gotFrom, err)
	}
	to, err := time.Parse("2006-01-02", gotTo)
	if err != nil {
		t.Fatalf("to = %q, want YYYY-MM-DD: %v", gotTo, err)
	}
	if d := to.Sub(from).Hours() / 24; d != axurWindowDays {
		t.Errorf("window = %v days, want %d", d, axurWindowDays)
	}
	if d := to.Sub(from).Hours() / 24; d > 90 {
		t.Errorf("window %v days exceeds Axur's 90-day cap", d)
	}
}

// TestAxurWindowIsUTCAndExact pins the exact strings for a known instant, so a
// timezone-dependent regression fails here rather than shifting a report by a
// day in production.
func TestAxurWindowIsUTCAndExact(t *testing.T) {
	// 2026-03-01T02:00Z is the previous day in any negative-offset zone.
	now := time.Date(2026, 3, 1, 2, 0, 0, 0, time.FixedZone("UTC-8", -8*3600))
	from, to := axurWindow(now)
	if to != "2026-03-01" {
		t.Errorf("to = %q, want 2026-03-01 (UTC, not local)", to)
	}
	if from != "2026-01-30" {
		t.Errorf("from = %q, want 2026-01-30", from)
	}
}

// TestAxurGatewayPrefixSurvives is FINDING 8 proper: a base URL that carries a
// path prefix must keep it. rest.Client.url concatenates rather than resolving
// a relative reference, and this asserts that rather than trusting it.
func TestAxurGatewayPrefixSurvives(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"totalByTicketType":[]}`))
	}))
	defer srv.Close()
	s := &Service{
		Cache: cache.New(),
		Axur:  rest.New(srv.URL+"/gateway/1.0/api", rest.NewAuth("Bearer t", nil)),
	}
	s.FetchAxurTickets()
	want := "/gateway/1.0/api" + axurTicketTypesPath
	if gotPath != want {
		t.Errorf("path = %q, want %q", gotPath, want)
	}
}

// TestAxurNotConfigured: no credential is not a failure. configured:false, and
// no "unavailable" wording that would send an operator looking for an outage.
func TestAxurNotConfigured(t *testing.T) {
	s := &Service{Cache: cache.New()}
	got := s.FetchAxurTickets()
	if got["configured"] != false {
		t.Errorf("configured = %v, want false", got["configured"])
	}
	if _, ok := got["unavailable"]; ok {
		t.Errorf("unconfigured must not report an outage, got %v", got["unavailable"])
	}
}

// TestAxurFailureIsNotEmpty is FINDING 3 and FINDING 4: a dead feed must never
// be indistinguishable from a healthy tenant with no incidents.
func TestAxurFailureIsNotEmpty(t *testing.T) {
	cases := []struct {
		name        string
		status      int
		body        string
		notEntitled bool
		wantReason  string
	}{
		{"403 entitlement", 403, `{"error":"forbidden"}`, true, "Axur incident counts not entitled"},
		{"401 credential", 401, `{"error":"unauthorized"}`, false, "Axur rejected the credential — check AXUR_API_KEY"},
		{"500 outage", 500, `boom`, false, "Axur service unavailable"},
		{"200 but not JSON", 200, `<html>proxy interstitial</html>`, false, "Axur service unavailable"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := axurService(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			got := s.FetchAxurTickets()
			if got["unavailable"] != tc.wantReason {
				t.Errorf("unavailable = %v, want %q", got["unavailable"], tc.wantReason)
			}
			if got["not_entitled"] != tc.notEntitled {
				t.Errorf("not_entitled = %v, want %v", got["not_entitled"], tc.notEntitled)
			}
			if got["configured"] != true {
				t.Errorf("configured = %v, want true (a key IS set; the call failed)", got["configured"])
			}
		})
	}
}

// TestAxurLoadedEmpty is the other half of FINDING 4: a real zero must carry NO
// unavailable key, so the UI can tell the two apart.
func TestAxurLoadedEmpty(t *testing.T) {
	s, _ := axurService(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"totalByTicketType":[{"type":"phishing","totalOnPeriod":0}]}`))
	})
	got := s.FetchAxurTickets()
	if _, ok := got["unavailable"]; ok {
		t.Fatalf("a successful empty read must not report unavailable: %v", got["unavailable"])
	}
	if n := len(got["types"].([]any)); n != 0 {
		t.Errorf("types = %d rows, want 0 (zero counts are dropped)", n)
	}
	if got["total"] != 0 {
		t.Errorf("total = %v, want 0", got["total"])
	}
}

// TestAxurNormAndOrder covers the shaping: zero rows dropped, highest first,
// ties broken by name so the order does not flicker between polls.
func TestAxurNormAndOrder(t *testing.T) {
	s, _ := axurService(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"totalByTicketType":[
			{"type":"phishing","totalOnPeriod":3},
			{"type":"malware","totalOnPeriod":0},
			{"type":"similar-domain-name","totalOnPeriod":18},
			{"type":"paid-search","totalOnPeriod":3},
			{"type":"","totalOnPeriod":9}
		]}`))
	})
	got := s.FetchAxurTickets()
	types := got["types"].([]any)
	var names []string
	for _, r := range types {
		names = append(names, r.(map[string]any)["type"].(string))
	}
	want := []string{"similar-domain-name", "paid-search", "phishing"}
	if len(names) != len(want) {
		t.Fatalf("types = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("types = %v, want %v", names, want)
		}
	}
	if got["total"] != 24 {
		t.Errorf("total = %v, want 24", got["total"])
	}
}

// TestAxurClientIgnoresAccountSwitch is FINDING 2: the credential isolation
// claimed in helpers.go has to be a fact, not a comment. An Infoblox account
// switch sets an override on the Infoblox Auth; the Axur client must send the
// same header before and after, and With() must not swap it either.
func TestAxurClientIgnoresAccountSwitch(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"totalByTicketType":[]}`))
	}))
	defer srv.Close()

	infoblox := rest.NewAuth("Token infoblox-key", nil)
	s := &Service{
		Cache: cache.New(),
		Rest:  rest.New(srv.URL, infoblox),
		Axur:  rest.New(srv.URL, rest.NewAuth("Bearer axur-key", nil)),
	}
	s.FetchAxurTickets()

	// A portal account switch, exactly as account.SwitchAccount performs it.
	infoblox.SetOverride("Bearer someone-elses-tenant-jwt")
	s.Cache.Rotate()

	// And the request-pinned copy the handler actually uses.
	pinned := s.With(s.Rest.Pin())
	pinned.FetchAxurTickets()

	if len(seen) != 2 {
		t.Fatalf("expected 2 Axur calls, got %d", len(seen))
	}
	for i, got := range seen {
		if got != "Bearer axur-key" {
			t.Errorf("call %d Authorization = %q, want the Axur key unchanged by the switch", i, got)
		}
	}
}

// --- vault-backed credential -------------------------------------------------

// TestAxurLockedIsNotUnconfigured is the distinction Codex finding 3 named and
// the one an operator most needs: a shut vault must not be reported as "you
// never set a key". Those two sentences send someone to opposite places.
func TestAxurLockedIsNotUnconfigured(t *testing.T) {
	s := &Service{
		Cache:      cache.New(),
		Axur:       rest.New("http://127.0.0.1:1", rest.NewAuth("", func() string { return "" })),
		AxurLocked: func() bool { return true },
	}
	got := s.FetchAxurTickets()
	if got["configured"] != true {
		t.Errorf("configured = %v, want true — a key may well be stored, we just cannot read it", got["configured"])
	}
	if got["locked"] != true {
		t.Errorf("locked = %v, want true", got["locked"])
	}
	if got["unavailable"] != "Vault locked — unlock to read Axur" {
		t.Errorf("unavailable = %v, want the locked wording", got["unavailable"])
	}
}

// The same empty credential with the vault OPEN really does mean unconfigured.
func TestAxurUnlockedAndEmptyIsUnconfigured(t *testing.T) {
	s := &Service{
		Cache:      cache.New(),
		Axur:       rest.New("http://127.0.0.1:1", rest.NewAuth("", func() string { return "" })),
		AxurLocked: func() bool { return false },
	}
	got := s.FetchAxurTickets()
	if got["configured"] != false {
		t.Errorf("configured = %v, want false", got["configured"])
	}
	if _, ok := got["unavailable"]; ok {
		t.Errorf("unconfigured must not claim an outage: %v", got["unavailable"])
	}
}

// TestAxurVaultKeyBeatsEnv pins the precedence main.go builds: the vault's key
// is the 'active' resolver and the env key is the fallback, so a stored key
// wins. Matches LLMCreds, deliberately.
func TestAxurVaultKeyBeatsEnv(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"totalByTicketType":[]}`))
	}))
	defer srv.Close()

	vaultKey := "Bearer from-vault"
	s := &Service{
		Cache: cache.New(),
		Axur:  rest.New(srv.URL, rest.NewAuth("Bearer from-env", func() string { return vaultKey })),
	}
	s.FetchAxurTickets()
	if len(seen) != 1 || seen[0] != "Bearer from-vault" {
		t.Fatalf("sent %v, want the vault key to win", seen)
	}

	// Clearing the vault entry falls back to the environment — it does NOT turn
	// Axur off. That is the ambiguity SetAxur's doc comment resolves, pinned here.
	vaultKey = ""
	s.Cache = cache.New()
	s.FetchAxurTickets()
	if len(seen) != 2 || seen[1] != "Bearer from-env" {
		t.Fatalf("sent %v, want the env key after the vault entry was cleared", seen)
	}
}

// TestAxurCacheKeyedOnCredential is Codex finding 1. A response fetched under
// one key must never be served under another — for a multi-tenant vendor API
// that is one customer's incident counts shown under another's credential.
func TestAxurCacheKeyedOnCredential(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = w.Write([]byte(`{"totalByTicketType":[{"type":"phishing","totalOnPeriod":1}]}`))
	}))
	defer srv.Close()

	key := "Bearer tenant-a"
	s := &Service{
		Cache: cache.New(),
		Axur:  rest.New(srv.URL, rest.NewAuth("", func() string { return key })),
	}
	s.FetchAxurTickets()
	s.FetchAxurTickets()
	if hits != 1 {
		t.Fatalf("hits = %d after two calls on ONE key, want 1 — the cache is not working", hits)
	}

	key = "Bearer tenant-b"
	s.FetchAxurTickets()
	if hits != 2 {
		t.Fatalf("hits = %d after the key changed, want 2 — a cached response outlived its credential", hits)
	}
}

// TestAxurFailuresAreNotCached: an operator fixing a wrong key must see the fix
// take effect on the next poll, not after the TTL expires.
func TestAxurFailuresAreNotCached(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	s := &Service{
		Cache: cache.New(),
		Axur:  rest.New(srv.URL, rest.NewAuth("Bearer k", nil)),
	}
	s.FetchAxurTickets()
	s.FetchAxurTickets()
	if hits != 2 {
		t.Errorf("hits = %d, want 2 — a failure was cached and the retry never left", hits)
	}
}

// TestAxurFingerprintIsNotTheSecret: cache keys get logged, so the tag in them
// must not be reversible to the credential.
func TestAxurFingerprintIsNotTheSecret(t *testing.T) {
	const secret = "Bearer super-secret-token-value"
	fp := axurCredFingerprint(secret)
	if fp == "" || len(fp) != 12 {
		t.Fatalf("fingerprint = %q, want 12 hex characters", fp)
	}
	if strings.Contains(secret, fp) || strings.Contains(fp, "secret") {
		t.Errorf("fingerprint %q carries the secret", fp)
	}
	if axurCredFingerprint("Bearer another-key") == fp {
		t.Error("two different credentials produced the same fingerprint")
	}
}

// TestAxurNoVaultIsNotLocked is a regression, found by running the server and
// not by reading the code. AxurLocked was wired as !vault.IsUnlocked(), and a
// vault that has never been created also reports "not unlocked" — so a brand
// new install with no Axur key was told "Vault locked — unlock to read Axur"
// about a vault it did not have. main.go now asks Exists() first; this pins the
// behaviour that fix produces.
func TestAxurNoVaultIsNotLocked(t *testing.T) {
	// The resolver main.go builds when no vault file exists: nothing stored,
	// and "locked" answers false because there is nothing to be locked.
	s := &Service{
		Cache:      cache.New(),
		Axur:       rest.New("http://127.0.0.1:1", rest.NewAuth("", func() string { return "" })),
		AxurLocked: func() bool { return false },
	}
	got := s.FetchAxurTickets()
	if got["configured"] != false {
		t.Errorf("configured = %v, want false", got["configured"])
	}
	if _, ok := got["locked"]; ok {
		t.Errorf("a install with no vault reported a lock state: %v", got)
	}
	if _, ok := got["unavailable"]; ok {
		t.Errorf("nothing failed, so nothing may be reported unavailable: %v", got["unavailable"])
	}
}
