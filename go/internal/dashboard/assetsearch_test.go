package dashboard

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// The address search: an IP or MAC typed in the Assets search box goes to the
// asset search API, anything else stays a name search on the cube.

func TestAddressQuery_SpotsAddressesAndSpellsThemTheWayTheSearchMatches(t *testing.T) {
	cases := []struct {
		in, field, value string
	}{
		{"172.17.0.4", "ip_addresses", "172.17.0.4"},
		{"  10.0.1.4  ", "ip_addresses", "10.0.1.4"},
		// IPv6 is matched only in its short form: measured 2026-11-17, the long
		// form 2001:DB8:A42:CAFE:100:0:0:123 found nothing while the short form
		// of the same address found nd-v6.
		{"2001:DB8:A42:CAFE:100:0:0:123", "ip_addresses", "2001:db8:a42:cafe:100::123"},
		{"2001:db8:a42:cafe:100::123", "ip_addresses", "2001:db8:a42:cafe:100::123"},
		{"::ffff:192.168.1.199", "ip_addresses", "192.168.1.199"},
		{"6c:56:97:9d:8c:bc", "mac_addresses", "6c:56:97:9d:8c:bc"},
		{"6C-56-97-9D-8C-BC", "mac_addresses", "6c:56:97:9d:8c:bc"},
		{"6c56.979d.8cbc", "mac_addresses", "6c:56:97:9d:8c:bc"},
	}
	for _, c := range cases {
		f, v, ok := addressQuery(c.in)
		if !ok || f != c.field || v != c.value {
			t.Errorf("addressQuery(%q) = %q, %q, %v; want %q, %q, true", c.in, f, v, ok, c.field, c.value)
		}
	}
}

func TestAddressQuery_LeavesEverythingElseToTheNameSearch(t *testing.T) {
	for _, in := range []string{
		"", "web-01", "echo-master", "10.0.1", "172.17.999.4", "fe80::1%eth0",
		"10.0.0.0/24", "1.2.3.4' or name = 'x", "6c:56:97:9d:8c", "00:00:00:00:fe:80:00:00:00:00:00:00:02:00:5e:10:00:00:00:01",
	} {
		if f, v, ok := addressQuery(in); ok {
			t.Errorf("addressQuery(%q) = %q, %q, true; want a name search", in, f, v)
		}
	}
}

func TestAddressFilter_QuotesTheValueAndRefusesAnythingButAnAddress(t *testing.T) {
	got, err := addressFilter("ip_addresses", "172.17.0.4")
	if err != nil || got != "ip_addresses = '172.17.0.4'" {
		t.Fatalf("got %q, %v", got, err)
	}
	got, err = addressFilter("mac_addresses", "6c:56:97:9d:8c:bc")
	if err != nil || got != "mac_addresses = '6c:56:97:9d:8c:bc'" {
		t.Fatalf("got %q, %v", got, err)
	}
	for _, bad := range [][2]string{
		{"ip_addresses", "1.2.3.4' or name = 'x"},
		{"ip_addresses", `1.2.3.4\`},
		{"ip_addresses", ""},
		{"name", "web-01"},
		{"ip_addresses or 1=1", "1.2.3.4"},
	} {
		if f, err := addressFilter(bad[0], bad[1]); err == nil {
			t.Errorf("addressFilter(%q, %q) = %q; want a refusal", bad[0], bad[1], f)
		}
	}
}

// searchServer fakes /api/v1/assets/search and records each body it was sent.
func searchServer(t *testing.T, status int, reply string) (*Service, func() []map[string]any) {
	t.Helper()
	var mu sync.Mutex
	var bodies []map[string]any
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/api/v1/assets/search" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var b map[string]any
		_ = json.Unmarshal(raw, &b)
		mu.Lock()
		bodies = append(bodies, b)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(reply))
	})
	return s, func() []map[string]any { mu.Lock(); defer mu.Unlock(); return bodies }
}

func TestFetchAssetInventory_AnIPGoesToTheAddressSearch(t *testing.T) {
	s, bodies := searchServer(t, 200, `{"data":[
		{"id":"5860e843-ef0c-5b0b-959e-9bbae336426a","name":"echo-master","type":[{"id":"server","label":"Server"}],
		 "providers":[{"id":"DHCP Logs","label":"DHCP Logs"},{"id":"NIOS Grid","label":"NIOS Grid"}],
		 "vendor":"Dell","last_seen":"2026-11-18T01:31:27Z","ip_addresses":["192.168.1.199"],"mac_addresses":["6c:56:97:9d:8c:bc"]}
	],"pagination":{"next_page_token":null,"returned":1}}`)

	got := s.FetchAssetInventory(context.Background(), " 2001:DB8::1 ", "", "", "", 0, "")

	b := bodies()
	if len(b) != 1 {
		t.Fatalf("%d search calls, want 1", len(b))
	}
	if b[0]["filter"] != "ip_addresses = '2001:db8::1'" {
		t.Errorf("filter %v", b[0]["filter"])
	}
	if sync, _ := b[0]["sync"].(map[string]any); sync["mode"] != "FULL" {
		t.Errorf("sync %v, want mode FULL", b[0]["sync"])
	}
	if got["availability"] != "ok" || got["mode"] != "address" || got["window_days"] != assetSearchWindowDays {
		t.Fatalf("payload %v", got)
	}
	if got["total"] != 1 || got["has_more"] != false || got["page"] != 0 {
		t.Errorf("total %v has_more %v page %v", got["total"], got["has_more"], got["page"])
	}
	rows, _ := got["rows"].([]any)
	if len(rows) != 1 {
		t.Fatalf("rows %v", got["rows"])
	}
	r := rows[0].(map[string]any)
	want := map[string]string{
		"cqid": "5860e843-ef0c-5b0b-959e-9bbae336426a", "name": "echo-master", "type": "Server",
		"provider": "DHCP Logs, NIOS Grid", "vendor": "Dell", "last_seen": "2026-11-18T01:31:27Z",
	}
	for k, v := range want {
		if r[k] != v {
			t.Errorf("row %s = %v, want %q", k, r[k], v)
		}
	}
}

func TestFetchAssetInventory_AMACGoesToTheAddressSearch(t *testing.T) {
	s, bodies := searchServer(t, 200, `{"data":[],"pagination":{"next_page_token":null}}`)
	got := s.FetchAssetInventory(context.Background(), "6C-56-97-9D-8C-BC", "", "", "", 0, "")
	if b := bodies(); len(b) != 1 || b[0]["filter"] != "mac_addresses = '6c:56:97:9d:8c:bc'" {
		t.Fatalf("bodies %v", b)
	}
	// No hits is a real answer, not a failure: the page says "not seen in the
	// last 7 days" from mode + window_days.
	if got["availability"] != "ok" || got["total"] != 0 || got["mode"] != "address" {
		t.Errorf("payload %v", got)
	}
	if rows, ok := got["rows"].([]any); !ok || rows == nil || len(rows) != 0 {
		t.Errorf("rows %#v, want an empty list", got["rows"])
	}
}

func TestFetchAssetInventory_ANameStaysOnTheNameSearch(t *testing.T) {
	s, bodies := searchServer(t, 200, `{"data":[]}`)
	got := s.FetchAssetInventory(context.Background(), "echo-master", "", "", "", 0, "")
	if n := len(bodies()); n != 0 {
		t.Errorf("%d address searches for a name", n)
	}
	// This service has no cube session, so the name search says it could not
	// look. What matters is that it was the name search that answered.
	if got["mode"] == "address" {
		t.Errorf("a name was searched as an address: %v", got)
	}
}

func TestFetchAssetInventory_AnAddressSearchFailureSaysSoAndIsNotCached(t *testing.T) {
	s, bodies := searchServer(t, 500, `{"error":"boom"}`)
	got := s.FetchAssetInventory(context.Background(), "10.0.1.4", "", "", "", 0, "")
	if got["availability"] != "error" || got["total"] != nil {
		t.Fatalf("payload %v, want could-not-look with no total", got)
	}
	if r, _ := got["reason"].(string); r == "" {
		t.Error("no reason")
	}
	s.FetchAssetInventory(context.Background(), "10.0.1.4", "", "", "", 0, "")
	if n := len(bodies()); n != 2 {
		t.Errorf("%d calls, want 2: a failure must not be cached", n)
	}
}

func TestFetchAssetInventory_MoreHitsThanOnePageSaysTheTotalIsUnknown(t *testing.T) {
	s, _ := searchServer(t, 200, `{"data":[{"id":"a","name":"a"}],"pagination":{"next_page_token":"abc"}}`)
	got := s.FetchAssetInventory(context.Background(), "10.0.1.4", "", "", "", 0, "")
	if got["total"] != nil || got["truncated"] != true {
		t.Errorf("total %v truncated %v; a cut-off list must not claim a total", got["total"], got["truncated"])
	}
}

// Review finding: with 75 hits, Next used to fetch the same first rows again,
// so 25 devices could not be reached. The hits are read once and paged here.
func TestFetchAssetInventory_ManyAddressHitsPageThroughAllOfThem(t *testing.T) {
	var hits []string
	for i := 0; i < 75; i++ {
		hits = append(hits, `{"id":"id-`+strconv.Itoa(i)+`","name":"dev-`+strconv.Itoa(i)+`"}`)
	}
	s, bodies := searchServer(t, 200, `{"data":[`+strings.Join(hits, ",")+`],"pagination":{"next_page_token":null}}`)

	p0 := s.FetchAssetInventory(context.Background(), "10.0.1.4", "", "", "", 0, "")
	p1 := s.FetchAssetInventory(context.Background(), "10.0.1.4", "", "", "", 1, "")

	if n := len(bodies()); n != 1 {
		t.Errorf("%d searches, want 1: the second page comes from the first read", n)
	}
	if ps, _ := bodies()[0]["page_size"].(float64); int(ps) != assetSearchPageSize || assetSearchPageSize < 1000 {
		t.Errorf("page_size %v, want the API's 1000", bodies()[0]["page_size"])
	}
	r0, _ := p0["rows"].([]any)
	r1, _ := p1["rows"].([]any)
	if len(r0) != 50 || p0["total"] != 75 || p0["has_more"] != true || p0["page"] != 0 {
		t.Errorf("page 0: %d rows total %v has_more %v page %v", len(r0), p0["total"], p0["has_more"], p0["page"])
	}
	if len(r1) != 25 || p1["total"] != 75 || p1["has_more"] != false || p1["page"] != 1 {
		t.Fatalf("page 1: %d rows total %v has_more %v page %v", len(r1), p1["total"], p1["has_more"], p1["page"])
	}
	if r1[0].(map[string]any)["name"] != "dev-50" {
		t.Errorf("page 1 starts at %v, want dev-50", r1[0])
	}
}
