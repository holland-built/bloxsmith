package dashboard

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

// axurMux builds a fake Axur. Handlers are keyed by path prefix; anything not
// registered 404s, which surfaces as a failure rather than as a quiet zero.
func axurMux(t *testing.T, routes map[string]http.HandlerFunc) (*Service, *httptest.Server) {
	t.Helper()
	mux := http.NewServeMux()
	for p, h := range routes {
		mux.HandleFunc(p, h)
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &Service{
		Cache: cache.New(),
		Axur:  rest.New(srv.URL, rest.NewAuth("Bearer test-token", nil)),
	}, srv
}

func jsonHandler(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}
}

const oneAsset = `{"assets":[{"customerKey":"ACME","name":"example.com"}]}`

func indicatorsFor(vendors string) http.HandlerFunc {
	return jsonHandler(fmt.Sprintf(`{"pagination":{"page":1,"size":20,"total":1},"data":%s}`, vendors))
}

// --- the happy path -----------------------------------------------------------

func TestAxurVendorsShapeAndOrder(t *testing.T) {
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets": jsonHandler(oneAsset),
		"/vendor-monitor/customer-vendors-api/customer/ACME/indicators": indicatorsFor(`[
			{"assetKey":"A1","name":"Okta","indicators":[
				{"type":"EXPIRED_CERTIFICATES","primary":{"value":0}},
				{"type":"LEAKED_CREDENTIALS","primary":{"value":4}}]},
			{"assetKey":"A2","name":"SAP","indicators":[
				{"type":"DARK_WEB","primary":{"value":9}},
				{"type":"OPEN_PORTS","primary":{"value":2}},
				{"type":"EXPIRED_CERTIFICATES","primary":{"value":1}}]},
			{"assetKey":"A3","name":"ADP","indicators":[
				{"type":"OPEN_PORTS","primary":{"value":0}}]}]`),
	})
	got := s.FetchAxurVendors()
	if got["configured"] != true {
		t.Fatalf("configured = %v", got["configured"])
	}
	if got["customer"] != "ACME" {
		t.Errorf("customer = %v, want the discovered ACME", got["customer"])
	}
	vendors := got["vendors"].([]any)
	var names []string
	for _, v := range vendors {
		names = append(names, asMap(v)["name"].(string))
	}
	// SAP has 3 findings, Okta 1, ADP 0 — worst first.
	want := []string{"SAP", "Okta", "ADP"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Errorf("order = %v, want %v", names, want)
	}
	sap := asMap(vendors[0])
	if sap["findings"] != 3 || sap["top_type"] != "DARK_WEB" || sap["top_value"] != 9 {
		t.Errorf("SAP = %v, want 3 findings topping out at DARK_WEB 9", sap)
	}
	if got["total_findings"] != 4 {
		t.Errorf("total_findings = %v, want 4", got["total_findings"])
	}
}

// A zero-value indicator is not a finding, and a vendor with only zeroes is
// still listed — "monitored, nothing found" is a real and useful row.
func TestAxurZeroIndicatorsStillListsTheVendor(t *testing.T) {
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets": jsonHandler(oneAsset),
		"/vendor-monitor/customer-vendors-api/customer/ACME/indicators": indicatorsFor(
			`[{"assetKey":"A1","name":"Okta","indicators":[{"type":"OPEN_PORTS","primary":{"value":0}}]}]`),
	})
	got := s.FetchAxurVendors()
	vendors := got["vendors"].([]any)
	if len(vendors) != 1 {
		t.Fatalf("vendors = %d, want the vendor listed with zero findings", len(vendors))
	}
	if asMap(vendors[0])["findings"] != 0 {
		t.Errorf("findings = %v, want 0", asMap(vendors[0])["findings"])
	}
}

// TestAxurTieBreak is Codex finding 8: equal values must not flicker between
// polls, so the tie is broken by name.
func TestAxurTieBreak(t *testing.T) {
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets": jsonHandler(oneAsset),
		"/vendor-monitor/customer-vendors-api/customer/ACME/indicators": indicatorsFor(`[
			{"assetKey":"A1","name":"Zeta","indicators":[{"type":"B_TYPE","primary":{"value":5}},{"type":"A_TYPE","primary":{"value":5}}]},
			{"assetKey":"A2","name":"Alpha","indicators":[{"type":"B_TYPE","primary":{"value":5}},{"type":"A_TYPE","primary":{"value":5}}]}]`),
	})
	got := s.FetchAxurVendors()
	vendors := got["vendors"].([]any)
	if asMap(vendors[0])["name"] != "Alpha" {
		t.Errorf("tie broken to %v, want Alpha (name ascending)", asMap(vendors[0])["name"])
	}
	if asMap(vendors[0])["top_type"] != "A_TYPE" {
		t.Errorf("top_type = %v, want A_TYPE (equal values, name ascending)", asMap(vendors[0])["top_type"])
	}
}

// --- Codex finding 1: pagination ---------------------------------------------

func TestAxurWalksEveryPage(t *testing.T) {
	var pages int32
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets": jsonHandler(oneAsset),
		"/vendor-monitor/customer-vendors-api/customer/ACME/indicators": func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&pages, 1)
			// Page 1 is FULL (20 vendors, all with 1 finding); page 2 holds the
			// single worst one. A page-1-only read would rank it last.
			if r.URL.Query().Get("page") == "1" {
				var rows []string
				for i := 0; i < 20; i++ {
					rows = append(rows, fmt.Sprintf(
						`{"assetKey":"P%02d","name":"vendor-%02d","indicators":[{"type":"X","primary":{"value":1}}]}`, i, i))
				}
				_, _ = w.Write([]byte(`{"data":[` + strings.Join(rows, ",") + `]}`))
				return
			}
			_, _ = w.Write([]byte(`{"data":[{"assetKey":"WORST","name":"worst-vendor","indicators":[
				{"type":"A","primary":{"value":9}},{"type":"B","primary":{"value":9}}]}]}`))
		},
	})
	got := s.FetchAxurVendors()
	if pages < 2 {
		t.Fatalf("fetched %d page(s); a full first page must be followed", pages)
	}
	vendors := got["vendors"].([]any)
	if len(vendors) != 21 {
		t.Errorf("vendors = %d, want all 21 across both pages", len(vendors))
	}
	if asMap(vendors[0])["name"] != "worst-vendor" {
		t.Errorf("first = %v, want worst-vendor — worst-first must span pages", asMap(vendors[0])["name"])
	}
}

// --- Codex finding 2 and 3: never guess between accounts ----------------------

func TestAxurRefusesToGuessBetweenAccounts(t *testing.T) {
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets": jsonHandler(
			`{"assets":[{"customerKey":"ACME"},{"customerKey":"OTHERCO"}]}`),
		"/vendor-monitor/customer-vendors-api/customer/ACME/indicators": func(w http.ResponseWriter, r *http.Request) {
			t.Error("fetched a tenant's data after seeing two candidate accounts")
		},
	})
	got := s.FetchAxurVendors()
	if got["needs_key"] != true {
		t.Fatalf("needs_key = %v, want true — ambiguity must be reported, not guessed", got["needs_key"])
	}
	msg, _ := got["unavailable"].(string)
	if !strings.Contains(msg, "AXUR_CUSTOMER_KEY") {
		t.Errorf("unavailable = %q, want it to name the override", msg)
	}
	if !strings.Contains(msg, "2 accounts") {
		t.Errorf("unavailable = %q, want it to say how many accounts were seen", msg)
	}
}

// Repeated keys are ONE account, not ambiguity — every asset carries the same
// customerKey on an ordinary tenant.
func TestAxurRepeatedKeyIsNotAmbiguous(t *testing.T) {
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets": jsonHandler(
			`{"assets":[{"customerKey":"ACME"},{"customerKey":"ACME"},{"customerKey":"ACME"}]}`),
		"/vendor-monitor/customer-vendors-api/customer/ACME/indicators": indicatorsFor(`[]`),
	})
	got := s.FetchAxurVendors()
	if got["needs_key"] != nil {
		t.Fatalf("one repeated key was treated as ambiguous: %v", got)
	}
	if got["customer"] != "ACME" {
		t.Errorf("customer = %v, want ACME", got["customer"])
	}
}

// The explicit override outranks discovery and skips it entirely.
func TestAxurCustomerOverrideSkipsDiscovery(t *testing.T) {
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets": func(w http.ResponseWriter, r *http.Request) {
			t.Error("discovery ran even though AXUR_CUSTOMER_KEY was set")
		},
		"/vendor-monitor/customer-vendors-api/customer/MINE/indicators": indicatorsFor(`[]`),
	})
	s.AxurCustomer = "MINE"
	got := s.FetchAxurVendors()
	if got["customer"] != "MINE" {
		t.Errorf("customer = %v, want the override MINE", got["customer"])
	}
}

// --- Codex finding 5: a failure is not a configuration problem ----------------

func TestAxurDiscoveryFailureStaysAFailure(t *testing.T) {
	cases := []struct {
		name        string
		status      int
		wantReason  string
		notEntitled bool
	}{
		{"403", 403, "Axur supplier monitoring not entitled for this key", true},
		{"401", 401, "Axur rejected the credential — check the key under Settings", false},
		{"500", 500, "Axur service unavailable — The upstream server returned an error (status 500).", false},
		{"404", 404, "Axur service unavailable — The upstream server returned an error (status 404).", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fail := func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status) }
			s, _ := axurMux(t, map[string]http.HandlerFunc{
				"/assets-api/assets":       fail,
				"/customers-api/customers": fail,
			})
			got := s.FetchAxurVendors()
			if got["needs_key"] == true {
				t.Fatalf("an upstream %d was reported as a missing setting: %v", tc.status, got)
			}
			reason, _ := got["unavailable"].(string)
			if !strings.Contains(reason, tc.wantReason) {
				t.Errorf("unavailable = %q, want it to contain %q", reason, tc.wantReason)
			}
			// A discovery failure has to say it was the account LOOKUP that
			// failed, and name the way past it. Without that, a 404 on the
			// lookup and a 404 on the supplier read read identically.
			if !strings.Contains(reason, "account code") {
				t.Errorf("unavailable = %q, want it to name the account lookup as the failing stage", reason)
			}
			if !strings.Contains(reason, "AXUR_CUSTOMER_KEY") {
				t.Errorf("unavailable = %q, want it to name the override", reason)
			}
			if got["not_entitled"] != tc.notEntitled {
				t.Errorf("not_entitled = %v, want %v", got["not_entitled"], tc.notEntitled)
			}
		})
	}
}

// A clean answer that simply carries no key IS the configuration case.
func TestAxurNoKeyAnywhereAsksForTheOverride(t *testing.T) {
	empty := jsonHandler(`{"assets":[]}`)
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets":       empty,
		"/customers-api/customers": jsonHandler(`[]`),
	})
	got := s.FetchAxurVendors()
	if got["needs_key"] != true {
		t.Fatalf("needs_key = %v, want true", got["needs_key"])
	}
}

// The second probe rescues the first: assets may 403 while customers answers.
func TestAxurSecondProbeRescuesTheFirst(t *testing.T) {
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets":       func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(403) },
		"/customers-api/customers": jsonHandler(`[{"name":"Acme","key":"ACME","active":true}]`),
		"/vendor-monitor/customer-vendors-api/customer/ACME/indicators": indicatorsFor(`[]`),
	})
	got := s.FetchAxurVendors()
	if got["customer"] != "ACME" {
		t.Errorf("customer = %v, want ACME from the second probe", got["customer"])
	}
}

// --- Codex finding 6: discovery failures are not re-run on every refresh ------

func TestAxurDiscoveryFailureIsCachedBriefly(t *testing.T) {
	var hits int32
	fail := func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(403)
	}
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets":       fail,
		"/customers-api/customers": fail,
	})
	s.FetchAxurVendors()
	first := atomic.LoadInt32(&hits)
	s.FetchAxurVendors()
	if atomic.LoadInt32(&hits) != first {
		t.Errorf("discovery re-ran on the second call (%d then %d hits) — every refresh would hammer Axur",
			first, atomic.LoadInt32(&hits))
	}
}

// --- Codex finding 7: a missing data field is not an empty supplier list ------

func TestAxurMissingDataFieldIsAFailure(t *testing.T) {
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets": jsonHandler(oneAsset),
		"/vendor-monitor/customer-vendors-api/customer/ACME/indicators": jsonHandler(
			`{"pagination":{"page":1,"size":20}}`),
	})
	got := s.FetchAxurVendors()
	if _, ok := got["unavailable"]; !ok {
		t.Fatalf("a response with no data field was read as a clean zero: %v", got)
	}
}

// --- credential handling, carried over ----------------------------------------

func TestAxurNotConfigured(t *testing.T) {
	s := &Service{Cache: cache.New()}
	got := s.FetchAxurVendors()
	if got["configured"] != false {
		t.Errorf("configured = %v, want false", got["configured"])
	}
	if _, ok := got["unavailable"]; ok {
		t.Errorf("unconfigured must not report an outage: %v", got["unavailable"])
	}
}

func TestAxurLockedIsNotUnconfigured(t *testing.T) {
	s := &Service{
		Cache:      cache.New(),
		Axur:       rest.New("http://127.0.0.1:1", rest.NewAuth("", func() string { return "" })),
		AxurLocked: func() bool { return true },
	}
	got := s.FetchAxurVendors()
	if got["configured"] != true || got["locked"] != true {
		t.Errorf("got %v, want configured+locked — a shut vault is not an unset key", got)
	}
}

func TestAxurNoVaultIsNotLocked(t *testing.T) {
	s := &Service{
		Cache:      cache.New(),
		Axur:       rest.New("http://127.0.0.1:1", rest.NewAuth("", func() string { return "" })),
		AxurLocked: func() bool { return false },
	}
	got := s.FetchAxurVendors()
	if got["configured"] != false {
		t.Errorf("configured = %v, want false", got["configured"])
	}
	if _, ok := got["locked"]; ok {
		t.Errorf("an install with no vault reported a lock state: %v", got)
	}
}

func TestAxurVaultKeyBeatsEnv(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "indicators") {
			_, _ = w.Write([]byte(`{"data":[]}`))
			return
		}
		_, _ = w.Write([]byte(oneAsset))
	}))
	defer srv.Close()
	vaultKey := "Bearer from-vault"
	s := &Service{
		Cache: cache.New(),
		Axur:  rest.New(srv.URL, rest.NewAuth("Bearer from-env", func() string { return vaultKey })),
	}
	s.FetchAxurVendors()
	if len(seen) == 0 || seen[0] != "Bearer from-vault" {
		t.Fatalf("sent %v, want the vault key to win", seen)
	}
}

// A response cached under one credential must never be served under another.
func TestAxurCacheKeyedOnCredential(t *testing.T) {
	var indicatorHits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "indicators") {
			atomic.AddInt32(&indicatorHits, 1)
			_, _ = w.Write([]byte(`{"data":[]}`))
			return
		}
		_, _ = w.Write([]byte(oneAsset))
	}))
	defer srv.Close()
	key := "Bearer tenant-a"
	s := &Service{Cache: cache.New(), Axur: rest.New(srv.URL, rest.NewAuth("", func() string { return key }))}
	s.FetchAxurVendors()
	s.FetchAxurVendors()
	if n := atomic.LoadInt32(&indicatorHits); n != 1 {
		t.Fatalf("indicator hits = %d after two calls on one key, want 1", n)
	}
	key = "Bearer tenant-b"
	s.FetchAxurVendors()
	if n := atomic.LoadInt32(&indicatorHits); n != 2 {
		t.Fatalf("indicator hits = %d after the key changed, want 2 — a cached response outlived its credential", n)
	}
}

func TestAxurFingerprintIsNotTheSecret(t *testing.T) {
	const secret = "Bearer super-secret-token-value"
	fp := axurCredFingerprint(secret)
	if len(fp) != 12 {
		t.Fatalf("fingerprint = %q, want 12 hex characters", fp)
	}
	if strings.Contains(secret, fp) {
		t.Errorf("fingerprint %q carries the secret", fp)
	}
	if axurCredFingerprint("Bearer another-key") == fp {
		t.Error("two different credentials produced the same fingerprint")
	}
}

// The customer key reaches a URL path, so a hostile value must not retarget it.
func TestAxurCustomerKeyIsPathEscaped(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer srv.Close()
	s := &Service{Cache: cache.New(), Axur: rest.New(srv.URL, rest.NewAuth("Bearer k", nil))}
	s.AxurCustomer = "a/../../evil"
	s.FetchAxurVendors()
	if strings.Contains(gotPath, "/../") {
		t.Errorf("path = %q, want the traversal escaped", gotPath)
	}
}

// The shape the HTTP layer serves has to survive a JSON round trip — the panel
// reads it as JSON, not as Go values.
func TestAxurResultIsJSONSerialisable(t *testing.T) {
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets": jsonHandler(oneAsset),
		"/vendor-monitor/customer-vendors-api/customer/ACME/indicators": indicatorsFor(
			`[{"assetKey":"A1","name":"Okta","indicators":[{"type":"X","primary":{"value":3}}]}]`),
	})
	b, err := json.Marshal(s.FetchAxurVendors())
	if err != nil {
		t.Fatalf("result does not marshal: %v", err)
	}
	if !strings.Contains(string(b), `"findings":1`) {
		t.Errorf("marshalled shape lost findings: %s", b)
	}
}

// --- Codex finding 1: the failure body is logged whichever outcome wins -------

// TestAxurProbeFailureIsLoggedEvenWhenConfigWins: probe 1 fails, probe 2
// succeeds-but-empty, so the CONFIG message wins. The 400's body is the only
// thing that can explain probe 1, and it must still reach the log.
func TestAxurProbeFailureIsLoggedEvenWhenConfigWins(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"code":"asset.badRequest","message":"perPage exceeds maximum"}`))
		},
		"/customers-api/customers": jsonHandler(`[]`),
	})
	got := s.FetchAxurVendors()
	if got["needs_key"] != true {
		t.Fatalf("needs_key = %v, want true — an empty success beats a sibling failure", got["needs_key"])
	}
	out := buf.String()
	if !strings.Contains(out, "status=400") {
		t.Errorf("log did not record the 400: %q", out)
	}
	if !strings.Contains(out, "perPage exceeds maximum") {
		t.Errorf("log did not carry the provider's explanation: %q", out)
	}
}

// --- Codex finding 2: the logged snippet is redacted and cannot forge a line --

func TestAxurLoggedSnippetIsRedactedAndQuoted(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(400)
			_, _ = w.Write([]byte("{\"authorization\":\"Bearer super-secret-value\"}\nFORGED LINE"))
		},
		"/customers-api/customers": jsonHandler(`[]`),
	})
	s.FetchAxurVendors()
	out := buf.String()
	if strings.Contains(out, "super-secret-value") {
		t.Errorf("a credential reached the log: %q", out)
	}
	if !strings.Contains(out, "[REDACTED]") {
		t.Errorf("nothing was redacted: %q", out)
	}
	// %q turns the newline into an escape, so the forged text cannot start its
	// own log line.
	if strings.Contains(out, "\nFORGED LINE") {
		t.Errorf("upstream text forged a log line: %q", out)
	}
	if !strings.Contains(out, `\nFORGED LINE`) {
		t.Errorf("expected the newline escaped rather than dropped: %q", out)
	}
}

// --- Codex finding 3: a 2xx of the wrong shape is a failure, not an empty ----

func TestAxurProbeWrongShapeIsAFailure(t *testing.T) {
	// Both probes answer 200 with an error envelope carrying no list at all.
	envelope := jsonHandler(`{"error":"something went wrong","code":"E_OOPS"}`)
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets":       envelope,
		"/customers-api/customers": envelope,
	})
	got := s.FetchAxurVendors()
	if got["needs_key"] == true {
		t.Fatalf("an error envelope at HTTP 200 was reported as a missing setting: %v", got)
	}
	if _, ok := got["unavailable"]; !ok {
		t.Fatalf("wrong-shaped 200 was not treated as a failure: %v", got)
	}
}

// --- Codex finding 4: reconcile across pages and across probes ---------------

// A second page of assets revealing a different account must be caught, even
// though page one was uniform.
func TestAxurMultiAccountFoundOnLaterPage(t *testing.T) {
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if r.URL.Query().Get("page") == "1" {
				var rows []string
				for i := 0; i < 100; i++ {
					rows = append(rows, `{"customerKey":"ACME"}`)
				}
				_, _ = w.Write([]byte(`{"assets":[` + strings.Join(rows, ",") + `]}`))
				return
			}
			_, _ = w.Write([]byte(`{"assets":[{"customerKey":"OTHERCO"}]}`))
		},
		"/customers-api/customers": jsonHandler(`[]`),
		"/vendor-monitor/customer-vendors-api/customer/ACME/indicators": func(w http.ResponseWriter, r *http.Request) {
			t.Error("read a tenant's data despite a second account on a later page")
		},
	})
	got := s.FetchAxurVendors()
	if got["needs_key"] != true {
		t.Fatalf("needs_key = %v, want true — page 2 held a second account", got["needs_key"])
	}
}

// Two probes that each answer cleanly but disagree must not be reconciled by
// preferring one of them.
func TestAxurProbesDisagreeing(t *testing.T) {
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets":       jsonHandler(`{"assets":[{"customerKey":"ACME"}]}`),
		"/customers-api/customers": jsonHandler(`[{"key":"OTHERCO"}]`),
	})
	got := s.FetchAxurVendors()
	if got["needs_key"] != true {
		t.Fatalf("needs_key = %v, want true — the two probes disagreed", got["needs_key"])
	}
}

// Both probes agreeing on the same single code is not ambiguity.
func TestAxurProbesAgreeing(t *testing.T) {
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets":       jsonHandler(`{"assets":[{"customerKey":"ACME"}]}`),
		"/customers-api/customers": jsonHandler(`[{"key":"ACME"}]`),
		"/vendor-monitor/customer-vendors-api/customer/ACME/indicators": indicatorsFor(`[]`),
	})
	got := s.FetchAxurVendors()
	if got["customer"] != "ACME" {
		t.Errorf("customer = %v, want ACME", got["customer"])
	}
}

// --- Codex finding 5: the exact query each probe sends -----------------------

// The customers endpoint documents NO query parameters, and sending page and
// perPage to an endpoint that declares none is one way a 400 gets invented.
func TestAxurProbeQueryStrings(t *testing.T) {
	var assetsQ, customersQ string
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets": func(w http.ResponseWriter, r *http.Request) {
			assetsQ = r.URL.RawQuery
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"assets":[]}`))
		},
		"/customers-api/customers": func(w http.ResponseWriter, r *http.Request) {
			customersQ = r.URL.RawQuery
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[]`))
		},
	})
	s.FetchAxurVendors()
	if !strings.Contains(assetsQ, "page=1") || !strings.Contains(assetsQ, "perPage=20") {
		t.Errorf("assets query = %q, want page and perPage", assetsQ)
	}
	if customersQ != "" {
		t.Errorf("customers query = %q, want none — that endpoint documents no parameters", customersQ)
	}
}

// --- Codex finding 2 again: nothing from the body reaches the panel ----------

func TestAxurPanelMessageCarriesNoUpstreamBody(t *testing.T) {
	fail := func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"secretish":"internal-detail-abc123","path":"/private/thing"}`))
	}
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets":       fail,
		"/customers-api/customers": fail,
	})
	got := s.FetchAxurVendors()
	msg, _ := got["unavailable"].(string)
	for _, leak := range []string{"internal-detail-abc123", "/private/thing", "secretish"} {
		if strings.Contains(msg, leak) {
			t.Errorf("panel message leaked %q: %s", leak, msg)
		}
	}
	if !strings.Contains(msg, "400") {
		t.Errorf("panel message = %q, want the status", msg)
	}
}

// TestAxurReasonCarriesAxursOwnMessage: a status says the request was refused,
// not which part of it was wrong. The provider's own wording is what closes
// that gap, through the allowlist internal/rest owns — recognised keys only,
// bounded, and no fallback to the raw body.
func TestAxurReasonCarriesAxursOwnMessage(t *testing.T) {
	fail := func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"message":"perPage must be 20 or less","trace":"internal-abc"}`))
	}
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets":       fail,
		"/customers-api/customers": fail,
	})
	msg, _ := s.FetchAxurVendors()["unavailable"].(string)
	if !strings.Contains(msg, "perPage must be 20 or less") {
		t.Errorf("unavailable = %q, want Axur's own message", msg)
	}
	if strings.Contains(msg, "internal-abc") {
		t.Errorf("a non-allowlisted field reached the panel: %q", msg)
	}
}

// An unrecognised body contributes nothing — the allowlist never falls back to
// dumping what it does not understand.
func TestAxurUnrecognisedBodyAddsNothing(t *testing.T) {
	fail := func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"weird":"unrecognised-detail-xyz"}`))
	}
	s, _ := axurMux(t, map[string]http.HandlerFunc{
		"/assets-api/assets":       fail,
		"/customers-api/customers": fail,
	})
	msg, _ := s.FetchAxurVendors()["unavailable"].(string)
	if strings.Contains(msg, "unrecognised-detail-xyz") {
		t.Errorf("raw body leaked onto the panel: %q", msg)
	}
	if !strings.Contains(msg, "400") {
		t.Errorf("unavailable = %q, want the status still present", msg)
	}
}
