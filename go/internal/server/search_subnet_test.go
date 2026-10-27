package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A free address has no ipam/address row, so the search page has to be told
// which subnet holds it. The upstream is asked for every network address the
// IP could have; only the rows whose own prefix contains the IP come back,
// smallest subnet first.
func TestSearchSubnetKeepsOnlySubnetsThatHoldTheAddress(t *testing.T) {
	var filter string
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		filter = r.URL.Query().Get("_filter")
		w.Header().Set("Content-Type", "application/json")
		// 10.80.0.0/22 holds 10.80.0.5; 10.80.0.0/30 starts at the same
		// address but stops at .3; 10.0.0.0/8 holds it too.
		w.Write([]byte(`{"results":[
			{"id":"a","address":"10.0.0.0","cidr":8,"name":"big"},
			{"id":"b","address":"10.80.0.0","cidr":30,"name":"tiny"},
			{"id":"c","address":"10.80.0.0","cidr":22,"name":"dub-wired"}]}`))
	})
	defer closeSrv()

	rr := httptest.NewRecorder()
	d.searchSubnet(rr, httptest.NewRequest("GET", "/api/search/subnet?q=10.80.0.5", nil))
	var body struct {
		Availability string           `json:"availability"`
		Rows         []map[string]any `json:"rows"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Availability != "ok" || len(body.Rows) != 2 || body.Rows[0]["name"] != "dub-wired" || body.Rows[1]["name"] != "big" {
		t.Fatalf("want dub-wired then big, got %+v", body)
	}
	for _, want := range []string{`address=="10.0.0.0"`, `address=="10.80.0.0"`, `address=="10.80.0.5"`} {
		if !strings.Contains(filter, want) {
			t.Fatalf("filter %q is missing %s", filter, want)
		}
	}
}

// A name or an IPv6 address is not asked upstream at all.
func TestSearchSubnetOnlyAsksForIPv4(t *testing.T) {
	called := false
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) { called = true })
	defer closeSrv()
	for _, q := range []string{"host.example.com", "fd10::1", ""} {
		rr := httptest.NewRecorder()
		d.searchSubnet(rr, httptest.NewRequest("GET", "/api/search/subnet?q="+q, nil))
		if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"availability":"empty"`) {
			t.Fatalf("q=%q: got %d %s", q, rr.Code, rr.Body.String())
		}
	}
	if called {
		t.Fatal("upstream was asked about something that is not an IPv4 address")
	}
}
