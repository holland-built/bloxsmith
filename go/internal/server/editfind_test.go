package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func findReq(t *testing.T, typ, q, reply string) (int, map[string]any, string) {
	t.Helper()
	var filter string
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		filter = r.URL.Query().Get("_filter")
		w.Write([]byte(reply))
	})
	defer closeSrv()
	req := httptest.NewRequest("GET", "/api/edit/"+typ+"/find?q="+q, nil)
	req.SetPathValue("type", typ)
	rr := httptest.NewRecorder()
	d.editFind(rr, req)
	if rr.Code != 200 {
		return rr.Code, nil, filter
	}
	return rr.Code, decodeBody(t, rr), filter
}

func TestEditFind_HostCarriesTheFormValues(t *testing.T) {
	_, body, filter := findReq(t, "host", "web", `{"results":[{"id":"ipam/host/1","name":"web1","comment":"rack 4","addresses":[{"address":"10.0.0.5","space":"ipam/ip_space/9"},{"address":"10.0.0.6","space":"ipam/ip_space/4"}]}]}`)
	if filter != `name~"web" or comment~"web"` {
		t.Fatalf("_filter = %q", filter)
	}
	item := body["items"].([]any)[0].(map[string]any)
	f := item["fields"].(map[string]any)
	if item["id"] != "ipam/host/1" || f["addresses"] != "10.0.0.5, 10.0.0.6" || f["comment"] != "rack 4" || f["spaces"] != "10.0.0.5=ipam/ip_space/9, 10.0.0.6=ipam/ip_space/4" {
		t.Fatalf("item = %v", item)
	}
}

// CSP answers 500 to ~ on a subnet's address (checked live), so a full IP
// matches the address exactly.
func TestEditFind_SubnetByIPIsExact(t *testing.T) {
	_, body, filter := findReq(t, "subnet", "10.1.2.0", `{"results":[{"id":"ipam/subnet/9","address":"10.1.2.0","cidr":24,"name":"lab","parent":"ipam/address_block/3","tags":{"b":"2","a":"1"}}]}`)
	if filter != `address=="10.1.2.0"` {
		t.Fatalf("_filter = %q", filter)
	}
	item := body["items"].([]any)[0].(map[string]any)
	f := item["fields"].(map[string]any)
	if item["label"] != "10.1.2.0/24 — lab" || f["block_id"] != "ipam/address_block/3" || f["tags"] != "a=1, b=2" {
		t.Fatalf("item = %v", item)
	}
}

func TestEditFind_RejectsUnknownTypeAndCleansTheSearch(t *testing.T) {
	if code, _, _ := findReq(t, "atlas", "x", `{}`); code != 404 {
		t.Fatalf("unknown type got %d, want 404", code)
	}
	_, _, filter := findReq(t, "dns_zone", "pro(d", `{"results":[]}`)
	if !strings.Contains(filter, `fqdn~"prod"`) {
		t.Fatalf("_filter = %q, want the ( dropped", filter)
	}
}

// A deep link names the item by id. q alone can match more than the 25 find
// returns (98 blocks at 10.0.0.0 on one tenant), so with id the find asks for
// that one item and returns it in the same shape.
func TestEditFind_IDReturnsThatItemEvenWhenQMatchesMoreThan25(t *testing.T) {
	var filters []string
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		f := r.URL.Query().Get("_filter")
		filters = append(filters, f)
		if f == `id=="ipam/address_block/far"` {
			w.Write([]byte(`{"results":[{"id":"ipam/address_block/far","address":"10.0.0.0","cidr":8,"comment":"far"}]}`))
			return
		}
		var rows []string
		for i := 0; i < 25; i++ {
			rows = append(rows, fmt.Sprintf(`{"id":"ipam/address_block/n%d","address":"10.0.0.0","cidr":8}`, i))
		}
		w.Write([]byte(`{"results":[` + strings.Join(rows, ",") + `]}`))
	})
	defer closeSrv()
	req := httptest.NewRequest("GET", "/api/edit/address_block/find?q=10.0.0.0&id=ipam%2Faddress_block%2Ffar", nil)
	req.SetPathValue("type", "address_block")
	rr := httptest.NewRecorder()
	d.editFind(rr, req)
	if rr.Code != 200 {
		t.Fatalf("code %d: %s", rr.Code, rr.Body.String())
	}
	items := decodeBody(t, rr)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("got %d items, want just the one asked for (filters %v)", len(items), filters)
	}
	it := items[0].(map[string]any)
	if it["id"] != "ipam/address_block/far" || it["label"] != "10.0.0.0/8 — far" {
		t.Fatalf("item = %v", it)
	}
	if _, ok := it["fields"].(map[string]any); !ok {
		t.Fatalf("item has no fields: %v", it)
	}
}

func TestEditFind_IDOfAnotherKindOrPathIsRefused(t *testing.T) {
	for _, id := range []string{"ipam/subnet/1", "ipam/address_block/../x", `ipam/address_block/a"b`, "a/b/c"} {
		called := false
		d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) { called = true; w.Write([]byte(`{"results":[]}`)) })
		req := httptest.NewRequest("GET", "/api/edit/address_block/find?id="+url.QueryEscape(id), nil)
		req.SetPathValue("type", "address_block")
		rr := httptest.NewRecorder()
		d.editFind(rr, req)
		closeSrv()
		if rr.Code != 400 || called {
			t.Fatalf("id %q: code %d, upstream called %v; want 400 and no call", id, rr.Code, called)
		}
	}
}
