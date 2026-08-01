package dashboard

import (
	"net/http"
	"sync"
	"testing"
	"time"
)

// probe records how many upstream requests the fake CSP is serving at the same
// instant, and the peak that count ever reached. It is the only way to tell a
// genuinely parallel /api/data fan-out from a sequential one: the measurement
// that motivated this change showed every call's start equalling the previous
// call's end, so "peak in flight" is exactly the number that has to move.
type probe struct {
	mu    sync.Mutex
	cur   int
	peak  int
	byURL map[string]int
}

func newProbe() *probe { return &probe{byURL: map[string]int{}} }

func (p *probe) enter(key string) {
	p.mu.Lock()
	p.cur++
	if p.cur > p.peak {
		p.peak = p.cur
	}
	p.byURL[key]++
	p.mu.Unlock()
}

func (p *probe) leave() {
	p.mu.Lock()
	p.cur--
	p.mu.Unlock()
}

func (p *probe) peakAndTotal() (peak, total int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, n := range p.byURL {
		total += n
	}
	return p.peak, total
}

func (p *probe) count(key string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.byURL[key]
}

// probeKey names a request the way the /api/data aggregate distinguishes them:
// the subnet endpoint alone is hit four different ways.
func probeKey(r *http.Request) string {
	q := r.URL.Query()
	switch {
	case q.Get("_filter") != "":
		return r.URL.Path + "?" + q.Get("_filter")
	case q.Get("_limit") == "1":
		return r.URL.Path + "?count"
	default:
		return r.URL.Path
	}
}

// slowAggregateHandler answers every /api/data feed successfully after a fixed
// delay, so overlap (or its absence) is observable. Rows are non-empty for the
// seven strict feeds and the audit feed so each one reports "ok".
func slowAggregateHandler(p *probe, delay time.Duration) http.HandlerFunc {
	rowsFor := map[string][]map[string]any{
		"/api/ddi/v1/ipam/subnet":         {{"id": "1", "name": "sub1", "address": "10.0.0.0", "cidr": 24, "utilization": map[string]any{"total": 100, "used": 10}}},
		"/api/ddi/v1/dhcp/lease":          {{"address": "10.0.0.5", "hostname": "h1", "state": "leased"}},
		"/api/ddi/v1/dns/view":            {{"id": "v1", "name": "default"}},
		"/api/ddi/v1/dns/auth_zone":       {{"id": "z1", "fqdn": "example.com", "view": "v1"}},
		"/api/infra/v1/detail_hosts":      {{"display_name": "host1", "composite_status": "online"}},
		"/api/atcfw/v1/security_policies": {{"id": "p1", "name": "policy1"}},
		"/api/atcfw/v1/named_lists":       {{"id": "f1", "name": "feed1"}},
		"/api/auditlog/v1/logs":           {{"id": "a1", "created_at": "2026-01-01"}},
	}
	return func(w http.ResponseWriter, r *http.Request) {
		p.enter(probeKey(r))
		time.Sleep(delay)
		defer p.leave()
		q := r.URL.Query()
		// Count queries and the at-risk page carry an explicit total_size; the
		// at-risk page returns zero rows so its (deliberately still sequential)
		// paging loop makes exactly one request.
		if q.Get("_limit") == "1" || q.Get("_filter") == "utilization.utilization>=70" {
			writeResultsWithPage(w, nil, map[string]any{"total_size": "3"})
			return
		}
		writeResults(w, rowsFor[r.URL.Path])
	}
}

// TestBuildAggregate_UpstreamCallsRunConcurrently is the concurrency proof. A
// cold /api/data makes 12 upstream calls; measured live they ran strictly
// sequentially (every start == the previous end), costing the sum of all 12
// latencies instead of the slowest one. The fake upstream here records peak
// in-flight requests: sequential code can never exceed 1.
//
// Mutation that must turn this RED: replace the fan-out in buildAggregate with
// the original straight-line sequential calls -> peak == 1.
func TestBuildAggregate_UpstreamCallsRunConcurrently(t *testing.T) {
	p := newProbe()
	s := newDashboardTestService(t, slowAggregateHandler(p, 80*time.Millisecond))

	s.FetchDashboardData(nil)

	peak, total := p.peakAndTotal()
	if total != 12 {
		t.Fatalf("upstream call count = %d, want 12 (7 strict feeds + at-risk page + audit + 3 counts)", total)
	}
	if peak < 2 {
		t.Fatalf("peak concurrent upstream requests = %d, want > 1 — the aggregate is still sequential", peak)
	}
	// A peak of 2 would mean only one pair ever overlapped, which is not a
	// fan-out. The bound is aggregateFanOut, so a healthy run pins to it.
	if peak < 4 {
		t.Fatalf("peak concurrent upstream requests = %d, want >= 4 — fan-out is too narrow to be real", peak)
	}
}

// TestBuildAggregate_AtRiskPagingStaysSequential guards the one call in the
// aggregate that must NOT be parallelised: the at-risk subnet paging loop
// computes each request's _offset from the previous batch's length, so its
// pages must never overlap even though the loop as a whole runs alongside the
// other feeds.
func TestBuildAggregate_AtRiskPagingStaysSequential(t *testing.T) {
	var mu sync.Mutex
	inAtRisk, peakAtRisk, pages := 0, 0, 0
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("_filter") == "utilization.utilization>=70" {
			mu.Lock()
			inAtRisk++
			pages++
			if inAtRisk > peakAtRisk {
				peakAtRisk = inAtRisk
			}
			mu.Unlock()
			time.Sleep(20 * time.Millisecond)
			mu.Lock()
			inAtRisk--
			mu.Unlock()
			// Always claim more rows remain so the loop keeps paging up to its cap.
			writeResultsWithPage(w, []map[string]any{
				{"id": "row", "name": "x", "utilization": map[string]any{"total": 100, "used": 99}},
			}, map[string]any{"total_size": "999999"})
			return
		}
		if q.Get("_limit") == "1" {
			writeResultsWithPage(w, nil, map[string]any{"total_size": "0"})
			return
		}
		writeResults(w, nil)
	})

	s.FetchDashboardData(nil)

	mu.Lock()
	defer mu.Unlock()
	if pages != atRiskPageCap {
		t.Fatalf("at-risk paging made %d requests, want atRiskPageCap=%d", pages, atRiskPageCap)
	}
	if peakAtRisk != 1 {
		t.Fatalf("peak concurrent at-risk page requests = %d, want 1 — the paging loop must stay sequential (each _offset depends on the previous batch)", peakAtRisk)
	}
}

// TestBuildAggregate_ConcurrentFailureIsolation is rule 3 under concurrency:
// with the 12 calls running at once, a feed that FAILED and a feed that
// succeeded with zero rows must still land on different words, and neither may
// contaminate a healthy neighbour. Three outcomes are asserted in ONE run so a
// fan-out that crossed its result wires would be caught.
//
// Mutation that must turn this RED: make fetchStrict swallow the error and
// return "empty" -> secPolicies reads "empty" instead of "error".
func TestBuildAggregate_ConcurrentFailureIsolation(t *testing.T) {
	rowsFor := map[string][]map[string]any{
		"/api/ddi/v1/ipam/subnet":    {{"id": "1", "name": "sub1", "address": "10.0.0.0", "cidr": 24, "utilization": map[string]any{"total": 100, "used": 10}}},
		"/api/ddi/v1/dhcp/lease":     {{"address": "10.0.0.5", "hostname": "h1", "state": "leased"}},
		"/api/ddi/v1/dns/view":       {{"id": "v1", "name": "default"}},
		"/api/infra/v1/detail_hosts": {{"display_name": "host1", "composite_status": "online"}},
		"/api/atcfw/v1/named_lists":  {{"id": "f1", "name": "feed1"}},
		"/api/auditlog/v1/logs":      {{"id": "a1", "created_at": "2026-01-01"}},
		// auth_zone deliberately absent -> succeeds with zero rows -> "empty".
	}
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		// security_policies is the failing feed. Stagger the failure so it
		// completes while the healthy feeds are still in flight.
		if r.URL.Path == "/api/atcfw/v1/security_policies" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		time.Sleep(30 * time.Millisecond)
		if q.Get("_limit") == "1" || q.Get("_filter") == "utilization.utilization>=70" {
			writeResultsWithPage(w, nil, map[string]any{"total_size": "5"})
			return
		}
		writeResults(w, rowsFor[r.URL.Path])
	})

	data := s.FetchDashboardData(nil)

	meta, ok := data["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("_meta missing or wrong type: %v", data["_meta"])
	}
	want := map[string]string{
		"secPolicies": "error", // the read FAILED
		"zones":       "empty", // the read SUCCEEDED and found nothing
		"subnets":     "ok",
		"leases":      "ok",
		"dnsViews":    "ok",
		"hosts":       "ok",
		"feeds":       "ok",
		"auditLogs":   "ok",
	}
	for key, w := range want {
		if meta[key] != w {
			t.Fatalf("_meta[%s] = %v, want %q — a failed read and an empty read must never render the same, and neither may leak onto a healthy feed", key, meta[key], w)
		}
	}
	// The healthy neighbours' ROWS must be intact too, not just their status.
	if rows, ok := data["leases"].([]map[string]any); !ok || len(rows) != 1 {
		t.Fatalf("leases rows corrupted by a concurrent feed failure: %v", data["leases"])
	}
	if rows, ok := data["secPolicies"].([]map[string]any); !ok || len(rows) != 0 {
		t.Fatalf("secPolicies must be an empty (non-nil) slice on error, got %v", data["secPolicies"])
	}
	totals, ok := data["_totals"].(map[string]any)
	if !ok || totals["degraded"] != true {
		t.Fatalf("_totals[degraded] = %v, want true when a feed errors", data["_totals"])
	}
}

// TestBuildAggregate_EveryFeedFailsIndependently walks each of the seven strict
// feeds in turn: only that feed may read "error" while the other six stay
// healthy. One shared fan-out that reused a single status variable would pass
// the single-feed test above and fail here.
func TestBuildAggregate_EveryFeedFailsIndependently(t *testing.T) {
	feeds := map[string]string{
		"/api/ddi/v1/ipam/subnet":         "subnets",
		"/api/ddi/v1/dhcp/lease":          "leases",
		"/api/ddi/v1/dns/view":            "dnsViews",
		"/api/ddi/v1/dns/auth_zone":       "zones",
		"/api/infra/v1/detail_hosts":      "hosts",
		"/api/atcfw/v1/security_policies": "secPolicies",
		"/api/atcfw/v1/named_lists":       "feeds",
	}
	rowsFor := map[string][]map[string]any{
		"/api/ddi/v1/ipam/subnet":         {{"id": "1", "name": "sub1", "address": "10.0.0.0", "cidr": 24, "utilization": map[string]any{"total": 100, "used": 10}}},
		"/api/ddi/v1/dhcp/lease":          {{"address": "10.0.0.5"}},
		"/api/ddi/v1/dns/view":            {{"id": "v1", "name": "default"}},
		"/api/ddi/v1/dns/auth_zone":       {{"id": "z1", "fqdn": "example.com", "view": "v1"}},
		"/api/infra/v1/detail_hosts":      {{"display_name": "host1", "composite_status": "online"}},
		"/api/atcfw/v1/security_policies": {{"id": "p1", "name": "policy1"}},
		"/api/atcfw/v1/named_lists":       {{"id": "f1", "name": "feed1"}},
		"/api/auditlog/v1/logs":           {{"id": "a1"}},
	}
	for deadPath, deadKey := range feeds {
		t.Run(deadKey, func(t *testing.T) {
			s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
				q := r.URL.Query()
				isCount := q.Get("_limit") == "1" || q.Get("_filter") == "utilization.utilization>=70"
				// Only the FULL feed read fails; the cheap count queries against
				// the same path still work, so this isolates the feed itself.
				if r.URL.Path == deadPath && !isCount {
					w.WriteHeader(http.StatusInternalServerError)
					return
				}
				if isCount {
					writeResultsWithPage(w, nil, map[string]any{"total_size": "2"})
					return
				}
				writeResults(w, rowsFor[r.URL.Path])
			})

			meta, ok := s.FetchDashboardData(nil)["_meta"].(map[string]any)
			if !ok {
				t.Fatalf("_meta missing")
			}
			for _, key := range feeds {
				want := "ok"
				if key == deadKey {
					want = "error"
				}
				if meta[key] != want {
					t.Fatalf("with %s dead: _meta[%s] = %v, want %q", deadKey, key, meta[key], want)
				}
			}
		})
	}
}

// TestFetchDashboardData_SingleFlightCollapsesConcurrentColdCallers is the
// single-flight proof. Cold cache + N concurrent callers used to mean N full
// 12-call aggregates against the same tenant, each one slowing the others down.
// Exactly one upstream fetch may happen, and every caller must get the same
// good payload — not an empty one.
//
// Mutation that must turn this RED: bypass Cache.Do (Get -> buildAggregate ->
// SetGen) -> the main subnet page is fetched more than once.
func TestFetchDashboardData_SingleFlightCollapsesConcurrentColdCallers(t *testing.T) {
	const callers = 5
	p := newProbe()
	// The delay must outlast the time it takes all callers to arrive, so they
	// genuinely contend on a cold key instead of trickling in one after another.
	s := newDashboardTestService(t, slowAggregateHandler(p, 150*time.Millisecond))

	var wg sync.WaitGroup
	results := make([]map[string]any, callers)
	start := make(chan struct{})
	for i := range callers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			results[i] = s.FetchDashboardData(nil)
		}(i)
	}
	close(start)
	wg.Wait()

	if n := p.count("/api/ddi/v1/ipam/subnet"); n != 1 {
		t.Fatalf("%d concurrent cold callers caused %d upstream subnet fetches, want exactly 1 — Cache.Do is not wired in", callers, n)
	}
	if _, total := p.peakAndTotal(); total != 12 {
		t.Fatalf("total upstream calls = %d, want 12 for one shared aggregate", total)
	}
	for i, data := range results {
		if data == nil {
			t.Fatalf("caller %d got a nil payload", i)
		}
		meta, ok := data["_meta"].(map[string]any)
		if !ok {
			t.Fatalf("caller %d got no _meta: %v", i, data)
		}
		// A shared result must be the real one, not a failure shape handed out
		// to the waiters.
		if meta["subnets"] != "ok" || meta["auditLogs"] != "ok" {
			t.Fatalf("caller %d got a degraded shared result: %v", i, meta)
		}
	}
}

// TestFetchDashboardData_SingleFlightDoesNotShareAFailureAsSuccess pins the
// half of Cache.Do that matters most here: a fetch whose feeds failed must not
// be cached as if it were good. The aggregate never returns a hard error (one
// dead feed must not blank the payload), so the guarantee is that the SECOND
// wave of callers, after the shared result was handed out, still sees the
// per-feed "error" word rather than a silently-empty payload.
func TestFetchDashboardData_SingleFlightPreservesFailureWord(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if r.URL.Path == "/api/atcfw/v1/named_lists" {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		if q.Get("_limit") == "1" || q.Get("_filter") == "utilization.utilization>=70" {
			writeResultsWithPage(w, nil, map[string]any{"total_size": "0"})
			return
		}
		writeResults(w, nil)
	})

	var wg sync.WaitGroup
	metas := make([]any, 3)
	for i := range 3 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			meta := s.FetchDashboardData(nil)["_meta"].(map[string]any)
			metas[i] = meta["feeds"]
		}(i)
	}
	wg.Wait()
	for i, got := range metas {
		if got != "error" {
			t.Fatalf("caller %d saw _meta[feeds] = %v, want \"error\" — a shared single-flight result must not launder a failed read into \"empty\"", i, got)
		}
	}
}
