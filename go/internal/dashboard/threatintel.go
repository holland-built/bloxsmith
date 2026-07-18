package dashboard

import (
	"context"
	"sort"
	"strings"

	"bloxsmith/internal/cache"
)

// This file ports the three deferred threat-intel fetchers (server.py
// fetch_assets 4371, fetch_dossier 4463, fetch_lookalikes 4526) plus their
// norm_* shapers. dossier + lookalikes are direct REST (TIDE / TDLAD); assets
// is an MCP cube (SecurityActionAssets) via the same client the AI tools use.
// Each degrades to an {"...":[], "unavailable": "..."} shape on 403/error and
// never fabricates data, exactly as Python does.

// --- FQDN / IP validation (server.py _FQDN_RE 176 / _IP_RE 181) --------------
// Go's RE2 has no lookahead, so the Python regexes are reimplemented by hand.

func isIPIndicator(q string) bool {
	if q == "" {
		return false
	}
	// IPv4: four 1-3 digit octets.
	if parts := strings.Split(q, "."); len(parts) == 4 {
		v4 := true
		for _, p := range parts {
			if p == "" || len(p) > 3 {
				v4 = false
				break
			}
			for _, r := range p {
				if r < '0' || r > '9' {
					v4 = false
					break
				}
			}
		}
		if v4 {
			return true
		}
	}
	// IPv6 (loose): must contain a colon; only hex + colon, length 2-45.
	if strings.Contains(q, ":") && len(q) >= 2 && len(q) <= 45 {
		for _, r := range q {
			if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F') || r == ':') {
				return false
			}
		}
		return true
	}
	return false
}

func isFQDN(q string) bool {
	if len(q) < 1 || len(q) > 253 {
		return false
	}
	labels := strings.Split(q, ".")
	if len(labels) < 2 {
		return false
	}
	tld := labels[len(labels)-1]
	if len(tld) < 2 || len(tld) > 63 {
		return false
	}
	for _, r := range tld {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')) {
			return false
		}
	}
	for _, lb := range labels[:len(labels)-1] {
		if len(lb) < 1 || len(lb) > 63 {
			return false
		}
		for i, r := range lb {
			ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || (r == '-' && i > 0 && i < len(lb)-1)
			if !ok {
				return false
			}
		}
	}
	return true
}

func inferIndicatorType(q string) string {
	if isIPIndicator(q) {
		return "ip"
	}
	return "host"
}

// --- Dossier (server.py fetch_dossier 4463 / norm_dossier 4399) --------------

// FetchDossier is fetch_dossier: create a TIDE lookup job (wait=true), then read
// its results. 403 -> "not entitled"; invalid indicator -> "invalid ...".
func (s *Service) FetchDossier(q, itype string) map[string]any {
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return map[string]any{"query": "", "type": "", "summary": map[string]any{},
			"sources": []any{}, "unavailable": "query required"}
	}
	itype = strings.ToLower(strings.TrimSpace(itype))
	if itype != "host" && itype != "ip" && itype != "url" {
		itype = inferIndicatorType(q)
	}
	if itype == "ip" {
		if !isIPIndicator(q) {
			return dossierUnavail(q, itype, "invalid IP indicator")
		}
	} else {
		if !isFQDN(q) {
			return dossierUnavail(q, itype, "invalid domain indicator")
		}
	}
	ck := cache.Key("dossier", itype, map[string]string{"q": q}, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	job, st, _ := s.Rest.GetEx("/tide/api/services/intel/lookup/indicator/"+itype,
		map[string]string{"value": q, "wait": "true"})
	if st == 403 {
		res := dossierUnavail(q, itype, "Dossier not entitled")
		s.Cache.Set(ck, res)
		return res
	}
	jobID := ""
	if m, ok := job.(map[string]any); ok {
		jobID = getStr(m["job_id"])
	}
	if jobID == "" {
		return dossierUnavail(q, itype, "Dossier lookup failed")
	}
	res, _, _ := s.Rest.GetEx("/tide/api/services/intel/lookup/jobs/"+jobID+"/results", nil)
	var results []any
	if m, ok := res.(map[string]any); ok {
		results = asSlice(m["results"])
	}
	out := normDossier(q, itype, results)
	s.Cache.Set(ck, out)
	return out
}

func dossierUnavail(q, itype, msg string) map[string]any {
	return map[string]any{"query": q, "type": itype, "summary": map[string]any{},
		"sources": []any{}, "unavailable": msg}
}

// normDossier is norm_dossier (server.py:4399).
func normDossier(query, itype string, results []any) map[string]any {
	sources := []any{}
	threatClasses := map[string]bool{}
	properties := map[string]bool{}
	summary := map[string]any{
		"malicious": false, "max_threat_level": float64(0), "threat_classes": []any{},
		"properties": []any{}, "country": "", "registrar": "", "actor": "",
	}
	maxTL := float64(0)
	for _, ri := range results {
		r, ok := ri.(map[string]any)
		if !ok {
			continue
		}
		src := getStr(asMap(r["params"])["source"])
		data, ok := r["data"].(map[string]any)
		if !ok || len(data) == 0 {
			continue
		}
		entry := map[string]any{"source": src}
		if recs := asSlice(data["records"]); len(recs) > 0 {
			shaped := []any{}
			for i, xi := range recs {
				x, ok := xi.(map[string]any)
				if !ok {
					continue
				}
				if i < 10 {
					shaped = append(shaped, map[string]any{
						"class": x["class"], "property": x["property"],
						"threat_level": x["threat_level"], "feed": x["feed_name"],
						"detected": x["detected"],
					})
				}
				if c := getStr(x["class"]); c != "" {
					threatClasses[c] = true
				}
				if p := getStr(x["property"]); p != "" {
					properties[p] = true
				}
				if tl, ok := x["threat_level"].(float64); ok {
					if tl > maxTL {
						maxTL = tl
					}
					summary["malicious"] = true
				}
			}
			entry["records"] = shaped
		}
		switch {
		case src == "geo":
			geo := map[string]any{}
			for _, k := range []string{"country", "country_name", "city", "region", "asn", "org"} {
				if truthy(data[k]) {
					geo[k] = data[k]
				}
			}
			entry["geo"] = geo
			summary["country"] = orStr(data["country_name"], data["country"], summary["country"])
		case src == "whois":
			resp := data["response"]
			if resp == nil {
				resp = data
			}
			entry["whois"] = trunc(jstr(resp), 600)
			if rm, ok := resp.(map[string]any); ok {
				summary["registrar"] = trunc(orStr(rm["registrar"], summary["registrar"]), 120)
			}
		case src == "threat_actor" && truthy(data["actor_name"]):
			entry["actor"] = map[string]any{"name": data["actor_name"], "display": data["display_name"],
				"description": trunc(getStr(data["actor_description"]), 300)}
			summary["actor"] = orStr(data["actor_name"], summary["actor"])
		case strings.Contains(src, "malware"):
			if inner, ok := data["data"].(map[string]any); ok {
				if attrs, ok := inner["attributes"].(map[string]any); ok {
					entry["malware"] = map[string]any{"reputation": attrs["reputation"],
						"last_analysis_stats": attrs["last_analysis_stats"], "categories": attrs["categories"]}
					if stats, ok := attrs["last_analysis_stats"].(map[string]any); ok && truthy(stats["malicious"]) {
						summary["malicious"] = true
					}
				}
			}
		}
		if len(entry) == 1 {
			entry["detail"] = trunc(jstr(data), 400)
		}
		sources = append(sources, entry)
	}
	summary["max_threat_level"] = maxTL
	summary["threat_classes"] = sortedCap(threatClasses, 15)
	summary["properties"] = sortedCap(properties, 15)
	return map[string]any{"query": query, "type": itype, "summary": summary,
		"sources": sources, "unavailable": nil}
}

// --- Lookalikes (server.py fetch_lookalikes 4526 / norm_lookalikes 4506) -----

// FetchLookalikes is fetch_lookalikes: typosquat domains + protected targets via
// TDLAD REST. Degrades on 403/error.
func (s *Service) FetchLookalikes() map[string]any {
	ck := cache.Key("lookalikes", "", nil, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	dom, st1, _ := s.Rest.GetEx("/api/tdlad/v1/lookalike_domains", map[string]string{"_limit": "500"})
	tgt, st2, _ := s.Rest.GetEx("/api/tdlad/v1/lookalike_targets", nil)
	var result map[string]any
	switch {
	case st1 == 403 && st2 == 403:
		result = map[string]any{"domains": []any{}, "targets": []any{}, "unavailable": "Lookalike Domains not entitled"}
	case dom == nil && tgt == nil:
		result = map[string]any{"domains": []any{}, "targets": []any{}, "unavailable": "Lookalike Domains service unavailable"}
	default:
		result = normLookalikes(dom, tgt)
	}
	s.Cache.Set(ck, result)
	return result
}

// normLookalikes is norm_lookalikes (server.py:4506).
func normLookalikes(domainsRaw, targetsRaw any) map[string]any {
	var domList []any
	if m, ok := domainsRaw.(map[string]any); ok {
		domList = asSlice(m["results"])
	} else {
		domList = asSlice(domainsRaw)
	}
	domains := []any{}
	for _, di := range domList {
		d, ok := di.(map[string]any)
		if !ok {
			continue
		}
		domains = append(domains, map[string]any{
			"lookalike":   orStr(d["lookalike_domain"], ""),
			"host":        orStr(d["lookalike_host"], ""),
			"target":      orStr(d["target_domain"], ""),
			"reason":      orStr(d["reason"], ""),
			"suspicious":  truthy(d["suspicious"]),
			"detected_at": orStr(d["detected_at"], ""),
		})
	}
	targets := []any{}
	if tm, ok := targetsRaw.(map[string]any); ok {
		res := tm["results"]
		if rm, ok := res.(map[string]any); ok {
			for _, t := range asSlice(rm["items"]) {
				if ts, ok := t.(string); ok {
					targets = append(targets, ts)
				}
			}
		} else if rl, ok := res.([]any); ok {
			for _, t := range rl {
				if tmap, ok := t.(map[string]any); ok {
					targets = append(targets, orAny(tmap["domain"], t))
				} else {
					targets = append(targets, t)
				}
			}
		}
	}
	return map[string]any{"domains": domains, "targets": targets, "unavailable": nil}
}

// --- Assets (server.py fetch_assets 4371 / _fetch_assets_async 4349) ---------

// FetchAssets is fetch_assets: three SecurityActionAssets cube queries
// (inventory + rollup + trend) via the MCP client. Degrades to unavailable when
// the tenant has no security-action assets.
func (s *Service) FetchAssets(ctx context.Context) map[string]any {
	ck := cache.Key("assets", "", nil, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	assets, rollup, trend := []any{}, []any{}, []any{}
	if s.Mcp != nil && s.Mcp.Initialize(ctx) == nil {
		invD := s.Mcp.QueryCube(ctx, "SecurityActionAssets",
			[]string{"SecurityActionAssets.count"}, map[string]any{
				"dimensions": []string{
					"SecurityActionAssets.deviceName", "SecurityActionAssets.os",
					"SecurityActionAssets.ipAddresses", "SecurityActionAssets.macAddresses",
					"SecurityActionAssets.vendor", "SecurityActionAssets.region",
					"SecurityActionAssets.isRisky", "SecurityActionAssets.isVerified",
					"SecurityActionAssets.lastDetected"},
				"order": map[string]any{"SecurityActionAssets.count": "desc"}, "limit": 500,
			})
		rollupD := s.Mcp.QueryCube(ctx, "SecurityActionAssets",
			[]string{"SecurityActionAssets.uniqueDevices", "SecurityActionAssets.count"},
			map[string]any{
				"dimensions": []string{"SecurityActionAssets.os", "SecurityActionAssets.isVerified"},
				"order":      map[string]any{"SecurityActionAssets.count": "desc"}, "limit": 50,
			})
		trendD := s.Mcp.QueryCube(ctx, "SecurityActionAssets",
			[]string{"SecurityActionAssets.count"}, map[string]any{
				"time_dimensions": []map[string]any{{
					"dimension": "SecurityActionAssets.createdAt",
					"dateRange": "30 days", "granularity": "day"}},
			})
		assets = normAssets(invD)
		rollup = flattenCubeRows(rollupD)
		trend = flattenCubeRows(trendD)
	}
	var result map[string]any
	if len(assets) > 0 || len(rollup) > 0 || len(trend) > 0 {
		result = map[string]any{"assets": assets, "rollup": rollup, "trend": trend, "unavailable": nil}
	} else {
		result = map[string]any{"assets": []any{}, "rollup": []any{}, "trend": []any{},
			"unavailable": "No security-action assets in the last 30 days for this tenant."}
	}
	s.Cache.Set(ck, result)
	return result
}

// flattenCubeRow is _flatten_cube_row (server.py:4327): strip the "Cube." prefix
// from each key. QueryCube already turned "Cube__field" into "Cube.field".
func flattenCubeRow(r map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range r {
		if i := strings.Index(k, "."); i >= 0 {
			out[k[i+1:]] = v
		} else {
			out[k] = v
		}
	}
	return out
}

func flattenCubeRows(rows []map[string]any) []any {
	out := []any{}
	for _, r := range rows {
		out = append(out, flattenCubeRow(r))
	}
	return out
}

// normAssets is norm_assets (server.py:4331).
func normAssets(rows []map[string]any) []any {
	out := []any{}
	for _, raw := range rows {
		r := flattenCubeRow(raw)
		out = append(out, map[string]any{
			"device":    orStr(r["deviceName"], ""),
			"os":        orStr(r["os"], ""),
			"ip":        orStr(r["ipAddresses"], ""),
			"mac":       orStr(r["macAddresses"], ""),
			"vendor":    orStr(r["vendor"], ""),
			"region":    orStr(r["region"], ""),
			"risky":     r["isRisky"],
			"verified":  r["isVerified"],
			"last_seen": orStr(r["lastDetected"], ""),
			"count":     r["count"],
		})
	}
	return out
}

// --- small local helpers -----------------------------------------------------

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func sortedCap(set map[string]bool, n int) []any {
	keys := make([]string, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) > n {
		keys = keys[:n]
	}
	out := make([]any, len(keys))
	for i, k := range keys {
		out[i] = k
	}
	return out
}
