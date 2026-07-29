package edit

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"bloxsmith/internal/rest"
)

// newTestClient wires an edit.Client to a rest.Client pointed at the given
// httptest server, mirroring rest.New's real construction (auth.Value() just
// needs to resolve to something non-empty; content doesn't matter here).
func newTestClient(srv *httptest.Server) *Client {
	auth := rest.NewAuth("test-key", func() string { return "" })
	return New(rest.New(srv.URL, auth))
}

// dnsRecordServer serves the GET-current-record response on
// /api/ddi/v1/dns/record/<id> and counts any write (PATCH/PUT) calls, failing
// the test if one is made when writeAllowed is false.
func dnsRecordServer(t *testing.T, current map[string]any, writeAllowed bool) (*httptest.Server, *int32) {
	t.Helper()
	var writes int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"result": current})
			return
		}
		// PATCH or PUT: a write.
		atomic.AddInt32(&writes, 1)
		if !writeAllowed {
			t.Fatalf("unexpected upstream write request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"result": current})
	}))
	return srv, &writes
}

func baseCurrent() map[string]any {
	return map[string]any{
		"id":           "dns/record/abc123",
		"type":         "A",
		"dns_rdata":    "10.0.0.1",
		"ttl":          float64(28800),
		"comment":      "prod host",
		"name_in_zone": "host1",
	}
}

func TestDNSRecordUpdate_StaleValue_Returns409AndNoWrite(t *testing.T) {
	current := baseCurrent()
	srv, writes := dnsRecordServer(t, current, false)
	defer srv.Close()
	c := newTestClient(srv)

	res, status := c.DNSRecordUpdate(M{
		"id":    "abc123",
		"value": "10.0.0.2",
		"expected": M{
			"value": "10.0.0.99", // stale — real value is 10.0.0.1
		},
	})

	if status != 409 {
		t.Fatalf("status = %d, want 409", status)
	}
	if res["ok"] != false {
		t.Fatalf("ok = %v, want false", res["ok"])
	}
	if atomic.LoadInt32(writes) != 0 {
		t.Fatalf("writes = %d, want 0 (no upstream write on conflict)", *writes)
	}
}

func TestDNSRecordUpdate_StaleTTL_NumericVsString(t *testing.T) {
	cases := []struct {
		name        string
		expectedTTL any
	}{
		{"numeric mismatch", float64(3600)},
		{"string mismatch", "3600"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			current := baseCurrent() // ttl = 28800
			srv, writes := dnsRecordServer(t, current, false)
			defer srv.Close()
			c := newTestClient(srv)

			_, status := c.DNSRecordUpdate(M{
				"id":  "abc123",
				"ttl": 60,
				"expected": M{
					"ttl": tc.expectedTTL,
				},
			})
			if status != 409 {
				t.Fatalf("status = %d, want 409", status)
			}
			if atomic.LoadInt32(writes) != 0 {
				t.Fatalf("writes = %d, want 0", *writes)
			}
		})
	}
}

func TestDNSRecordUpdate_TTLMatches_NumericVsStringForms(t *testing.T) {
	// The current ttl is 28800 (float64 from JSON). Expected as a numeric
	// string "28800" must compare EQUAL via numeric coercion, not string
	// equality, and must proceed (no conflict).
	current := baseCurrent()
	srv, _ := dnsRecordServer(t, current, true)
	defer srv.Close()
	c := newTestClient(srv)

	res, status := c.DNSRecordUpdate(M{
		"id":      "abc123",
		"comment": "updated",
		"expected": M{
			"ttl": "28800",
		},
	})
	if status == 409 {
		t.Fatalf("got 409 conflict, want match: %v", res)
	}
}

func TestDNSRecordUpdate_CommentMissingVsEmpty_TreatedEqual(t *testing.T) {
	current := baseCurrent()
	current["comment"] = "" // current record has empty-string comment
	srv, _ := dnsRecordServer(t, current, true)
	defer srv.Close()
	c := newTestClient(srv)

	// expected["comment"] absent entirely -> must not conflict against "".
	res, status := c.DNSRecordUpdate(M{
		"id":    "abc123",
		"value": "10.0.0.5",
		"expected": M{
			"value": "10.0.0.1",
			// no "comment" key
		},
	})
	if status == 409 {
		t.Fatalf("missing expected.comment vs current \"\" should not conflict: %v", res)
	}

	// Now flip: current comment missing entirely, expected.comment == "".
	current2 := baseCurrent()
	delete(current2, "comment")
	srv2, _ := dnsRecordServer(t, current2, true)
	defer srv2.Close()
	c2 := newTestClient(srv2)

	res2, status2 := c2.DNSRecordUpdate(M{
		"id":    "abc123",
		"value": "10.0.0.5",
		"expected": M{
			"value":   "10.0.0.1",
			"comment": "",
		},
	})
	if status2 == 409 {
		t.Fatalf("current comment missing vs expected \"\" should not conflict: %v", res2)
	}
}

func TestDNSRecordUpdate_AllFieldsMatch_ProceedsNormally(t *testing.T) {
	current := baseCurrent()
	srv, writes := dnsRecordServer(t, current, true)
	defer srv.Close()
	c := newTestClient(srv)

	res, status := c.DNSRecordUpdate(M{
		"id":    "abc123",
		"value": "10.0.0.9",
		"expected": M{
			"value":   "10.0.0.1",
			"ttl":     float64(28800),
			"comment": "prod host",
		},
	})
	if status != 200 {
		t.Fatalf("status = %d, want 200: %v", status, res)
	}
	if atomic.LoadInt32(writes) != 1 {
		t.Fatalf("writes = %d, want 1", *writes)
	}
}

func TestDNSRecordUpdate_ExpectedAbsent_BehavesAsBefore(t *testing.T) {
	current := baseCurrent()
	srv, writes := dnsRecordServer(t, current, true)
	defer srv.Close()
	c := newTestClient(srv)

	res, status := c.DNSRecordUpdate(M{
		"id":    "abc123",
		"value": "10.0.0.9",
		// no "expected" key at all
	})
	if status != 200 {
		t.Fatalf("status = %d, want 200: %v", status, res)
	}
	if atomic.LoadInt32(writes) != 1 {
		t.Fatalf("writes = %d, want 1", *writes)
	}
}

func TestDNSRecordUpdate_ConflictFiresOnDryPath(t *testing.T) {
	current := baseCurrent()
	srv, writes := dnsRecordServer(t, current, false)
	defer srv.Close()
	c := newTestClient(srv)

	res, status := c.DNSRecordUpdate(M{
		"id":    "abc123",
		"value": "10.0.0.2",
		"dry":   true,
		"expected": M{
			"value": "10.0.0.99", // stale
		},
	})
	if status != 409 {
		t.Fatalf("status = %d, want 409 even on dry path: %v", status, res)
	}
	if atomic.LoadInt32(writes) != 0 {
		t.Fatalf("writes = %d, want 0", *writes)
	}
}

// TestDNSRecordUpdate_NonJSON200OnRead_DecodeFlavoredError is the regression
// test for edit.go's discarded GetEx decode error: a pre-update GET that
// returns HTTP 200 with a non-JSON body (e.g. an upstream proxy/gateway
// hiccup) must NOT be reported as "record not found" — the record was never
// actually read, so its existence is unknown, not disproven. The error
// message must reflect the real decode failure instead.
func TestDNSRecordUpdate_NonJSON200OnRead_DecodeFlavoredError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(200)
		_, _ = w.Write([]byte("<html>not json</html>"))
	}))
	defer srv.Close()
	c := newTestClient(srv)

	res, _ := c.DNSRecordUpdate(M{
		"id":      "abc123",
		"comment": "updated",
	})

	if res["ok"] != false {
		t.Fatalf("ok = %v, want false", res["ok"])
	}
	errMsg, _ := res["error"].(string)
	if strings.Contains(errMsg, "record not found") {
		t.Fatalf("error = %q, must not claim the record was not found when the GET actually returned 200", errMsg)
	}
	if !strings.Contains(errMsg, "decode") && !strings.Contains(errMsg, "could not read") {
		t.Fatalf("error = %q, want a decode-flavored message", errMsg)
	}
}

func TestObjectPath_FullFormID_NoDoublePrefix(t *testing.T) {
	got, err := ObjectPath("dns/record", "dns/record/abc")
	want := "/api/ddi/v1/dns/record/abc"
	if err != nil {
		t.Fatalf("ObjectPath() error = %v, want nil", err)
	}
	if got != want {
		t.Fatalf("ObjectPath() = %q, want %q", got, want)
	}
}

func TestObjectPath_BareUUID_PrependsKind(t *testing.T) {
	got, err := ObjectPath("dns/record", "abc")
	want := "/api/ddi/v1/dns/record/abc"
	if err != nil {
		t.Fatalf("ObjectPath() error = %v, want nil", err)
	}
	if got != want {
		t.Fatalf("ObjectPath() = %q, want %q", got, want)
	}
}

func TestObjectPath_IPAMFullForm(t *testing.T) {
	got, err := ObjectPath("ipam/address", "ipam/address/xyz")
	want := "/api/ddi/v1/ipam/address/xyz"
	if err != nil {
		t.Fatalf("ObjectPath() error = %v, want nil", err)
	}
	if got != want {
		t.Fatalf("ObjectPath() = %q, want %q", got, want)
	}
}

func TestObjectPath_TrimsSlashesAndWhitespace(t *testing.T) {
	cases := []struct {
		name string
		kind string
		id   string
		want string
	}{
		{"leading/trailing slash on full-form", "dns/record", "/dns/record/abc/", "/api/ddi/v1/dns/record/abc"},
		{"whitespace around bare id", "dns/record", "  abc  ", "/api/ddi/v1/dns/record/abc"},
		{"whitespace and slash on full-form", "ipam/address", "  /ipam/address/xyz/  ", "/api/ddi/v1/ipam/address/xyz"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ObjectPath(tc.kind, tc.id)
			if err != nil {
				t.Fatalf("ObjectPath(%q, %q) error = %v, want nil", tc.kind, tc.id, err)
			}
			if got != tc.want {
				t.Fatalf("ObjectPath(%q, %q) = %q, want %q", tc.kind, tc.id, got, tc.want)
			}
		})
	}
}

// --- ObjectPath hardening: path traversal / type confusion -------------------

func TestObjectPath_Rejects(t *testing.T) {
	cases := []struct {
		name string
		kind string
		id   string
	}{
		{"bare traversal", "dns/record", "../../../etc"},
		{"full-form traversal suffix", "dns/record", "dns/record/../../x"},
		{"cross-type full-form id", "dns/record", "ipam/address/uuid"},
		{"encoded separator lowercase", "dns/record", "abc%2fdef"},
		{"encoded separator uppercase", "dns/record", "abc%2Fdef"},
		{"encoded separator full-form", "dns/record", "dns/record/abc%2fdef"},
		{"backslash", "dns/record", `abc\def`},
		{"empty id", "dns/record", ""},
		{"slash-only id", "dns/record", "///"},
		{"whitespace-and-slash-only id", "dns/record", "  /  "},
		{"dots-only segment", "dns/record", ".."},
		{"control character", "dns/record", "abc\x00def"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ObjectPath(tc.kind, tc.id)
			if err == nil {
				t.Fatalf("ObjectPath(%q, %q) = %q, want error", tc.kind, tc.id, got)
			}
		})
	}
}

func TestObjectPath_ValidFullFormAndBare(t *testing.T) {
	cases := []struct {
		name string
		kind string
		id   string
		want string
	}{
		{"valid full-form dns", "dns/record", "dns/record/abc123", "/api/ddi/v1/dns/record/abc123"},
		{"valid bare dns", "dns/record", "abc123", "/api/ddi/v1/dns/record/abc123"},
		{"valid full-form ipam", "ipam/address", "ipam/address/xyz", "/api/ddi/v1/ipam/address/xyz"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ObjectPath(tc.kind, tc.id)
			if err != nil {
				t.Fatalf("ObjectPath(%q, %q) unexpected error: %v", tc.kind, tc.id, err)
			}
			if got != tc.want {
				t.Fatalf("ObjectPath(%q, %q) = %q, want %q", tc.kind, tc.id, got, tc.want)
			}
		})
	}
}

func TestDNSRecordUpdate_FullFormID_NoDoubledPathPrefix(t *testing.T) {
	current := baseCurrent() // id: "dns/record/abc123"
	var writePaths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writePaths = append(writePaths, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"result": current})
	}))
	defer srv.Close()
	c := newTestClient(srv)

	// Full-form id, exactly as returned by GET /api/dns/records.
	_, status := c.DNSRecordUpdate(M{
		"id":      "dns/record/abc123",
		"comment": "updated",
	})
	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}

	wantPath := "/api/ddi/v1/dns/record/abc123"
	for _, p := range writePaths {
		if strings.Contains(p, "dns/record/dns/record") {
			t.Fatalf("doubled path prefix: %q", p)
		}
	}
	if len(writePaths) != 1 || writePaths[0] != wantPath {
		t.Fatalf("write paths = %v, want exactly one %q", writePaths, wantPath)
	}
}

func TestDNSRecordUpdate_ExpectedNeverInOutgoingBody(t *testing.T) {
	current := baseCurrent()
	var capturedBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"result": current})
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&capturedBody)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"result": current})
	}))
	defer srv.Close()
	c := newTestClient(srv)

	_, status := c.DNSRecordUpdate(M{
		"id":    "abc123",
		"value": "10.0.0.9",
		"expected": M{
			"value":   "10.0.0.1",
			"ttl":     float64(28800),
			"comment": "prod host",
		},
	})
	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	if _, present := capturedBody["expected"]; present {
		t.Fatalf("outgoing update body must never contain \"expected\", got: %v", capturedBody)
	}
}

// --- SelfserviceAllocate: tag-lookup GetStrict migration ---------------------

// TestSelfserviceAllocate_TagLookupUpstreamError_Returns502NotFalse404 is the
// regression test for the bug this migration fixes: Rest.Get swallowed a
// failed subnet-by-tag read into an empty slice, which SelfserviceAllocate
// then reported as "No subnet found with tag ..." — a wrong, misleading 404.
// A failed READ must 502, never masquerade as a genuine "no match" result.
func TestSelfserviceAllocate_TagLookupUpstreamError_Returns502NotFalse404(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
	}))
	defer srv.Close()
	c := newTestClient(srv)

	res, status := c.SelfserviceAllocate(M{"tag_key": "Env", "tag_value": "prod"})

	if status != 502 {
		t.Fatalf("status = %d, want 502 (upstream 500 must NOT become the 'No subnet found' 404); res=%v", status, res)
	}
	if resultOK(res) {
		t.Fatalf("ok = true, want false on upstream failure: %v", res)
	}
	if calls != 1 {
		t.Fatalf("upstream calls = %d, want exactly 1", calls)
	}
}

// resultOK mirrors internal/server's helper of the same name (not imported
// here — this package has no dependency on internal/server).
func resultOK(res M) bool { b, _ := res["ok"].(bool); return b }

// TestSelfserviceAllocate_TagLookupGenuineEmpty_Returns404NotFound confirms
// the original not-found behavior survives the migration: a successful read
// that genuinely finds no subnet with the tag still 404s with the original
// message, not a 502.
func TestSelfserviceAllocate_TagLookupGenuineEmpty_Returns404NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[]}`))
	}))
	defer srv.Close()
	c := newTestClient(srv)

	res, status := c.SelfserviceAllocate(M{"tag_key": "Env", "tag_value": "prod"})

	if status != 404 {
		t.Fatalf("status = %d, want 404; res=%v", status, res)
	}
	if res["error"] != "No subnet found with tag Env==prod" {
		t.Fatalf("error = %v, want original not-found message", res["error"])
	}
}
