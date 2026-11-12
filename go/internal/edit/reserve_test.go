package edit

// Tests for reserveForDevice (reserve.go): Get an address's "Reserve for a
// device" choice. All upstream traffic is an httptest fake; none of these may
// be pointed at a live tenant.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type resvReq struct {
	method, path, filter string
	body                 M
}

type resvConfig struct {
	existing    string // body for GET dhcp/fixed_address (the MAC check); "" => no results
	fixedStatus int    // POST dhcp/fixed_address (0 => 201)
	dnsStatus   int    // POST dns/record (0 => 201)
}

type resvFake struct {
	srv  *httptest.Server
	mu   sync.Mutex
	reqs []resvReq
}

const resvSubnet = "ipam/subnet/s-1"

func newResvFake(t *testing.T, cfg resvConfig) *resvFake {
	t.Helper()
	f := &resvFake{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body M
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		f.mu.Lock()
		f.reqs = append(f.reqs, resvReq{r.Method, r.URL.Path, r.URL.Query().Get("_filter"), body})
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		p := r.URL.Path
		switch {
		case r.Method == "GET" && p == "/api/ddi/v1/"+resvSubnet:
			_, _ = io.WriteString(w, `{"result":{"address":"10.7.0.0","cidr":24,"space":"ipam/ip_space/sp-1"}}`)
		case r.Method == "GET" && p == "/api/ddi/v1/dhcp/fixed_address":
			_, _ = io.WriteString(w, allocStringOr(cfg.existing, `{"results":[]}`))
		case r.Method == "GET" && strings.HasSuffix(p, "/nextavailableip"):
			_, _ = io.WriteString(w, `{"results":[{"address":"10.7.0.9"}]}`)
		case r.Method == "POST" && p == "/api/ddi/v1/dhcp/fixed_address":
			st := allocStatusOr(cfg.fixedStatus, 201)
			w.WriteHeader(st)
			if st < 300 {
				_, _ = io.WriteString(w, `{"result":{"id":"dhcp/fixed_address/f-1","address":"10.7.0.9"}}`)
			} else if st < 500 {
				_, _ = io.WriteString(w, `{"error":[{"message":"refused"}]}`)
			}
		case r.Method == "POST" && p == "/api/ddi/v1/dns/record":
			st := allocStatusOr(cfg.dnsStatus, 201)
			w.WriteHeader(st)
			_, _ = io.WriteString(w, `{"result":{"id":"dns/record/r-1"}}`)
		default:
			t.Errorf("unexpected upstream call %s %s", r.Method, p)
			w.WriteHeader(500)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *resvFake) all() []resvReq {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]resvReq(nil), f.reqs...)
}

func (f *resvFake) writes() []resvReq {
	var w []resvReq
	for _, r := range f.all() {
		if r.method != "GET" {
			w = append(w, r)
		}
	}
	return w
}

func reserveBody(dry bool, dhcp any) M {
	return M{"subnet_id": resvSubnet, "dry": dry, "dhcp": dhcp}
}

func TestReserveRefusesBadInputBeforeAnyCall(t *testing.T) {
	cases := map[string]M{
		"bad mac":        reserveBody(false, M{"mac": "not-a-mac"}),
		"8-byte mac":     reserveBody(false, M{"mac": "00:11:22:33:44:55:66:77"}),
		"dhcp not a map": reserveBody(false, "aa:bb:cc:dd:ee:ff"),
		"two addresses":  {"subnet_id": resvSubnet, "dry": false, "count": 2, "dhcp": M{"mac": "aa:bb:cc:dd:ee:ff"}},
		"bad dns":        {"subnet_id": resvSubnet, "dry": false, "dhcp": M{"mac": "aa:bb:cc:dd:ee:ff"}, "dns": M{"type": "MX", "value": "x"}},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			f := newResvFake(t, resvConfig{})
			res, status := f.client().SelfserviceAllocate(body)
			if status != 400 || res["ok"] != false {
				t.Fatalf("want 400 ok:false, got %d %v", status, res)
			}
			if n := len(f.writes()); n != 0 {
				t.Fatalf("a refused request wrote %d time(s) upstream", n)
			}
		})
	}
}

func TestReservePreviewChecksMACAndWritesNothing(t *testing.T) {
	f := newResvFake(t, resvConfig{})
	res, status := f.client().SelfserviceAllocate(reserveBody(true, M{"mac": "AA-BB-CC-DD-EE-01", "name": "printer-3"}))
	if status != 200 || res["dry_run"] != true {
		t.Fatalf("want a 200 preview, got %d %v", status, res)
	}
	fixed := asMap(res["fixed_address"])
	if fixed["address"] != "10.7.0.9" || fixed["mac"] != "aa:bb:cc:dd:ee:01" || fixed["name"] != "printer-3" {
		t.Fatalf("preview should name the address, the normalised MAC and the device: %v", fixed)
	}
	if n := len(f.writes()); n != 0 {
		t.Fatalf("a preview wrote %d time(s) upstream", n)
	}
	checked := false
	for _, r := range f.all() {
		if r.path == "/api/ddi/v1/dhcp/fixed_address" && strings.Contains(r.filter, `"aa:bb:cc:dd:ee:01"`) {
			checked = true
		}
	}
	if !checked {
		t.Fatal("the preview did not look for an existing reservation on that MAC")
	}
}

func TestReserveRefusesAMACThatAlreadyHasOne(t *testing.T) {
	for _, dry := range []bool{true, false} {
		f := newResvFake(t, resvConfig{existing: `{"results":[{"address":"10.7.0.40","name":"old-printer"}]}`})
		res, status := f.client().SelfserviceAllocate(reserveBody(dry, M{"mac": "aa:bb:cc:dd:ee:01"}))
		if status != 409 || !strings.Contains(pyStr(res["error"]), "10.7.0.40") {
			t.Fatalf("dry=%v: want 409 naming the existing address, got %d %v", dry, status, res)
		}
		if n := len(f.writes()); n != 0 {
			t.Fatalf("dry=%v: wrote %d time(s) despite the existing reservation", dry, n)
		}
	}
}

func TestReserveCreatesTheFixedAddressOnThePreviewedAddress(t *testing.T) {
	f := newResvFake(t, resvConfig{})
	res, status := f.client().SelfserviceAllocate(reserveBody(false,
		M{"mac": "aa:bb:cc:dd:ee:01", "name": "printer-3", "address": "10.7.0.9"}))
	if status != 200 || res["ok"] != true {
		t.Fatalf("want 200 ok, got %d %v", status, res)
	}
	w := f.writes()
	if len(w) != 1 || w[0].path != "/api/ddi/v1/dhcp/fixed_address" {
		t.Fatalf("want exactly one write, the fixed address; got %+v", w)
	}
	want := M{"address": "10.7.0.9", "match_type": "mac", "match_value": "aa:bb:cc:dd:ee:01",
		"name": "printer-3", "ip_space": "ipam/ip_space/sp-1"}
	for k, v := range want {
		if w[0].body[k] != v {
			t.Errorf("fixed address body %s = %v, want %v", k, w[0].body[k], v)
		}
	}
	for _, r := range f.all() {
		if strings.HasSuffix(r.path, "/nextavailableip") {
			t.Fatal("with a previewed address it must not ask for the next free one")
		}
	}
	if asMap(res["fixed_address"])["id"] != "dhcp/fixed_address/f-1" {
		t.Fatalf("result should carry the new reservation's id: %v", res)
	}
}

func TestReserveRefusesAnAddressOutsideTheSubnet(t *testing.T) {
	f := newResvFake(t, resvConfig{})
	res, status := f.client().SelfserviceAllocate(reserveBody(false, M{"mac": "aa:bb:cc:dd:ee:01", "address": "10.8.0.9"}))
	if status != 400 || res["ok"] != false {
		t.Fatalf("want 400, got %d %v", status, res)
	}
	if n := len(f.writes()); n != 0 {
		t.Fatalf("wrote %d time(s) for an address outside the subnet", n)
	}
}

func TestReserveRefusedLeavesNothingToRelease(t *testing.T) {
	f := newResvFake(t, resvConfig{fixedStatus: 409})
	res, status := f.client().SelfserviceAllocate(reserveBody(false, M{"mac": "aa:bb:cc:dd:ee:01"}))
	if status != 409 || res["ok"] != false || !strings.Contains(pyStr(res["error"]), "nothing was created") {
		t.Fatalf("want 409 'nothing was created', got %d %v", status, res)
	}
	if n := len(f.writes()); n != 1 {
		t.Fatalf("want only the refused create, got %d writes", n)
	}
}

func TestReserveUnknownOutcomeIsReportedNotRetried(t *testing.T) {
	f := newResvFake(t, resvConfig{fixedStatus: 504})
	res, _ := f.client().SelfserviceAllocate(reserveBody(false, M{"mac": "aa:bb:cc:dd:ee:01"}))
	if res[CreatedUnreadableKey] != true || has(res, "ok") {
		t.Fatalf("an unanswered create must be reported as maybe-made, neither ok nor failed: %v", res)
	}
	if n := len(f.writes()); n != 1 {
		t.Fatalf("want one create and no retry or delete, got %d writes", n)
	}
}

func TestReserveKeepsTheReservationWhenDNSFails(t *testing.T) {
	f := newResvFake(t, resvConfig{dnsStatus: 400})
	res, status := f.client().SelfserviceAllocate(M{"subnet_id": resvSubnet, "dry": false,
		"dhcp": M{"mac": "aa:bb:cc:dd:ee:01"}, "dns": M{"zone_id": "dns/auth_zone/z-1", "name": "printer-3"}})
	if status != 502 || res["ok"] != false || asMap(res["fixed_address"])["ok"] != true {
		t.Fatalf("want ok:false with the reservation still reported made, got %d %v", status, res)
	}
	for _, r := range f.writes() {
		if r.method == "DELETE" {
			t.Fatal("a failed DNS record must not release the reservation")
		}
	}
	if !strings.Contains(pyStr(res["error"]), "reservation was made") {
		t.Fatalf("the error should say the reservation was made: %v", res["error"])
	}
}

func (f *resvFake) client() *Client { return newTestClient(f.srv) }

func TestReserveDNSTimeoutSaysTheRecordMayExist(t *testing.T) {
	f := newResvFake(t, resvConfig{dnsStatus: 504})
	res, _ := f.client().SelfserviceAllocate(M{"subnet_id": resvSubnet, "dry": false,
		"dhcp": M{"mac": "aa:bb:cc:dd:ee:01"}, "dns": M{"zone_id": "dns/auth_zone/z-1", "name": "printer-3"}})
	if res[CreatedUnreadableKey] != true || has(res, "ok") || asMap(res["fixed_address"])["ok"] != true {
		t.Fatalf("a DNS timeout must say the record may exist and the reservation was made: %v", res)
	}
	if strings.Contains(pyStr(res["error"]), "add the record on its own") {
		t.Fatal("must not suggest adding a record that may already exist")
	}
}
