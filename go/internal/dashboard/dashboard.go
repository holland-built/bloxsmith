package dashboard

import (
	"log"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

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
	// Capture the cache generation BEFORE the upstream fetch: a vault/portal
	// tenant switch mid-fetch Rotates the cache, and SetGen then drops this
	// now-wrong-tenant result instead of caching it under the new tenant.
	g := s.Cache.Gen()

	subnetsD := s.Rest.Get("/api/ddi/v1/ipam/subnet",
		map[string]string{"_fields": "id,name,address,cidr,utilization,tags", "_limit": "5000"})
	leasesD := s.Rest.Get("/api/ddi/v1/dhcp/lease",
		map[string]string{"_fields": "address,hostname,state,client_id", "_limit": "5000"})
	viewsD := s.Rest.Get("/api/ddi/v1/dns/view",
		map[string]string{"_fields": "id,name,comment", "_limit": "5000"})
	zonesD := s.Rest.Get("/api/ddi/v1/dns/auth_zone",
		map[string]string{"_fields": "id,fqdn,view,zone_authority,primary_type", "_limit": "5000"})
	hostsD := s.Rest.Get("/api/infra/v1/detail_hosts", map[string]string{"_limit": "500"})
	policiesD := s.Rest.Get("/api/atcfw/v1/security_policies", map[string]string{"_limit": "200"})
	feedsD := s.Rest.Get("/api/atcfw/v1/named_lists", map[string]string{"_limit": "200"})

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

	result := map[string]any{
		"subnets":     normSubnets(subnetsD),
		"leases":      normLeases(leasesD),
		"dnsViews":    normViews(viewsD),
		"zones":       normZones(zonesD, viewMap),
		"hosts":       normHosts(hostsD),
		"secPolicies": normPolicies(policiesD),
		"feeds":       normFeeds(feedsD),
		"auditLogs":   normAudit(auditD),
		"_meta":       map[string]any{"auditLogs": auditStatus},
	}
	log.Printf("  subnets=%d leases=%d zones=%d hosts=%d policies=%d feeds=%d audit=%d(%s)",
		len(subnetsD), len(leasesD), len(zonesD), len(hostsD), len(policiesD), len(feedsD),
		len(auditD), auditStatus)
	s.Cache.SetGen(ck, result, g)
	return result
}
