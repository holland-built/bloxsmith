package dashboard

import (
	"net/http"
	"strconv"
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
		// The subnets first page arrives as subnetPageCount concurrent _offset
		// requests. Give each offset a DISTINCT id, otherwise every page
		// returns the same row, assembly dedupes it away, and a test could not
		// tell ten pages from one.
		if r.URL.Path == "/api/ddi/v1/ipam/subnet" {
			writeResults(w, []map[string]any{{
				"id": "sub-" + q.Get("_offset"), "name": "sub" + q.Get("_offset"),
				"address": "10.0.0.0", "cidr": 24,
				"utilization": map[string]any{"total": 100, "used": 10},
			}})
			return
		}
		writeResults(w, rowsFor[r.URL.Path])
	}
}

// TestBuildAggregate_UpstreamCallsRunConcurrently is the concurrency proof. A
// cold /api/data makes 21 upstream calls; measured live they ran strictly
// sequentially (every start == the previous end), costing the sum of all
// latencies instead of the slowest one. The fake upstream here records peak
// in-flight requests: sequential code can never exceed 1.
//
// Mutation that must turn this RED: replace the fan-out in buildAggregate with
// the original straight-line sequential calls -> peak == 1. Dropping the 9
// extra subnet page registrations also turns it RED on the count.
func TestBuildAggregate_UpstreamCallsRunConcurrently(t *testing.T) {
	p := newProbe()
	s := newDashboardTestService(t, slowAggregateHandler(p, 80*time.Millisecond))

	s.FetchDashboardData(nil)

	peak, total := p.peakAndTotal()
	if total != 21 {
		t.Fatalf("upstream call count = %d, want 21 (%d subnet pages + 6 other strict feeds + at-risk page + audit + 3 counts)", total, subnetPageCount)
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

	// probeKey buckets every split page under the bare subnet path, so ONE
	// shared aggregate is exactly subnetPageCount hits here — five contending
	// cold callers would be five times that.
	if n := p.count("/api/ddi/v1/ipam/subnet"); n != subnetPageCount {
		t.Fatalf("%d concurrent cold callers caused %d upstream subnet-page fetches, want exactly subnetPageCount=%d — Cache.Do is not wired in", callers, n, subnetPageCount)
	}
	if _, total := p.peakAndTotal(); total != 21 {
		t.Fatalf("total upstream calls = %d, want 21 for one shared aggregate", total)
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

// TestSubnetFirstPage_SplitsIntoConcurrentOffsetPages pins the shape of the
// split: the subnets first page is subnetPageCount requests of subnetPageSize
// rows at offsets 0, 500, ... 4500, and they genuinely overlap. The endpoint
// charges think time per ROW PREPARED (~1.7ms), so one _limit=5000 call costs
// 8.4s while these ten cost 1.43s wall for identical rows.
//
// Mutation that must turn this RED: re-register a single task with
// {"_limit": "5000"} instead of the ten page tasks.
func TestSubnetFirstPage_SplitsIntoConcurrentOffsetPages(t *testing.T) {
	var mu sync.Mutex
	limitAt := map[string]string{}
	inPages, peakPages := 0, 0
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		isCount := q.Get("_limit") == "1" || q.Get("_filter") != ""
		if r.URL.Path == "/api/ddi/v1/ipam/subnet" && !isCount {
			mu.Lock()
			limitAt[q.Get("_offset")] = q.Get("_limit")
			inPages++
			if inPages > peakPages {
				peakPages = inPages
			}
			mu.Unlock()
			time.Sleep(60 * time.Millisecond)
			mu.Lock()
			inPages--
			mu.Unlock()
			writeResults(w, []map[string]any{{"id": "sub-" + q.Get("_offset")}})
			return
		}
		if isCount {
			writeResultsWithPage(w, nil, map[string]any{"total_size": "0"})
			return
		}
		writeResults(w, nil)
	})

	s.FetchDashboardData(nil)

	mu.Lock()
	defer mu.Unlock()
	if len(limitAt) != subnetPageCount {
		t.Fatalf("subnets first page made %d distinct offset requests, want subnetPageCount=%d: %v", len(limitAt), subnetPageCount, limitAt)
	}
	for i := range subnetPageCount {
		off := strconv.Itoa(i * subnetPageSize)
		got, ok := limitAt[off]
		if !ok {
			t.Fatalf("no subnet page requested at _offset=%s — the offsets must tile 0..%d with no gap: %v", off, (subnetPageCount-1)*subnetPageSize, limitAt)
		}
		if got != strconv.Itoa(subnetPageSize) {
			t.Fatalf("subnet page at _offset=%s sent _limit=%q, want %q — a bigger page is exactly the cost this split removes", off, got, strconv.Itoa(subnetPageSize))
		}
	}
	if peakPages < 4 {
		t.Fatalf("peak concurrent subnet pages = %d, want >= 4 — pages issued one at a time buy nothing over the single 5,000-row call", peakPages)
	}
}

// TestSubnetFirstPage_OnePageFailureIsErrorNotPartial is the honesty rule for
// the split: one failed page (after its retry) makes the WHOLE first page read
// "error" and contribute zero rows. It must not ship the nine pages that
// worked, because a hole at offset 2000 under the label "the first N rows"
// (the UI's "showing X of N" numerator) states something untrue. The at-risk
// union is unaffected — exactly today's observable failure shape.
//
// Mutations that must turn this RED: in assembleSubnetPages, change the error
// short-circuit to `continue`; or drop the one-shot retry (offset 2000 is then
// requested once, not twice).
func TestSubnetFirstPage_OnePageFailureIsErrorNotPartial(t *testing.T) {
	var mu sync.Mutex
	deadPageHits := 0
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if r.URL.Path != "/api/ddi/v1/ipam/subnet" {
			writeResults(w, nil)
			return
		}
		switch {
		case q.Get("_filter") == "utilization.utilization>=70":
			writeResultsWithPage(w, []map[string]any{
				{"id": "at-risk-1", "name": "hot", "address": "10.9.0.0", "cidr": 24,
					"utilization": map[string]any{"total": 100, "used": 92}},
			}, map[string]any{"total_size": "1"})
		case q.Get("_limit") == "1":
			writeResultsWithPage(w, nil, map[string]any{"total_size": "9"})
		case q.Get("_offset") == "2000":
			// A page in the MIDDLE of the set: shipping the survivors would
			// leave a hole rather than a short prefix.
			mu.Lock()
			deadPageHits++
			mu.Unlock()
			w.WriteHeader(http.StatusInternalServerError)
		default:
			writeResults(w, []map[string]any{
				{"id": "sub-" + q.Get("_offset"), "name": "s", "address": "10.0.0.0", "cidr": 24,
					"utilization": map[string]any{"total": 100, "used": 10}},
			})
		}
	})

	data := s.FetchDashboardData(nil)

	meta, ok := data["_meta"].(map[string]any)
	if !ok || meta["subnets"] != "error" {
		t.Fatalf("_meta[subnets] = %v, want \"error\" — one failed page must not be laundered into ok/empty by its nine healthy neighbours", data["_meta"])
	}
	rows, ok := data["subnets"].([]map[string]any)
	if !ok {
		t.Fatalf("subnets missing or wrong type: %T", data["subnets"])
	}
	if len(rows) != 1 || rows[0]["id"] != "at-risk-1" {
		t.Fatalf("subnets = %v, want ONLY the at-risk row — the surviving pages must be discarded, not shipped as a holed prefix", rows)
	}
	mu.Lock()
	defer mu.Unlock()
	if deadPageHits != 2 {
		t.Fatalf("failing subnet page was requested %d times, want 2 (one attempt + one retry) — ten pages mean ~10x the chance the slice reads \"error\", and the retry is what pays that back", deadPageHits)
	}
}

// TestAssembleSubnetPages_DedupesAcrossPageBoundaries pins the id dedupe inside
// assembleSubnetPages. The ten _offset pages are concurrent reads of a LIVE
// table: a subnet created or deleted between two of them shifts every later
// offset by one, so the same row can be handed back by two different pages.
// Without the dedupe the union ships a duplicate subnet, which the UI counts
// twice in "showing X of N" and BuildSignals can alert on twice.
//
// This is deliberately a direct call on the pure function — no HTTP server can
// reproduce a mid-read shift reliably, and the whole suite stayed GREEN with
// the guard deleted precisely because nothing tested the function itself.
//
// Mutation that must turn this RED: delete the `if seen[id] { continue }` guard
// (and its `seen[id] = true`) from assembleSubnetPages' inner loop.
func TestAssembleSubnetPages_DedupesAcrossPageBoundaries(t *testing.T) {
	row := func(id string) any {
		return map[string]any{"id": id, "name": "sub-" + id, "address": "10.0.0.0", "cidr": 24}
	}
	// "b" is served by BOTH pages — exactly what an offset shift produces.
	pages := [][]any{
		{row("a"), row("b")},
		{row("b"), row("c")},
	}
	statuses := []string{"ok", "ok"}

	out, status := assembleSubnetPages(pages, statuses)

	if status != "ok" {
		t.Fatalf("assembleSubnetPages status = %q, want \"ok\" — every page succeeded", status)
	}
	if len(out) != 3 {
		t.Fatalf("assembled %d rows from pages [a b][b c], want 3 — a row served by two concurrent offset pages must be kept ONCE, not counted twice: %v", len(out), out)
	}
	counts := map[any]int{}
	for _, item := range out {
		counts[idOf(asMap(item)["id"])]++
	}
	if counts["b"] != 1 {
		t.Fatalf("id \"b\" appears %d times in the assembled first page, want exactly 1: %v", counts["b"], out)
	}
	for _, id := range []string{"a", "c"} {
		if counts[id] != 1 {
			t.Fatalf("id %q appears %d times, want exactly 1 — dedupe must not drop a row that was never duplicated: %v", id, counts[id], out)
		}
	}

	// NOT the same job as dedupeSubnets. That function unions the first page
	// with the at-risk pager and, by design, does NOT dedupe within its own
	// `first` argument — it only skips atRisk rows already seen. So it can
	// never stand in for the dedupe above, and "dedupeSubnets already covers
	// it" is false. Pinned here so the two are not confused.
	dup := []any{row("b"), row("b")}
	if got := dedupeSubnets(dup, nil); len(got) != 2 {
		t.Fatalf("dedupeSubnets(first=[b b], atRisk=nil) returned %d rows, want 2 — it deliberately does not dedupe within `first`, which is exactly why assembleSubnetPages has to", len(got))
	}
	if got := dedupeSubnets([]any{row("b")}, []any{row("b")}); len(got) != 1 {
		t.Fatalf("dedupeSubnets(first=[b], atRisk=[b]) returned %d rows, want 1 — it must still drop an atRisk row already present in first", len(got))
	}
}

// TestSubnetFirstPage_ConcatenatesInOffsetOrderNotCompletionOrder pins the
// ordering claim in assembleSubnetPages' contract: the pages are concatenated
// in OFFSET order, never in the order the goroutines happened to finish. The
// rows a caller sees are the UI's list and the "showing X of N" prefix, so they
// must not be reshuffled by upstream jitter between two identical loads.
//
// The fake upstream makes _offset=0 the SLOWEST page (every other offset
// returns immediately), so completion order is the exact REVERSE-ish of offset
// order and offset 0's row finishes last. Each offset returns a distinct id, so
// the assembled order is fully identifiable.
//
// Mutation that must turn this RED: replace buildAggregate's indexed
// `subnetPages[i]` slots with a mutex-guarded `append` from inside each page
// task (a completion-order implementation) -> "sub-0" lands LAST.
func TestSubnetFirstPage_ConcatenatesInOffsetOrderNotCompletionOrder(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if r.URL.Path != "/api/ddi/v1/ipam/subnet" {
			writeResults(w, nil)
			return
		}
		switch {
		case q.Get("_filter") != "":
			// The at-risk pager and the >=90 count: zero rows, so the union is
			// the offset pages and nothing else.
			writeResultsWithPage(w, nil, map[string]any{"total_size": "0"})
		case q.Get("_limit") == "1":
			writeResultsWithPage(w, nil, map[string]any{"total_size": "0"})
		default:
			off := q.Get("_offset")
			if off == "0" {
				// The FIRST page finishes LAST. Not a race the assertion
				// depends on: offset 0 is held long past every other page's
				// completion, so a completion-order build cannot put it first.
				time.Sleep(300 * time.Millisecond)
			}
			writeResults(w, []map[string]any{{
				"id": "sub-" + off, "name": "s" + off, "address": "10.0.0.0", "cidr": 24,
				"utilization": map[string]any{"total": 100, "used": 10},
			}})
		}
	})

	data := s.FetchDashboardData(nil)

	rows, ok := data["subnets"].([]map[string]any)
	if !ok {
		t.Fatalf("subnets missing or wrong type: %T", data["subnets"])
	}
	if len(rows) != subnetPageCount {
		t.Fatalf("subnets = %d rows, want subnetPageCount=%d (one distinct row per offset page)", len(rows), subnetPageCount)
	}
	if rows[0]["id"] != "sub-0" {
		t.Fatalf("first assembled subnet row is %v, want \"sub-0\" — _offset=0 was the SLOWEST page, so anything else means the pages are concatenated in COMPLETION order and the list reshuffles itself between two identical loads", rows[0]["id"])
	}
	for i := range subnetPageCount {
		want := "sub-" + strconv.Itoa(i*subnetPageSize)
		if rows[i]["id"] != want {
			t.Fatalf("subnets[%d] = %v, want %q — pages must be concatenated in offset order 0,%d,...,%d regardless of which goroutine finished first", i, rows[i]["id"], want, subnetPageSize, (subnetPageCount-1)*subnetPageSize)
		}
	}
}

// TestFanOut_AdmitsTasksInRegistrationOrder pins fanOut's admission contract:
// the first `bound` tasks REGISTERED are the first `bound` tasks to START.
// buildAggregate leans on this — it registers the 10 subnet pages, the at-risk
// pager and security_policies first precisely so those 12 measured long poles
// fill the bound at t=0. If admission goes back to being a race, the ~3.9s
// security_policies call can be admitted last and start ~1.2s late, and the
// whole cold-load win quietly shrinks with every other test still green.
//
// Deterministic by construction, no sleeps: every admitted task blocks on
// `release` and never finishes, so the semaphore stays saturated. Receiving
// exactly `bound` values from the buffered `started` channel therefore
// identifies exactly the tasks that were admitted at t=0 — the receive blocks
// until they have started, rather than a timer guessing when they have.
//
// Mutation that must turn this RED: move `sem <- struct{}{}` from fanOut's
// registration loop back INSIDE the spawned goroutine -> all `total`
// goroutines exist at once and race for the slots, so the winners are
// scheduler-chosen rather than the first `bound` registered.
func TestFanOut_AdmitsTasksInRegistrationOrder(t *testing.T) {
	// The real bound, and far more tasks than slots. The test itself is exact
	// either way — under the correct fanOut only the first `bound` tasks are
	// ever spawned, so it cannot flake (300 runs, 0 failures). The width is
	// chosen for the MUTATION: with 48 goroutines racing for 12 slots, a
	// scheduler-decided admission reproduced registration order in 1 run out of
	// 100, so the wrong implementation is caught essentially every time.
	const bound = dashboardFanOut
	const total = 4 * dashboardFanOut

	started := make(chan int, total)
	release := make(chan struct{})
	tasks := make([]func(), total)
	for i := range total {
		tasks[i] = func() {
			started <- i
			<-release
		}
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		fanOut(bound, tasks...)
	}()

	admitted := make(map[int]bool, bound)
	order := make([]int, 0, bound)
	for range bound {
		i := <-started
		admitted[i] = true
		order = append(order, i)
	}
	close(release)
	<-done

	for i := range bound {
		if !admitted[i] {
			t.Fatalf("task %d was registered in the first %d but was NOT among the first %d to start (started: %v) — fanOut must acquire its semaphore in the registration loop, not inside the goroutine, or buildAggregate's long poles no longer start at t=0", i, bound, bound, order)
		}
	}
	// Every task must still run: admission order must not cost completeness.
	if n := len(started) + bound; n != total {
		t.Fatalf("fanOut ran %d of %d tasks", n, total)
	}
}
