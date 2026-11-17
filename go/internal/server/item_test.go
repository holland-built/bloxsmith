package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A network is looked up by its address and size inside the IP space named,
// and the space's name comes back beside its id.
func TestItemNetworkByCIDRAndSpaceName(t *testing.T) {
	var subnetFilter string
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		f := r.URL.Query().Get("_filter")
		switch {
		case strings.HasSuffix(r.URL.Path, "/ipam/ip_space") && f == `name=="Corp"`:
			w.Write([]byte(`{"results":[{"id":"ipam/ip_space/s1"}]}`))
		case strings.HasSuffix(r.URL.Path, "/ipam/ip_space"):
			w.Write([]byte(`{"results":[{"id":"ipam/ip_space/s1","name":"Corp"}]}`))
		case strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			subnetFilter = f
			w.Write([]byte(`{"results":[{"id":"ipam/subnet/n1","address":"10.1.0.0","cidr":24,"name":"dub-wired","space":"ipam/ip_space/s1"}]}`))
		default:
			t.Errorf("unexpected upstream call %s", r.URL)
		}
	})
	defer closeSrv()

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/item/network?q=10.1.0.0/24&space=Corp", nil)
	req.SetPathValue("kind", "network")
	d.itemGet(rr, req)
	body := decodeBody(t, rr)
	rows, _ := body["rows"].([]any)
	if body["availability"] != "ok" || len(rows) != 1 {
		t.Fatalf("want one ok row, got %+v", body)
	}
	row := rows[0].(map[string]any)
	if row["name"] != "dub-wired" || row["space_name"] != "Corp" {
		t.Fatalf("row = %+v", row)
	}
	for _, want := range []string{`address=="10.1.0.0"`, `cidr==24`, `space=="ipam/ip_space/s1"`} {
		if !strings.Contains(subnetFilter, want) {
			t.Fatalf("subnet filter %q is missing %s", subnetFilter, want)
		}
	}
}

// With an id, that one object is read; nothing is searched by value.
func TestItemZoneByID(t *testing.T) {
	var filter string
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/dns/auth_zone") {
			filter = r.URL.Query().Get("_filter")
			w.Write([]byte(`{"results":[{"id":"dns/auth_zone/z1","fqdn":"acme.corp.","view":"dns/view/v1"}]}`))
			return
		}
		w.Write([]byte(`{"results":[{"id":"dns/view/v1","name":"default"}]}`))
	})
	defer closeSrv()

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/item/zone?q=acme.corp&id=dns/auth_zone/z1", nil)
	req.SetPathValue("kind", "zone")
	d.itemGet(rr, req)
	body := decodeBody(t, rr)
	if filter != `id=="dns/auth_zone/z1"` {
		t.Fatalf("filter = %q", filter)
	}
	rows, _ := body["rows"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["view_name"] != "default" {
		t.Fatalf("body = %+v", body)
	}
}

// An id of another kind, or a network that is not a CIDR, is refused without
// asking Infoblox anything, and still answers 200.
func TestItemRefusesBadInputWithoutAsking(t *testing.T) {
	called := false
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) { called = true })
	defer closeSrv()
	for _, c := range []struct{ kind, query string }{
		{"network", "q=10.1.0.5"},
		{"network", "id=dns/auth_zone/z1"},
		{"zone", "id=../../x"},
		{"space", "q="},
	} {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/api/item/"+c.kind+"?"+c.query, nil)
		req.SetPathValue("kind", c.kind)
		d.itemGet(rr, req)
		if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"availability":"empty"`) {
			t.Fatalf("%s?%s: got %d %s", c.kind, c.query, rr.Code, rr.Body.String())
		}
	}
	if called {
		t.Fatal("upstream was asked about input that was refused")
	}
}

// A site is the site tag on subnets, asked with a tag filter.
func TestItemSiteUsesTagFilter(t *testing.T) {
	var tfilter string
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/ipam/subnet") {
			tfilter = r.URL.Query().Get("_tfilter")
		}
		w.Write([]byte(`{"results":[]}`))
	})
	defer closeSrv()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/item/site?q=dublin", nil)
	req.SetPathValue("kind", "site")
	d.itemGet(rr, req)
	if !strings.Contains(tfilter, `site=="dublin"`) || !strings.Contains(rr.Body.String(), `"availability":"ok"`) {
		t.Fatalf("tfilter %q body %s", tfilter, rr.Body.String())
	}
}

// The item route only reads, so the write lock must never refuse it.
func TestItemRouteIsAReadNotAWrite(t *testing.T) {
	rr := &recordingRouter{}
	(&Deps{}).registerItemRoutes(rr)
	if len(rr.patterns) != 1 || rr.patterns[0] != "GET /api/item/{kind}" {
		t.Fatalf("registered %v", rr.patterns)
	}
	if isTenantWrite("/api/item/network") {
		t.Fatal("isTenantWrite says /api/item changes the tenant")
	}
}
