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
	return shared(s, "hub_health", func() []map[string]any { return s.fetchHubHealth() })
}

// fetchHubHealth is FetchHubHealth without the single-flight wrapper (shared.go).
func (s *Service) fetchHubHealth() []map[string]any {
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
				"statusLabel": "unavailable", "meta": "information unavailable",
				"availability": "error", "reason": "Service inventory information is unavailable",
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
				"availability": "ok", "not_running": []map[string]any{},
			})
			continue
		}
		worst := 0
		errs, stopped, online := 0, 0, 0
		notRunning := []map[string]any{}
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
			// Anything not counted as up above, including a blank status, so
			// the list length is always total minus up.
			if cs != "online" {
				notRunning = append(notRunning, notRunningRow(m))
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
			"not_running":  notRunning,
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

// notRunningRow is one service the "n/m up" count did not count as up, so the
// Infra page lists exactly the services behind that number. A service can run
// on several hosts and is still one row, because the count is of services.
func notRunningRow(m map[string]any) map[string]any {
	var names, ips []string
	for _, item := range asSlice(m["hosts"]) {
		h := asMap(item)
		if n := getStr(h["display_name"]); n != "" {
			names = append(names, n)
		}
		if ip := getStr(h["ip_address"]); ip != "" {
			ips = append(ips, ip)
		}
	}
	return map[string]any{
		"name":  getStr(m["name"]),
		"state": getStr(m["composite_status"]),
		"host":  strings.Join(names, ", "),
		"ip":    strings.Join(ips, ", "),
	}
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
	return shared(s, "service_inventory", func() map[string]any { return s.fetchServiceInventory() })
}

// fetchServiceInventory is FetchServiceInventory without the single-flight wrapper (shared.go).
func (s *Service) fetchServiceInventory() map[string]any {
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
			"reason":        "Service inventory information is unavailable",
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

// hubSecurityCountCap is how many events one hub/security read counts. Measured
// live on 2026-11-21: dns_event honoured _limit=5001 and 10001 in one response
// (no paging needed) and answered HTTP 500 at 50001. A 5001-row answer was 3.8 MB
// and took about a second; that hour held 354 events.
const hubSecurityCountCap = 5000

// FetchHubSecurity is fetch_hub_security (server.py:3685).
func (s *Service) FetchHubSecurity(windowSecs, limit int) map[string]any {
	return shared(s, fmt.Sprintf("hub_security|%d|%d", windowSecs, limit), func() map[string]any { return s.fetchHubSecurity(windowSecs, limit) })
}

// fetchHubSecurity is FetchHubSecurity without the single-flight wrapper (shared.go).
func (s *Service) fetchHubSecurity(windowSecs, limit int) map[string]any {
	ck := cache.Key("hub_security", "",
		map[string]string{"w": fmt.Sprint(windowSecs), "l": fmt.Sprint(limit)}, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()
	t1 := time.Now().Unix()
	t0 := t1 - int64(windowSecs)
	// Cap+1, and deliberately NOT _is_total_size_needed.
	//
	// Every number this function returns is derived by looping the rows it read,
	// so it reads far more rows than it lists. Counting only the listed 50 made
	// the figures swing: measured live on 2026-11-21, an hour with 21 critical or
	// high events showed 2, and 17% of runs of 50 events held none.
	//
	// The +1 separates "asked for 5000, got 5000" from "there are exactly 5000".
	//
	// /api/dnsdata/v2/dns_event answers HTTP 400 to _is_total_size_needed, and
	// that drops this function into its failed-read branch. dnsdata/v2 is the DNS
	// Data reporting API and does not take DDI's paging parameters. The body is
	// still read for a total below, in case the endpoint ever volunteers one.
	fetched, body, err := s.Rest.GetPageStrict("/api/dnsdata/v2/dns_event", map[string]string{
		"t0": fmt.Sprint(t0), "t1": fmt.Sprint(t1),
		"_limit": fmt.Sprint(hubSecurityCountCap + 1),
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
			"complete":     false,
			"availability": "error",
			"reason":       "Threat event information is unavailable",
		}
		s.Cache.SetGen(ck, result, g)
		return result
	}
	// The row past the cap, if it came, is proof and not content: it is dropped
	// before anything is counted.
	rows := fetched
	capHit := len(fetched) > hubSecurityCountCap
	if capHit {
		rows = fetched[:hubSecurityCountCap]
	}

	// An authoritative total, but only when it is coherent with what arrived.
	// pageTotalSize returns the fallback for a missing or unparseable
	// page.total_size; an envelope claiming FEWER than it just handed over is
	// not a total either, and is dropped rather than displayed.
	total := pageTotalSize(body, -1)
	totalOK := total >= len(rows)

	// With a real total, completeness is a fact about the window. Without one,
	// the row past the cap is the only evidence there is. Deliberately NOT
	// len(rows) >= cap, which calls a window of exactly 5000 events capped.
	complete := !capHit
	if totalOK {
		complete = total <= len(rows)
	}

	counts := map[string]int{"critical": 0, "high": 0, "medium": 0, "low": 0}
	blocked, logged := 0, 0
	events := make([]map[string]any, 0, min(limit, len(rows)))
	countedSince := ""
	for i, item := range rows {
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
		// Upstream answers newest first, so the last row read is the oldest
		// event these counts cover.
		if t := getStr(e["event_time"]); t != "" {
			countedSince = t
		}
		if i >= limit {
			continue
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
	// returned is the length of the list. counted is how many events the counts
	// cover, and complete says whether that is the whole window. truncated is
	// its inverse, kept for readers of the older shape. "total" is ABSENT when
	// no true total is known, never a stand-in.
	result := map[string]any{
		"events":       events,
		"counts":       counts,
		"blocked":      blocked,
		"logged":       logged,
		"returned":     len(events),
		"counted":      len(rows),
		"complete":     complete,
		"truncated":    !complete,
		"availability": "ok",
	}
	if countedSince != "" {
		result["counted_since"] = countedSince
	}
	if totalOK {
		result["total"] = total
	} else if complete {
		result["total"] = len(rows)
	}
	s.Cache.SetGen(ck, result, g)
	return result
}

// --- hub/domains -------------------------------------------------------------

// hubDomainsFanOut bounds the seven concurrent section reads below. Seven, i.e.
// all of them at once: they are seven different upstream collections and this
// endpoint's whole latency is one round trip once they overlap. dashboardFanOut
// is smaller because buildAggregate's tasks include multi-page pagers that would
// otherwise open many connections each; nothing here pages.
const hubDomainsFanOut = 7

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
	return shared(s, "hub_domains", func() map[string]any { return s.fetchHubDomains() })
}

// fetchHubDomains is FetchHubDomains without the single-flight wrapper (shared.go).
func (s *Service) fetchHubDomains() map[string]any {
	ck := cache.Key("hub_domains", "", nil, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()

	// SEVEN INDEPENDENT UPSTREAM READS, CONCURRENTLY. They used to run one after
	// another, which is the whole reason nothing could afford to call this
	// endpoint: the sections do not depend on each other, so the wait was the
	// sum of seven round trips instead of the slowest one, and the tab that
	// would show this already fetches eleven feeds of its own. buildAggregate
	// solved the same shape with fanOut (dashboard.go:202) and this reuses it
	// rather than growing a second mechanism.
	//
	// Each task writes only its own two variables and nothing reads them until
	// fanOut has returned, so there is nothing to synchronise beyond the
	// WaitGroup. `go test -race ./internal/dashboard/` covers this — the CI job
	// runs the whole suite with the detector on.
	var (
		policies, feeds, named, roaming, anycast, dfp, hosts []any
		errPolicies, errFeeds, errNamed, errRoaming          error
		errAnycast, errDfp, errHosts                         error
		hostsTotal                                           int
		hostsTotalOK                                         bool
	)
	panicked := fanOut(hubDomainsFanOut,
		func() {
			policies, errPolicies = s.Rest.GetStrict("/api/atcfw/v1/security_policies", map[string]string{"_limit": "100"})
		},
		func() {
			feeds, errFeeds = s.Rest.GetStrict("/api/atcfw/v1/threat_feeds", map[string]string{"_limit": "100"})
		},
		func() {
			named, errNamed = s.Rest.GetStrict("/api/atcfw/v1/named_lists", map[string]string{"_limit": "100"})
		},
		func() {
			roaming, errRoaming = s.Rest.GetStrict("/api/atcep/v1/roaming_devices", map[string]string{"_limit": "200"})
		},
		func() {
			anycast, errAnycast = s.Rest.GetStrict("/api/anycast/v1/accm/ac_runtime_statuses", map[string]string{"_limit": "100"})
		},
		func() {
			dfp, errDfp = s.Rest.GetStrict("/api/atcdfp/v1/dfp_services", map[string]string{"_limit": "100"})
		},
		func() { hosts, hostsTotal, hostsTotalOK, errHosts = s.fetchHosts("") },
	)
	if panicked > 0 {
		// A feed whose task panicked has neither rows nor an error, which would
		// read as an empty feed. Give it the failure it is.
		for _, f := range []struct {
			rows []any
			err  *error
		}{
			{policies, &errPolicies}, {feeds, &errFeeds}, {named, &errNamed}, {roaming, &errRoaming},
			{anycast, &errAnycast}, {dfp, &errDfp}, {hosts, &errHosts},
		} {
			if f.rows == nil && *f.err == nil {
				*f.err = errTaskPanicked
			}
		}
	}

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

	// The Sources page's rows, plus a severity.
	anycastHA := normAnycast(anycast)
	for _, row := range anycastHA {
		a := row.(map[string]any)
		state := a["state"].(string)
		sev := "warn"
		if strings.Contains(state, "up") || strings.Contains(state, "online") || strings.Contains(state, "healthy") {
			sev = "ok"
		}
		a["severity"] = sev
	}

	dfpServices := normSourceDFP(dfp)

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
