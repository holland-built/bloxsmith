package dashboard

import (
	"context"
	"log"
	"sort"
	"strings"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
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
	g := s.Cache.Gen()
	job, st, _ := s.Rest.GetEx("/tide/api/services/intel/lookup/indicator/"+itype,
		map[string]string{"value": q, "wait": "true"})
	if st == 403 {
		res := dossierUnavail(q, itype, "Dossier not entitled")
		s.Cache.SetGen(ck, res, g)
		return res
	}
	jobID := ""
	if m, ok := job.(map[string]any); ok {
		jobID = getStr(m["job_id"])
	}
	if jobID == "" {
		return dossierUnavail(q, itype, "Dossier lookup failed")
	}
	// GetStrict (not GetEx): a 500/403/timeout/decode failure here must never
	// fall through to normDossier with a nil/empty results list, because
	// normDossier's zero-value summary (malicious:false, max_threat_level:0)
	// is indistinguishable from a genuinely clean indicator — the DEFECT 1
	// bug where a dead lookup rendered as a green CLEAN verdict. On failure
	// we emit dossierUnavail instead: no verdict fields at all, so
	// DossierPanel's existing `unavailable` escape hatch fires. The failure
	// result (not a fabricated clean one) is what gets cached, matching this
	// package's existing convention (see hub.go FetchHubHealth) of caching
	// an explicit "unavailable" state rather than skipping the cache.
	//
	// This arm alone does NOT close DEFECT 1 — it only guarantees that a
	// results read which FAILED never reaches normDossier. A results read
	// that SUCCEEDS can still carry nothing usable (an empty results list, or
	// records that all lack a `data` object), and shaping that into the same
	// zero-value summary is the same green-CLEAN-for-an-unchecked-indicator
	// failure by a different route. The guarantee "no verdict without an
	// examined source" is enforced by normDossier itself, at its own
	// len(sources) == 0 check; see there.
	results, err := s.Rest.GetStrict("/tide/api/services/intel/lookup/jobs/"+jobID+"/results", nil)
	if err != nil {
		log.Printf("dossier: TIDE results fetch failed for %s indicator %q: %v", itype, q, err)
		res := dossierUnavail(q, itype, "Dossier results fetch failed")
		s.Cache.SetGen(ck, res, g)
		return res
	}
	out := normDossier(q, itype, results)
	s.Cache.SetGen(ck, out, g)
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
		"malicious": false, "max_threat_level": nil, "threat_classes": []any{},
		"properties": []any{}, "country": "", "registrar": "", "actor": "",
		"assessed": false,
	}
	// maxTL and assessed move together on purpose. "assessed" is set by the
	// SAME evidence that can move the level or the verdict, never by the mere
	// presence of a container: an empty records list, a record that is not a
	// mapping, a non-numeric level and a geo/whois/actor source all contribute
	// context and no judgement. Without this, a dossier carrying only a
	// registrar and a country rendered "Verdict: Clean" — a claim, made on the
	// strength of a WHOIS record (#89).
	maxTL := float64(0)
	haveTL := false
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
				// The verdict used to turn on the PRESENCE of this field, so a
				// record TIDE graded 0 — checked, and found not to be a threat
				// — accused the indicator anyway, and the panel printed
				// "Verdict: Malicious" directly above "Threat level: 0" (#87).
				//
				// This is deliberately NOT a severity threshold, and no such
				// threshold is invented here: the upstream threat-level domain
				// is documented nowhere in this repo and no live TIDE response
				// was available to read. The claim is narrower and needs no
				// domain — a level of exactly 0 is not evidence of
				// maliciousness, so it cannot be the thing that flips the
				// verdict. A negative level is not evidence either, and maxTL
				// starts at 0 so it can never go below zero; nonsense data
				// accuses nobody.
				// A negative level counts as NOTHING — not a max, not a verdict,
				// and not an assessment either. #87 established that nonsense
				// accuses nobody; letting it establish assessment would let the
				// same nonsense buy a "Clean" instead.
				if tl, ok := x["threat_level"].(float64); ok && tl >= 0 {
					summary["assessed"] = true
					if !haveTL || tl > maxTL {
						maxTL = tl
						haveTL = true
					}
					if tl > 0 {
						summary["malicious"] = true
					}
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
					// The malware arm reports an engine COUNT, not a level, and a
					// count of 0 is a real measurement — engines looked and
					// flagged nothing — so it establishes assessment while
					// leaving the verdict clean. A stats object that is absent,
					// not a map, or carries no numeric "malicious" establishes
					// nothing.
					//
					// KNOWN LIMIT, stated rather than papered over: an all-zero
					// stats object cannot be told apart from one where no engine
					// actually ran. Nothing in the payload distinguishes them and
					// no live response was available to check, so this reads it
					// as "0 engines flagged it", which is what the field name
					// says. If that turns out to be wrong it is a separate,
					// measurable question.
					if stats, ok := attrs["last_analysis_stats"].(map[string]any); ok {
						if n, isNum := stats["malicious"].(float64); isNum {
							summary["assessed"] = true
							if n > 0 {
								summary["malicious"] = true
							}
						}
					}
				}
			}
		}
		if len(entry) == 1 {
			entry["detail"] = trunc(jstr(data), 400)
		}
		sources = append(sources, entry)
	}
	// A verdict requires having actually examined at least one source. Every
	// record above was skipped for want of a usable `data` object, or TIDE
	// returned a successful-but-empty results list: nothing was checked, so
	// there is nothing to be clean OR malicious about. Falling through here
	// would emit the zero-value summary (malicious:false, max_threat_level:0)
	// with sources:[] and unavailable:nil — a green CLEAN pill for a lookup
	// that read no source at all, which is the FetchDossier failure arm's bug
	// arriving by the success path. Degrade to the same dossierUnavail shape
	// that arm uses (no verdict fields at all) so DossierPanel's `unavailable`
	// escape hatch fires. Guessing MALICIOUS instead would be equally
	// fabricated; the honest state is "we did not check". The reason wording
	// is deliberately distinct from the fetch-failure reasons: this lookup
	// ran and answered, it just answered with nothing usable.
	if len(sources) == 0 {
		return dossierUnavail(query, itype, "Dossier lookup returned no usable sources")
	}
	// nil, not 0, when nothing reported a level: 0 is a measurement ("graded
	// zero") and must not double as "nobody graded it" — the unknown-vs-zero
	// collapse normSubnets (norm.go) forbids, and the last place in this
	// package still doing it.
	if haveTL {
		summary["max_threat_level"] = maxTL
	}
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
	g := s.Cache.Gen()
	// GetPageStrict (not GetEx): failures must be detected per-endpoint, not
	// just when BOTH happen to return nil/403 together. DEFECT 3 was exactly
	// this — domains 403 while targets succeeded fell through to the
	// `default` case and rendered "0 detected" for a dead feed. Any failure
	// of EITHER read now degrades the whole response; a one-sided success is
	// not enough to call this "ok". rawBody reconstructs what GetEx used to
	// hand normLookalikes (the raw decoded body, not the Unwrap()-flattened
	// rows), because the targets envelope nests its own "results"/"items"
	// shape that Unwrap would otherwise flatten away.
	domRows, domBody, domErr := s.Rest.GetPageStrict("/api/tdlad/v1/lookalike_domains", map[string]string{"_limit": "500"})
	tgtRows, tgtBody, tgtErr := s.Rest.GetPageStrict("/api/tdlad/v1/lookalike_targets", nil)
	var result map[string]any
	switch {
	case domErr != nil:
		log.Printf("lookalikes: domains fetch failed: %v", domErr)
		result = lookalikeUnavailable(domErr)
	case tgtErr != nil:
		log.Printf("lookalikes: targets fetch failed: %v", tgtErr)
		result = lookalikeUnavailable(tgtErr)
	default:
		result = normLookalikes(rawBody(domRows, domBody), rawBody(tgtRows, tgtBody))
	}
	s.Cache.SetGen(ck, result, g)
	return result
}

// rawBody reconstructs the value rest.GetEx used to hand callers before the
// status-aware GetPageStrict existed: the decoded top-level JSON node itself
// (object or bare array), not GetPageStrict's Unwrap()-flattened rows. It is
// non-nil (the map) for an object response, else the raw row list for a bare
// array response.
func rawBody(rows []any, body map[string]any) any {
	if body != nil {
		return body
	}
	return rows
}

// lookalikeUnavailable builds the degrade shape for a failed TDLAD read.
// "unavailable" stays an operator-safe, human-readable reason; "not_entitled"
// is a SEPARATE explicit boolean so a caller can tell "this tenant isn't
// entitled to this feed" (403) apart from a plain service outage (any other
// failure) instead of collapsing both into entitlement wording. The Security
// tab currently renders ANY `unavailable` value as "not entitled — <msg>"
// (ui/src/tabs/Security.jsx:379) — that line needs to switch to keying off
// `not_entitled` and falling back to a plain outage message otherwise; see
// this fix's handoff note.
func lookalikeUnavailable(err error) map[string]any {
	reason := "Lookalike Domains service unavailable"
	notEntitled := false
	if ue, ok := err.(*rest.UpstreamError); ok && ue.Status == 403 {
		reason = "Lookalike Domains not entitled"
		notEntitled = true
	}
	return map[string]any{"domains": []any{}, "targets": []any{},
		"unavailable": reason, "not_entitled": notEntitled}
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
	g := s.Cache.Gen()
	var invD, rollupD, trendD []map[string]any
	mcpOK := s.Mcp != nil && s.Mcp.Initialize(ctx) == nil
	if mcpOK {
		invD = s.Mcp.QueryCube(ctx, "SecurityActionAssets",
			[]string{"SecurityActionAssets.count"}, map[string]any{
				"dimensions": []string{
					"SecurityActionAssets.deviceName", "SecurityActionAssets.os",
					"SecurityActionAssets.ipAddresses", "SecurityActionAssets.macAddresses",
					"SecurityActionAssets.vendor", "SecurityActionAssets.region",
					"SecurityActionAssets.isRisky", "SecurityActionAssets.isVerified",
					"SecurityActionAssets.lastDetected"},
				"order": map[string]any{"SecurityActionAssets.count": "desc"}, "limit": 500,
			})
		rollupD = s.Mcp.QueryCube(ctx, "SecurityActionAssets",
			[]string{"SecurityActionAssets.uniqueDevices", "SecurityActionAssets.count"},
			map[string]any{
				"dimensions": []string{"SecurityActionAssets.os", "SecurityActionAssets.isVerified"},
				"order":      map[string]any{"SecurityActionAssets.count": "desc"}, "limit": 50,
			})
		trendD = s.Mcp.QueryCube(ctx, "SecurityActionAssets",
			[]string{"SecurityActionAssets.count"}, map[string]any{
				"time_dimensions": []map[string]any{{
					"dimension": "SecurityActionAssets.createdAt",
					"dateRange": "30 days", "granularity": "day"}},
			})
	}
	result := assembleAssetsResult(mcpOK, invD, rollupD, trendD)
	s.Cache.SetGen(ck, result, g)
	return result
}

// assembleAssetsResult shapes the three raw SecurityActionAssets cube
// results into the FetchAssets payload. QueryCube returns a nil slice on any
// transport, HTTP, or parse failure and a non-nil slice on success (see
// internal/mcp.Client.QueryCube and assetcounts.go's scalarCubeTotal, which
// fixed the identical pattern) — that nil check is the only signal available
// to tell "queried fine, tenant genuinely has zero" apart from "the query
// failed". The prior `len(assets)>0 || len(rollup)>0 || len(trend)>0` check
// collapsed those two cases: a failed query rendered as a factual "No
// security-action assets in the last 30 days for this tenant" instead of an
// unavailable marker. Any of the three being nil (including mcpOK being
// false — MCP absent or its handshake failed) now degrades the WHOLE result
// to unavailable; only when all three genuinely succeeded (each non-nil,
// though any may legitimately be an empty slice) does an all-empty result
// mean a real zero, reported via `note` with `unavailable` left nil.
func assembleAssetsResult(mcpOK bool, invD, rollupD, trendD []map[string]any) map[string]any {
	if !mcpOK || invD == nil || rollupD == nil || trendD == nil {
		return map[string]any{"assets": []any{}, "rollup": []any{}, "trend": []any{},
			"unavailable": "Security-action assets are unavailable: the query failed."}
	}
	assets := normAssets(invD)
	rollup := flattenCubeRows(rollupD)
	trend := flattenCubeRows(trendD)
	if len(assets) == 0 && len(rollup) == 0 && len(trend) == 0 {
		return map[string]any{"assets": []any{}, "rollup": []any{}, "trend": []any{},
			"unavailable": nil,
			"note":        "No security-action assets in the last 30 days for this tenant."}
	}
	return map[string]any{"assets": assets, "rollup": rollup, "trend": trend, "unavailable": nil}
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
