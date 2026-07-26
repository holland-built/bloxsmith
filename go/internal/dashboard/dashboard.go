package dashboard

import (
	"log"
	"strconv"
	"time"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

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
func (s *Service) FetchDashboardData() map[string]any {
	ck := cache.Key("dashboard_rest", "", nil, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}

	// Generation fencing (server.py-equivalent tenant-switch guard): capture
	// gen BEFORE each attempt's upstream fetches and re-check it after. A
	// Rotate() mid-fetch means the result belongs to the wrong tenant; retry
	// the whole aggregate at most once rather than looping unbounded (which
	// would hand a busy, constantly-rotating tenant an empty dashboard).
	var result map[string]any
	for attempt := 0; attempt < 2; attempt++ {
		g := s.Cache.Gen()
		result = s.buildAggregate()
		if s.Cache.Gen() == g {
			s.Cache.SetGen(ck, result, g)
			return result
		}
	}
	// Both attempts raced a Rotate. Prefer a last-good cached snapshot
	// (marked stale) over handing back a possibly wrong-tenant aggregate; if
	// no snapshot survived the Rotate (it clears the cache), fall back to
	// the best-effort result from the second attempt.
	if v, ok := s.Cache.Get(ck); ok {
		snap := v.(map[string]any)
		if totals, ok := snap["_totals"].(map[string]any); ok {
			totals["stale"] = true
		}
		return snap
	}
	if totals, ok := result["_totals"].(map[string]any); ok {
		totals["stale"] = true
	}
	return result
}

// buildAggregate is one full /api/data fetch attempt: the eight REST feeds —
// subnets, leases, dnsViews, zones, hosts, secPolicies, feeds, auditLogs —
// each through its norm_* shaper, plus the additive _totals block. The MCP
// parquet path is broken server-side, so this uses direct REST exactly as
// Python does; the audit feed goes through GetEx so a 4xx (unavailable) is
// distinguishable from a genuinely empty feed.
func (s *Service) buildAggregate() map[string]any {
	subnetsD := s.Rest.Get("/api/ddi/v1/ipam/subnet",
		map[string]string{"_fields": subnetFields, "_limit": "5000"})
	leasesD := s.Rest.Get("/api/ddi/v1/dhcp/lease",
		map[string]string{"_fields": "address,hostname,state,client_id", "_limit": "5000"})
	viewsD := s.Rest.Get("/api/ddi/v1/dns/view",
		map[string]string{"_fields": "id,name,comment", "_limit": "5000"})
	zonesD := s.Rest.Get("/api/ddi/v1/dns/auth_zone",
		map[string]string{"_fields": "id,fqdn,view,zone_authority,primary_type,dnssec_status", "_limit": "5000"})
	hostsD := s.Rest.Get("/api/infra/v1/detail_hosts", map[string]string{"_limit": "500"})
	policiesD := s.Rest.Get("/api/atcfw/v1/security_policies", map[string]string{"_limit": "200"})
	feedsD := s.Rest.Get("/api/atcfw/v1/named_lists", map[string]string{"_limit": "200"})

	// The at-risk fetch is the fix for the core bug: BuildSignals (signals.go)
	// only ever sees data["subnets"], so any at-risk subnet outside the first
	// 5,000-row page raised no alert. Union it into the same "subnets" key
	// (deduped by id) instead of adding a second key, so BuildSignals is
	// correct with zero changes to signals.go.
	atRiskD, atRiskTotal, atRiskTotalOK, atRiskDegraded := s.fetchAtRiskSubnets()
	subnetsUnion := dedupeSubnets(subnetsD, atRiskD)

	// CSP portal audit — REST, status-surfacing (server.py:3609). MCP AuditLog
	// is broken server-side, so this is the only working path.
	auditBody, auditHTTP, _ := s.Rest.GetEx("/api/auditlog/v1/logs",
		map[string]string{"_limit": "100", "_order_by": "created_at desc"})
	auditD := rest.Unwrap(auditBody)
	auditStatus := "empty"
	if auditHTTP == 0 || auditHTTP >= 400 {
		auditStatus = "error"
	} else if len(auditD) > 0 {
		auditStatus = "ok"
	}

	viewMap := map[string]string{}
	for _, item := range viewsD {
		v := asMap(item)
		viewMap[getStr(v["id"])] = getStr(v["name"])
	}

	// _totals: additive-only tenant-wide counts, cheap _limit=1 count queries
	// (reusing atRiskTotal for subnetsWarn instead of a fifth redundant
	// query). A failed count query is OMITTED, never replaced with a
	// row-derived number that would contradict it — see fetchCount.
	subnetsTotal, subnetsTotalOK := s.fetchCount("/api/ddi/v1/ipam/subnet", nil)
	subnetsCrit, subnetsCritOK := s.fetchCount("/api/ddi/v1/ipam/subnet",
		map[string]string{"_filter": "utilization.utilization>=90"})
	hostsTotal, hostsTotalOK := s.fetchCount("/api/infra/v1/detail_hosts", nil)

	degraded := atRiskDegraded
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

	result := map[string]any{
		"subnets":     normSubnets(subnetsUnion),
		"leases":      normLeases(leasesD),
		"dnsViews":    normViews(viewsD),
		"zones":       normZones(zonesD, viewMap),
		"hosts":       normHosts(hostsD),
		"secPolicies": normPolicies(policiesD),
		"feeds":       normFeeds(feedsD),
		"auditLogs":   normAudit(auditD),
		"_meta":       map[string]any{"auditLogs": auditStatus},
		"_totals":     totals,
	}
	log.Printf("  subnets=%d(union, page=%d atRisk=%d) leases=%d zones=%d hosts=%d policies=%d feeds=%d audit=%d(%s) totals[subnets=%v subnetsCrit=%v subnetsWarn=%v hosts=%v degraded=%v]",
		len(subnetsUnion), len(subnetsD), len(atRiskD), len(leasesD), len(zonesD), len(hostsD),
		len(policiesD), len(feedsD), len(auditD), auditStatus,
		totals["subnets"], totals["subnetsCrit"], totals["subnetsWarn"], totals["hosts"], degraded)
	return result
}
