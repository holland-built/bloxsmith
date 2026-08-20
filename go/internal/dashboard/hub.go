package dashboard

import (
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"bloxsmith/internal/cache"
)

// --- hub/health --------------------------------------------------------------

// hubBucket is one ordered service-type rollup (server.py:3626 _HUB_SERVICE_BUCKETS).
type hubBucket struct {
	name  string
	types map[string]bool
}

var hubBuckets = []hubBucket{
	{"DNS", map[string]bool{"dns": true, "ndns": true}},
	{"DHCP", map[string]bool{"dhcp": true, "ndhcp": true}},
	{"Security", map[string]bool{"dfp": true, "orpheus": true}},
}

var (
	hubStatusRank    = map[string]int{"online": 0, "stopped": 1, "error": 2}
	hubRankSeverity  = map[int]string{0: "ok", 1: "warn", 2: "crit"}
	hubSeverityLabel = map[string]string{"ok": "healthy", "warn": "degraded", "crit": "critical"}
)

// The rollup's "status" field is a SEVERITY, and it spends two words that are
// not severities. "error" (the dead-feed branch below) has always been one.
// "unknown" is the second: a bucket whose service types may have been
// truncated away has no measured severity at all, and every value
// hubSeverityLabel can produce — "healthy" most of all — would assert one.
// Neither word is a fourth entry in the ok/empty/error AVAILABILITY vocabulary
// documented at the top of dashboard.go; they live in a different field.
const hubStatusUnknown = "unknown"

// FetchHubHealth is fetch_hub_health (server.py:3648).
func (s *Service) FetchHubHealth() []map[string]any {
	ck := cache.Key("hub_health", "", nil, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.([]map[string]any)
	}
	g := s.Cache.Gen()
	services, body, err := s.Rest.GetPageStrict("/api/infra/v1/detail_services", serviceInventoryParams())
	if err != nil {
		// A dead detail_services feed must never masquerade as "0 deployed,
		// all healthy" — that is the exact failure-reads-as-safety bug this
		// migration exists to close. Every bucket is marked error instead of
		// fabricating a healthy rollup from an empty slice.
		log.Printf("hub: detail_services fetch failed: %v", err)
		rollup := make([]map[string]any, 0, len(hubBuckets))
		for _, b := range hubBuckets {
			rollup = append(rollup, map[string]any{
				"name": b.name, "status": "error",
				"statusLabel": "unavailable", "meta": "feed unavailable",
				"availability": "error", "reason": "service inventory feed unavailable",
			})
		}
		s.Cache.SetGen(ck, rollup, g)
		return rollup
	}
	// The SAME truncation test FetchServiceInventory applies to the SAME feed at
	// the SAME limit. Without it this function reads a list it knows may be
	// incomplete and calls every unseen bucket healthy — the "failure reads as
	// safety" bug the comment in the error branch above exists to prevent,
	// arriving through the success path instead.
	truncated, truncReason := serviceInventoryTruncated(services, body)

	rollup := make([]map[string]any, 0, len(hubBuckets))
	for _, b := range hubBuckets {
		var members []map[string]any
		for _, item := range services {
			m := asMap(item)
			if b.types[getStr(m["service_type"])] {
				members = append(members, m)
			}
		}
		if len(members) == 0 {
			if truncated {
				// Not "0 deployed". Nobody counted to zero — the count stopped
				// at the row cap, and this bucket's services may sit past it.
				rollup = append(rollup, map[string]any{
					"name": b.name, "status": hubStatusUnknown,
					"statusLabel": "not listed", "meta": "beyond the row cap",
					"availability": "partial", "reason": truncReason,
				})
				continue
			}
			rollup = append(rollup, map[string]any{
				"name": b.name, "status": "ok",
				"statusLabel": "no services", "meta": "0 deployed",
				"availability": "ok",
			})
			continue
		}
		worst := 0
		errs, stopped, online := 0, 0, 0
		for _, m := range members {
			cs := getStr(m["composite_status"])
			key := cs
			if key == "" {
				key = "online"
			}
			if r, ok := hubStatusRank[key]; ok && r > worst {
				worst = r
			}
			switch cs {
			case "error":
				errs++
			case "stopped":
				stopped++
			case "online":
				online++
			}
		}
		severity := hubRankSeverity[worst]
		var meta string
		switch {
		case errs > 0:
			meta = fmt.Sprintf("%d error · %d/%d up", errs, online, len(members))
		case stopped > 0:
			meta = fmt.Sprintf("%d stopped · %d/%d up", stopped, online, len(members))
		default:
			meta = fmt.Sprintf("%d/%d online", online, len(members))
		}
		row := map[string]any{
			"name":         b.name,
			"status":       severity,
			"statusLabel":  hubSeverityLabel[severity],
			"meta":         meta,
			"availability": "ok",
		}
		// A bucket with members is marked partial too. The severity and the
		// counts describe the members actually seen and stay exactly as
		// measured — but three members online says nothing about six more past
		// the cap, any of which could be stopped or in error, so the rollup is
		// not an authoritative statement about the bucket.
		if truncated {
			row["availability"] = "partial"
			row["reason"] = truncReason
		}
		rollup = append(rollup, row)
	}
	s.Cache.SetGen(ck, rollup, g)
	return rollup
}

// --- service inventory -------------------------------------------------------

// serviceInventoryLimit is the _limit sent to detail_services, and therefore
// also the row count at which the answer stops being trustworthy — see the
// "partial" state below. FetchHubHealth reads the same feed and now sends the
// same params through serviceInventoryParams, so the two cannot drift: the
// comment used to say they agreed, and only one of them acted on it (#81).
const serviceInventoryLimit = 500

// serviceInventoryParams is the one detail_services request both readers send.
// _is_total_size_needed asks CSP for page.total_size, the authoritative row
// count — the same param fetchCount and fetchAtRiskSubnets already use
// (dashboard.go:281, 236).
func serviceInventoryParams() map[string]string {
	return map[string]string{
		"_limit":                fmt.Sprint(serviceInventoryLimit),
		"_is_total_size_needed": "true",
	}
}

// serviceInventoryTruncated answers "could this list be missing rows?" for both
// readers, and returns the operator-facing reason to attach when it can.
//
// Trust order matters. page.total_size is upstream's own count of the whole
// collection, so when it is readable it settles the question outright — and a
// tenant with exactly serviceInventoryLimit services is then correctly reported
// as complete rather than assumed truncated. A total that DISAGREES with the
// rows in hand (smaller than what arrived) is not a pass: the response is
// internally inconsistent, which is a reason to distrust it, not to trust it —
// the same rule totalConsistencyCheck applies in csp.go:145.
//
// Only when no total is readable does the row count decide, and there
// len(rows) >= limit is the best available signal: a full page is
// indistinguishable from a truncated one.
func serviceInventoryTruncated(rows []any, body map[string]any) (bool, string) {
	reason := fmt.Sprintf(
		"service inventory truncated at the %d-row limit — a service type absent here may exist but not be listed",
		serviceInventoryLimit)
	if total := pageTotalSize(body, -1); total >= 0 {
		if total == len(rows) {
			return false, ""
		}
		return true, reason
	}
	if len(rows) >= serviceInventoryLimit {
		return true, reason
	}
	return false, ""
}

// FetchServiceInventory is the raw owned-service-type set behind
// FetchHubHealth's three-bucket rollup. Same feed, same limit; what differs is
// that no rollup is applied, so dfp/orpheus/ndns survive as themselves.
//
// Three availability states, not two, because the caller uses this to HIDE UI:
//
//	ok      — the read succeeded and the list is complete. service_types is a
//	          non-nil slice; empty means this tenant genuinely owns nothing.
//	error   — the read failed. service_types is nil, never an empty slice: a
//	          dead feed answering "you own nothing" is the same
//	          failure-reads-as-safety bug the comment at FetchHubHealth's error
//	          branch exists to prevent, and hiding a panel on it would be worse
//	          than the empty card it replaced.
//	partial — the response came back at or over the limit, so a service_type
//	          that is absent is indistinguishable from one that was truncated
//	          away. The types we did see are returned (they are real), but the
//	          SET is not authoritative, so the caller must fail open exactly as
//	          it does for error. Paging is deliberately not built.
func (s *Service) FetchServiceInventory() map[string]any {
	ck := cache.Key("service_inventory", "", nil, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()
	services, body, err := s.Rest.GetPageStrict("/api/infra/v1/detail_services", serviceInventoryParams())
	if err != nil {
		log.Printf("service inventory: detail_services fetch failed: %v", err)
		result := map[string]any{
			"service_types": []string(nil),
			"availability":  "error",
			"reason":        "service inventory feed unavailable",
		}
		s.Cache.SetGen(ck, result, g)
		return result
	}

	seen := map[string]bool{}
	types := []string{}
	for _, item := range services {
		st := getStr(asMap(item)["service_type"])
		if st == "" || seen[st] {
			continue
		}
		seen[st] = true
		types = append(types, st)
	}
	sort.Strings(types)

	result := map[string]any{
		"service_types": types,
		"availability":  "ok",
	}
	if truncated, reason := serviceInventoryTruncated(services, body); truncated {
		result["availability"] = "partial"
		result["reason"] = reason
	}
	s.Cache.SetGen(ck, result, g)
	return result
}

// --- hub/security ------------------------------------------------------------

// FetchHubSecurity is fetch_hub_security (server.py:3685).
func (s *Service) FetchHubSecurity(windowSecs, limit int) map[string]any {
	ck := cache.Key("hub_security", "",
		map[string]string{"w": fmt.Sprint(windowSecs), "l": fmt.Sprint(limit)}, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()
	t1 := time.Now().Unix()
	t0 := t1 - int64(windowSecs)
	// _limit+1, and deliberately NOT _is_total_size_needed. Read the second half
	// of this comment before adding it.
	//
	// Every number this function returns — counts, blocked, logged — is derived
	// by looping the rows it got back. Before 2026-08-20 it asked for exactly
	// `limit` rows and then reported `"total": len(rows)`, so on a busy hour the
	// four panels downstream showed a count OF THE SAMPLE under labels that read
	// as the hour. Measured on the live tenant that day: 50 rows returned
	// against a limit of 50, `total: 50`, `blocked: 50` — the cap was being hit,
	// and "Total Events 50" was on screen for an hour whose real count nobody
	// knew.
	//
	// The +1 is what fixes that. Without it, "I asked for 50 and got 50" cannot
	// be told apart from "there are exactly 50", and calling the second one
	// truncated is its own false claim in the other direction. Asking for one
	// more row than we intend to keep makes the distinction free: 51 back means
	// there is a 51st. Same technique, same reason, as server/search.go's
	// searchFetch. Confirmed live on 2026-08-20: this tenant answers 51, so
	// `truncated` is true and the panels stopped printing a bare 50.
	//
	// WHY THERE IS NO _is_total_size_needed HERE, WHEN EVERY OTHER COUNT IN THIS
	// PACKAGE USES IT. It was written that way first and the endpoint refused
	// it: /api/dnsdata/v2/dns_event answered HTTP 400 and FetchHubSecurity fell
	// into its dead-feed branch, so the whole Security tab read "threat feed
	// unavailable". Measured by sending it, watching the 400, removing only that
	// parameter, and watching the same request succeed. dnsdata/v2 is the DNS
	// Data reporting API, not DDI, and it does not take DDI's paging parameters
	// — fetchCount, fetchAtRiskSubnets and serviceInventoryParams all talk to
	// ddi/v1 or infra/v1, which do. The similarity of the URLs is not a
	// similarity of the APIs.
	//
	// So there is no authoritative total available for this feed at all, and the
	// panels say "total unknown" rather than inventing one. The body is still
	// read for a total below, because if this endpoint ever starts volunteering
	// page.total_size unasked it costs nothing to believe it; what cannot be
	// done is ASK.
	fetched, body, err := s.Rest.GetPageStrict("/api/dnsdata/v2/dns_event", map[string]string{
		"t0": fmt.Sprint(t0), "t1": fmt.Sprint(t1),
		"_limit": fmt.Sprint(limit + 1),
	})
	if err != nil {
		// This is the highest-consequence instance of the empty-vs-error bug:
		// a dead DNS-threat-event feed must never render as "no threats" — a
		// failure that reads as safety. Mark the section error instead of
		// silently emitting zero events/counts.
		log.Printf("hub: dns_event fetch failed: %v", err)
		result := map[string]any{
			"events":  []map[string]any{},
			"counts":  map[string]int{"critical": 0, "high": 0, "medium": 0, "low": 0},
			"blocked": 0,
			"logged":  0,
			// No "total" key at all. A dead feed knows no counts, and 0 is a
			// number; the consumers render availability:"error" as "feed
			// unavailable" and never reach these, but a zero left sitting in the
			// payload is the next reader's bug.
			"returned":     0,
			"truncated":    false,
			"availability": "error",
			"reason":       "threat-event feed unavailable",
		}
		s.Cache.SetGen(ck, result, g)
		return result
	}
	// The 51st row, if it came, is proof and not content: it is dropped before
	// anything is counted, so the sample stays exactly the size the caller asked
	// for and `truncated` does not depend on having kept an extra row around.
	rows := fetched
	pageTruncated := len(fetched) > limit
	if pageTruncated {
		rows = fetched[:limit]
	}

	// An authoritative total, but only when it is coherent with what arrived.
	// pageTotalSize returns the fallback for a missing or unparseable
	// page.total_size; an envelope claiming FEWER than it just handed over is
	// not a total either, and is dropped rather than displayed. Same shape of
	// check as feedCountLabel in ui/src/lib/feedCount.js: the flag is upstream's
	// claim, the comparison is whether the claim holds.
	total := pageTotalSize(body, -1)
	totalOK := total >= len(rows)

	// With a real total, truncation is a fact about the estate. Without one, the
	// 51st row is the only evidence there is. Deliberately NOT len(rows) >=
	// limit, which calls an hour holding exactly 50 events truncated and is a
	// false claim in the other direction.
	truncated := pageTruncated
	if totalOK {
		truncated = total > len(rows)
	}

	counts := map[string]int{"critical": 0, "high": 0, "medium": 0, "low": 0}
	blocked, logged := 0, 0
	events := make([]map[string]any, 0, len(rows))
	for _, item := range rows {
		e := asMap(item)
		sev := strings.ToLower(getStr(e["severity"]))
		if _, ok := counts[sev]; ok {
			counts[sev]++
		}
		action := strings.ToLower(getStr(e["policy_action"]))
		if action == "block" || action == "redirect" {
			blocked++
		} else if action == "log" {
			logged++
		}
		events = append(events, map[string]any{
			"event_time":       getStr(e["event_time"]),
			"qname":            getStr(e["qname"]),
			"severity":         getStr(e["severity"]),
			"policy_action":    getStr(e["policy_action"]),
			"feed_name":        getStr(e["feed_name"]),
			"threat_indicator": getStr(e["threat_indicator"]),
			"device":           orAny(e["device"], ""),
			"network":          orAny(e["network"], ""),
		})
	}
	// "returned" is the row count and says so. It replaces a key called "total"
	// that held exactly this number, which is the mislabel 28d55e2 ("Stop
	// reporting the row limit as the size of the estate") removed elsewhere and
	// which survived here. "total" now means the estate figure and is ABSENT
	// when there isn't one — never a stand-in, because a consumer reading
	// `total ?? rows.length` is back to printing the sample under the old label.
	//
	// counts/blocked/logged still describe `rows`, and that is unavoidable at
	// this layer: severity is a property of each event, so a tenant-wide
	// breakdown would need a counting query per severity. `truncated` is what
	// tells the three panels to say whose numbers these are.
	result := map[string]any{
		"events":       events,
		"counts":       counts,
		"blocked":      blocked,
		"logged":       logged,
		"returned":     len(rows),
		"truncated":    truncated,
		"availability": "ok",
	}
	if totalOK {
		result["total"] = total
	}
	s.Cache.SetGen(ck, result, g)
	return result
}

// --- hub/domains -------------------------------------------------------------

// counter preserves first-seen order so ties break the way collections.Counter
// does (most_common is stable on insertion order).
type counter struct {
	order  []string
	counts map[string]int
}

func newCounter() *counter { return &counter{counts: map[string]int{}} }

func (c *counter) add(k string) {
	if _, ok := c.counts[k]; !ok {
		c.order = append(c.order, k)
	}
	c.counts[k]++
}

// dict returns the counter as a plain map (Python dict(counter)).
func (c *counter) dict() map[string]int {
	m := make(map[string]int, len(c.counts))
	for k, v := range c.counts {
		m[k] = v
	}
	return m
}

// mostCommon is Counter.most_common(n): count desc, ties in insertion order,
// each entry a [key, count] pair.
func (c *counter) mostCommon(n int) []any {
	idx := map[string]int{}
	for i, k := range c.order {
		idx[k] = i
	}
	keys := append([]string(nil), c.order...)
	sort.SliceStable(keys, func(i, j int) bool {
		if c.counts[keys[i]] != c.counts[keys[j]] {
			return c.counts[keys[i]] > c.counts[keys[j]]
		}
		return idx[keys[i]] < idx[keys[j]]
	})
	if n > len(keys) {
		n = len(keys)
	}
	out := make([]any, 0, n)
	for _, k := range keys[:n] {
		out = append(out, []any{k, c.counts[k]})
	}
	return out
}

// hubSevRank is _hub_sev_rank (server.py:3730).
func hubSevRank(level string) string {
	lv := strings.ToUpper(level)
	if lv == "HIGH" || lv == "CRITICAL" {
		return "crit"
	}
	if lv == "MEDIUM" || lv == "MED" {
		return "warn"
	}
	return "ok"
}

// FetchHubDomains is fetch_hub_domains (server.py:3740).
func (s *Service) FetchHubDomains() map[string]any {
	ck := cache.Key("hub_domains", "", nil, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()

	policies, errPolicies := s.Rest.GetStrict("/api/atcfw/v1/security_policies", map[string]string{"_limit": "100"})
	feeds, errFeeds := s.Rest.GetStrict("/api/atcfw/v1/threat_feeds", map[string]string{"_limit": "100"})
	named, errNamed := s.Rest.GetStrict("/api/atcfw/v1/named_lists", map[string]string{"_limit": "100"})
	roaming, errRoaming := s.Rest.GetStrict("/api/atcep/v1/roaming_devices", map[string]string{"_limit": "200"})
	anycast, errAnycast := s.Rest.GetStrict("/api/anycast/v1/accm/ac_runtime_statuses", map[string]string{"_limit": "100"})
	dfp, errDfp := s.Rest.GetStrict("/api/atcdfp/v1/dfp_services", map[string]string{"_limit": "100"})
	hosts, hostsTotal, hostsTotalOK, errHosts := s.fetchHosts("")

	// availability is one section-name -> "ok"/"error" entry per
	// independent feed this endpoint combines. Unlike the single-feed
	// hub/security and hub/health sections (which carry one flat
	// availability/reason pair each, mirroring csp.go's exposureFeedUnavailable
	// shape directly), hub/domains fans out to 7 unrelated upstreams in one
	// response, so a single failure must never blank the other 6 — each is
	// tracked independently instead of collapsing to one status.
	availability := map[string]any{}
	noteAvailability := func(section string, err error) {
		if err != nil {
			log.Printf("hub: %s fetch failed: %v", section, err)
			availability[section] = "error"
			return
		}
		availability[section] = "ok"
	}
	noteAvailability("security_policies", errPolicies)
	noteAvailability("threat_feeds", errFeeds)
	noteAvailability("named_lists", errNamed)
	noteAvailability("roaming_endpoints", errRoaming)
	noteAvailability("anycast_ha", errAnycast)
	noteAvailability("dfp_services", errDfp)
	noteAvailability("host_inventory", errHosts)

	threatFeeds := make([]map[string]any, 0, len(feeds))
	for _, item := range feeds {
		f := asMap(item)
		threatFeeds = append(threatFeeds, map[string]any{
			"name":         getStr(f["name"]),
			"source":       getStr(f["source"]),
			"threat_level": getStr(f["threat_level"]),
			"confidence":   getStr(f["confidence_level"]),
			"severity":     hubSevRank(getStr(f["threat_level"])),
		})
	}

	namedLists := make([]map[string]any, 0, len(named))
	for _, item := range named {
		n := asMap(item)
		namedLists = append(namedLists, map[string]any{
			"name":         getStr(n["name"]),
			"type":         getStr(n["type"]),
			"items":        orAny(n["item_count"], 0),
			"threat_level": getStr(n["threat_level"]),
			"policies":     len(asSlice(n["policies"])),
			"severity":     hubSevRank(getStr(n["threat_level"])),
		})
	}

	securityPolicies := make([]map[string]any, 0, len(policies))
	for _, item := range policies {
		p := asMap(item)
		securityPolicies = append(securityPolicies, map[string]any{
			"name":           getStr(p["name"]),
			"default_action": getStr(p["default_action"]),
			"dfps":           len(asSlice(p["dfps"])),
			"rules":          len(asSlice(p["rules"])),
			"doh":            truthy(p["doh_enabled"]),
		})
	}

	statusCounts := newCounter()
	countries := newCounter()
	for _, item := range roaming {
		d := asMap(item)
		st := strings.ToLower(vToStr(orAny(d["display_status"], d["calculated_status"], "unknown")))
		statusCounts.add(st)
		if c := getStr(d["country_name"]); c != "" {
			countries.add(c)
		}
	}
	roamingEndpoints := map[string]any{
		"total":         len(roaming),
		"by_status":     statusCounts.dict(),
		"top_countries": countries.mostCommon(5),
	}

	anycastHA := make([]map[string]any, 0, len(anycast))
	for _, item := range anycast {
		a := asMap(item)
		state := ""
		if rt, ok := a["runtime_status"].(map[string]any); ok {
			state = strings.ToLower(vToStr(orAny(rt["state"], rt)))
		} else {
			state = strings.ToLower(vToStr(a["runtime_status"]))
		}
		sev := "warn"
		if strings.Contains(state, "up") || strings.Contains(state, "online") || strings.Contains(state, "healthy") {
			sev = "ok"
		}
		anycastHA = append(anycastHA, map[string]any{
			"name":     getStr(a["name"]),
			"service":  getStr(a["service"]),
			"ip":       getStr(a["anycast_ip_address"]),
			"state":    orAny(state, "unknown"),
			"severity": sev,
		})
	}

	dfpHost := func(d map[string]any) string {
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
	dfpServices := make([]map[string]any, 0, len(dfp))
	for _, item := range dfp {
		d := asMap(item)
		dfpServices = append(dfpServices, map[string]any{
			"name":      getStr(d["name"]),
			"mode":      orStr(d["forwarding_policy"], d["mode"], ""),
			"host":      dfpHost(d),
			"resolvers": len(asSlice(d["default_resolvers"])),
		})
	}

	qpsNum := func(h map[string]any) any {
		q := h["qps"]
		if qm, ok := q.(map[string]any); ok {
			for _, k := range []string{"current", "value", "avg", "limit"} {
				if f, ok := qm[k].(float64); ok {
					return f
				}
			}
			return 0
		}
		if _, ok := q.(float64); ok {
			return q
		}
		return 0
	}
	hostStatus := newCounter()
	for _, item := range hosts {
		h := asMap(item)
		hostStatus.add(strings.ToLower(vToStr(orAny(h["composite_status"], "unknown"))))
	}
	hostRows := []map[string]any{}
	for i, item := range hosts {
		if i >= 12 {
			break
		}
		h := asMap(item)
		hostRows = append(hostRows, map[string]any{
			"name":    getStr(h["display_name"]),
			"ip":      getStr(h["ip_address"]),
			"version": getStr(h["host_version"]),
			"status":  strings.ToLower(getStr(h["composite_status"])),
			"qps":     qpsNum(h),
		})
	}
	// "total" used to be len(hosts), i.e. the rows in this page — a meaning the
	// key name flatly denies. At the old _limit=200 it read 200 for a measured
	// 532-host tenant (#85). It is now the AUTHORITATIVE tenant total when
	// upstream reports one, and "returned" carries the row count that
	// by_status and hosts were actually computed from. Nothing in go/ or ui/
	// reads host_inventory today (grepped), so redefining the key fixes the
	// name rather than breaking a reader.
	hostInventory := map[string]any{
		"returned":  len(hosts),
		"by_status": hostStatus.dict(),
		"hosts":     hostRows,
	}
	if hostsTotalOK {
		hostInventory["total"] = hostsTotal
	}
	if hostsTruncated(hosts, hostsTotal, hostsTotalOK) {
		// by_status and hosts describe the rows in hand, not the estate. The
		// section is marked partial so no consumer can read those aggregates as
		// tenant-wide — reporting an authoritative total beside subset-derived
		// counts with no such marker would be a new inconsistency, not a fix.
		hostInventory["truncated"] = true
		hostInventory["reason"] = hostsReason
		availability["host_inventory"] = "partial"
	}

	result := map[string]any{
		"threat_feeds":      threatFeeds,
		"named_lists":       namedLists,
		"security_policies": securityPolicies,
		"roaming_endpoints": roamingEndpoints,
		"anycast_ha":        anycastHA,
		"dfp_services":      dfpServices,
		"host_inventory":    hostInventory,
		"availability":      availability,
	}
	s.Cache.SetGen(ck, result, g)
	return result
}
