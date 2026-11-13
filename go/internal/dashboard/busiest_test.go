package dashboard

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

func TestSiteOfFoldsNamesIntoSitesAndSkipsInternalOnes(t *testing.T) {
	for in, want := range map[string]string{
		"www.google.com.":       "google.com",
		"mail.google.com":       "google.com",
		"a.b.example.co.uk.":    "example.co.uk",
		"alice.github.io.":      "alice.github.io", // a hosted name stays its own site
		"Netflix.COM.":          "netflix.com",
		"dhcp-db.infoblox.svc":  "",
		"noa.svc.cluster.local": "",
		"app-infra-monitor.":    "",
		"4.3.2.1.in-addr.arpa.": "",
	} {
		got, ok := siteOf(in)
		if got != want || ok != (want != "") {
			t.Errorf("siteOf(%q) = %q %v, want %q", in, got, ok, want)
		}
	}
}

// The shape is the live one (Infoblox Sales, 2026-11-13): counts as strings,
// names with a trailing dot.
func TestBusiestSitesSumsPerSiteBeforeTakingTheTop(t *testing.T) {
	calls := 0
	var asked map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_ = json.Unmarshal([]byte(r.URL.Query().Get("query")), &asked)
		_, _ = io.WriteString(w, `{"result":{"data":[
			{"DnsActivityV1.qname":"dhcp-dhcp-db.infoblox.svc.","DnsActivityV1.total_query_count":"1867258"},
			{"DnsActivityV1.qname":"apple.com.","DnsActivityV1.total_query_count":"500"},
			{"DnsActivityV1.qname":"www.google.com.","DnsActivityV1.total_query_count":"300"},
			{"DnsActivityV1.qname":"mail.google.com.","DnsActivityV1.total_query_count":"300"},
			{"DnsActivityV1.qname":"netflix.com.","DnsActivityV1.total_query_count":"100"}]}}`)
	}))
	t.Cleanup(srv.Close)
	s := &Service{Rest: rest.New(srv.URL, rest.NewAuth("k", nil)), Cache: cache.New()}
	res, err := s.BusiestSites(2)
	if err != nil {
		t.Fatal(err)
	}
	// google.com has 600 across two names, so it beats apple.com's one name.
	if d := res["domains"].([]string); !reflect.DeepEqual(d, []string{"google.com", "apple.com"}) {
		t.Fatalf("domains = %v", d)
	}
	if q := res["queries"].([]int64); !reflect.DeepEqual(q, []int64{600, 500}) {
		t.Fatalf("queries = %v", q)
	}
	if res["total"] != 3 || res["names"] != 5 || res["estimate"] != false {
		t.Fatalf("res = %v", res)
	}
	if asked["limit"] != float64(busiestRows) {
		t.Fatalf("query = %v", asked)
	}
	if _, err := s.BusiestSites(3); err != nil || calls != 1 {
		t.Fatalf("want one query reused, got %d", calls)
	}
	if _, err := s.BusiestSites(0); err == nil {
		t.Fatal("top 0 must be refused")
	}
}

func TestBusiestSitesSaysWhenInfobloxIsDown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(502) }))
	t.Cleanup(srv.Close)
	s := &Service{Rest: rest.New(srv.URL, rest.NewAuth("k", nil)), Cache: cache.New()}
	if _, err := s.BusiestSites(10); err == nil {
		t.Fatal("an outage must be an error, not an empty list")
	}
}

func TestNeverAddLeavesOutTheSiteAndAnythingItCovers(t *testing.T) {
	keep, left := NeverAdd(
		[]string{"google.com", "www.facebook.com", "facebook.com.au", "apple.com", "maps.apple.com"},
		[]string{"www.google.com", "Facebook.com."})
	// google.com would cover www.google.com; www.facebook.com is under facebook.com;
	// facebook.com.au is a different site.
	if !reflect.DeepEqual(keep, []string{"facebook.com.au", "apple.com", "maps.apple.com"}) ||
		!reflect.DeepEqual(left, []string{"google.com", "www.facebook.com"}) {
		t.Fatalf("keep %v left %v", keep, left)
	}
}
