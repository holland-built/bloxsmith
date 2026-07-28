package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"bloxsmith/internal/config"
	"bloxsmith/internal/rest"
)

// newTestDeps wires a minimal Deps whose Rest client points at an
// httptest.Server running the given handler, mirroring the upstream CSP API.
func newTestDeps(t *testing.T, upstream http.HandlerFunc) (*Deps, func()) {
	t.Helper()
	srv := httptest.NewServer(upstream)
	auth := rest.NewAuth("test-key", nil)
	d := &Deps{
		Cfg:  &config.Config{Port: "8080"},
		Rest: rest.New(srv.URL, auth),
	}
	return d, srv.Close
}

func decodeBody(t *testing.T, rr *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode response body %q: %v", rr.Body.String(), err)
	}
	return m
}

// --- dnsRecordsGet -----------------------------------------------------------

func TestDNSRecordsGet_DefaultLimit(t *testing.T) {
	var gotLimit string
	calls := 0
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		gotLimit = r.URL.Query().Get("_limit")
		w.Write([]byte(`{"results":[]}`))
	})
	defer closeSrv()

	req := httptest.NewRequest("GET", "/api/dns/records?zone=example.com", nil)
	rr := httptest.NewRecorder()
	d.dnsRecordsGet(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	// Default is 200; the single upstream fetch always asks for limit+1 = 201.
	if gotLimit != "201" {
		t.Fatalf("upstream _limit = %q, want 201 (default 200 + 1 for truncation probe)", gotLimit)
	}
	if calls != 1 {
		t.Fatalf("upstream calls = %d, want exactly 1", calls)
	}
}

func TestDNSRecordsGet_LimitValidation(t *testing.T) {
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[]}`))
	})
	defer closeSrv()

	bad := []string{"abc", "0", "-5", "5000", "1000"}
	for _, v := range bad {
		req := httptest.NewRequest("GET", "/api/dns/records?zone=example.com&_limit="+v, nil)
		rr := httptest.NewRecorder()
		d.dnsRecordsGet(rr, req)
		if rr.Code != 400 {
			t.Fatalf("_limit=%s: status = %d, want 400; body=%s", v, rr.Code, rr.Body.String())
		}
		body := decodeBody(t, rr)
		if body["error"] != "_limit must be an integer between 1 and 999" {
			t.Fatalf("_limit=%s: error = %v, want the validation message", v, body["error"])
		}
	}

	req := httptest.NewRequest("GET", "/api/dns/records?zone=example.com&_limit=1", nil)
	rr := httptest.NewRecorder()
	d.dnsRecordsGet(rr, req)
	if rr.Code != 200 {
		t.Fatalf("_limit=1: status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}

	req = httptest.NewRequest("GET", "/api/dns/records?zone=example.com&_limit=999", nil)
	rr = httptest.NewRecorder()
	d.dnsRecordsGet(rr, req)
	if rr.Code != 200 {
		t.Fatalf("_limit=999: status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
}

func TestDNSRecordsGet_UpstreamErrorIs502NotEmptySuccess(t *testing.T) {
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
	})
	defer closeSrv()

	req := httptest.NewRequest("GET", "/api/dns/records?zone=example.com", nil)
	rr := httptest.NewRecorder()
	d.dnsRecordsGet(rr, req)

	if rr.Code != 502 {
		t.Fatalf("status = %d, want 502 (upstream 500 must NOT become a 200 empty list); body=%s", rr.Code, rr.Body.String())
	}
	body := decodeBody(t, rr)
	if _, has := body["records"]; has {
		t.Fatalf("body has 'records' key on upstream failure, want error-only response: %v", body)
	}
	if body["error"] != "upstream request failed" {
		t.Fatalf("error = %v, want 'upstream request failed'", body["error"])
	}
}

func TestDNSRecordsGet_WithTotal(t *testing.T) {
	var gotLimit string
	calls := 0
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		gotLimit = r.URL.Query().Get("_limit")
		w.Write([]byte(`{"results":[{"id":"1","name_in_zone":"a","type":"A","ttl":300,"dns_rdata":{},"comment":"","disabled":false}],"total_count":42}`))
	})
	defer closeSrv()

	req := httptest.NewRequest("GET", "/api/dns/records?zone=example.com&_limit=5", nil)
	rr := httptest.NewRecorder()
	d.dnsRecordsGet(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	if gotLimit != "6" {
		t.Fatalf("upstream _limit = %q, want 6 (single fetch always requests limit+1)", gotLimit)
	}
	if calls != 1 {
		t.Fatalf("upstream calls = %d, want exactly 1", calls)
	}
	body := decodeBody(t, rr)
	if total, ok := body["total"].(float64); !ok || int(total) != 42 {
		t.Fatalf("total = %v, want 42", body["total"])
	}
	if limit, ok := body["limit"].(float64); !ok || int(limit) != 5 {
		t.Fatalf("limit = %v, want 5", body["limit"])
	}
	if _, has := body["truncated"]; has {
		t.Fatalf("truncated key present when a total was found, want it omitted: %v", body)
	}
	records, ok := body["records"].([]any)
	if !ok || len(records) != 1 {
		t.Fatalf("records = %v, want 1 row", body["records"])
	}
	row := records[0].(map[string]any)
	for _, k := range []string{"id", "name_in_zone", "type", "ttl", "dns_rdata", "comment", "disabled"} {
		if _, has := row[k]; !has {
			t.Fatalf("record row missing key %q: %v", k, row)
		}
	}
}

func TestDNSRecordsGet_NoTotalTruncated(t *testing.T) {
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		// Serves 3 rows regardless of the requested _limit: the first
		// (no-total) probe fetch asks for limit+1=3, gets 3 back -> truncated.
		rows := `{"id":"1","name_in_zone":"a","type":"A","ttl":1,"dns_rdata":{},"comment":"","disabled":false}`
		w.Write([]byte(`{"results":[` + rows + `,` + rows + `,` + rows + `]}`))
	})
	defer closeSrv()

	req := httptest.NewRequest("GET", "/api/dns/records?zone=example.com&_limit=2", nil)
	rr := httptest.NewRecorder()
	d.dnsRecordsGet(rr, req)

	body := decodeBody(t, rr)
	if body["truncated"] != true {
		t.Fatalf("truncated = %v, want true", body["truncated"])
	}
	records := body["records"].([]any)
	if len(records) != 2 {
		t.Fatalf("records = %d rows, want exactly 2 (the requested limit, extra probe row dropped)", len(records))
	}
	if _, has := body["total"]; has {
		t.Fatalf("total present when none was found upstream, want it omitted (never invent a total): %v", body)
	}
}

func TestDNSRecordsGet_NoTotalNotTruncated(t *testing.T) {
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		row := `{"id":"1","name_in_zone":"a","type":"A","ttl":1,"dns_rdata":{},"comment":"","disabled":false}`
		w.Write([]byte(`{"results":[` + row + `]}`))
	})
	defer closeSrv()

	req := httptest.NewRequest("GET", "/api/dns/records?zone=example.com&_limit=2", nil)
	rr := httptest.NewRecorder()
	d.dnsRecordsGet(rr, req)

	body := decodeBody(t, rr)
	if body["truncated"] != false {
		t.Fatalf("truncated = %v, want false", body["truncated"])
	}
	records := body["records"].([]any)
	if len(records) != 1 {
		t.Fatalf("records = %d rows, want 1", len(records))
	}
}

func TestDNSRecordsGet_CountKeyIsNotTrusted(t *testing.T) {
	// "count" alone is not a recognized total key (it commonly means "rows in
	// this page", not the collection total) -> falls back to truncated.
	calls := 0
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		row := `{"id":"1","name_in_zone":"a","type":"A","ttl":1,"dns_rdata":{},"comment":"","disabled":false}`
		w.Write([]byte(`{"results":[` + row + `,` + row + `,` + row + `],"count":3}`))
	})
	defer closeSrv()

	req := httptest.NewRequest("GET", "/api/dns/records?zone=example.com&_limit=2", nil)
	rr := httptest.NewRecorder()
	d.dnsRecordsGet(rr, req)

	body := decodeBody(t, rr)
	if _, has := body["total"]; has {
		t.Fatalf("total present from a bare 'count' key, want it rejected: %v", body)
	}
	if body["truncated"] != true {
		t.Fatalf("truncated = %v, want true (fell back since 'count' isn't trusted)", body["truncated"])
	}
	if calls != 1 {
		t.Fatalf("upstream calls = %d, want exactly 1", calls)
	}
}

func TestDNSRecordsGet_TotalSmallerThanRowsIsRejected(t *testing.T) {
	// A candidate total less than the rows actually returned is definitionally
	// not a collection total -> rejected, falls back to truncated.
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		row := `{"id":"1","name_in_zone":"a","type":"A","ttl":1,"dns_rdata":{},"comment":"","disabled":false}`
		w.Write([]byte(`{"results":[` + row + `,` + row + `,` + row + `],"total_count":1}`))
	})
	defer closeSrv()

	req := httptest.NewRequest("GET", "/api/dns/records?zone=example.com&_limit=2", nil)
	rr := httptest.NewRecorder()
	d.dnsRecordsGet(rr, req)

	body := decodeBody(t, rr)
	if _, has := body["total"]; has {
		t.Fatalf("total present despite total_count(1) < rows returned(3), want it rejected: %v", body)
	}
	if body["truncated"] != true {
		t.Fatalf("truncated = %v, want true", body["truncated"])
	}
}

// --- ipamAddressesGet ---------------------------------------------------------

func TestIPAMAddressesGet_DefaultLimit(t *testing.T) {
	var gotLimit string
	calls := 0
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		gotLimit = r.URL.Query().Get("_limit")
		w.Write([]byte(`{"results":[]}`))
	})
	defer closeSrv()

	req := httptest.NewRequest("GET", "/api/ipam/addresses?subnet=abc", nil)
	rr := httptest.NewRecorder()
	d.ipamAddressesGet(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	if gotLimit != "201" {
		t.Fatalf("upstream _limit = %q, want 201", gotLimit)
	}
	if calls != 1 {
		t.Fatalf("upstream calls = %d, want exactly 1", calls)
	}
}

func TestIPAMAddressesGet_LimitValidation(t *testing.T) {
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[]}`))
	})
	defer closeSrv()

	bad := []string{"abc", "0", "-5", "5000", "1000"}
	for _, v := range bad {
		req := httptest.NewRequest("GET", "/api/ipam/addresses?subnet=abc&_limit="+v, nil)
		rr := httptest.NewRecorder()
		d.ipamAddressesGet(rr, req)
		if rr.Code != 400 {
			t.Fatalf("_limit=%s: status = %d, want 400; body=%s", v, rr.Code, rr.Body.String())
		}
		body := decodeBody(t, rr)
		if body["error"] != "_limit must be an integer between 1 and 999" {
			t.Fatalf("_limit=%s: error = %v, want the validation message", v, body["error"])
		}
	}

	req := httptest.NewRequest("GET", "/api/ipam/addresses?subnet=abc&_limit=1", nil)
	rr := httptest.NewRecorder()
	d.ipamAddressesGet(rr, req)
	if rr.Code != 200 {
		t.Fatalf("_limit=1: status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}

	req = httptest.NewRequest("GET", "/api/ipam/addresses?subnet=abc&_limit=999", nil)
	rr = httptest.NewRecorder()
	d.ipamAddressesGet(rr, req)
	if rr.Code != 200 {
		t.Fatalf("_limit=999: status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
}

func TestIPAMAddressesGet_UpstreamErrorIs502NotEmptySuccess(t *testing.T) {
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
	})
	defer closeSrv()

	req := httptest.NewRequest("GET", "/api/ipam/addresses?subnet=abc", nil)
	rr := httptest.NewRecorder()
	d.ipamAddressesGet(rr, req)

	if rr.Code != 502 {
		t.Fatalf("status = %d, want 502; body=%s", rr.Code, rr.Body.String())
	}
	body := decodeBody(t, rr)
	if _, has := body["addresses"]; has {
		t.Fatalf("body has 'addresses' key on upstream failure: %v", body)
	}
}

func TestIPAMAddressesGet_WithTotal(t *testing.T) {
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[{"id":"1","address":"10.0.0.1","name":"host1","comment":"","state":"used"}],"page_info":{"total_size":7}}`))
	})
	defer closeSrv()

	req := httptest.NewRequest("GET", "/api/ipam/addresses?subnet=abc&_limit=10", nil)
	rr := httptest.NewRecorder()
	d.ipamAddressesGet(rr, req)

	body := decodeBody(t, rr)
	if total, ok := body["total"].(float64); !ok || int(total) != 7 {
		t.Fatalf("total = %v, want 7 (from nested page_info)", body["total"])
	}
	if _, has := body["truncated"]; has {
		t.Fatalf("truncated present with a total found: %v", body)
	}
	addrs := body["addresses"].([]any)
	row := addrs[0].(map[string]any)
	for _, k := range []string{"id", "address", "name", "comment", "state"} {
		if _, has := row[k]; !has {
			t.Fatalf("address row missing key %q: %v", k, row)
		}
	}
}

func TestIPAMAddressesGet_NoTotalTruncated(t *testing.T) {
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		row := `{"id":"1","address":"10.0.0.1","name":"h","comment":"","state":"used"}`
		w.Write([]byte(`{"results":[` + strings.Join([]string{row, row, row}, ",") + `]}`))
	})
	defer closeSrv()

	req := httptest.NewRequest("GET", "/api/ipam/addresses?subnet=abc&_limit=2", nil)
	rr := httptest.NewRecorder()
	d.ipamAddressesGet(rr, req)

	body := decodeBody(t, rr)
	if body["truncated"] != true {
		t.Fatalf("truncated = %v, want true", body["truncated"])
	}
	addrs := body["addresses"].([]any)
	if len(addrs) != 2 {
		t.Fatalf("addresses = %d rows, want 2", len(addrs))
	}
}

func TestIPAMAddressesGet_NoTotalNotTruncated(t *testing.T) {
	calls := 0
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		row := `{"id":"1","address":"10.0.0.1","name":"h","comment":"","state":"used"}`
		w.Write([]byte(`{"results":[` + row + `]}`))
	})
	defer closeSrv()

	req := httptest.NewRequest("GET", "/api/ipam/addresses?subnet=abc&_limit=2", nil)
	rr := httptest.NewRecorder()
	d.ipamAddressesGet(rr, req)

	body := decodeBody(t, rr)
	if body["truncated"] != false {
		t.Fatalf("truncated = %v, want false", body["truncated"])
	}
	if calls != 1 {
		t.Fatalf("upstream calls = %d, want exactly 1", calls)
	}
}

func TestIPAMAddressesGet_CountKeyIsNotTrusted(t *testing.T) {
	// "count" alone is not a recognized total key -> falls back to truncated.
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		row := `{"id":"1","address":"10.0.0.1","name":"h","comment":"","state":"used"}`
		w.Write([]byte(`{"results":[` + strings.Join([]string{row, row, row}, ",") + `],"count":3}`))
	})
	defer closeSrv()

	req := httptest.NewRequest("GET", "/api/ipam/addresses?subnet=abc&_limit=2", nil)
	rr := httptest.NewRecorder()
	d.ipamAddressesGet(rr, req)

	body := decodeBody(t, rr)
	if _, has := body["total"]; has {
		t.Fatalf("total present from a bare 'count' key, want it rejected: %v", body)
	}
	if body["truncated"] != true {
		t.Fatalf("truncated = %v, want true", body["truncated"])
	}
}

func TestIPAMAddressesGet_TotalSmallerThanRowsIsRejected(t *testing.T) {
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		row := `{"id":"1","address":"10.0.0.1","name":"h","comment":"","state":"used"}`
		w.Write([]byte(`{"results":[` + strings.Join([]string{row, row, row}, ",") + `],"page_info":{"total_size":1}}`))
	})
	defer closeSrv()

	req := httptest.NewRequest("GET", "/api/ipam/addresses?subnet=abc&_limit=2", nil)
	rr := httptest.NewRecorder()
	d.ipamAddressesGet(rr, req)

	body := decodeBody(t, rr)
	if _, has := body["total"]; has {
		t.Fatalf("total present despite total_size(1) < rows returned(3), want it rejected: %v", body)
	}
	if body["truncated"] != true {
		t.Fatalf("truncated = %v, want true", body["truncated"])
	}
}
