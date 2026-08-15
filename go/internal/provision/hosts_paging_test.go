package provision

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// EVERY HOST, OR NONE.
//
// planHosts read ONE page of 1000 hosts and filtered it locally, so on a tenant
// holding more than that, this site's hosts past row 1000 were never seen, never
// deleted, and the teardown returned a normal success with them still holding
// addresses on the customer's network. The export written before the first
// delete carried the same short list.
//
// SCOPE. These tests pin the WALK and what the teardown does with it. They do
// not prove anything about the DELETEs themselves (decommission_incomplete_test
// covers those) or about the export format (export_test).
//
// Every test drives the real Decommission() or QuerySiteLive() through a fake
// tenant that honours _limit/_offset the way the API does. A direct call to
// readAllHosts would stay green if either call site were left on the old
// single-page read, which is the bug.
//
// NO TEST HERE TOUCHES A REAL TENANT.

// pagingTenant serves `hosts` in _limit/_offset pages and records every host
// query it answered, so a test can assert the walk really paged.
type pagingTenant struct {
	mu      sync.Mutex
	hosts   []any
	queries []string
	deletes []string

	// failPage, when >= 0, makes that page index return 500.
	failPage int
	// totalSize overrides page.total_size; "" means report len(hosts).
	totalSize string
	// alwaysFull makes every page return a full page regardless of offset — a
	// tenant that never ends, for the page-cap guard.
	alwaysFull bool
}

func siteHost(i int) map[string]any {
	return map[string]any{"id": fmt.Sprintf("ipam/host/site-%d", i),
		"name":      fmt.Sprintf("gw%d.site-test.example.com", i),
		"addresses": []any{map[string]any{"address": fmt.Sprintf("10.20.0.%d", i)}}}
}

func otherHost(i int) map[string]any {
	return map[string]any{"id": fmt.Sprintf("ipam/host/other-%d", i),
		"name": fmt.Sprintf("h%d.elsewhere.example.com", i)}
}

func (f *pagingTenant) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "DELETE" {
			f.mu.Lock()
			f.deletes = append(f.deletes, strings.TrimPrefix(r.URL.Path, "/api/ddi/v1/"))
			f.mu.Unlock()
			w.Write([]byte(`{"result":{}}`))
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/ipam/host"):
			q := r.URL.Query()
			f.mu.Lock()
			page := len(f.queries)
			f.queries = append(f.queries, r.URL.RawQuery)
			f.mu.Unlock()
			if page == f.failPage {
				w.WriteHeader(500)
				w.Write([]byte(`{"error":"host read failed"}`))
				return
			}
			limit, _ := strconv.Atoi(q.Get("_limit"))
			offset, _ := strconv.Atoi(q.Get("_offset"))
			var batch []any
			if f.alwaysFull {
				for i := 0; i < limit; i++ {
					batch = append(batch, otherHost(offset+i))
				}
			} else {
				for i := offset; i < offset+limit && i < len(f.hosts); i++ {
					batch = append(batch, f.hosts[i])
				}
			}
			total := f.totalSize
			if total == "" {
				total = strconv.Itoa(len(f.hosts))
			}
			b, _ := json.Marshal(map[string]any{
				"results": batch, "page": map[string]any{"total_size": total}})
			w.Write(b)
		case strings.HasSuffix(r.URL.Path, "/ipam/ip_space"):
			w.Write([]byte(`{"results":[{"id":"ipam/ip_space/sp-1","name":"default"}]}`))
		case strings.HasSuffix(r.URL.Path, "/dns/view"):
			w.Write([]byte(`{"results":[{"id":"dns/view/v-1","name":"default"}]}`))
		case strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			w.Write([]byte(`{"results":[{"id":"ipam/subnet/sn-1","address":"10.20.0.0","cidr":24,"name":"test-net"}]}`))
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	}
}

func runPagedTeardown(t *testing.T, f *pagingTenant) (M, error, *pagingTenant) {
	t.Helper()
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	e := newTestEngine(srv)
	e.Export = &ExportWriter{Dir: t.TempDir()}
	d := e.NewSiteDecommissioner(&DecommissionConfig{
		Site: "test", IPSpace: "default", DNSParent: "example.com", DNSView: "default"}, func(M) {})
	out, err := d.Decommission()
	return out, err, f
}

// manyHosts builds n non-site hosts followed by one host that DOES belong to
// the site — deliberately last, so a walk that stops early never finds it.
func manyHosts(n int) []any {
	rows := make([]any, 0, n+1)
	for i := 0; i < n; i++ {
		rows = append(rows, otherHost(i))
	}
	return append(rows, siteHost(1))
}

func (f *pagingTenant) snapshot() (queries, deletes []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.queries...), append([]string{}, f.deletes...)
}

// THE BUG. The site's only host is row 2501 of 2501.
func TestTeardown_FindsHostsPastTheFirstPage(t *testing.T) {
	out, err, f := runPagedTeardown(t, &pagingTenant{hosts: manyHosts(2500), failPage: -1})
	if err != nil {
		t.Fatalf("Decommission() error = %v, want nil", err)
	}
	queries, deletes := f.snapshot()
	if len(queries) != 3 {
		t.Fatalf("host reads = %d (%v), want 3 pages — one un-paged read is the bug", len(queries), queries)
	}
	for i, want := range []string{"_offset=0", "_offset=1000", "_offset=2000"} {
		if !strings.Contains(queries[i], want) {
			t.Fatalf("host read %d = %q, want %s", i, queries[i], want)
		}
	}
	gone := getList(out, "hosts_deleted")
	if len(gone) != 1 || pyStr(asMap(gone[0])["id"]) != "ipam/host/site-1" {
		t.Fatalf("hosts_deleted = %v, want the site host that lives on page 3 — it is still holding "+
			"10.20.0.1 on the customer's network otherwise", gone)
	}
	if len(deletes) == 0 {
		t.Fatalf("no DELETEs were issued at all")
	}
}

// The common case must not change: a tenant under one page still makes exactly
// one request, and a SHORT page ends the walk without a probe for an empty one.
func TestTeardown_SmallTenantStillMakesOneRead(t *testing.T) {
	_, err, f := runPagedTeardown(t, &pagingTenant{hosts: manyHosts(3), failPage: -1})
	if err != nil {
		t.Fatalf("Decommission() error = %v, want nil", err)
	}
	queries, _ := f.snapshot()
	if len(queries) != 1 {
		t.Fatalf("host reads = %d (%v), want exactly 1", len(queries), queries)
	}
}

// A page that fails mid-walk must REFUSE, and must do it before any delete —
// the teardown is fail-forward, so a delete issued on a partial inventory
// cannot be taken back.
func TestTeardown_RefusesWhenAPageFailsAndDeletesNothing(t *testing.T) {
	_, err, f := runPagedTeardown(t, &pagingTenant{hosts: manyHosts(2500), failPage: 1})
	if err == nil {
		t.Fatal("Decommission() error = nil — a half-read host list must refuse, not proceed")
	}
	_, deletes := f.snapshot()
	if len(deletes) != 0 {
		t.Fatalf("%d DELETE(s) were issued on a partial host list: %v", len(deletes), deletes)
	}
}

// A tenant that never returns a short page must stop at the cap and refuse,
// rather than looping forever or silently truncating.
func TestTeardown_RefusesAtThePageCapAndDeletesNothing(t *testing.T) {
	_, err, f := runPagedTeardown(t, &pagingTenant{alwaysFull: true, failPage: -1, totalSize: "999999"})
	if err == nil {
		t.Fatal("Decommission() error = nil, want the page-cap refusal")
	}
	if !strings.Contains(err.Error(), "more than") {
		t.Fatalf("error = %v, want the page-cap refusal naming the bound", err)
	}
	queries, deletes := f.snapshot()
	if len(queries) != hostPageCap {
		t.Fatalf("host reads = %d, want exactly the cap (%d)", len(queries), hostPageCap)
	}
	if len(deletes) != 0 {
		t.Fatalf("%d DELETE(s) were issued: %v", len(deletes), deletes)
	}
}

// The cross-check: the tenant says it holds more hosts than the walk collected,
// which is what a concurrent mutation shifting the offsets looks like from here.
// Fewer rows than advertised may mean one was skipped, so it refuses.
func TestTeardown_RefusesWhenFewerHostsAreReadThanTheTenantReports(t *testing.T) {
	_, err, f := runPagedTeardown(t, &pagingTenant{hosts: manyHosts(3), failPage: -1, totalSize: "9"})
	if err == nil {
		t.Fatal("Decommission() error = nil — 4 rows read against a reported 9 may have skipped a host")
	}
	if !strings.Contains(err.Error(), "changed while it was being read") {
		t.Fatalf("error = %v, want the instability refusal", err)
	}
	if _, deletes := f.snapshot(); len(deletes) != 0 {
		t.Fatalf("%d DELETE(s) were issued: %v", len(deletes), deletes)
	}
}

// MORE rows than the total is the opposite case and must NOT refuse: hosts were
// added while the walk ran. Finding more than expected cannot leave one behind.
func TestTeardown_MoreHostsThanReportedIsNotAFailure(t *testing.T) {
	_, err, _ := runPagedTeardown(t, &pagingTenant{hosts: manyHosts(3), failPage: -1, totalSize: "2"})
	if err != nil {
		t.Fatalf("Decommission() error = %v, want nil — the tenant grew during the read", err)
	}
}

// No total at all (an envelope with no page.total_size) must not be read as
// zero, and must not refuse: the short-page rule alone is enough to finish.
func TestTeardown_MissingTotalIsNotTreatedAsZero(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "DELETE" {
			w.Write([]byte(`{"result":{}}`))
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/ipam/host"):
			b, _ := json.Marshal(map[string]any{"results": []any{siteHost(1)}}) // no "page" key
			w.Write(b)
		case strings.HasSuffix(r.URL.Path, "/ipam/ip_space"):
			w.Write([]byte(`{"results":[{"id":"ipam/ip_space/sp-1","name":"default"}]}`))
		case strings.HasSuffix(r.URL.Path, "/dns/view"):
			w.Write([]byte(`{"results":[{"id":"dns/view/v-1","name":"default"}]}`))
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	}))
	defer srv.Close()
	e := newTestEngine(srv)
	e.Export = &ExportWriter{Dir: t.TempDir()}
	out, err := e.NewSiteDecommissioner(&DecommissionConfig{
		Site: "test", IPSpace: "default", DNSParent: "example.com", DNSView: "default"}, func(M) {}).Decommission()
	if err != nil {
		t.Fatalf("Decommission() error = %v, want nil — an absent total means \"unknown\", not zero", err)
	}
	if len(getList(out, "hosts_deleted")) != 1 {
		t.Fatalf("hosts_deleted = %v, want the one site host", out["hosts_deleted"])
	}
}

// The same host id appearing on two pages is deleted ONCE. A second DELETE on
// an id already gone answers 404 and aborts the teardown at its very last step.
//
// total_size is 1999 here — the number of DISTINCT hosts — so this isolates
// deduplication from the skip cross-check. The case where a duplicate arrives
// because the offsets shifted (and therefore something was probably skipped) is
// TestTeardown_RefusesWhenFewerHostsAreReadThanTheTenantReports: there the
// unique count falls short of the total and the walk refuses, which is the point
// of having both mechanisms.
func TestTeardown_DuplicateHostAcrossPagesIsDeletedOnce(t *testing.T) {
	rows := manyHosts(1999) // 2000 rows: page 1 full, page 2 has the site host
	rows[999] = siteHost(1) // and the same site host also sits on page 1
	_, err, f := runPagedTeardown(t, &pagingTenant{hosts: rows, failPage: -1, totalSize: "1999"})
	if err != nil {
		t.Fatalf("Decommission() error = %v, want nil", err)
	}
	_, deletes := f.snapshot()
	n := 0
	for _, d := range deletes {
		if d == "ipam/host/site-1" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("the same host was DELETEd %d times: %v", n, deletes)
	}
}

// Drift is the second caller and had the identical read. A host on a later page
// must not be reported as missing — that sends an operator to re-create
// something that is already there.
func TestQuerySiteLive_SeesHostsPastTheFirstPage(t *testing.T) {
	f := &pagingTenant{hosts: manyHosts(2500), failPage: -1}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()

	live, err := newTestEngine(srv).QuerySiteLive("test", "default", "default", "site-test.example.com")
	if err != nil {
		t.Fatalf("QuerySiteLive() error = %v, want nil", err)
	}
	subnets := getList(live, "subnets")
	if len(subnets) != 1 {
		t.Fatalf("subnets = %v, want 1", subnets)
	}
	hosts := getList(asMap(subnets[0]), "hosts")
	if len(hosts) != 1 {
		t.Fatalf("hosts in subnet = %v, want the one on page 3", hosts)
	}

	drift := DetectDrift(M{"hosts": []any{M{"hostname": "gw1"}}}, live, "test")
	for _, d := range getList(drift, "drifts") {
		if strings.Contains(pyStr(asMap(d)["message"]), "not found in any subnet") {
			t.Fatalf("drift claims a host is missing that is present on a later page: %v", d)
		}
	}
}
