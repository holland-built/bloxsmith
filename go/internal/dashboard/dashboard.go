package dashboard

// Canonical feed-health vocabulary. Every status-shaped value this package
// emits — the per-feed "_meta" map (dashboard.go/signals.go/server/noc.go),
// the per-section "availability" scalar (hub.go, analytics.go, csp.go,
// sources.go), and the per-tile "status" scalar (assetcounts.go, csp.go) —
// is spelled from the same three words, never a fourth:
//
//   - "ok": the read succeeded, whether or not it returned rows.
//   - "empty": the read succeeded and genuinely found nothing. Never
//     conflate this with "error" — a quiet feed and a dead one must render
//     differently, or a real outage silently reads as "all clear".
//   - "error": the read itself failed (transport error, bad status,
//     unparseable/unexpected body). Never fabricate an "ok"/"empty" shape
//     from a failed read just because the failure path also produces zero
//     rows.
//
// The one exception is the attack-surface "availability" tri-state
// (CSPExposures/CSPExposedHostnames/CSPExposedIPs in csp.go), which adds a
// fourth, feed-specific value: "metadata-degraded" — rows fetched fine (the
// feed itself is healthy) but the upstream total is missing or internally
// inconsistent, so no total is emitted. That is a real third meaning, not a
// synonym for "error": the rows are trustworthy, only the total isn't. It
// does not apply outside the exposure feeds; do not spread it to _meta or
// tile status.
import (
	"errors"
	"log"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

// dataSlices is every data key /api/data can return, in the order
// buildAggregate assembles them. It doubles as the ?only= vocabulary: a name
// outside this list is rejected with a 400 (server/data.go) rather than quietly
// dropped, because a thinner-than-asked-for 200 is indistinguishable from
// "you have none".
//
// Deliberately NOT a slice name: "_totals". A narrowed response carries no
// _totals at all (see buildAggregate), because three of its four numbers come
// from count queries and the fourth (subnetsWarn) from the heavy at-risk pager
// — a "totals" pseudo-slice would need its own cheap filtered count and its own
// tests to earn its place. The only tab that would use it (Infra) is optional
// scope, so it is not built. Nothing invented, nothing defaulted.
var dataSlices = []string{"subnets", "leases", "dnsViews", "zones", "hosts", "secPolicies", "feeds", "auditLogs"}

// DataSlices returns the ?only= vocabulary as a fresh copy, so a caller
// building an error message cannot mutate the package's own list.
func DataSlices() []string {
	out := make([]string, len(dataSlices))
	copy(out, dataSlices)
	return out
}

// ValidSlice reports whether name is a slice /api/data knows how to fetch.
func ValidSlice(name string) bool {
	for _, s := range dataSlices {
		if s == name {
			return true
		}
	}
	return false
}

// sliceSet is the set of slices ONE /api/data request will actually fetch.
// A nil set means "all of them" — the historic, byte-identical full aggregate.
// A non-nil set is always the caller's request PLUS its dependency closure, so
// the set is literally the list of keys the response will contain.
type sliceSet map[string]bool

// has reports whether the aggregate should fetch name. A nil set fetches
// everything, which is what keeps the no-?only= path exactly as it was.
func (ss sliceSet) has(name string) bool { return ss == nil || ss[name] }

// all reports whether this is the full aggregate (the only shape that carries
// _totals and the degraded flag).
func (ss sliceSet) all() bool { return ss == nil }

// key renders the set as a stable, sorted string for the cache key.
func (ss sliceSet) key() string {
	names := make([]string, 0, len(ss))
	for name := range ss {
		names = append(names, name)
	}
	sort.Strings(names)
	return strings.Join(names, ",")
}

// newSliceSet turns a requested slice list into the set that will actually be
// fetched: the request plus its dependency closure. An empty/nil request
// returns nil — "no ?only= given" must stay the untouched full path.
//
// The closure is not an optimisation, it is a correctness rule: some slices
// cannot be shaped without another slice's rows, and the response must then
// REPORT that extra slice too (with its own genuine status), because the
// contract is "the payload contains exactly what was read".
func newSliceSet(only []string) sliceSet {
	if len(only) == 0 {
		return nil
	}
	ss := sliceSet{}
	for _, name := range only {
		ss[name] = true
	}
	// zones carry a human-readable view NAME, resolved through normZones'
	// viewMap which is built from the dns/view rows. Fetching zones without
	// dnsViews would hand back zones whose view is an opaque id — so dnsViews
	// is fetched, and returned.
	if ss["zones"] {
		ss["dnsViews"] = true
	}
	// subnets is a union of the first 5,000-row page and the at-risk pager
	// (dedupeSubnets); both live inside the "subnets" slice, so there is no
	// extra response key to add for it.
	return ss
}

// atRiskPageCap, atRiskRowCap, atRiskTimeCap bound the /api/data at-risk
// subnet paging loop (fetchAtRiskSubnets): whichever trips first stops the
// loop and marks the result degraded rather than silently truncating it.
const (
	atRiskPageCap = 5
	atRiskRowCap  = 25000
	atRiskTimeCap = 30 * time.Second
)

// subnetFields is the shared _fields param for both the first-page subnet
// fetch and the at-risk fetch, so normSubnets sees identically-shaped rows
// from either source.
const subnetFields = "id,name,address,cidr,utilization,tags"

// dashboardFanOut bounds how many of buildAggregate's 12 upstream calls are in
// flight at once.
//
// WHY 6, and what is NOT known. Measured (4 clean runs, 48 call pairs): the 12
// calls ran strictly sequentially and summed to ~18.6s of medians, of which the
// single slowest call (the 5,000-row subnet page) was ~7.5s. With a bound of 6,
// the theoretical floor is max(slowest call, total/6) = max(7.5s, 3.1s) = 7.5s
// — identical to an unbounded 12-way burst, because the critical path is one
// slow call, not queueing. So the bound costs nothing measurable and halves the
// burst width.
//
// It is deliberately conservative because of a real gap in the measurement:
// 4 concurrent full aggregates were fired at CSP and absorbed without slowing
// down, but a 12-way burst of DISTINCT heavy queries from ONE credential was
// never fired, so whether CSP rate-limits that shape is UNTESTED. 6 stays near
// the concurrency that was actually observed to be safe. Raise it only with a
// measurement, not a guess.
const dashboardFanOut = 6

// fanOut runs tasks concurrently, at most bound at a time, and returns once all
// have finished. Each task must write only to variables no other task touches;
// the WaitGroup then establishes happens-before for the caller's reads, so no
// further locking is needed. stdlib only — this repo has no golang.org/x/sync.
func fanOut(bound int, tasks ...func()) {
	sem := make(chan struct{}, bound)
	var wg sync.WaitGroup
	for _, task := range tasks {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			task()
		}()
	}
	wg.Wait()
}

// fetchAtRiskSubnets pages /api/ddi/v1/ipam/subnet filtered to
// utilization.utilization>=70 (the BuildSignals warn threshold), so every
// subnet BuildSignals would flag is present in data["subnets"] even though
// the first 5,000-row page alone would miss it. Paging stops at whichever of
// atRiskPageCap/atRiskRowCap/atRiskTimeCap trips first; a trip sets degraded
// true and is logged, never silently truncated. total/totalOK come from the
// FIRST page's page.total_size (an authoritative count independent of how
// much of the set we actually finish paging through); if that first request
// fails, neither rows nor total are usable.
func (s *Service) fetchAtRiskSubnets() (rows []any, total int, totalOK bool, degraded bool) {
	start := time.Now()
	offset := 0
	for page := 0; page < atRiskPageCap; page++ {
		if time.Since(start) > atRiskTimeCap {
			log.Printf("  at-risk subnet paging capped: elapsed>%s after %d rows", atRiskTimeCap, len(rows))
			degraded = true
			break
		}
		if len(rows) >= atRiskRowCap {
			log.Printf("  at-risk subnet paging capped: rowCap=%d reached", atRiskRowCap)
			degraded = true
			break
		}
		body, http, err := s.Rest.GetEx("/api/ddi/v1/ipam/subnet", map[string]string{
			"_fields":               subnetFields,
			"_filter":               "utilization.utilization>=70",
			"_limit":                "5000",
			"_offset":               strconv.Itoa(offset),
			"_is_total_size_needed": "true",
		})
		if err != nil || http >= 400 {
			log.Printf("  at-risk subnet fetch failed at offset=%d http=%d", offset, http)
			degraded = true
			if page == 0 {
				return nil, 0, false, true
			}
			break
		}
		batch := rest.Unwrap(body)
		if page == 0 {
			total = pageTotalSize(body, -1)
			totalOK = total >= 0
			if !totalOK {
				total = 0
			}
		}
		rows = append(rows, batch...)
		offset += len(batch)
		if len(batch) == 0 || (totalOK && len(rows) >= total) {
			break
		}
		if page == atRiskPageCap-1 {
			log.Printf("  at-risk subnet paging capped: pageCap=%d reached (total=%d, fetched=%d)", atRiskPageCap, total, len(rows))
			degraded = true
		}
	}
	if len(rows) > atRiskRowCap {
		rows = rows[:atRiskRowCap]
		degraded = true
	}
	return rows, total, totalOK, degraded
}

// fetchCount reads the authoritative tenant-wide row count for path+params via
// a cheap _limit=1&_is_total_size_needed=true request, returning (0, false) on
// any failure (non-2xx, network error, or an unparseable/missing
// page.total_size) so the caller never mistakes a failure for a real zero.
func (s *Service) fetchCount(path string, params map[string]string) (int, bool) {
	p := make(map[string]string, len(params)+2)
	for k, v := range params {
		p[k] = v
	}
	p["_limit"] = "1"
	p["_is_total_size_needed"] = "true"
	body, http, err := s.Rest.GetEx(path, p)
	if err != nil || http >= 400 {
		return 0, false
	}
	n := pageTotalSize(body, -1)
	return n, n >= 0
}

// dedupeSubnets returns the union of first and atRisk, deduped by the raw
// "id" field, preserving first's ordering and appending only atRisk rows not
// already present.
func dedupeSubnets(first, atRisk []any) []any {
	seen := make(map[any]bool, len(first))
	out := make([]any, 0, len(first)+len(atRisk))
	for _, item := range first {
		id := idOf(asMap(item)["id"])
		seen[id] = true
		out = append(out, item)
	}
	for _, item := range atRisk {
		id := idOf(asMap(item)["id"])
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, item)
	}
	return out
}

// FetchDashboardData is fetch_dashboard_data (server.py:3581): the /api/data
// aggregation. It batches the eight REST feeds — subnets, leases, dnsViews,
// zones, hosts, secPolicies, feeds, auditLogs — each through its norm_* shaper
// and returns ONE object plus a _meta status map. The MCP parquet path is
// broken server-side, so this uses direct REST exactly as Python does; the
// audit feed goes through GetEx so a 4xx (unavailable) is distinguishable from
// a genuinely empty feed. Cached under the "dashboard_rest" key with the shared
// TTL, matching the warm-loop's hot-cache behavior.
//
// only narrows the read to a subset of dataSlices (plus that subset's
// dependency closure). nil or empty means the full 12-call aggregate — byte for
// byte what this function returned before slice selection existed.
func (s *Service) FetchDashboardData(only []string) map[string]any {
	ss := newSliceSet(only)

	// Projection bridge. The whole aggregate lives under ONE cache key, so a
	// narrowed ask cached under its own key would MISS a warm full entry and go
	// upstream again — slower than the full request it was meant to beat. When
	// the full entry is warm, answer the narrowed ask straight out of it: zero
	// upstream calls.
	//
	// HONEST SCOPE — the bridge is one-directional. A warm FULL entry answers
	// narrowed asks, but a narrowed fetch does NOT warm the full entry, and a
	// warm narrowed entry does not answer a differently-narrowed ask. So within
	// one TTL a slice can be read twice (once narrowed, once inside a full
	// aggregate). That is one duplicate read of a read-only endpoint, accepted;
	// making warmth flow both ways means per-slice cache keys with their own
	// single-flight and generation fencing, deliberately deferred.
	if ss != nil {
		if v, ok := s.Cache.Get(dashboardCacheKey(nil)); ok {
			if full, ok := v.(map[string]any); ok {
				if projected := projectFull(full, ss); projected != nil {
					return projected
				}
			}
		}
	}

	ck := dashboardCacheKey(ss)

	// Single-flight (cache.Do): the Get-miss -> fetch -> Set path used to be
	// open, so N concurrent cold callers — two browser tabs, a poll landing on
	// top of a first load — each ran the full 12-call aggregate against the
	// same tenant. Measured duplicate contention cost ~+40% on the heavy subnet
	// query, i.e. the duplicates made the cold window worse for everyone. Do
	// collapses them: one caller fetches, the rest wait and share the result.
	v, err := s.Cache.Do(ck, func() (any, error) {
		// Generation fencing (server.py-equivalent tenant-switch guard):
		// capture gen BEFORE each attempt's upstream fetches and re-check it
		// after. A Rotate() mid-fetch means the result belongs to the wrong
		// tenant; retry the whole aggregate at most once rather than looping
		// unbounded (which would hand a busy, constantly-rotating tenant an
		// empty dashboard).
		var result map[string]any
		for attempt := 0; attempt < 2; attempt++ {
			g := s.Cache.Gen()
			result = s.buildAggregate(ss)
			if s.Cache.Gen() == g {
				// Do performs the cache write itself, fenced by the gen it
				// captured before this whole closure ran. If attempt 0 raced a
				// Rotate and attempt 1 succeeded, that outer fence no longer
				// matches and Do drops the write — the correct result is still
				// returned to every caller, only the caching of it is skipped
				// for that one rare race. Losing a cache write is a cost; a
				// wrong-tenant cache entry would be a bug.
				return result, nil
			}
		}
		// Both attempts raced a Rotate. Returning an error keeps Do from
		// caching this, and hands the same best-effort result to every waiter.
		return result, errRotatedMidFetch
	})

	result, _ := v.(map[string]any)
	if err == nil {
		return result
	}
	// Prefer a last-good cached snapshot (marked stale) over handing back a
	// possibly wrong-tenant aggregate; if no snapshot survived the Rotate (it
	// clears the cache), fall back to the best-effort result.
	//
	// The stale marker lives in _totals, which a narrowed payload does not
	// carry, so a narrowed snapshot goes back unmarked. Stated plainly rather
	// than papered over: no client reads _totals.stale today (grepped), so this
	// loses nothing that is currently used — but it is a real asymmetry, and a
	// future consumer of staleness needs a marker that both shapes can carry.
	if v, ok := s.Cache.Get(ck); ok {
		snap := v.(map[string]any)
		if totals, ok := snap["_totals"].(map[string]any); ok {
			totals["stale"] = true
		}
		return snap
	}
	if result == nil {
		// Do's panic guard is the only path that returns a nil value with an
		// error. It re-panics, so this is unreachable for the leader; a waiter
		// that got here must not be handed a nil map to dereference.
		return s.buildAggregate(ss)
	}
	if totals, ok := result["_totals"].(map[string]any); ok {
		totals["stale"] = true
	}
	return result
}

// errRotatedMidFetch marks an aggregate whose every attempt raced a tenant
// switch. It exists only to tell cache.Do "do not cache this" — the accompanying
// value is still the best-effort payload, not nil.
var errRotatedMidFetch = errors.New("dashboard: cache rotated during every aggregate attempt")

// buildAggregate is one full /api/data fetch attempt: the eight REST feeds —
// subnets, leases, dnsViews, zones, hosts, secPolicies, feeds, auditLogs —
// each through its norm_* shaper, plus the additive _totals block. The MCP
// parquet path is broken server-side, so this uses direct REST exactly as
// Python does; the audit feed goes through GetEx so a 4xx (unavailable) is
// distinguishable from a genuinely empty feed.
//
// ss narrows the attempt: a nil set runs all 12 tasks and returns all 8 data
// keys, all 8 _meta keys and _totals (the historic shape). A non-nil set runs
// ONLY the tasks its slices need and returns ONLY those slices' keys. A slice
// that was not fetched is absent from both the data map and _meta — absence IS
// the representation of "not asked for". There is no fourth status word, and
// the client must never read absence as "you have none".
func (s *Service) buildAggregate(ss sliceSet) map[string]any {
	// All 12 upstream calls are independent of each other, and they were
	// measured running strictly sequentially: every call started at the exact
	// millisecond the previous one ended, so the cold cost was the SUM of 12
	// latencies (~18.6s of medians) rather than the slowest one (~7.5s). They
	// are fanned out below, bounded by dashboardFanOut.
	//
	// Each task writes to its OWN variables — status and rows are set together
	// inside the same closure and never shared. That is not a style choice: it
	// is what keeps a feed that FAILED distinguishable from a feed that
	// returned nothing. A shared status/error variable across the fan-out is
	// exactly how "error" would get overwritten by a neighbour's "empty" and a
	// dead feed would silently render as "you have none".
	var (
		subnetsD, subnetsStatus   = []any(nil), ""
		leasesD, leasesStatus     = []any(nil), ""
		viewsD, viewsStatus       = []any(nil), ""
		zonesD, zonesStatus       = []any(nil), ""
		hostsD, hostsStatus       = []any(nil), ""
		policiesD, policiesStatus = []any(nil), ""
		feedsD, feedsStatus       = []any(nil), ""

		atRiskD                       []any
		atRiskTotal                   int
		atRiskTotalOK, atRiskDegraded bool

		auditD      []any
		auditStatus string

		subnetsTotal, subnetsCrit, hostsTotal       int
		subnetsTotalOK, subnetsCritOK, hostsTotalOK bool
	)

	// Tasks are collected in the SAME order they were passed to fanOut before
	// slice selection existed, so the nil-set path is unchanged down to which
	// call starts first under the fan-out bound. `want` drops the tasks whose
	// slice was not asked for; a nil set keeps every one of them.
	var tasks []func()
	want := func(slice string, task func()) {
		if ss.has(slice) {
			tasks = append(tasks, task)
		}
	}

	want("subnets", func() {
		subnetsD, subnetsStatus = fetchStrict(s.Rest, "/api/ddi/v1/ipam/subnet",
			map[string]string{"_fields": subnetFields, "_limit": "5000"})
	})
	want("leases", func() {
		leasesD, leasesStatus = fetchStrict(s.Rest, "/api/ddi/v1/dhcp/lease",
			map[string]string{"_fields": "address,hostname,state,client_id", "_limit": "5000"})
	})
	want("dnsViews", func() {
		viewsD, viewsStatus = fetchStrict(s.Rest, "/api/ddi/v1/dns/view",
			map[string]string{"_fields": "id,name,comment", "_limit": "5000"})
	})
	want("zones", func() {
		zonesD, zonesStatus = fetchStrict(s.Rest, "/api/ddi/v1/dns/auth_zone",
			map[string]string{"_fields": "id,fqdn,view,zone_authority,primary_type,dnssec_status", "_limit": "5000"})
	})
	want("hosts", func() {
		hostsD, hostsStatus = fetchStrict(s.Rest, "/api/infra/v1/detail_hosts", map[string]string{"_limit": "500"})
	})
	want("secPolicies", func() {
		policiesD, policiesStatus = fetchStrict(s.Rest, "/api/atcfw/v1/security_policies", map[string]string{"_limit": "200"})
	})
	want("feeds", func() {
		feedsD, feedsStatus = fetchStrict(s.Rest, "/api/atcfw/v1/named_lists", map[string]string{"_limit": "200"})
	})
	// The at-risk pager belongs to the subnets slice (dedupeSubnets unions it
	// with the first page), so it is gated on "subnets", not on its own name.
	want("subnets", func() {
		// The at-risk fetch is the fix for the core bug: BuildSignals
		// (signals.go) only ever sees data["subnets"], so any at-risk subnet
		// outside the first 5,000-row page raised no alert. It runs
		// alongside the other feeds, but its OWN paging loop stays strictly
		// sequential — each request's _offset is derived from the previous
		// batch's length, so overlapping its pages would fetch the wrong
		// rows. Do not parallelise inside fetchAtRiskSubnets.
		atRiskD, atRiskTotal, atRiskTotalOK, atRiskDegraded = s.fetchAtRiskSubnets()
	})
	want("auditLogs", func() {
		// CSP portal audit — REST, status-surfacing (server.py:3609). MCP
		// AuditLog is broken server-side, so this is the only working path.
		auditBody, auditHTTP, auditErr := s.Rest.GetEx("/api/auditlog/v1/logs",
			map[string]string{"_limit": "100", "_order_by": "created_at desc"})
		auditD = rest.Unwrap(auditBody)
		auditStatus = "empty"
		if auditErr != nil || auditHTTP == 0 || auditHTTP >= 400 {
			auditStatus = "error"
		} else if len(auditD) > 0 {
			auditStatus = "ok"
		}
	})
	if ss.all() {
		// _totals: additive-only tenant-wide counts, cheap _limit=1 count
		// queries (reusing atRiskTotal for subnetsWarn instead of a fifth
		// redundant query). A failed count query is OMITTED, never replaced with
		// a row-derived number that would contradict it — see fetchCount.
		//
		// Only the full aggregate carries _totals: subnetsWarn is the at-risk
		// pager's own first-page total, so a narrowed payload could only report
		// it by running the very call narrowing exists to skip. A narrowed
		// response therefore omits _totals entirely rather than shipping a
		// partial one that reads like a complete one.
		tasks = append(tasks,
			func() { subnetsTotal, subnetsTotalOK = s.fetchCount("/api/ddi/v1/ipam/subnet", nil) },
			func() {
				subnetsCrit, subnetsCritOK = s.fetchCount("/api/ddi/v1/ipam/subnet",
					map[string]string{"_filter": "utilization.utilization>=90"})
			},
			func() { hostsTotal, hostsTotalOK = s.fetchCount("/api/infra/v1/detail_hosts", nil) },
		)
	}

	fanOut(dashboardFanOut, tasks...)

	// Everything below runs after every task has finished (fanOut's WaitGroup
	// establishes happens-before), so these reads need no synchronisation.
	subnetsUnion := dedupeSubnets(subnetsD, atRiskD)

	viewMap := map[string]string{}
	for _, item := range viewsD {
		v := asMap(item)
		viewMap[getStr(v["id"])] = getStr(v["name"])
	}

	// Every value below is produced by the task that was actually run; a slice
	// that was not requested contributes nothing at all — no key, no status, no
	// zero standing in for a number nobody read.
	result := make(map[string]any, len(dataSlices)+2)
	meta := make(map[string]any, len(dataSlices))
	for _, name := range dataSlices {
		if !ss.has(name) {
			continue
		}
		switch name {
		case "subnets":
			result[name], meta[name] = normSubnets(subnetsUnion), subnetsStatus
		case "leases":
			result[name], meta[name] = normLeases(leasesD), leasesStatus
		case "dnsViews":
			result[name], meta[name] = normViews(viewsD), viewsStatus
		case "zones":
			result[name], meta[name] = normZones(zonesD, viewMap), zonesStatus
		case "hosts":
			result[name], meta[name] = normHosts(hostsD), hostsStatus
		case "secPolicies":
			result[name], meta[name] = normPolicies(policiesD), policiesStatus
		case "feeds":
			result[name], meta[name] = normFeeds(feedsD), feedsStatus
		case "auditLogs":
			result[name], meta[name] = normAudit(auditD), auditStatus
		}
	}
	result["_meta"] = meta

	if !ss.all() {
		log.Printf("  /api/data narrowed to [%s]: %v", ss.key(), meta)
		return result
	}

	degraded := atRiskDegraded
	if subnetsStatus == "error" || leasesStatus == "error" || viewsStatus == "error" ||
		zonesStatus == "error" || hostsStatus == "error" || policiesStatus == "error" || feedsStatus == "error" {
		degraded = true
	}
	totals := map[string]any{}
	if subnetsTotalOK {
		totals["subnets"] = subnetsTotal
	} else {
		degraded = true
	}
	if subnetsCritOK {
		totals["subnetsCrit"] = subnetsCrit
	} else {
		degraded = true
	}
	if atRiskTotalOK {
		totals["subnetsWarn"] = atRiskTotal
	} else {
		degraded = true
	}
	if hostsTotalOK {
		totals["hosts"] = hostsTotal
	} else {
		degraded = true
	}
	totals["degraded"] = degraded
	result["_totals"] = totals

	log.Printf("  subnets=%d(union, page=%d atRisk=%d, %s) leases=%d(%s) zones=%d(%s) hosts=%d(%s) policies=%d(%s) feeds=%d(%s) audit=%d(%s) totals[subnets=%v subnetsCrit=%v subnetsWarn=%v hosts=%v degraded=%v]",
		len(subnetsUnion), len(subnetsD), len(atRiskD), subnetsStatus, len(leasesD), leasesStatus,
		len(zonesD), zonesStatus, len(hostsD), hostsStatus, len(policiesD), policiesStatus,
		len(feedsD), feedsStatus, len(auditD), auditStatus,
		totals["subnets"], totals["subnetsCrit"], totals["subnetsWarn"], totals["hosts"], degraded)
	return result
}

// dashboardCacheKey is the cache key for one aggregate SHAPE. The full
// aggregate keeps its historic key byte for byte ("dashboard_rest" with no
// params), so the existing warm entry — the one ConnStatus keeps hot from every
// tab — is neither moved nor invalidated by this change. A narrowed ask gets
// its own key, built from the sorted CLOSED set, so ?only=zones and
// ?only=zones,dnsViews (identical payloads) share one entry.
func dashboardCacheKey(ss sliceSet) string {
	if ss == nil {
		return cache.Key("dashboard_rest", "", nil, false)
	}
	return cache.Key("dashboard_rest", "", map[string]string{"only": ss.key()}, false)
}

// projectFull answers a narrowed ask out of an already-warm FULL aggregate,
// with zero upstream calls. It returns nil — meaning "this warm entry cannot
// answer that ask, go and fetch" — if any requested slice or its status is
// missing from the full entry, so a future payload change can never make this
// silently hand back a thinner response than the caller asked for.
//
// The row slices are shared with the cached entry rather than copied. That is
// safe because every consumer of this map only reads it (the handler
// JSON-encodes it), and it is what makes the projection free.
func projectFull(full map[string]any, ss sliceSet) map[string]any {
	fullMeta, ok := full["_meta"].(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]any, len(ss)+1)
	meta := make(map[string]any, len(ss))
	for _, name := range dataSlices {
		if !ss[name] {
			continue
		}
		rows, hasRows := full[name]
		st, hasStatus := fullMeta[name]
		if !hasRows || !hasStatus {
			return nil
		}
		out[name] = rows
		meta[name] = st
	}
	out["_meta"] = meta
	return out
}

// fetchStrict wraps Rest.GetStrict with the same three-state status
// vocabulary ("ok"/"empty"/"error") already used for the audit feed at
// auditStatus above, so a dead upstream feed reports its failure instead of
// silently rendering as "you have none". On error the returned slice is a
// non-nil empty []any so every downstream norm* shaper and the handler keep
// working — one dead feed must never blank the whole /api/data payload.
func fetchStrict(c *rest.Client, path string, params map[string]string) ([]any, string) {
	rows, err := c.GetStrict(path, params)
	if err != nil {
		return []any{}, "error"
	}
	if len(rows) == 0 {
		return rows, "empty"
	}
	return rows, "ok"
}
