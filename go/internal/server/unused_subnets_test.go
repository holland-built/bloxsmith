package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"

	"bloxsmith/internal/dashboard"
)

// unusedUpstream fakes the subnet endpoint and records the last query it was
// sent. The handler runs on the test server's goroutine, so the query is held
// behind a mutex for -race.
func unusedUpstream(t *testing.T, body string) (*Deps, func() url.Values, func()) {
	t.Helper()
	var mu sync.Mutex
	var got url.Values
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		got = r.URL.Query()
		mu.Unlock()
		w.Write([]byte(body))
	})
	return d, func() url.Values { mu.Lock(); defer mu.Unlock(); return got }, closeSrv
}

func getUnused(d *Deps, query string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", "/api/ipam/subnets/unused"+query, nil)
	rr := httptest.NewRecorder()
	d.ipamUnusedSubnets(rr, req)
	return rr
}

// The list and the tenant-wide count in _totals.subnetsUnused must ask the
// same question, so the list sends the very constant the count sends.
func TestUnusedSubnets_SendsCountFilterOffsetLimitOrder(t *testing.T) {
	d, got, closeSrv := unusedUpstream(t, `{"results":[]}`)
	defer closeSrv()

	rr := getUnused(d, "?offset=100&limit=50")
	if rr.Code != 200 {
		t.Fatalf("status = %d, body=%s", rr.Code, rr.Body.String())
	}
	q := got()
	if q.Get("_filter") != dashboard.UnusedSubnetFilter {
		t.Fatalf("_filter = %q, want the count's filter %q", q.Get("_filter"), dashboard.UnusedSubnetFilter)
	}
	if q.Get("_offset") != "100" || q.Get("_limit") != "50" {
		t.Fatalf("_offset/_limit = %q/%q, want 100/50", q.Get("_offset"), q.Get("_limit"))
	}
	if q.Get("_order_by") != "address,id" {
		t.Fatalf("_order_by = %q, want a stable unique order address,id", q.Get("_order_by"))
	}
}

func TestUnusedSubnets_DefaultsToFirstPageOf50(t *testing.T) {
	d, got, closeSrv := unusedUpstream(t, `{"results":[]}`)
	defer closeSrv()

	if rr := getUnused(d, ""); rr.Code != 200 {
		t.Fatalf("status = %d, body=%s", rr.Code, rr.Body.String())
	}
	if q := got(); q.Get("_offset") != "0" || q.Get("_limit") != "50" {
		t.Fatalf("_offset/_limit = %q/%q, want 0/50", q.Get("_offset"), q.Get("_limit"))
	}
}

func TestUnusedSubnets_BadOffsetOrLimitRejected(t *testing.T) {
	d, got, closeSrv := unusedUpstream(t, `{"results":[]}`)
	defer closeSrv()

	for _, q := range []string{"?offset=-1", "?offset=abc", "?limit=0", "?limit=101", "?limit=x", "?offset=1.5"} {
		rr := getUnused(d, q)
		if rr.Code != 400 {
			t.Fatalf("%s: status = %d, want 400; body=%s", q, rr.Code, rr.Body.String())
		}
	}
	if got() != nil {
		t.Fatalf("a rejected request still reached upstream: %v", got())
	}
}

// Rows go through the same normalisation as the main table, so the table gets
// one row shape: addr/used/total/util/site/cloud.
func TestUnusedSubnets_RowsNormalisedLikeTheTable(t *testing.T) {
	d, _, closeSrv := unusedUpstream(t, `{"results":[
		{"id":"ipam/subnet/a","address":"10.0.0.0","cidr":24,"name":"",
		 "utilization":{"total":"256","used":"2","free":"254","utilization":1},
		 "tags":{"site":"Dallas"}}]}`)
	defer closeSrv()

	rr := getUnused(d, "?limit=1")
	body := decodeBody(t, rr)
	rows, _ := body["subnets"].([]any)
	if len(rows) != 1 {
		t.Fatalf("subnets = %v, want 1 row", body["subnets"])
	}
	row := rows[0].(map[string]any)
	want := map[string]any{"addr": "10.0.0.0", "used": 2.0, "total": 256.0, "util": 1.0, "site": "Dallas", "cloud": ""}
	for k, v := range want {
		if row[k] != v {
			t.Fatalf("row[%q] = %#v, want %#v; row=%v", k, row[k], v, row)
		}
	}
	// A full page (1 row of limit 1) says there may be more.
	if body["more"] != true {
		t.Fatalf("more = %v, want true for a full page", body["more"])
	}
}

// IPv6 rows report total 0, so the filter already leaves them out; any that
// arrive anyway are dropped. "more" still follows the upstream page size, so a
// dropped row never ends paging early.
func TestUnusedSubnets_IPv6Dropped(t *testing.T) {
	d, _, closeSrv := unusedUpstream(t, `{"results":[
		{"id":"a","address":"10.0.0.0","cidr":24,"utilization":{"total":"256","used":"2"}},
		{"id":"b","address":"2001:db8::","cidr":30,"utilization":{"total":"4","used":"2"}}]}`)
	defer closeSrv()

	body := decodeBody(t, getUnused(d, "?limit=2"))
	rows, _ := body["subnets"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["addr"] != "10.0.0.0" {
		t.Fatalf("subnets = %v, want only the IPv4 row", body["subnets"])
	}
	if body["more"] != true {
		t.Fatalf("more = %v, want true: upstream returned a full page of 2", body["more"])
	}
}

func TestUnusedSubnets_ShortPageHasNoMore(t *testing.T) {
	d, _, closeSrv := unusedUpstream(t, `{"results":[{"id":"a","address":"10.0.0.0","cidr":24,"utilization":{"total":"256","used":"2"}}]}`)
	defer closeSrv()

	body := decodeBody(t, getUnused(d, ""))
	if body["more"] != false {
		t.Fatalf("more = %v, want false for 1 row of 50", body["more"])
	}
}

func TestUnusedSubnets_UpstreamErrorIs502(t *testing.T) {
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
	})
	defer closeSrv()

	rr := getUnused(d, "")
	if rr.Code != 502 {
		t.Fatalf("status = %d, want 502", rr.Code)
	}
	if _, has := decodeBody(t, rr)["subnets"]; has {
		t.Fatalf("subnets present on upstream failure")
	}
}
