package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"bloxsmith/internal/rest"
)

// RunAITool is _run_tool (server.py:3940): execute one AI tool call and return
// its JSON (or a "No X data." sentinel) as a string, exactly as the LLM loop
// expects. Only search_entity still goes through s.Mcp (network_entity_search
// returns its result directly from the tool response and never touches the
// broken parquet store). Every other data tool (get_subnets, get_hosts,
// get_dns, get_dhcp_leases, get_threat_feeds, get_audit_logs,
// get_dns_analytics) now calls s.Rest / the cubejs REST endpoint directly:
// the MCP `query_stored_data` parquet store cannot be read back (reads fail
// by table_name, by resource_id, and via read_resource — verified live), so
// mcp.Get/QueryCube always returned zero rows. These same REST paths are
// already proven against this tenant by FetchDashboardData (dashboard.go) and
// the CSP tiles (csp.go). The three threat-intel tools (dossier_lookup /
// lookalike_domains / asset_insights) call the ported TIDE/TDLAD/cube
// fetchers (FetchDossier / FetchLookalikes / FetchAssets, Phase 1i) so the
// LLM sees real threat-intel data with the same graceful "unavailable"
// degradation shape Python returns.
func (s *Service) RunAITool(ctx context.Context, name string, args map[string]any) string {
	// Threat-intel tools reuse the same fetchers backing /api/dossier|lookalikes|assets.
	switch name {
	case "dossier_lookup":
		return jstr(s.FetchDossier(aiStr(args["indicator"]), aiStr(args["type"])))
	case "lookalike_domains":
		return jstr(s.FetchLookalikes())
	case "asset_insights":
		return jstr(s.FetchAssets(ctx))
	}

	// search_entity is the only tool still on the MCP path (network_entity_search
	// returns its hits directly, bypassing the broken parquet store), so it is
	// the only one gated on a working MCP session. An MCP init failure must not
	// block the REST-backed tools below.
	if name == "search_entity" {
		if s.Mcp == nil {
			return "Tool error: MCP client not configured"
		}
		// Python opens a fresh MCP session per tool (_mcp_session); the Go client
		// is persistent, so (re)initialize the session before each call.
		if err := s.Mcp.Initialize(ctx); err != nil {
			return "Tool error: " + err.Error()
		}
		hits := s.Mcp.Search(ctx, aiStr(args["query"]))
		if len(hits) == 0 {
			return "No entities found."
		}
		return jstr(capAny(hits, 10))
	}

	switch name {
	case "get_subnets":
		// _is_total_size_needed asks the subnet endpoint for the authoritative
		// tenant-wide row count in page.total_size — subnets is the one REST
		// list here where the fetched (capped-by-_limit) row count is NOT the
		// true total (verified live: 5000 fetched of a real 72,316). The other
		// list tools below return no page object even with this param and
		// their row counts already sit under their _limit, so it is NOT added
		// there — it would just be cargo-culted dead weight.
		params := map[string]string{"_fields": "name,address,cidr,utilization", "_limit": "5000",
			"_is_total_size_needed": "true"}
		if addr := aiStr(args["address"]); addr != "" {
			if aiAddrRE.MatchString(addr) {
				params["address"] = addr
			}
		}
		if c, ok := aiInt(args["cidr"]); ok && c >= 0 && c <= 128 {
			params["cidr"] = strconv.Itoa(c)
		}
		body, status, err := s.Rest.GetEx("/api/ddi/v1/ipam/subnet", params)
		if err != nil || status == 0 || status >= 400 {
			return "No subnet data."
		}
		data := normSubnets(rest.Unwrap(body))
		if len(data) == 0 {
			return "No subnet data."
		}
		return jstr(cappedPayloadWithTotal(data, aiSampleCap, pageTotalSize(body, len(data)), "subnets"))

	case "get_hosts":
		// _is_total_size_needed mirrors get_subnets: detail_hosts is a second
		// instance of the same truncation-as-total bug (500 fetched vs a real
		// 548 — the model was reporting the _limit, not the tenant total).
		body, status, err := s.Rest.GetEx("/api/infra/v1/detail_hosts",
			map[string]string{"_fields": "display_name,ip_address,composite_status,host_type", "_limit": "500",
				"_is_total_size_needed": "true"})
		if err != nil || status == 0 || status >= 400 {
			return "No host data."
		}
		data := normHosts(rest.Unwrap(body))
		total := pageTotalSize(body, len(data))
		if st := aiStr(args["status"]); st != "" {
			filtered := data[:0:0]
			for _, h := range data {
				if getStr(h["status"]) == st {
					filtered = append(filtered, h)
				}
			}
			data = filtered
		}
		if len(data) == 0 {
			return "No host data."
		}
		return jstr(cappedPayloadWithTotal(data, aiSampleCap, total, "hosts"))

	case "get_dns":
		viewsD := s.Rest.Get("/api/ddi/v1/dns/view",
			map[string]string{"_fields": "id,name,comment", "_limit": "5000"})
		zonesD := s.Rest.Get("/api/ddi/v1/dns/auth_zone",
			map[string]string{"_fields": "fqdn,view,zone_authority", "_limit": "5000"})
		vm := map[string]string{}
		for _, v := range viewsD {
			m := asMap(v)
			vm[getStr(m["id"])] = getStr(m["name"])
		}
		return jstr(map[string]any{
			"views": cappedPayload(normViews(viewsD), aiSampleCap, "DNS views"),
			"zones": cappedPayload(normZones(zonesD, vm), aiSampleCap, "DNS zones"),
		})

	case "get_dhcp_leases":
		rows := s.Rest.Get("/api/ddi/v1/dhcp/lease",
			map[string]string{"_fields": "address,hostname,state", "_limit": "5000"})
		data := normLeases(rows)
		if sub := aiStr(args["subnet"]); sub != "" {
			filtered := data[:0:0]
			for _, l := range data {
				if strings.HasPrefix(getStr(l["addr"]), sub) {
					filtered = append(filtered, l)
				}
			}
			data = filtered
		}
		if len(data) == 0 {
			return "No lease data."
		}
		return jstr(cappedPayload(data, aiSampleCap, "DHCP leases"))

	case "get_threat_feeds":
		rows := s.Rest.Get("/api/atcfw/v1/named_lists",
			map[string]string{"_fields": "name,threat_level,item_count", "_limit": "200"})
		data := normFeeds(rows)
		if len(data) == 0 {
			return "No threat feed data."
		}
		return jstr(cappedPayload(data, aiSampleCap, "threat feeds"))

	case "get_audit_logs":
		limit := 20
		if n, ok := aiInt(args["limit"]); ok {
			limit = n
		}
		rows := s.Rest.Get("/api/auditlog/v1/logs",
			map[string]string{"_limit": strconv.Itoa(limit), "_order_by": "created_at desc"})
		data := normAudit(rows)
		if len(data) == 0 {
			return "No audit log data."
		}
		return jstr(cappedPayload(data, aiSampleCap, "audit log entries"))

	case "get_dns_analytics":
		days := 7
		if n, ok := aiInt(args["days"]); ok {
			days = n
		}
		limit := 10
		if n, ok := aiInt(args["limit"]); ok {
			limit = n
		}
		q, _ := json.Marshal(map[string]any{
			"measures":   []string{"NstarDnsActivity.total_query_count"},
			"dimensions": []string{"NstarDnsActivity.device_name", "NstarDnsActivity.device_ip"},
			"timeDimensions": []map[string]any{{
				"dimension": "NstarDnsActivity.timestamp",
				"dateRange": "last " + strconv.Itoa(days) + " days",
			}},
			"order": map[string]any{"NstarDnsActivity.total_query_count": "desc"},
			"limit": limit,
		})
		body, status, err := s.Rest.GetEx("/api/cubejs/v1/query", map[string]string{"query": string(q)})
		if err != nil || status == 0 || status >= 400 {
			return "No DNS analytics data."
		}
		rows := cubeData(body)
		if len(rows) == 0 {
			return "No DNS analytics data."
		}
		return jstr(rows)
	}
	return "Unknown tool: " + name
}

// aiAddrRE is the IP/CIDR-ish filter guard (server.py:3972) applied to a
// caller-supplied subnet address before it is forwarded upstream.
var aiAddrRE = regexp.MustCompile(`^[0-9a-fA-F:.]{1,45}(/\d{1,3})?$`)

// aiSampleCap is the ONE shared row-sample size for every list-shaped AI
// tool result (get_subnets, get_hosts, get_dns views/zones, get_dhcp_leases,
// get_threat_feeds, get_audit_logs). It is deliberately small: the backing
// model (llama-3.3-70b via Groq, free tier) has a 12,000 tokens-per-minute
// budget, and a fat sample was eating most of it — "how many hosts" started
// 429ing with "Rate limit reached ... TPM Limit 12000, Used 10494". The
// authoritative count travels in `total_count` and the `summary` sentence,
// NOT in sample length, so shrinking this buys back TPM headroom for free —
// it does not cost the model any counting accuracy. Change it in this one
// place, not per call site.
const aiSampleCap = 25

// toolPayload is the tool-result envelope for every list-shaped AI tool. It
// is a struct, not a map[string]any, specifically so json.Marshal preserves
// field declaration order and Summary serializes FIRST: encoding/json always
// alphabetizes map keys, which would bury "summary" after "returned" and
// "sample" and defeat the point of leading with it.
type toolPayload struct {
	Summary    string           `json:"summary"`
	TotalCount int              `json:"total_count"`
	Returned   int              `json:"returned"`
	Truncated  bool             `json:"truncated"`
	Sample     []map[string]any `json:"sample"`
}

// cappedPayload is the tool-result envelope for every list-shaped AI tool:
// it reports the TRUE row count (measured before capping) alongside the
// possibly-truncated sample the model actually sees. Silently truncating a
// row array with no count was the original bug (the model answered "26
// subnets" for a tenant with 5000, then later "100" — parroting `returned`
// off a bare total_count/returned pair). The backing model (llama-3.3-70b via
// Groq) does not reliably honor a structured-field-precedence rule at that
// tier, so the authoritative number is now also spelled out in a plain-
// English `summary` sentence INSIDE the tool result — belt-and-braces with
// the system-prompt instruction, not a replacement for it. noun is the
// per-tool plural ("subnets", "hosts", ...) used in that sentence.
func cappedPayload(rows []map[string]any, n int, noun string) toolPayload {
	return cappedPayloadWithTotal(rows, n, len(rows), noun)
}

// cappedPayloadWithTotal is cappedPayload with the total_count supplied by
// the caller instead of derived from len(rows) — for endpoints (get_subnets)
// where the fetched-and-capped row count is NOT the true tenant-wide total;
// see pageTotalSize.
func cappedPayloadWithTotal(rows []map[string]any, n int, total int, noun string) toolPayload {
	sample := capMaps(rows, n)
	returned := len(sample)
	truncated := total > returned
	summary := fmt.Sprintf("%d %s exist in total; all are listed below.", total, noun)
	if truncated {
		summary = fmt.Sprintf("%d %s exist in total; the %d below are a sample, not the full list.",
			total, noun, returned)
	}
	return toolPayload{
		Summary:    summary,
		TotalCount: total,
		Returned:   returned,
		Truncated:  truncated,
		Sample:     sample,
	}
}

// pageTotalSize reads the authoritative tenant-wide row count from a REST
// response's page.total_size (present only when the request sent
// `_is_total_size_needed=true`). The field is a JSON STRING ("72316"), not a
// number, so it is parsed defensively: a missing page object, a non-string
// total_size, or an unparseable/negative value all fall back to `fallback`
// (the count of rows actually fetched) rather than inventing a number. ZERO
// IS A VALID TOTAL: CSP legitimately reports page.total_size: "0" when a
// filtered query (e.g. a >=90% utilization crit-subnet count) genuinely
// matches nothing, and that must be returned as 0, not treated as
// unparseable — do not "tighten" this back to n <= 0.
func pageTotalSize(body any, fallback int) int {
	page, ok := asMap(body)["page"].(map[string]any)
	if !ok {
		return fallback
	}
	ts, ok := page["total_size"].(string)
	if !ok {
		return fallback
	}
	n, err := strconv.Atoi(strings.TrimSpace(ts))
	if err != nil || n < 0 {
		return fallback
	}
	return n
}

func capMaps(ms []map[string]any, n int) []map[string]any {
	if len(ms) > n {
		return ms[:n]
	}
	return ms
}

func capAny(a []any, n int) []any {
	if len(a) > n {
		return a[:n]
	}
	return a
}

// jstr is json.dumps(data, default=str): never raises — an unmarshalable value
// degrades to an empty array rather than aborting the tool.
func jstr(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "[]"
	}
	return string(b)
}

// aiStr coerces an LLM-supplied arg to a string (Python str(args.get(k, ""))).
func aiStr(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return vToStr(v)
}

// aiInt coerces an LLM-supplied arg to an int; ok=false when it is absent or
// not numeric (mirrors Python's int(args.get(...)) guarded by try/except).
func aiInt(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(t)); err == nil {
			return n, true
		}
	}
	return 0, false
}
