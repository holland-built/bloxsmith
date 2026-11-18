package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/config"
	"bloxsmith/internal/dashboard"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/store"
)

// Compare one zone across two DNS views. The reference script this idea came
// from (infoblox-UDDI-zonesync) reads records with _limit=1000 and no paging,
// so a zone over 1,000 records silently loses the rest. These tests pin full
// paging, every kind of difference, and an honest partial result.

const zoneA, zoneB = "dns/auth_zone/aaa", "dns/auth_zone/bbb"

type fakeRec struct {
	name, typ, data string
	ttl             int
}

func compareDeps(t *testing.T, zones map[string][]fakeRec, failAfter map[string]int) (*Deps, *[]url.Values) {
	t.Helper()
	var seen []url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		seen = append(seen, q)
		if r.URL.Path != "/api/ddi/v1/dns/record" {
			w.WriteHeader(404)
			return
		}
		id := strings.TrimSuffix(strings.TrimPrefix(q.Get("_filter"), `zone=="`), `"`)
		recs, ok := zones[id]
		if !ok {
			w.WriteHeader(400)
			return
		}
		off, _ := strconv.Atoi(q.Get("_offset"))
		lim, _ := strconv.Atoi(q.Get("_limit"))
		if n, ok := failAfter[id]; ok && off >= n {
			w.WriteHeader(502)
			return
		}
		rows := []map[string]any{}
		for i := off; i < len(recs) && i < off+lim; i++ {
			rows = append(rows, map[string]any{"id": fmt.Sprintf("dns/record/%s-%05d", id, i),
				"name_in_zone": recs[i].name, "type": recs[i].typ, "dns_rdata": recs[i].data, "ttl": recs[i].ttl})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"results": rows})
	}))
	t.Cleanup(srv.Close)
	c := rest.New(srv.URL, rest.NewAuth("test-key", nil))
	return &Deps{Cfg: &config.Config{Port: "8080"}, Rest: c, Dashboard: dashboard.New(c, cache.New()), Store: store.New(t.TempDir())}, &seen
}

type compareOut struct {
	Status string `json:"status"`
	A, B   struct {
		Records  int    `json:"records"`
		Complete bool   `json:"complete"`
		Note     string `json:"note"`
	}
	Same      int                                 `json:"same"`
	OnlyA     []struct{ Name, Type, Data string } `json:"only_a"`
	OnlyB     []struct{ Name, Type, Data string } `json:"only_b"`
	Different []struct {
		Name, Type, What string
	} `json:"different"`
}

func runCompare(t *testing.T, d *Deps, query string) (int, compareOut, string) {
	t.Helper()
	mux := http.NewServeMux()
	d.registerIPAMReadRoutes(mux)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("GET", "/api/dns/zone-compare?"+query, nil))
	var out compareOut
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	return rr.Code, out, rr.Body.String()
}

func q(a, b string) string { return "a=" + url.QueryEscape(a) + "&b=" + url.QueryEscape(b) }

func TestZoneCompare_ReadsEveryPage(t *testing.T) {
	// 2,345 identical A records in each view, plus one extra in A past the
	// 2,000th row: a reader that stops at 1,000 would miss it.
	var a, b []fakeRec
	for i := 0; i < 2345; i++ {
		r := fakeRec{fmt.Sprintf("host%d", i), "A", fmt.Sprintf("10.0.%d.%d", i/250, i%250), 3600}
		a, b = append(a, r), append(b, r)
	}
	a = append(a, fakeRec{"late", "A", "10.9.9.9", 3600})
	d, seen := compareDeps(t, map[string][]fakeRec{zoneA: a, zoneB: b}, nil)
	code, out, raw := runCompare(t, d, q(zoneA, zoneB))
	if code != 200 || out.Status != "ok" {
		t.Fatalf("code %d: %s", code, raw)
	}
	if out.A.Records != 2346 || out.B.Records != 2345 || !out.A.Complete || !out.B.Complete {
		t.Fatalf("records a=%d b=%d complete %v %v", out.A.Records, out.B.Records, out.A.Complete, out.B.Complete)
	}
	if out.Same != 2345 || len(out.OnlyA) != 1 || out.OnlyA[0].Name != "late" || len(out.OnlyB) != 0 {
		t.Fatalf("same %d onlyA %+v onlyB %+v", out.Same, out.OnlyA, out.OnlyB)
	}
	// Paged by zone id (view== is refused upstream), in a stable order.
	for _, v := range *seen {
		if v.Get("_order_by") != "id" || !strings.HasPrefix(v.Get("_filter"), `zone=="`) {
			t.Fatalf("request %v: want _order_by=id and a zone== filter", v)
		}
	}
}

func TestZoneCompare_Differences(t *testing.T) {
	a := []fakeRec{
		{"", "NS", "ns1.example.", 3600},
		{"www", "A", "10.0.0.1", 3600},   // same
		{"mail", "A", "10.0.0.2", 3600},  // TTL differs
		{"app", "A", "10.0.0.3", 3600},   // value differs
		{"old", "CNAME", "www.ex.", 300}, // only in A
	}
	b := []fakeRec{
		{"", "NS", "ns1.example.", 3600},
		{"WWW", "A", "10.0.0.1", 3600}, // names compare without case
		{"mail", "A", "10.0.0.2", 60},
		{"app", "A", "10.0.0.30", 3600},
		{"new", "TXT", `"hello"`, 300}, // only in B
	}
	d, _ := compareDeps(t, map[string][]fakeRec{zoneA: a, zoneB: b}, nil)
	_, out, raw := runCompare(t, d, q(zoneA, zoneB))
	if out.Same != 2 {
		t.Fatalf("same = %d, want 2: %s", out.Same, raw)
	}
	if len(out.OnlyA) != 1 || out.OnlyA[0].Name != "old" || len(out.OnlyB) != 1 || out.OnlyB[0].Name != "new" {
		t.Fatalf("only a %+v only b %+v", out.OnlyA, out.OnlyB)
	}
	got := map[string]string{}
	for _, x := range out.Different {
		got[x.Name] = x.What
	}
	if got["mail"] != "ttl" || got["app"] != "value" || len(got) != 2 {
		t.Fatalf("different = %+v", out.Different)
	}
}

func TestZoneCompare_PartialReadSaysSo(t *testing.T) {
	var a []fakeRec
	for i := 0; i < 1500; i++ {
		a = append(a, fakeRec{fmt.Sprintf("h%d", i), "A", "10.0.0.1", 60})
	}
	d, _ := compareDeps(t, map[string][]fakeRec{zoneA: a, zoneB: a}, map[string]int{zoneB: 1000})
	code, out, raw := runCompare(t, d, q(zoneA, zoneB))
	if code != 200 || out.Status != "partial" || out.B.Complete || !out.A.Complete || out.B.Records != 1000 {
		t.Fatalf("code %d: %s", code, raw)
	}
	if !strings.Contains(out.B.Note, "1,000") {
		t.Fatalf("note %q does not say how many records were read", out.B.Note)
	}
}

func TestZoneCompare_FirstPageFailsIsAnError(t *testing.T) {
	d, _ := compareDeps(t, map[string][]fakeRec{zoneA: nil, zoneB: nil}, map[string]int{zoneA: 0})
	_, out, raw := runCompare(t, d, q(zoneA, zoneB))
	if out.Status != "error" {
		t.Fatalf("want error, got %s", raw)
	}
}

func TestZoneCompare_RejectsBadIDs(t *testing.T) {
	d, _ := compareDeps(t, nil, nil)
	for _, query := range []string{"", q(zoneA, ""), q(zoneA, "dns/view/x"), q(zoneA, zoneA), q(zoneA, `dns/auth_zone/x" or 1==1`)} {
		if code, _, raw := runCompare(t, d, query); code != 400 {
			t.Fatalf("%q: code %d, want 400: %s", query, code, raw)
		}
	}
}

// Every view keeps its own SOA serial, so a serial-only difference is not a
// difference (live 2026-11-17 it flagged @ SOA on every compare). Any other
// SOA field that differs still is.
func TestZoneCompare_SOAIgnoresSerial(t *testing.T) {
	a := []fakeRec{{"", "SOA", "ns.lab.local. user.infoblox.com. 7 10800 3600 2419200 900", 3600}}
	b := []fakeRec{{"", "SOA", "ns.lab.local. user.infoblox.com. 42 10800 3600 2419200 900", 3600}}
	d, _ := compareDeps(t, map[string][]fakeRec{zoneA: a, zoneB: b}, nil)
	if _, out, raw := runCompare(t, d, q(zoneA, zoneB)); out.Same != 1 || len(out.Different) != 0 {
		t.Fatalf("serial-only SOA difference counted: %s", raw)
	}
	b[0].data = "ns.lab.local. user.infoblox.com. 42 10800 3600 2419200 60"
	d, _ = compareDeps(t, map[string][]fakeRec{zoneA: a, zoneB: b}, nil)
	if _, out, raw := runCompare(t, d, q(zoneA, zoneB)); len(out.Different) != 1 || out.Different[0].What != "value" {
		t.Fatalf("SOA with a different minimum TTL not flagged: %s", raw)
	}
}
