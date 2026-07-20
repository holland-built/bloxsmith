package dashboard

import (
	"context"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// RunAITool is _run_tool (server.py:3940): execute one AI tool call and return
// its JSON (or a "No X data." sentinel) as a string, exactly as the LLM loop
// expects. The eight MCP-backed tools go through s.Mcp (make_get_request /
// query_cube / network_entity_search) and the same norm_* shapers /api/data
// uses. The three threat-intel tools (dossier_lookup / lookalike_domains /
// asset_insights) call the ported TIDE/TDLAD/cube fetchers (FetchDossier /
// FetchLookalikes / FetchAssets, Phase 1i) so the LLM sees real threat-intel
// data with the same graceful "unavailable" degradation shape Python returns.
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

	if s.Mcp == nil {
		return "Tool error: MCP client not configured"
	}
	// Python opens a fresh MCP session per tool (_mcp_session); the Go client is
	// persistent, so (re)initialize the session before each call.
	if err := s.Mcp.Initialize(ctx); err != nil {
		return "Tool error: " + err.Error()
	}

	switch name {
	case "search_entity":
		hits := s.Mcp.Search(ctx, aiStr(args["query"]))
		if len(hits) == 0 {
			return "No entities found."
		}
		return jstr(capAny(hits, 10))

	case "get_subnets":
		params := map[string]any{"_fields": "name,address,cidr,utilization"}
		hasAddr := false
		if addr := aiStr(args["address"]); addr != "" {
			if aiAddrRE.MatchString(addr) {
				params["address"] = addr
			}
			hasAddr = true
		}
		if c, ok := aiInt(args["cidr"]); ok && c >= 0 && c <= 128 {
			params["cidr"] = strconv.Itoa(c)
		}
		rows := s.Mcp.Get(ctx, "Ipamsvc", "/ipam/subnet", params, !hasAddr)
		data := normSubnets(toAny(rows))
		if len(data) == 0 {
			return "No subnet data."
		}
		return jstr(capMaps(data, 100))

	case "get_hosts":
		rows := s.Mcp.Get(ctx, "Infrastructure", "/detail_hosts",
			map[string]any{"_fields": "display_name,ip_address,composite_status,host_type"}, true)
		data := normHosts(toAny(rows))
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
		return jstr(capMaps(data, 100))

	case "get_dns":
		viewsD := s.Mcp.Get(ctx, "DnsConfig", "/dns/view",
			map[string]any{"_fields": "id,name,comment"}, true)
		zonesD := s.Mcp.Get(ctx, "DnsConfig", "/dns/auth_zone",
			map[string]any{"_fields": "fqdn,view,zone_authority"}, true)
		vm := map[string]string{}
		for _, v := range viewsD {
			vm[getStr(v["id"])] = getStr(v["name"])
		}
		return jstr(map[string]any{
			"views": normViews(toAny(viewsD)),
			"zones": capMaps(normZones(toAny(zonesD), vm), 200),
		})

	case "get_dhcp_leases":
		rows := s.Mcp.Get(ctx, "DhcpLeases", "/dhcp/lease",
			map[string]any{"_fields": "address,hostname,state"}, true)
		data := normLeases(toAny(rows))
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
		return jstr(capMaps(data, 200))

	case "get_threat_feeds":
		rows := s.Mcp.Get(ctx, "Atcfw", "/named_lists",
			map[string]any{"_fields": "name,threat_level,item_count"}, true)
		data := normFeeds(toAny(rows))
		if len(data) == 0 {
			return "No threat feed data."
		}
		return jstr(data)

	case "get_audit_logs":
		limit := 20
		if n, ok := aiInt(args["limit"]); ok {
			limit = n
		}
		rows := s.Mcp.Get(ctx, "AuditLog", "/logs",
			map[string]any{"_limit": limit, "_order_by": "created_at desc"}, false)
		data := normAudit(toAny(rows))
		if len(data) == 0 {
			return "No audit log data."
		}
		return jstr(data)

	case "get_dns_analytics":
		days := 7
		if n, ok := aiInt(args["days"]); ok {
			days = n
		}
		limit := 10
		if n, ok := aiInt(args["limit"]); ok {
			limit = n
		}
		rows := s.Mcp.QueryCube(ctx, "NstarDnsActivity",
			[]string{"NstarDnsActivity.total_query_count"}, map[string]any{
				"dimensions": []string{"NstarDnsActivity.device_name", "NstarDnsActivity.device_ip"},
				"time_dimensions": []map[string]any{{
					"dimension": "NstarDnsActivity.timestamp",
					"dateRange": strconv.Itoa(days) + " days",
				}},
				"order": map[string]any{"NstarDnsActivity.total_query_count": "desc"},
				"limit": limit,
			})
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

// toAny widens []map[string]any (what mcp.Client returns) to []any (what the
// norm_* shapers accept), matching Python's _results() pass-through.
func toAny(ms []map[string]any) []any {
	out := make([]any, len(ms))
	for i, m := range ms {
		out[i] = m
	}
	return out
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
