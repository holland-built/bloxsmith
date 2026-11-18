package edit

import (
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
)

// reverseFake is Infoblox for the reverse-zone check: zones maps a zone fqdn
// to its view, forward zone fz-1 lives in view dns/view/v1, and fail makes
// the zone list answer 400. Anything else goes to next when set.
type reverseFake struct {
	zones   map[string]string
	fail    bool
	lists   atomic.Int32
	filters []string
}

var (
	fqdnRe = regexp.MustCompile(`fqdn=="([^"]+)"`)
	viewRe = regexp.MustCompile(`view=="([^"]+)"`)
)

func (f *reverseFake) server(t *testing.T, next *httptest.Server) *httptest.Server {
	t.Helper()
	var proxy http.Handler
	if next != nil {
		u, _ := url.Parse(next.URL)
		proxy = httputil.NewSingleHostReverseProxy(u)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/ddi/v1/dns/auth_zone/fz-1":
			w.Write([]byte(`{"result":{"id":"dns/auth_zone/fz-1","fqdn":"example.com.","view":"dns/view/v1"}}`))
		case r.Method == "GET" && r.URL.Path == "/api/ddi/v1/dns/auth_zone":
			f.lists.Add(1)
			filter := r.URL.Query().Get("_filter")
			f.filters = append(f.filters, filter)
			if f.fail {
				w.WriteHeader(400)
				w.Write([]byte(`{"error":"no"}`))
				return
			}
			view := ""
			if m := viewRe.FindStringSubmatch(filter); m != nil {
				view = m[1]
			}
			var rows []string
			for _, m := range fqdnRe.FindAllStringSubmatch(filter, -1) {
				if v, ok := f.zones[m[1]]; ok && v == view {
					rows = append(rows, `{"fqdn":"`+m[1]+`"}`)
				}
			}
			w.Write([]byte(`{"results":[` + strings.Join(rows, ",") + `]}`))
		case proxy != nil:
			proxy.ServeHTTP(w, r)
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestReverseZone(t *testing.T) {
	for _, tc := range []struct {
		name  string
		zones map[string]string
		addr  string
		want  string
	}{
		{"found at the /24", map[string]string{"5.16.172.in-addr.arpa.": "dns/view/v1", "16.172.in-addr.arpa.": "dns/view/v1"},
			"172.16.5.9", "5.16.172.in-addr.arpa."},
		{"found at the parent /16", map[string]string{"16.172.in-addr.arpa.": "dns/view/v1"}, "172.16.5.9", "16.172.in-addr.arpa."},
		{"found at the /8", map[string]string{"10.in-addr.arpa.": "dns/view/v1"}, "10.1.2.3", "10.in-addr.arpa."},
		{"not found", map[string]string{"6.16.172.in-addr.arpa.": "dns/view/v1"}, "172.16.5.9", ""},
		{"only in another view", map[string]string{"5.16.172.in-addr.arpa.": "dns/view/other"}, "172.16.5.9", ""},
		{"IPv6 /48 parent", map[string]string{"8.b.d.0.1.0.0.2.ip6.arpa.": "dns/view/v1"}, "2001:db8::5", "8.b.d.0.1.0.0.2.ip6.arpa."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &reverseFake{zones: tc.zones}
			c := newTestClient(f.server(t, nil))
			got, err := c.reverseZone("dns/view/v1", netip.MustParseAddr(tc.addr))
			if err != nil || got != tc.want {
				t.Fatalf("reverseZone = %q, %v; want %q", got, err, tc.want)
			}
			if f.lists.Load() != 1 {
				t.Fatalf("zone list read %d times, want once", f.lists.Load())
			}
		})
	}
}

func TestReverseZone_LookupError(t *testing.T) {
	f := &reverseFake{fail: true}
	c := newTestClient(f.server(t, nil))
	if got, err := c.reverseZone("dns/view/v1", netip.MustParseAddr("172.16.5.9")); err == nil {
		t.Fatalf("reverseZone = %q, nil; want an error when the lookup fails", got)
	}
}

const (
	noReverse    = "No reverse zone covers 172.16.5.9, so no reverse (PTR) record will be made."
	reverseUnchk = "Could not check whether a reverse zone covers 172.16.5.9, so the reverse (PTR) record may not be made."
)

func dnsPreview(c *Client, ptr bool) M {
	res, _ := c.DNSRecordCreate(M{"zone_id": "dns/auth_zone/fz-1", "name_in_zone": "web", "type": "A",
		"value": "172.16.5.9", "create_ptr": ptr, "dry": true})
	return res
}

func TestDNSRecordPreview_ReverseNote(t *testing.T) {
	none := &reverseFake{zones: map[string]string{}}
	if got := dnsPreview(newTestClient(none.server(t, nil)), true)["reverse_note"]; got != noReverse {
		t.Fatalf("no reverse zone: reverse_note = %v, want %q", got, noReverse)
	}
	have := &reverseFake{zones: map[string]string{"16.172.in-addr.arpa.": "dns/view/v1"}}
	if got, ok := dnsPreview(newTestClient(have.server(t, nil)), true)["reverse_note"]; ok {
		t.Fatalf("reverse zone exists: reverse_note = %v, want none", got)
	}
	broken := &reverseFake{fail: true}
	if got := dnsPreview(newTestClient(broken.server(t, nil)), true)["reverse_note"]; got != reverseUnchk {
		t.Fatalf("lookup failed: reverse_note = %v, want %q", got, reverseUnchk)
	}
	unasked := &reverseFake{zones: map[string]string{}}
	if got, ok := dnsPreview(newTestClient(unasked.server(t, nil)), false)["reverse_note"]; ok || unasked.lists.Load() != 0 {
		t.Fatalf("no PTR asked for: reverse_note = %v, lookups %d; want neither", got, unasked.lists.Load())
	}
}

// Get an address: the note names the address the preview offers (10.0.0.1).
func TestAllocatePreview_ReverseNote(t *testing.T) {
	f := &reverseFake{zones: map[string]string{}}
	srv := f.server(t, sharedAllocServer(t, ""))
	res, status := newTestClient(srv).SelfserviceAllocate(M{"subnet_id": "ipam/subnet/s-1", "count": float64(1), "dry": true,
		"dns": M{"zone_id": "dns/auth_zone/fz-1", "name": "web", "type": "A", "create_ptr": true}})
	want := "No reverse zone covers 10.0.0.1, so no reverse (PTR) record will be made."
	if status != 200 || res["reverse_note"] != want {
		t.Fatalf("= %d reverse_note %v, want %q (%v)", status, res["reverse_note"], want, res)
	}

	g := &reverseFake{zones: map[string]string{"0.0.10.in-addr.arpa.": "dns/view/v1"}}
	srv = g.server(t, sharedAllocServer(t, ""))
	res, _ = newTestClient(srv).SelfserviceAllocate(M{"subnet_id": "ipam/subnet/s-1", "count": float64(1), "dry": true,
		"dns": M{"zone_id": "dns/auth_zone/fz-1", "name": "web", "type": "A", "create_ptr": true}})
	if got, ok := res["reverse_note"]; ok {
		t.Fatalf("reverse zone exists: reverse_note = %v, want none", got)
	}
}

// Reserve for a device: the note names the address the reservation would get.
func TestReservePreview_ReverseNote(t *testing.T) {
	f := &reverseFake{zones: map[string]string{}}
	srv := f.server(t, newResvFake(t, resvConfig{}).srv)
	body := reserveBody(true, M{"mac": "aa:bb:cc:dd:ee:01"})
	body["dns"] = M{"zone_id": "dns/auth_zone/fz-1", "name": "printer", "type": "A", "create_ptr": true}
	res, status := newTestClient(srv).SelfserviceAllocate(body)
	want := "No reverse zone covers 10.7.0.9, so no reverse (PTR) record will be made."
	if status != 200 || res["reverse_note"] != want {
		t.Fatalf("= %d reverse_note %v, want %q (%v)", status, res["reverse_note"], want, res)
	}
}
