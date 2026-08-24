package dashboard

import (
	"net/http"
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
