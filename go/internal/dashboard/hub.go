package dashboard

import (
	"fmt"
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

// FetchHubHealth is fetch_hub_health (server.py:3648).
func (s *Service) FetchHubHealth() []map[string]any {
	ck := cache.Key("hub_health", "", nil, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.([]map[string]any)
	}
	services := s.Rest.Get("/api/infra/v1/detail_services", map[string]string{"_limit": "500"})
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
			rollup = append(rollup, map[string]any{
				"name": b.name, "status": "ok",
				"statusLabel": "no services", "meta": "0 deployed",
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
		rollup = append(rollup, map[string]any{
			"name":        b.name,
			"status":      severity,
			"statusLabel": hubSeverityLabel[severity],
			"meta":        meta,
		})
	}
	s.Cache.Set(ck, rollup)
	return rollup
}

// --- hub/security ------------------------------------------------------------

// FetchHubSecurity is fetch_hub_security (server.py:3685).
func (s *Service) FetchHubSecurity(windowSecs, limit int) map[string]any {
	ck := cache.Key("hub_security", "",
		map[string]string{"w": fmt.Sprint(windowSecs), "l": fmt.Sprint(limit)}, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	t1 := time.Now().Unix()
	t0 := t1 - int64(windowSecs)
	rows := s.Rest.Get("/api/dnsdata/v2/dns_event", map[string]string{
		"t0": fmt.Sprint(t0), "t1": fmt.Sprint(t1), "_limit": fmt.Sprint(limit),
	})
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
	result := map[string]any{
		"events":  events,
		"counts":  counts,
		"blocked": blocked,
		"logged":  logged,
		"total":   len(rows),
	}
	s.Cache.Set(ck, result)
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

	policies := s.Rest.Get("/api/atcfw/v1/security_policies", map[string]string{"_limit": "100"})
	feeds := s.Rest.Get("/api/atcfw/v1/threat_feeds", map[string]string{"_limit": "100"})
	named := s.Rest.Get("/api/atcfw/v1/named_lists", map[string]string{"_limit": "100"})
	roaming := s.Rest.Get("/api/atcep/v1/roaming_devices", map[string]string{"_limit": "200"})
	anycast := s.Rest.Get("/api/anycast/v1/accm/ac_runtime_statuses", map[string]string{"_limit": "100"})
	dfp := s.Rest.Get("/api/atcdfp/v1/dfp_services", map[string]string{"_limit": "100"})
	hosts := s.Rest.Get("/api/infra/v1/detail_hosts", map[string]string{"_limit": "200"})

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
	hostInventory := map[string]any{
		"total":     len(hosts),
		"by_status": hostStatus.dict(),
		"hosts":     hostRows,
	}

	result := map[string]any{
		"threat_feeds":      threatFeeds,
		"named_lists":       namedLists,
		"security_policies": securityPolicies,
		"roaming_endpoints": roamingEndpoints,
		"anycast_ha":        anycastHA,
		"dfp_services":      dfpServices,
		"host_inventory":    hostInventory,
	}
	s.Cache.Set(ck, result)
	return result
}
