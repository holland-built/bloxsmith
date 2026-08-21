package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/mcp"
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
//
// availability distinguishes a genuinely failed read (transport/init error,
// or an unrecognised response shape — actionsAsync's ok=false, or a non-map
// result) from a genuinely empty tenant (a real, successful zero-action
// response), the same way FetchDNSAnalytics/FetchHostMetrics/FetchHubSecurity
// already do. sourceFetch's "incidents" case (sources.go) reads this field to
// decide whether to propagate an error, rather than trusting the mere
// presence of "unavailable" — which, before this field existed, was also set
// on a genuine empty tenant and so could not tell the two apart.
func (s *Service) FetchActions(ctx context.Context) map[string]any {
	raw, ok := s.actionsAsync(ctx)
	if !ok {
		return map[string]any{"actions": []any{},
			"unavailable":  "IQ Actions service unavailable (upstream error).",
			"availability": "error"}
	}
	data, isMap := raw.(map[string]any)
	if !isMap {
		return map[string]any{"actions": []any{},
			"unavailable":  "IQ Actions returned unexpected data.",
			"availability": "error"}
	}
	if v, has := data["actions"]; !has || v == nil {
		data["actions"] = []any{}
	}
	if !truthy(data["actions"]) {
		if _, hasU := data["unavailable"]; !hasU {
			data["unavailable"] = "No IQ Actions (SOC incidents) for this tenant."
		}
	}
	data["availability"] = "ok"
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
// until pagination.has_more is false or actionsMaxFetch is reached, and always
// publishes actions_truncated saying which of those it was — see the block at
// the end of this function for the five exits and why the flag is unconditional.
func (s *Service) actionsAsync(ctx context.Context) (any, bool) {
	if s.Mcp == nil || s.Mcp.Initialize(ctx) != nil {
		return nil, false
	}
	merged := []any{}
	var last map[string]any
	// TRUNCATED UNTIL PROVEN OTHERWISE. The loop below has five exits and only
	// ONE of them means "this is the whole set": upstream answering
	// has_more:false. The default is therefore true, and exactly one branch
	// clears it, so a new break added later is incomplete by default rather than
	// silently complete. See the actions_truncated block after the loop.
	truncated := true
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
		// Tested BEFORE the cap, and the order matters: a final page that both
		// says has_more:false and lands exactly on actionsMaxFetch is a COMPLETE
		// merge, and checking the cap first would label it truncated.
		if !hasMore {
			truncated = false
			break
		}
		if len(merged) >= actionsMaxFetch {
			break
		}
		offset += actionsPageSize
	}
	if last == nil {
		last = map[string]any{}
	}
	last["actions"] = merged

	// `last` is the FINAL PAGE's map with the merged list swapped in, so every
	// other key it carries still describes that one page. Measured live on
	// 2026-08-20: /api/actions served 78 merged rows (78 distinct ids, zero
	// duplicates) under total_count:28, message:"Found 28 actions" and
	// pagination:{has_more:false,limit:50,offset:50}. Three fields describing a
	// page of 28 sat next to a body of 78, and "total" is the word an operator
	// trusts, so the payload's own summary contradicted its own contents.
	//
	// DELETED, not recomputed, one reason each:
	//   - total_count: len(actions) already states the count, and it cannot
	//     drift from the list it is measured on. A recomputed total_count is a
	//     second derivation of the same fact, which is a field that can later
	//     disagree with the rows beside it for no gain.
	//   - message: upstream prose about ONE page ("Found 28 actions"). Nothing
	//     here knows what sentence would be true of the merged set, and writing
	//     one would be inventing upstream's voice.
	//   - pagination: limit/offset described the last request this loop happened
	//     to make, which is an artefact of paging, not a property of the result.
	//     Its has_more was the only surviving signal that the merge stopped
	//     early, and it is replaced by actions_truncated below rather than simply
	//     dropped — see that block for why re-emitting has_more would have been
	//     the wrong shape.
	//
	// The deletes are UNCONDITIONAL, and must stay that way: on the single-page
	// path `last` IS the only page and still carries all three. Dropping them
	// only when several pages were fetched would make the response shape depend
	// on how many actions the tenant happens to have, so a consumer would read
	// total_count successfully until the tenant crossed actionsPageSize and then
	// silently start reading a per-page figure. delete() on an absent key is a
	// no-op, so this costs nothing when upstream sends none of them.
	//
	// The two early returns above are exempt BY CONSTRUCTION, checked rather
	// than assumed: the offset==0 decode failure returns a hand-built
	// {"actions":[], "_raw":...} that never had these keys, and the offset==0
	// non-map return hands back raw `v`, which FetchActions' isMap check turns
	// into the "returned unexpected data" error shape without ever reading a
	// field. Neither can reach this point, and neither can carry a page total.
	for _, k := range []string{"total_count", "message", "pagination"} {
		delete(last, k)
	}

	// actions_truncated: THE INCOMPLETENESS SIGNAL `pagination` USED TO CARRY.
	//
	// Deleting pagination was right — limit/offset describe one request, not the
	// merged result — but pagination.has_more was the only field on this payload
	// that could say the merge stopped before upstream ran out. Removing it with
	// nothing in its place would make a merge that was cut short byte-identical
	// to a complete one, which is the same class of silent lie the deletes above
	// exist to remove, re-introduced on the same endpoint.
	//
	// FIVE EXITS FROM THE LOOP, and four of them leave the set INCOMPLETE with
	// the last page still reporting has_more:true. Naming all of them, because a
	// comment that said "the only other exit is the actionsMaxFetch cap" was
	// wrong here until 2026-08-21 and undercounted the risk by three:
	//   1. the actionsMaxFetch (500) cap        -> truncated
	//   2. a mid-page CallTool error            -> truncated
	//   3. a mid-page JSON decode failure       -> truncated
	//   4. a mid-page non-map response          -> truncated
	//   5. upstream reporting has_more:false    -> COMPLETE, the only one
	// Exits 2-4 have offset==0 twins that return early (an outright degrade, or
	// the raw body) and never reach this line; only their mid-merge forms break
	// out of the loop holding a partial `merged`.
	//
	// A BOOLEAN, NOT A RE-EMITTED has_more, and not a "fetched N of M": there is
	// no trustworthy M. total_count was per-page (see above), so the honest claim
	// is the narrow one — this list may not be all of them — and inventing a
	// denominator would be the fabrication that started this whole change.
	//
	// ALWAYS PRESENT, false included, matching `truncated` on /api/audit/log
	// (server/state.go). A flag that appears only when it fires is a flag a
	// consumer never learns to read, so the one response that sets it looks like
	// every other response with a missing key. Consumers must never have to infer
	// incompleteness from an absent field again — that inference is exactly what
	// pagination.has_more used to require.
	//
	// MEASURED on the live tenant, 2026-08-21: /api/actions merged 79 rows, well
	// under the 500 cap, exit 5. So today this field is false in production and
	// changes nothing an operator sees; it exists for the day the tenant grows
	// past 500 actions or a page fails, when nothing else would say so.
	last["actions_truncated"] = truncated
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

// ActionOutcomeApplied and ActionOutcomeUnknown are the only two words this
// function is entitled to say about a dispatched write, and the caller keys its
// audit row on them (server/noc.go actionStatus).
//
// There are TWO and not three because only two are provable. "applied" is
// grounded: mcp.SuccessFieldTrue recognises {"success":true,...}, the shape
// observed live from this tool. There is deliberately no "refused" word to go
// with it — mcp.ErrRejected does NOT mean the write missed. Its own doc says so
// (mcp.go: "The call reached the tool; the write may or may not have landed
// upstream"), and CallToolChecked returns it for an empty payload, an
// unparseable payload, and any payload the predicate does not affirmatively
// recognise. A {"success":false} reply has never been observed from
// iq-actions_update_action, so calling one "refused" would assert something
// about the customer's tenant on the strength of a shape nobody has seen —
// the same class of false claim this pair exists to remove.
const (
	ActionOutcomeApplied = "applied"
	ActionOutcomeUnknown = "unknown"
)

// UpdateAction is the first IQ Actions write path: resolve/reopen one action
// via iq-actions_update_action. status must be exactly "active" or
// "resolved" — the upstream tool has no version/etag precondition, so this is
// the only guard against bad input. The current status is read first (via
// iq-actions_get_action) so the caller can audit old->new; if that read
// fails, the write still proceeds with old status "unknown".
//
// THE ERROR RETURN MEANS "NOTHING WAS SENT". Every non-nil error below is
// returned before CallToolChecked is reached, so a caller may record it as a
// definite non-event. Once the call is dispatched the error return is never
// used again: the outcome is reported through the map's "outcome" field, which
// is at best "applied" and otherwise UNKNOWN. TestUpdateActionErrorsOnlyBefore
// Dispatch (analytics_action_outcome_test.go) holds that split over the syntax
// tree, because it is a claim another package's audit log depends on.
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

	text, err := s.Mcp.CallToolChecked(ctx, "iq-actions_update_action", map[string]any{
		"id": id, "status": status, "format": "json",
	}, mcp.SuccessFieldTrue)
	if err != nil {
		// The request left this process and its fate is UNKNOWN. That covers a
		// transport error (the 12s call timeout can expire after the tool ran, a
		// gateway 5xx can arrive once it may already have run) and equally the
		// fail-closed branch, which fires on any reply SuccessFieldTrue does not
		// recognise — including a success it does not know how to read. err's
		// text is kept as diagnostic context and is never a verdict.
		return map[string]any{
			"ok": false, "outcome": ActionOutcomeUnknown,
			"id": id, "old_status": oldStatus, "new_status": status,
			"error":      err.Error(),
			"result_raw": trunc(text, 200),
		}, nil
	}

	var v any
	_ = json.Unmarshal([]byte(text), &v)
	return map[string]any{
		"ok": true, "outcome": ActionOutcomeApplied,
		"id": id, "old_status": oldStatus, "new_status": status,
		"result": v,
	}, nil
}

// --- SOC Insights (server.py fetch_insights 4252 / norm_insights 4229) -------

// FetchInsights is fetch_insights: the direct REST /api/v1/insights read (the
// SecurityActionSummaryView cube is dead server-side). Degrades to
// {"data":[],"unavailable":...}; never fabricates.
//
// A failed read (network error, bad status, unparseable/unexpected body) must
// never collapse into the "No SOC Insights ... in the last 30 days for this
// tenant." wording — that sentence asserts a fact about the tenant's data,
// which a failed read has no basis to claim. It now goes through GetPageStrict
// so the failure is distinguishable from a genuine zero-row response, and a
// failure is NOT written to the ~5 min cache (SetGen only runs on the success
// path) so a transient outage can't freeze a false "no insights" state for
// the cache's lifetime.
func (s *Service) FetchInsights() map[string]any {
	ck := cache.Key("insights", "", nil, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()
	_, body, err := s.Rest.GetPageStrict("/api/v1/insights", nil)
	if err != nil {
		return map[string]any{
			"data":         []any{},
			"unavailable":  "SOC Insights (security actions) unavailable (upstream error).",
			"availability": "error",
		}
	}
	rows := asSlice(body["insightList"])
	var result map[string]any
	if len(rows) > 0 {
		result = map[string]any{"data": normInsights(rows), "availability": "ok"}
	} else {
		result = map[string]any{"data": []any{},
			"unavailable":  "No SOC Insights (security actions) in the last 30 days for this tenant.",
			"availability": "ok"}
	}
	s.Cache.SetGen(ck, result, g)
	return result
}

// normInsights is norm_insights (server.py:4229): it maps a REST
// /api/v1/insights row onto the field names the (dead) SecurityActionSummaryView
// cube used to produce, so consumers see one stable contract.
//
// Only some of that contract has a source. insightId/tFamily/threatType/
// priorityText/status/numEvents/feedSource/startedAt/mostRecentAt are real
// upstream fields and are mapped here. totalVerifiedAssets and timeSaved were
// cube columns with NO REST counterpart, and were emitted as a literal 0 —
// "0 assets verified", "0 seconds saved" — which reads as a measurement rather
// than as the absence of one. They are now passed through only when the row
// actually reports them, and are nil (JSON null, an em-dash in the UI)
// otherwise. No alias is guessed for them: if upstream turns out to report
// these under another name (numEvents -> totalEvents is the precedent), the
// name goes in firstPresent's key list here and nowhere else.
//
// PRESENCE, not truthiness, is the test — firstPresent, never orAny: a row
// that genuinely reports 0 verified assets is a real measurement and must
// survive as 0, and orAny (Python's `a or b`) would silently downgrade it to
// unknown, which is the opposite lie. severity is now on the same rule; see
// the comment at the assignment for why its unreported case reads "unknown"
// rather than a grade nobody gave it.
//
// count (always 1) and totalTimeSaved (always 0) are gone rather than nulled:
// both are cube AGGREGATE measures — "how many security actions", "seconds
// saved across them" — that have no per-row meaning at all, no upstream field
// to ever fill them, and no reader anywhere in go/ or ui/. `count` was also the
// visible symptom: json.Marshal sorts keys, so the SOC Insights table's
// first-four-keys column picker put a column of literal 1s in front of the
// operator.
func normInsights(raw []any) []any {
	out := []any{}
	for _, ri := range raw {
		r := asMap(ri)
		// An insight upstream never graded used to arrive graded "medium" — a
		// specific, actionable claim manufactured out of an absence, on the one
		// field a security decision turns on, and sortable as if it had been
		// measured. It is the same fabrication normFeeds made with an
		// unreported confidence (norm.go:294-315), normPolicies with an
		// unreported action, normAudit with an absent http_code and normHosts
		// with an unknown status; this one was missed when those were fixed.
		//
		// A REPORTED value survives whatever it says. The only transformation
		// is trim + lower-case, which is normalisation, not rewriting: unlike
		// normFeeds — where an unrecognised word would be fed through a levels
		// map and DERIVE a second confident grading — nothing here is derived
		// from this word, so replacing an upstream "SEVERE" with "unknown"
		// would discard a real measurement, which is the opposite lie.
		//
		// Absence has four shapes and all four are "unknown": the key missing,
		// the key present with JSON null (firstPresent's rule), an empty
		// string, and a whitespace-only string. getStr does not trim, so the
		// trim happens before the emptiness test.
		severity := "unknown"
		if raw, ok := firstPresent(r, "priorityText"); ok {
			if pt := strings.ToLower(strings.TrimSpace(getStr(raw))); pt != "" {
				severity = pt
			}
		}
		verifiedAssets, _ := firstPresent(r, "totalVerifiedAssets")
		timeSaved, _ := firstPresent(r, "timeSaved")
		out = append(out, map[string]any{
			"id":                  orStr(r["insightId"], ""),
			"name":                orStr(r["tFamily"], r["threatType"], r["insightId"], ""),
			"severity":            severity,
			"currentStatus":       orStr(r["status"], ""),
			"totalEvents":         toInt(orAny(r["numEvents"], 0)),
			"totalVerifiedAssets": verifiedAssets,
			"timeSaved":           timeSaved,
			"feedSource":          orStr(r["feedSource"], ""),
			"startedAt":           orStr(r["startedAt"], ""),
			"mostRecentAt":        orStr(r["mostRecentAt"], ""),
		})
	}
	return out
}

// --- DNS Analytics (server.py fetch_dns_analytics 4302) ----------------------

// cubeQuery runs one cubejs REST query (the same /api/cubejs/v1/query path
// CSPDNSQps/CSPThreats use) and returns its rows, normalized to plain
// (non-prefixed) keys via cubeRow. On any upstream error it returns an empty
// slice — never panics into the route.
func (s *Service) cubeQuery(query map[string]any) []map[string]any {
	q, _ := json.Marshal(query)
	body, st, err := s.Rest.GetEx("/api/cubejs/v1/query", map[string]string{"query": string(q)})
	if errored(st, err) {
		return nil
	}
	raw := cubeData(body)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		out = append(out, cubeRow(asMap(item)))
	}
	return out
}

// FetchDNSAnalytics is fetch_dns_analytics: three NstarDnsActivity cube
// queries (7-day volume trend, top clients, query-type mix) over direct REST
// — the MCP parquet path (query_stored_data) cannot be read back at all.
//
// cubeQuery returns a nil slice on upstream failure and a non-nil (possibly
// empty) slice on a genuine success, even with zero rows — see cubeQuery's
// doc comment. That distinction is preserved here as availability: a dead
// cubejs reports "error" with a reason and empty rows; a tenant with
// real but zero query activity still reports "ok", mirroring the
// availability/reason field names csp.go's exposureFeedUnavailable uses for
// the same failure-vs-empty problem on the attack-surface feeds.
func (s *Service) FetchDNSAnalytics(ctx context.Context) map[string]any {
	volRows := s.cubeQuery(map[string]any{
		"measures": []string{"NstarDnsActivity.total_query_count"},
		"timeDimensions": []map[string]any{{
			"dimension": "NstarDnsActivity.timestamp",
			"dateRange": "last 7 days", "granularity": "day"}},
	})
	clientRows := s.cubeQuery(map[string]any{
		"measures":   []string{"NstarDnsActivity.total_query_count"},
		"dimensions": []string{"NstarDnsActivity.device_name", "NstarDnsActivity.device_ip"},
		"timeDimensions": []map[string]any{{
			"dimension": "NstarDnsActivity.timestamp", "dateRange": "last 7 days"}},
		"order": map[string]any{"NstarDnsActivity.total_query_count": "desc"}, "limit": 50,
	})
	typeRows := s.cubeQuery(map[string]any{
		"measures":   []string{"NstarDnsActivity.total_query_count"},
		"dimensions": []string{"NstarDnsActivity.query_type"},
		"timeDimensions": []map[string]any{{
			"dimension": "NstarDnsActivity.timestamp", "dateRange": "last 7 days"}},
		"order": map[string]any{"NstarDnsActivity.total_query_count": "desc"}, "limit": 10,
	})
	if volRows == nil || clientRows == nil || typeRows == nil {
		log.Printf("dashboard: DNS analytics cube query failed (NstarDnsActivity unavailable)")
		return map[string]any{
			"volume": []any{}, "top_clients": []any{}, "query_types": []any{},
			"availability": "error",
			"reason":       "DNS analytics (NstarDnsActivity) unavailable (upstream error).",
		}
	}
	return map[string]any{
		"volume": toAnyN(volRows), "top_clients": toAnyN(clientRows), "query_types": toAnyN(typeRows),
		"availability": "ok",
	}
}

// --- Host Metrics (server.py fetch_host_metrics 4319) ------------------------

// hostDisplayNames builds a uuid/ophid -> display_name lookup from
// /api/infra/v1/detail_hosts, the same endpoint CSPHostHealth already reads.
// Never fabricates a name: a host with no match keeps its raw id upstream.
func (s *Service) hostDisplayNames() map[string]string {
	rows, total, totalOK, err := s.fetchHosts("id,ophid,display_name")
	if err != nil {
		// Not surfaced to the caller: this feeds a uuid/ophid -> display_name
		// lookup map for FetchHostMetrics, which has no error return of its
		// own and already degrades a missing name to the raw id. Aborting
		// here would just turn ALL host names blank instead of leaving the
		// (still-correct) ids in place, so the failure is logged and the map
		// comes back empty.
		log.Printf("dashboard: detail_hosts fetch failed: %v", err)
		return map[string]string{}
	}
	if hostsTruncated(rows, total, totalOK) {
		// This reader has no caller-facing shape to carry a truncation flag —
		// it is a lookup map, and FetchHostMetrics already documents a missing
		// name degrading to the raw id. So the fact is logged rather than
		// invented into a status field nobody can read. The wording is
		// deliberate: these rows were never FETCHED at all, which is not the
		// same as a host whose name failed to resolve.
		log.Printf("dashboard: host name lookup saw %d of %d inventory rows — %s",
			len(rows), total, hostsReason)
	}
	out := make(map[string]string, len(rows))
	for _, item := range rows {
		h := asMap(item)
		name := getStr(h["display_name"])
		if name == "" {
			continue
		}
		if id := getStr(h["id"]); id != "" {
			out[id] = name
		}
		if ophid := getStr(h["ophid"]); ophid != "" {
			out[ophid] = name
		}
	}
	return out
}

// FetchHostMetrics is fetch_host_metrics: one HostMetrics cube query per
// per-host metric (host_cpu, host_memory) over direct REST — HostMetrics has
// no host_name dimension and requires a metric_name filter, unlike the old
// (never-working) MCP query. HostMetrics.host is an opaque UUID; it is
// resolved to a display name via hostDisplayNames. Rows with a null host are
// account-level (e.g. dns_qps_iq) and are skipped, never rendered blank.
//
// Same availability treatment as FetchDNSAnalytics: cubeQuery returns nil on
// upstream failure and a non-nil (possibly empty) slice on a genuine
// success. A failure on either metric query reports availability
// "error" with a reason and an empty metrics list; a real tenant with
// no per-host metrics still reports "ok" with an empty metrics list. The
// "metrics" key and its row shape are unchanged.
func (s *Service) FetchHostMetrics(ctx context.Context) map[string]any {
	names := s.hostDisplayNames()
	metrics := []any{}
	failed := false
	for _, metricName := range []string{"host_cpu", "host_memory"} {
		rows := s.cubeQuery(map[string]any{
			"measures":   []string{"HostMetrics.avg_value"},
			"dimensions": []string{"HostMetrics.host", "HostMetrics.metric_name_label"},
			"filters": []map[string]any{{
				"member": "HostMetrics.metric_name", "operator": "equals",
				"values": []string{metricName}}},
		})
		if rows == nil {
			failed = true
			continue
		}
		for _, row := range rows {
			hostID := getStr(row["host"])
			if hostID == "" {
				continue
			}
			hostName := hostID
			if n, ok := names[hostID]; ok {
				hostName = n
			}
			metrics = append(metrics, map[string]any{
				"host":              hostID,
				"host_name":         hostName,
				"metric_name":       metricName,
				"metric_name_label": row["metric_name_label"],
				"avg_value":         toFloat(orAny(row["avg_value"], 0)),
			})
		}
	}
	if failed {
		log.Printf("dashboard: host metrics cube query failed (HostMetrics unavailable)")
		return map[string]any{
			"metrics":      []any{},
			"availability": "error",
			"reason":       "Host metrics (HostMetrics) unavailable (upstream error).",
		}
	}
	return map[string]any{"metrics": metrics, "availability": "ok"}
}

// --- Threat Lookup (server.py threat_lookup 4551 / _threat_lookup_async) -----

// ThreatLookup is threat_lookup: network_entity_search over one query string.
//
// s.Mcp.Search returns nil on a failed search (no MCP client, a failed
// Initialize, a transport error, a non-2xx, or an unparseable/unexpected
// payload) and a non-nil (possibly empty) slice on a genuine search — see
// mcp.go's Search doc. Collapsing both to entities:[] (the prior behavior)
// made a dead search render identically to a real "no matches" in the UI
// (EntitiesTable). availability distinguishes them for the caller the same
// way FetchDNSAnalytics/FetchHostMetrics/FetchHubSecurity already do; the
// "entities" field itself is unchanged so existing callers keep working.
func (s *Service) ThreatLookup(ctx context.Context, query string) map[string]any {
	if s.Mcp != nil && s.Mcp.Initialize(ctx) == nil {
		if hits := s.Mcp.Search(ctx, query); hits != nil {
			return map[string]any{"entities": hits, "query": query, "availability": "ok"}
		}
	}
	return map[string]any{
		"entities":     []any{},
		"query":        query,
		"availability": "error",
		"reason":       "Entity search (network_entity_search) unavailable (upstream error).",
	}
}
