package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"bloxsmith/internal/cache"
)

// This file ports the MCP/REST-backed analytics + SOC fetchers:
// fetch_actions (server.py:4160), fetch_mcp_events (4188), fetch_insights
// (4252) + norm_insights (4229), fetch_dns_analytics (4302), fetch_host_metrics
// (4319) and threat_lookup (4551). Each degrades gracefully — never panics into
// the route — mirroring the Python contract.

// --- IQ Actions (server.py fetch_actions 4160 / _fetch_actions_async 4149) ----

// FetchActions is fetch_actions: IQ Actions (SOC incidents) via the
// iq-actions_list_actions MCP tool. Never raises — degrades to an
// {"actions":[],"unavailable":...} shape.
func (s *Service) FetchActions(ctx context.Context) map[string]any {
	raw, ok := s.actionsAsync(ctx)
	if !ok {
		return map[string]any{"actions": []any{},
			"unavailable": "IQ Actions service unavailable (upstream error)."}
	}
	data, isMap := raw.(map[string]any)
	if !isMap {
		return map[string]any{"actions": []any{},
			"unavailable": "IQ Actions returned unexpected data."}
	}
	if v, has := data["actions"]; !has || v == nil {
		data["actions"] = []any{}
	}
	if !truthy(data["actions"]) {
		if _, hasU := data["unavailable"]; !hasU {
			data["unavailable"] = "No IQ Actions (SOC incidents) for this tenant."
		}
	}
	return data
}

// actionsMaxFetch caps the total actions merged across pages, protecting
// against a runaway upstream (e.g. has_more never going false).
const actionsMaxFetch = 500

// actionsPageSize is the per-page limit passed to iq-actions_list_actions.
const actionsPageSize = 50

// actionsAsync mirrors _fetch_actions_async: (parsed, gotResponse). On any
// transport/init error it reports gotResponse=false (the outer upstream-error
// degrade); a JSON decode failure returns a {"actions":[],"_raw":...} map, true.
// It pages through iq-actions_list_actions via limit/offset, merging results
// until pagination.has_more is false or actionsMaxFetch is reached.
func (s *Service) actionsAsync(ctx context.Context) (any, bool) {
	if s.Mcp == nil || s.Mcp.Initialize(ctx) != nil {
		return nil, false
	}
	merged := []any{}
	var last map[string]any
	offset := 0
	for {
		text, err := s.Mcp.CallTool(ctx, "iq-actions_list_actions", map[string]any{
			"limit": actionsPageSize, "offset": offset,
			"sort_field": "last_activity", "sort_order": "desc", "format": "json",
		})
		if err != nil {
			if offset == 0 {
				return nil, false
			}
			break
		}
		var v any
		if json.Unmarshal([]byte(text), &v) != nil {
			if offset == 0 {
				return map[string]any{"actions": []any{}, "_raw": trunc(text, 200)}, true
			}
			break
		}
		page, isMap := v.(map[string]any)
		if !isMap {
			if offset == 0 {
				return v, true
			}
			break
		}
		last = page
		merged = append(merged, asSlice(page["actions"])...)

		hasMore := false
		if pg, ok := page["pagination"].(map[string]any); ok {
			hasMore = truthy(pg["has_more"])
		}
		if !hasMore || len(merged) >= actionsMaxFetch {
			break
		}
		offset += actionsPageSize
	}
	if last == nil {
		last = map[string]any{}
	}
	last["actions"] = merged
	return last, true
}

// GetAction is a single-action read via iq-actions_get_action. Degrades to
// {"unavailable": ...} on any error, matching FetchActions' degrade style.
func (s *Service) GetAction(ctx context.Context, id string) map[string]any {
	if s.Mcp == nil || s.Mcp.Initialize(ctx) != nil {
		return map[string]any{"unavailable": "IQ Actions service unavailable (upstream error)."}
	}
	text, err := s.Mcp.CallTool(ctx, "iq-actions_get_action", map[string]any{
		"id": id, "format": "json",
	})
	if err != nil {
		return map[string]any{"unavailable": "IQ Actions service unavailable (upstream error)."}
	}
	var v any
	if json.Unmarshal([]byte(text), &v) != nil {
		return map[string]any{"unavailable": "IQ Actions returned unexpected data."}
	}
	m, isMap := v.(map[string]any)
	if !isMap {
		return map[string]any{"unavailable": "IQ Actions returned unexpected data."}
	}
	return m
}

// UpdateAction is the first IQ Actions write path: resolve/reopen one action
// via iq-actions_update_action. status must be exactly "active" or
// "resolved" — the upstream tool has no version/etag precondition, so this is
// the only guard against bad input. The current status is read first (via
// iq-actions_get_action) so the caller can audit old->new; if that read
// fails, the write still proceeds with old status "unknown".
func (s *Service) UpdateAction(ctx context.Context, id, status string) (map[string]any, error) {
	if strings.TrimSpace(id) == "" {
		return nil, fmt.Errorf("id is required")
	}
	if status != "active" && status != "resolved" {
		return nil, fmt.Errorf("invalid status %q: must be \"active\" or \"resolved\"", status)
	}
	if s.Mcp == nil || s.Mcp.Initialize(ctx) != nil {
		return nil, fmt.Errorf("IQ Actions service unavailable (upstream error)")
	}

	oldStatus := "unknown"
	if cur := s.GetAction(ctx, id); cur != nil {
		if action, ok := cur["action"].(map[string]any); ok {
			oldStatus = getStr(action["status"])
		} else if st := getStr(cur["status"]); st != "" {
			oldStatus = st
		}
	}
	if oldStatus == "" {
		oldStatus = "unknown"
	}

	text, err := s.Mcp.CallTool(ctx, "iq-actions_update_action", map[string]any{
		"id": id, "status": status, "format": "json",
	})
	if err != nil {
		return nil, err
	}
	var v any
	if json.Unmarshal([]byte(text), &v) != nil {
		// Upstream replied 200 but the body didn't parse: the write outcome is
		// unknown, not a success — never report ok:true for an unconfirmed write.
		return map[string]any{
			"ok": false, "id": id, "old_status": oldStatus, "new_status": status,
			"error":      "IQ Actions update returned an unparseable response; outcome unknown.",
			"result_raw": trunc(text, 200),
		}, nil
	}

	return map[string]any{
		"ok": true, "id": id, "old_status": oldStatus, "new_status": status,
		"result": v,
	}, nil
}

// --- SOC Insights (server.py fetch_insights 4252 / norm_insights 4229) -------

// FetchInsights is fetch_insights: the direct REST /api/v1/insights read (the
// SecurityActionSummaryView cube is dead server-side). Degrades to
// {"data":[],"unavailable":...}; never fabricates.
func (s *Service) FetchInsights() map[string]any {
	ck := cache.Key("insights", "", nil, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()
	raw, _, _ := s.Rest.GetEx("/api/v1/insights", nil)
	var rows []any
	if m, ok := raw.(map[string]any); ok {
		rows = asSlice(m["insightList"])
	}
	var result map[string]any
	if len(rows) > 0 {
		result = map[string]any{"data": normInsights(rows)}
	} else {
		result = map[string]any{"data": []any{},
			"unavailable": "No SOC Insights (security actions) in the last 30 days for this tenant."}
	}
	s.Cache.SetGen(ck, result, g)
	return result
}

// normInsights is norm_insights (server.py:4229).
func normInsights(raw []any) []any {
	out := []any{}
	for _, ri := range raw {
		r := asMap(ri)
		severity := ""
		if pt := getStr(r["priorityText"]); pt != "" {
			severity = strings.ToLower(pt)
		}
		if severity == "" {
			severity = "medium"
		}
		out = append(out, map[string]any{
			"id":                  orStr(r["insightId"], ""),
			"name":                orStr(r["tFamily"], r["threatType"], r["insightId"], ""),
			"severity":            severity,
			"currentStatus":       orStr(r["status"], ""),
			"totalEvents":         toInt(orAny(r["numEvents"], 0)),
			"totalVerifiedAssets": 0,
			"timeSaved":           0,
			"count":               1,
			"totalTimeSaved":      0,
			"feedSource":          orStr(r["feedSource"], ""),
			"startedAt":           orStr(r["startedAt"], ""),
			"mostRecentAt":        orStr(r["mostRecentAt"], ""),
		})
	}
	return out
}

// --- DNS Analytics (server.py fetch_dns_analytics 4302) ----------------------

// FetchDNSAnalytics is fetch_dns_analytics: three NstarDnsActivity cube queries
// (7-day volume trend, top clients, query-type mix).
func (s *Service) FetchDNSAnalytics(ctx context.Context) map[string]any {
	vol, clients, types := []any{}, []any{}, []any{}
	if s.Mcp != nil && s.Mcp.Initialize(ctx) == nil {
		vol = toAnyN(s.Mcp.QueryCube(ctx, "NstarDnsActivity",
			[]string{"NstarDnsActivity.total_query_count"}, map[string]any{
				"time_dimensions": []map[string]any{{
					"dimension": "NstarDnsActivity.timestamp",
					"dateRange": "7 days", "granularity": "day"}},
			}))
		clients = toAnyN(s.Mcp.QueryCube(ctx, "NstarDnsActivity",
			[]string{"NstarDnsActivity.total_query_count"}, map[string]any{
				"dimensions": []string{"NstarDnsActivity.device_name", "NstarDnsActivity.device_ip"},
				"time_dimensions": []map[string]any{{
					"dimension": "NstarDnsActivity.timestamp", "dateRange": "7 days"}},
				"order": map[string]any{"NstarDnsActivity.total_query_count": "desc"}, "limit": 50,
			}))
		types = toAnyN(s.Mcp.QueryCube(ctx, "NstarDnsActivity",
			[]string{"NstarDnsActivity.total_query_count"}, map[string]any{
				"dimensions": []string{"NstarDnsActivity.query_type"},
				"time_dimensions": []map[string]any{{
					"dimension": "NstarDnsActivity.timestamp", "dateRange": "7 days"}},
				"order": map[string]any{"NstarDnsActivity.total_query_count": "desc"}, "limit": 10,
			}))
	}
	return map[string]any{"volume": vol, "top_clients": clients, "query_types": types}
}

// --- Host Metrics (server.py fetch_host_metrics 4319) ------------------------

// FetchHostMetrics is fetch_host_metrics: the HostMetrics cube (1-hour avg per
// host+metric).
func (s *Service) FetchHostMetrics(ctx context.Context) map[string]any {
	metrics := []any{}
	if s.Mcp != nil && s.Mcp.Initialize(ctx) == nil {
		metrics = toAnyN(s.Mcp.QueryCube(ctx, "HostMetrics",
			[]string{"HostMetrics.avg_value"}, map[string]any{
				"dimensions": []string{"HostMetrics.host_name", "HostMetrics.metric_name"},
				"time_dimensions": []map[string]any{{
					"dimension": "HostMetrics.timestamp", "dateRange": "1 hours"}},
				"order": map[string]any{"HostMetrics.avg_value": "desc"}, "limit": 100,
			}))
	}
	return map[string]any{"metrics": metrics}
}

// --- Threat Lookup (server.py threat_lookup 4551 / _threat_lookup_async) -----

// ThreatLookup is threat_lookup: network_entity_search over one query string.
func (s *Service) ThreatLookup(ctx context.Context, query string) map[string]any {
	entities := []any{}
	if s.Mcp != nil && s.Mcp.Initialize(ctx) == nil {
		if hits := s.Mcp.Search(ctx, query); hits != nil {
			entities = hits
		}
	}
	return map[string]any{"entities": entities, "query": query}
}
