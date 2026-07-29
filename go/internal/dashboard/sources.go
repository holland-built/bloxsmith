package dashboard

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"bloxsmith/internal/rest"
)

// This file ports the curated data-source registry (server.py:4595-4874): the
// SOURCES catalog behind /api/sources (meta only) and /api/source/<id>
// (normalized {rows,count,fields}), plus the norm_* shapers each source uses
// (norm_threat_feeds 4605 … norm_incidents 4671) and source_rows (4824) with
// its equality filter + honest t0/t1 time window.

// fld is _fld (server.py:4602): one typed field descriptor.
func fld(name, typ, role string) map[string]any {
	return map[string]any{"name": name, "type": typ, "role": role}
}

// --- registry-specific shapers (server.py:4605-4681) -------------------------

func normThreatFeeds(raw []any) []any {
	out := []any{}
	for _, fi := range raw {
		f := asMap(fi)
		out = append(out, map[string]any{
			"name":         getStr(f["name"]),
			"source":       getStr(f["source"]),
			"confidence":   orAny(f["confidence_level"], ""),
			"threat_level": orAny(f["threat_level"], ""),
		})
	}
	return out
}

func normNamedLists(raw []any) []any {
	out := []any{}
	for _, ni := range raw {
		n := asMap(ni)
		out = append(out, map[string]any{
			"name":         getStr(n["name"]),
			"type":         getStr(n["type"]),
			"item_count":   orAny(n["item_count"], 0),
			"threat_level": orAny(n["threat_level"], ""),
			"policies":     len(asSlice(n["policies"])),
		})
	}
	return out
}

func normSourceDFP(raw []any) []any {
	host := func(d map[string]any) string {
		h := d["host"]
		if lst, ok := h.([]any); ok {
			if len(lst) > 0 {
				if m, ok := lst[0].(map[string]any); ok {
					return getStr(m["name"])
				}
			}
			return ""
		}
		hs := vToStr(h)
		if len(hs) > 40 {
			hs = hs[:40]
		}
		return hs
	}
	out := []any{}
	for _, di := range raw {
		d := asMap(di)
		out = append(out, map[string]any{
			"name":      getStr(d["name"]),
			"mode":      orStr(d["forwarding_policy"], d["mode"], ""),
			"host":      host(d),
			"resolvers": len(asSlice(d["default_resolvers"])),
		})
	}
	return out
}

func normAnycast(raw []any) []any {
	out := []any{}
	for _, ai := range raw {
		a := asMap(ai)
		state := "unknown"
		if rt, ok := a["runtime_status"].(map[string]any); ok {
			state = strings.ToLower(vToStr(orAny(rt["state"], rt)))
		} else if a["runtime_status"] != nil {
			state = strings.ToLower(vToStr(a["runtime_status"]))
		}
		if state == "" {
			state = "unknown"
		}
		out = append(out, map[string]any{
			"name":    getStr(a["name"]),
			"service": getStr(a["service"]),
			"ip":      getStr(a["anycast_ip_address"]),
			"state":   state,
		})
	}
	return out
}

func normRoaming(raw []any) []any {
	out := []any{}
	for _, di := range raw {
		d := asMap(di)
		out = append(out, map[string]any{
			"name":    getStr(d["name"]),
			"status":  vToStr(orAny(d["display_status"], d["calculated_status"], "unknown")),
			"country": getStr(d["country_name"]),
			"os":      getStr(d["os_platform"]),
			"group":   getStr(d["group_name"]),
		})
	}
	return out
}

func normRecords(raw []any) []any {
	out := []any{}
	for _, ri := range raw {
		r := asMap(ri)
		meta := asMap(r["nios_metadata"])
		rtype := strings.ToUpper(strings.ReplaceAll(vToStr(meta["objType"]), "record_", ""))
		if rtype == "" {
			rtype = getStr(r["type"])
		}
		out = append(out, map[string]any{
			"name":     orStr(r["absolute_name_spec"], r["name_in_zone"], ""),
			"zone":     getStr(r["absolute_zone_name"]),
			"type":     rtype,
			"rdata":    getStr(r["dns_rdata"]),
			"disabled": truthy(r["disabled"]),
		})
	}
	return out
}

// normIncidents is norm_incidents (server.py:4671): shape fetch_actions output.
func normIncidents(raw any) []any {
	var acts []any
	if m, ok := raw.(map[string]any); ok {
		acts = asSlice(m["actions"])
	} else {
		acts = asSlice(raw)
	}
	out := []any{}
	for _, ai := range acts {
		a := asMap(ai)
		out = append(out, map[string]any{
			"id":            orStr(a["id"], ""),
			"type":          orStr(a["type"], ""),
			"title":         orStr(a["title"], ""),
			"priority":      orStr(a["priority"], ""),
			"status":        orStr(a["status"], ""),
			"affected":      orAny(a["affected"], ""),
			"last_activity": orAny(a["last_activity"], ""),
		})
	}
	return out
}

// --- registry ----------------------------------------------------------------

type sourceDef struct {
	ID, Label, Transport string
	Requires             []string
	Fields               []map[string]any
}

// sourceOrder preserves Python's SOURCES dict insertion order (server.py:4683).
var sourceOrder = []string{
	"subnets", "leases", "dns_zones", "dns_records", "hosts", "threat_feeds",
	"named_lists", "security_policies", "dfp", "anycast", "roaming",
	"incidents", "anomaly_events", "entity_search",
}

func sourceDefs() map[string]sourceDef {
	return map[string]sourceDef{
		"subnets": {"subnets", "IPAM Subnets", "rest", nil, []map[string]any{
			fld("id", "string", "dimension"), fld("name", "string", "dimension"),
			fld("addr", "string", "dimension"), fld("cidr", "number", "dimension"),
			fld("total", "number", "measure"), fld("used", "number", "measure"),
			fld("util", "number", "measure"), fld("site", "string", "filterable")}},
		"leases": {"leases", "DHCP Leases", "rest", nil, []map[string]any{
			fld("addr", "string", "dimension"), fld("host", "string", "dimension"),
			fld("subnet", "string", "filterable"), fld("state", "string", "filterable")}},
		"dns_zones": {"dns_zones", "DNS Auth Zones", "rest", nil, []map[string]any{
			fld("id", "string", "dimension"), fld("fqdn", "string", "dimension"),
			fld("view", "string", "filterable"), fld("ttl", "number", "measure"),
			fld("neg_ttl", "number", "measure"), fld("records", "number", "measure")}},
		"dns_records": {"dns_records", "DNS Records", "rest", nil, []map[string]any{
			fld("name", "string", "dimension"), fld("zone", "string", "filterable"),
			fld("type", "string", "filterable"), fld("rdata", "string", "dimension"),
			fld("disabled", "string", "filterable")}},
		"hosts": {"hosts", "Infrastructure Hosts", "rest", nil, []map[string]any{
			fld("id", "string", "dimension"), fld("name", "string", "dimension"),
			fld("ip", "string", "dimension"), fld("type", "string", "filterable"),
			fld("status", "string", "filterable")}},
		"threat_feeds": {"threat_feeds", "Threat Feeds", "rest", nil, []map[string]any{
			fld("name", "string", "dimension"), fld("source", "string", "filterable"),
			fld("confidence", "string", "filterable"), fld("threat_level", "string", "filterable")}},
		"named_lists": {"named_lists", "Named Lists", "rest", nil, []map[string]any{
			fld("name", "string", "dimension"), fld("type", "string", "filterable"),
			fld("item_count", "number", "measure"), fld("threat_level", "string", "filterable"),
			fld("policies", "number", "measure")}},
		"security_policies": {"security_policies", "Security Policies", "rest", nil, []map[string]any{
			fld("id", "string", "dimension"), fld("name", "string", "dimension"),
			fld("action", "string", "filterable"), fld("rules", "number", "measure"),
			fld("created", "string", "dimension"), fld("active", "string", "filterable")}},
		"dfp": {"dfp", "DNS Forwarding Proxies", "rest", nil, []map[string]any{
			fld("name", "string", "dimension"), fld("mode", "string", "filterable"),
			fld("host", "string", "dimension"), fld("resolvers", "number", "measure")}},
		"anycast": {"anycast", "Anycast HA Status", "rest", nil, []map[string]any{
			fld("name", "string", "dimension"), fld("service", "string", "filterable"),
			fld("ip", "string", "dimension"), fld("state", "string", "filterable")}},
		"roaming": {"roaming", "Roaming Devices", "rest", nil, []map[string]any{
			fld("name", "string", "dimension"), fld("status", "string", "filterable"),
			fld("country", "string", "filterable"), fld("os", "string", "filterable"),
			fld("group", "string", "filterable")}},
		"incidents": {"incidents", "Incidents (SOC Actions)", "mcp", nil, []map[string]any{
			fld("id", "string", "dimension"), fld("type", "string", "filterable"),
			fld("title", "string", "dimension"), fld("priority", "string", "filterable"),
			fld("status", "string", "filterable"), fld("affected", "string", "filterable"),
			fld("last_activity", "time", "dimension")}},
		"anomaly_events": {"anomaly_events", "DNS Security Events", "rest", nil, []map[string]any{
			fld("event_time", "time", "dimension"), fld("qname", "string", "dimension"),
			fld("severity", "string", "filterable"), fld("policy_action", "string", "filterable"),
			fld("feed_name", "string", "filterable"), fld("threat_indicator", "string", "dimension"),
			fld("device", "string", "dimension"), fld("network", "string", "dimension")}},
		"entity_search": {"entity_search", "Network Entity Search", "mcp", []string{"q"}, []map[string]any{
			fld("name", "string", "dimension"), fld("type", "string", "filterable")}},
	}
}

// SourcesMeta is sources_meta (server.py:4789): registry META only, safe while
// the vault is locked. Preserves SOURCES order and appends the __raw escape hatch.
func (s *Service) SourcesMeta() map[string]any {
	defs := sourceDefs()
	list := []any{}
	for _, id := range sourceOrder {
		d := defs[id]
		req := d.Requires
		if req == nil {
			req = []string{}
		}
		list = append(list, map[string]any{
			"id": d.ID, "label": d.Label, "transport": d.Transport,
			"requires": toAnyN(req), "fields": toAnyN(d.Fields),
		})
	}
	list = append(list, map[string]any{
		"id": "__raw", "label": "Advanced: raw endpoint", "transport": "rest",
		"requires": []any{"path"}, "fields": []any{},
	})
	return map[string]any{"sources": list}
}

// sourceFetch dispatches a source's fetch (server.py SOURCES[sid]["fetch"]).
// It reports a failed upstream read as an error rather than collapsing it to
// an empty slice: a nil error with nil/empty rows means the source is
// genuinely empty, while a non-nil error means the read itself failed and the
// caller must not treat that as "no data".
func (s *Service) sourceFetch(ctx context.Context, sid string, p map[string]string) ([]any, error) {
	switch sid {
	case "subnets":
		raw, err := s.Rest.GetStrict("/api/ddi/v1/ipam/subnet",
			map[string]string{"_fields": "id,name,address,cidr,utilization,tags", "_limit": "5000"})
		if err != nil {
			return nil, err
		}
		return toAnyN(normSubnets(raw)), nil
	case "leases":
		raw, err := s.Rest.GetStrict("/api/ddi/v1/dhcp/lease",
			map[string]string{"_fields": "address,hostname,state,client_id", "_limit": "5000"})
		if err != nil {
			return nil, err
		}
		return toAnyN(normLeases(raw)), nil
	case "dns_zones":
		raw, err := s.Rest.GetStrict("/api/ddi/v1/dns/auth_zone",
			map[string]string{"_fields": "id,fqdn,view,zone_authority,primary_type", "_limit": "5000"})
		if err != nil {
			return nil, err
		}
		return toAnyN(normZones(raw, nil)), nil
	case "dns_records":
		raw, err := s.Rest.GetStrict("/api/ddi/v1/dns/record", map[string]string{"_limit": "2000"})
		if err != nil {
			return nil, err
		}
		return normRecords(raw), nil
	case "hosts":
		raw, err := s.Rest.GetStrict("/api/infra/v1/detail_hosts", map[string]string{"_limit": "500"})
		if err != nil {
			return nil, err
		}
		return toAnyN(normHosts(raw)), nil
	case "threat_feeds":
		raw, err := s.Rest.GetStrict("/api/atcfw/v1/threat_feeds", map[string]string{"_limit": "200"})
		if err != nil {
			return nil, err
		}
		return normThreatFeeds(raw), nil
	case "named_lists":
		raw, err := s.Rest.GetStrict("/api/atcfw/v1/named_lists", map[string]string{"_limit": "200"})
		if err != nil {
			return nil, err
		}
		return normNamedLists(raw), nil
	case "security_policies":
		raw, err := s.Rest.GetStrict("/api/atcfw/v1/security_policies", map[string]string{"_limit": "200"})
		if err != nil {
			return nil, err
		}
		return toAnyN(normPolicies(raw)), nil
	case "dfp":
		raw, err := s.Rest.GetStrict("/api/atcdfp/v1/dfp_services", map[string]string{"_limit": "200"})
		if err != nil {
			return nil, err
		}
		return normSourceDFP(raw), nil
	case "anycast":
		raw, err := s.Rest.GetStrict("/api/anycast/v1/accm/ac_runtime_statuses", map[string]string{"_limit": "200"})
		if err != nil {
			return nil, err
		}
		return normAnycast(raw), nil
	case "roaming":
		raw, err := s.Rest.GetStrict("/api/atcep/v1/roaming_devices", map[string]string{"_limit": "2000"})
		if err != nil {
			return nil, err
		}
		return normRoaming(raw), nil
	case "incidents":
		// FetchActions already knows when the upstream read failed: it marks
		// availability:"error" (upstream error) vs "ok" (genuine
		// result, including a real zero). Propagate that instead of handing
		// normIncidents a failure disguised as an empty actions list.
		data := s.FetchActions(ctx)
		if data["availability"] == "error" {
			return nil, fmt.Errorf("%s", getStr(data["unavailable"]))
		}
		return normIncidents(data), nil
	case "anomaly_events":
		// FetchHubSecurity reports the same availability/reason shape as
		// FetchDNSAnalytics/FetchHostMetrics for a dead threat-event feed.
		data := s.FetchHubSecurity(3600, 200)
		if data["availability"] == "error" {
			return nil, fmt.Errorf("%s", getStr(data["reason"]))
		}
		return toAnyN(anyToMaps(data["events"])), nil
	case "entity_search":
		if p["q"] == "" {
			return []any{}, nil
		}
		result := s.ThreatLookup(ctx, p["q"])
		if result["availability"] == "error" {
			return nil, fmt.Errorf("%s", getStr(result["reason"]))
		}
		return asSlice(result["entities"]), nil
	}
	return nil, nil
}

// upstreamErrorRows is the shared failed-read shape, matching the existing
// "unknown source" / "path must start with /api/" convention (below): an
// "error" key alongside empty rows/fields, never a panic or an aborted
// handler — one bad source reports its own error, the rest of the payload is
// unaffected.
func upstreamErrorRows(label string, err error) map[string]any {
	msg := label + " failed"
	var ue *rest.UpstreamError
	if errors.As(err, &ue) {
		msg = fmt.Sprintf("%s failed: %s", label, ue.Public())
	}
	return map[string]any{"error": msg, "rows": []any{}, "count": 0, "fields": []any{}}
}

// SourceRows is source_rows (server.py:4824): resolve a source, fetch via its
// transport, apply optional equality filter(s) + limit, and (for a "time" field)
// an honest t0/t1 window. Returns {rows,count,fields} (or an {error,...} shape).
func (s *Service) SourceRows(ctx context.Context, sid string, params map[string]string) map[string]any {
	if sid == "__raw" {
		restPath := params["path"]
		if !strings.HasPrefix(restPath, "/api/") {
			return map[string]any{"error": "path must start with /api/", "rows": []any{}, "count": 0, "fields": []any{}}
		}
		restParams := map[string]string{}
		for k, v := range params {
			if k != "path" {
				restParams[k] = v
			}
		}
		var rp map[string]string
		if len(restParams) > 0 {
			rp = restParams
		}
		rows, err := s.Rest.GetStrict(restPath, rp)
		if err != nil {
			return upstreamErrorRows(fmt.Sprintf("raw source %q", restPath), err)
		}
		if rows == nil {
			rows = []any{}
		}
		return map[string]any{"rows": rows, "count": len(rows), "fields": []any{}}
	}

	def, ok := sourceDefs()[sid]
	if !ok {
		return map[string]any{"error": "unknown source", "rows": []any{}, "count": 0, "fields": []any{}}
	}

	limit := 200
	if v, err := strconv.Atoi(params["limit"]); err == nil {
		limit = v
	}
	if limit < 1 {
		limit = 1
	} else if limit > 5000 {
		limit = 5000
	}

	rows, err := s.sourceFetch(ctx, sid, params)
	if err != nil {
		return upstreamErrorRows(fmt.Sprintf("source %q", sid), err)
	}
	if rows == nil {
		rows = []any{}
	}

	fieldNames := map[string]bool{}
	for _, f := range def.Fields {
		fieldNames[getStr(f["name"])] = true
	}
	for key, val := range params {
		if fieldNames[key] {
			filtered := rows[:0:0]
			for _, ri := range rows {
				if rowStr(asMap(ri)[key]) == val {
					filtered = append(filtered, ri)
				}
			}
			rows = filtered
		}
	}

	timeField := ""
	for _, f := range def.Fields {
		if getStr(f["type"]) == "time" {
			timeField = getStr(f["name"])
			break
		}
	}
	if timeField != "" && (params["t0"] != "" || params["t1"] != "") {
		t0, ok0 := parseFloat(params["t0"])
		t1, ok1 := parseFloat(params["t1"])
		kept := rows[:0:0]
		for _, ri := range rows {
			e, ok := rowEpoch(asMap(ri)[timeField])
			if !ok {
				kept = append(kept, ri)
				continue
			}
			if ok0 && e < t0 {
				continue
			}
			if ok1 && e > t1 {
				continue
			}
			kept = append(kept, ri)
		}
		rows = kept
	}

	if len(rows) > limit {
		rows = rows[:limit]
	}
	return map[string]any{"rows": rows, "count": len(rows), "fields": toAnyN(def.Fields)}
}

// --- helpers -----------------------------------------------------------------

// toAnyN widens any []T (e.g. []map[string]any shaper output, []string requires)
// to the []any the source/meta contract returns — Python's _results() pass-through.
func toAnyN[T any](s []T) []any {
	out := make([]any, len(s))
	for i, v := range s {
		out[i] = v
	}
	return out
}

func anyToMaps(v any) []map[string]any {
	switch t := v.(type) {
	case []map[string]any:
		return t
	case []any:
		out := make([]map[string]any, 0, len(t))
		for _, x := range t {
			out = append(out, asMap(x))
		}
		return out
	}
	return nil
}

// rowStr is Python str(r.get(key,"")) for the equality filter.
func rowStr(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return vToStr(v)
}

func parseFloat(s string) (float64, bool) {
	if s == "" {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

// rowEpoch is _row_epoch (server.py:4800): best-effort epoch-seconds parse.
func rowEpoch(val any) (float64, bool) {
	switch t := val.(type) {
	case nil:
		return 0, false
	case float64:
		if t > 1e11 {
			return t / 1000.0, true
		}
		return t, true
	case int:
		return rowEpoch(float64(t))
	}
	s := strings.TrimSpace(vToStr(val))
	if s == "" {
		return 0, false
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		if f > 1e11 {
			return f / 1000.0, true
		}
		return f, true
	}
	iso := strings.Replace(s, "Z", "+00:00", 1)
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05-07:00", "2006-01-02T15:04:05"} {
		if dt, err := time.Parse(layout, iso); err == nil {
			return float64(dt.Unix()), true
		}
	}
	return 0, false
}
