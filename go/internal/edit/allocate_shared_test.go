package edit

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// sharedAllocServer is subnet s-1 (10.0.0.0/24 in sp-1). Infoblox's
// nextavailableip offers 10.0.0.1 and 10.0.0.2; fixed is the reservation rows
// the free check reads.
func sharedAllocServer(t *testing.T, fixed string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		q := r.URL.Query()
		switch {
		case q.Get("_order_by") != "":
			rows := ""
			switch {
			case q.Get("_offset") != "0":
			case strings.HasSuffix(r.URL.Path, "/ipam/ip_space"):
				rows = `{"id":"ipam/ip_space/sp-1","name":"corp"},{"id":"ipam/ip_space/sp-2","name":"default-TK-lab"}`
			case strings.HasSuffix(r.URL.Path, "/dhcp/fixed_address"):
				rows = fixed
			}
			w.Write([]byte(`{"results":[` + rows + `]}`))
		case strings.HasSuffix(r.URL.Path, "/nextavailableip"):
			w.Write([]byte(`{"results":[{"address":"10.0.0.1"},{"address":"10.0.0.2"}]}`))
		case strings.HasSuffix(r.URL.Path, "/ipam/subnet/s-1"):
			w.Write([]byte(`{"result":{"address":"10.0.0.0","cidr":24,"space":"ipam/ip_space/sp-1"}}`))
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

const labFixed = `{"id":"dhcp/fixed_address/f","ip_space":"ipam/ip_space/sp-2","address":"%s"}`

// Get an address: an address only another IP space reserves is not refused,
// but one no other space uses is preferred.
func TestAllocatePreview_PrefersAnAddressNoOtherSpaceUses(t *testing.T) {
	srv := sharedAllocServer(t, strings.Replace(labFixed, "%s", "10.0.0.1", 1))
	res, status := newTestClient(srv).SelfserviceAllocate(M{"subnet_id": "ipam/subnet/s-1", "count": float64(1)})
	addrs, _ := res["addresses"].([]any)
	if status != 200 || len(addrs) != 1 || asMap(addrs[0])["address"] != "10.0.0.2" {
		t.Fatalf("= %d %v, want 10.0.0.2 offered", status, res)
	}
	if ws, _ := res["warnings"].([]any); len(ws) != 0 {
		t.Fatalf("warnings = %v, want none", ws)
	}
}

// When every offered address is used in another space, the first is offered,
// with the warning next to it.
func TestAllocatePreview_OffersAWarnedAddressWhenNoneIsClean(t *testing.T) {
	srv := sharedAllocServer(t, strings.Replace(labFixed, "%s", "10.0.0.1", 1)+","+
		strings.Replace(strings.Replace(labFixed, "%s", "10.0.0.2", 1), "fixed_address/f", "fixed_address/g", 1))
	res, status := newTestClient(srv).SelfserviceAllocate(M{"subnet_id": "ipam/subnet/s-1", "count": float64(1)})
	addrs, _ := res["addresses"].([]any)
	if status != 200 || len(addrs) != 1 || asMap(addrs[0])["address"] != "10.0.0.1" {
		t.Fatalf("= %d %v, want 10.0.0.1 offered", status, res)
	}
	ws, _ := res["warnings"].([]any)
	if len(ws) != 1 || asMap(ws[0])["space"] != "default-TK-lab" || asMap(ws[0])["kind"] != "reservation" {
		t.Fatalf("warnings = %v, want default-TK-lab's reservation", res["warnings"])
	}
	if asMap(res["checked"])["shared"] != 1 {
		t.Fatalf("checked = %v, want shared 1", res["checked"])
	}
}
