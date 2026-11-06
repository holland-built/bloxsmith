package server

import (
	"net/http"
	"net/http/httptest"
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
	_, body, filter := findReq(t, "host", "web", `{"results":[{"id":"ipam/host/1","name":"web1","comment":"rack 4","addresses":[{"address":"10.0.0.5"},{"address":"10.0.0.6"}]}]}`)
	if filter != `name~"web" or comment~"web"` {
		t.Fatalf("_filter = %q", filter)
	}
	item := body["items"].([]any)[0].(map[string]any)
	f := item["fields"].(map[string]any)
	if item["id"] != "ipam/host/1" || f["addresses"] != "10.0.0.5, 10.0.0.6" || f["comment"] != "rack 4" {
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
