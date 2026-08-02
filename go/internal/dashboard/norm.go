package dashboard

import (
	"math"
	"strings"
)

// normSubnets is norm_subnets (server.py:3201).
func normSubnets(raw []any) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		s := asMap(item)
		u := asMap(orAny(s["utilization"], s["dhcp_utilization"], map[string]any{}))
		// A row that does not report a capacity tells us nothing about its
		// capacity — it does NOT tell us the capacity is zero. The old
		// total=0/used=0/pct=0 default made every such subnet render as a
		// healthy, entirely-unused 0% row, indistinguishable from a genuinely
		// empty subnet that had actually been measured, and it took those rows
		// out of the exhaustion alerting silently.
		//
		// The test is whether a total was REPORTED, not whether a utilization
		// object exists, so an object that arrives carrying only `used` is
		// unknown rather than zero.
		//
		// Key PRESENCE is the test, not truthiness: orAny treats a reported
		// total of 0 as absent, which would turn a real measurement back into
		// an "unknown" — the opposite lie. A reported 0 is kept, including the
		// total != 0 guard that holds such a subnet at 0% rather than dividing
		// by zero.
		//
		// SCOPE, measured not assumed: on the live tenant today all 6,629
		// subnets report a total, so this changes nothing there. The 295 rows
		// sitting at 0% — every one IPv6 — were checked and they DO report
		// total=0; that is a real measurement and is left alone. This guards
		// the unreported case, which upstream is free to start returning.
		rawTotal, totalReported := firstPresent(u, "total", "total_count")
		var totalV, usedV, utilV any
		if totalReported {
			total := toInt(rawTotal)
			used := toInt(orAny(u["used"], u["used_count"], 0))
			pct := 0
			if total != 0 {
				pct = int(math.RoundToEven(float64(used) / float64(total) * 100))
			}
			totalV, usedV, utilV = total, used, pct
		}
		tags := asMap(s["tags"])
		cidr := s["cidr"]
		if cidr == nil {
			cidr = 0
		}
		out = append(out, map[string]any{
			"id":    idOf(s["id"]),
			"name":  orStr(s["name"], s["address"], ""),
			"addr":  orStr(s["address"], ""),
			"cidr":  cidr,
			"total": totalV,
			"used":  usedV,
			"util":  utilV,
			"site":  orStr(tags["site"], tags["location"], "–"),
		})
	}
	return out
}

// normLeases is norm_leases (server.py:3221).
func normLeases(raw []any) []map[string]any {
	active := map[string]bool{"used": true, "issued": true, "dynamic": true}
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		l := asMap(item)
		state := getStr(l["state"])
		mapped := "expired"
		if active[state] {
			mapped = "active"
		}
		hostname := strings.Trim(orStr(l["hostname"], l["client_id"], ""), `"`)
		out = append(out, map[string]any{
			"addr":      orStr(l["address"], ""),
			"host":      hostname,
			"subnet":    orStr(l["subnet_name"], ""),
			"subnet_id": "",
			"state":     mapped,
		})
	}
	return out
}

// normZones is norm_zones (server.py:3237).
func normZones(raw []any, viewMap map[string]string) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		z := asMap(item)
		za := asMap(z["zone_authority"])
		fqdn := orStr(z["fqdn"], z["name"], "")
		viewRef := getStr(z["view"])
		view := viewMap[viewRef]
		if view == "" {
			seg := viewRef
			if i := strings.LastIndex(viewRef, "/"); i >= 0 {
				seg = viewRef[i+1:]
			}
			if len(seg) > 12 {
				seg = seg[:12]
			}
			view = seg
			if view == "" {
				view = "default"
			}
		}
		// An unreported TTL used to default to 3600 — the single most plausible
		// real TTL there is — and that invented number was then run through the
		// three checks below, which it passes, so the zone was counted on the
		// clean side of "Zones w/ issues". An unreported TTL is now nil and the
		// checks are skipped outright: issues/anomaly stay nil so the zone is
		// neither asserted healthy nor accused of a problem.
		//
		// The test is whether default_ttl was REPORTED, not whether a
		// zone_authority object exists, so an authority block that omits the
		// TTL is unknown rather than 3600. Key presence, not truthiness: a
		// genuine TTL of 0 is a measurement and must survive as one.
		//
		// SCOPE, measured not assumed: on the live tenant all 1,542 zones
		// report a default_ttl, and the 121 sitting at exactly 3600 were
		// checked — they really do report 3600, which is the standard default.
		// Nothing on screen today changes; this guards the unreported case.
		rawTTL, ttlReported := firstPresent(za, "default_ttl")
		rawNegTTL, negTTLReported := firstPresent(za, "negative_ttl")
		// Each TTL is judged only if it was reported. An unreported one is not
		// evidence of a healthy value, so it contributes no issue and no
		// all-clear; a zone that reported neither is left entirely unjudged,
		// with issues/anomaly nil rather than an empty list that reads as
		// "checked and found clean".
		var ttlV, negTTLV, issuesV, anomalyV any
		issues := []any{}
		if ttlReported {
			ttl := toInt(rawTTL)
			ttlV = ttl
			if ttl < 60 {
				issues = append(issues, "TTL Too Low")
			}
			if ttl > 86400 {
				issues = append(issues, "TTL Too High")
			}
		}
		if negTTLReported {
			negTTL := toInt(rawNegTTL)
			negTTLV = negTTL
			if negTTL > 3600 {
				issues = append(issues, "High Neg-TTL")
			}
		}
		if ttlReported || negTTLReported {
			issuesV, anomalyV = issues, len(issues) > 0
		}
		out = append(out, map[string]any{
			"id":            idOf(z["id"]),
			"fqdn":          fqdn,
			"view":          view,
			"ttl":           ttlV,
			"neg_ttl":       negTTLV,
			"records":       0,
			"issues":        issuesV,
			"anomaly":       anomalyV,
			"dnssec_status": getStr(z["dnssec_status"]),
		})
	}
	return out
}

// normViews is norm_views (server.py:3263).
func normViews(raw []any) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		v := asMap(item)
		out = append(out, map[string]any{
			"id":      idOf(v["id"]),
			"name":    getStr(v["name"]),
			"comment": getStr(v["comment"]),
		})
	}
	return out
}

// normHosts is norm_hosts (server.py:3266).
func normHosts(raw []any) []map[string]any {
	statusMap := map[string]string{
		"online": "online", "active": "online",
		"degraded": "degraded",
		"offline":  "offline", "inactive": "offline",
		"error":   "error",
		"pending": "pending", "awaiting_provisioning": "pending",
	}
	typeMap := map[string]string{
		"dns": "DNS", "dhcp": "DHCP", "ntp": "NTP",
		"dfp": "Forwarder", "cdc": "Connector",
	}
	hostTypeMap := map[string]string{
		"bloxone_appliance": "Appliance", "bloxone_vm": "VM",
		"k8s": "K8s", "cloud": "Cloud",
	}
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		h := asMap(item)
		// Two different unknowns used to land on "pending": a host reporting no
		// status at all, and a host reporting a status this map has never heard
		// of. Neither means the host is awaiting provisioning — "pending" is a
		// real lifecycle state an operator acts on, so both fabricated a
		// specific, actionable claim out of an absence. Both now say so.
		rawStatus := orStr(h["composite_status"], asMap(h["connectivity_monitor"])["status"], "")
		status, ok := statusMap[strings.ToLower(rawStatus)]
		if !ok {
			status = "unknown"
		}
		configs := asSlice(h["configs"])
		var svcTypes []string
		for _, c := range configs {
			if st := getStr(asMap(c)["service_type"]); st != "" {
				svcTypes = append(svcTypes, st)
			}
		}
		htype := ""
		if len(svcTypes) > 0 {
			htype = typeMap[svcTypes[0]]
		}
		if htype == "" {
			ht, ok := hostTypeMap[strings.ToLower(getStr(h["host_type"]))]
			if ok {
				htype = ht
			} else {
				htype = "Host"
			}
		}
		out = append(out, map[string]any{
			"id":     idOf(h["id"]),
			"name":   orStr(h["display_name"], h["name"], ""),
			"ip":     orStr(h["ip_address"], ""),
			"type":   htype,
			"status": status,
		})
	}
	return out
}

// normPolicies is norm_policies (server.py:3302).
func normPolicies(raw []any) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		p := asMap(item)
		actionRaw := orStr(p["default_action"], p["action"], "action_allow")
		action := strings.ReplaceAll(actionRaw, "action_", "")
		rules := len(asSlice(orAny(p["rules"], p["rule_names"], p["network_lists"], []any{})))
		created := orStr(p["created_time"], "")
		if len(created) > 10 {
			created = created[:10]
		}
		isDefault, _ := p["is_default"].(bool)
		out = append(out, map[string]any{
			"id":      vToStr(orAny(p["id"], "")),
			"name":    getStr(p["name"]),
			"action":  action,
			"rules":   rules,
			"created": created,
			"active":  !isDefault,
		})
	}
	return out
}

// normFeeds is norm_feeds (server.py:3318).
func normFeeds(raw []any) []map[string]any {
	levels := map[string]string{"high": "critical", "medium": "high", "low": "medium"}
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		f := asMap(item)
		confLevel := strings.ToLower(orStr(f["confidence_level"], "MEDIUM"))
		threatLevel := strings.ToLower(getStr(f["threat_level"]))
		if threatLevel == "" {
			if v, ok := levels[confLevel]; ok {
				threatLevel = v
			} else {
				threatLevel = "medium"
			}
		}
		conf := confLevel
		if conf != "high" && conf != "medium" && conf != "low" {
			conf = "medium"
		}
		out = append(out, map[string]any{
			"id":      idOf(f["id"]),
			"name":    getStr(f["name"]),
			"level":   threatLevel,
			"conf":    conf,
			"cat":     orStr(f["type"], f["category"], "Mixed"),
			"entries": orAny(f["item_count"], f["items_described"], 0),
			// f.get("is_default") or not f.get("is_default", False) is always True.
			"active": true,
		})
	}
	return out
}

// auditClass is _audit_class (server.py:3335).
func auditClass(userName, subjectType string) string {
	u := strings.ToLower(userName)
	if strings.HasPrefix(u, "ngp.device") || subjectType == "Device" {
		return "device"
	}
	if strings.HasPrefix(u, "provider_id") || strings.HasPrefix(u, "service.") ||
		strings.HasPrefix(u, "federation") || subjectType == "Service" {
		return "service"
	}
	if strings.Contains(u, "@") {
		return "person"
	}
	if subjectType != "" {
		return strings.ToLower(subjectType)
	}
	return "other"
}

// normAudit is norm_audit (server.py:3348).
func normAudit(raw []any) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		l := asMap(item)
		userName := getStr(l["user_name"])
		subjectType := getStr(l["subject_type"])
		whoRole := ""
		if groups := asSlice(l["subject_groups"]); len(groups) > 0 {
			whoRole = getStr(groups[0])
		}
		// action and result are both three-state, not two. A record that carries
		// no http_code at all used to default to 200 here, so an entry whose
		// outcome was never recorded rendered as a confirmed green
		// "success" — indistinguishable from a verified 2xx. Now an absent
		// http_code yields "unknown": neither the fabricated success nor
		// the wrong-in-the-other-direction "failure". action was missed by that
		// fix and had exactly the same defect: with neither action nor
		// http_method present it defaulted to "READ", so an operation that was
		// never captured read as a harmless, verified lookup. It is "unknown"
		// too now. Note the literal lowercase — ToUpper is applied only to a
		// value that really came from upstream.
		action := "unknown"
		if a := orStr(l["action"], l["http_method"], ""); a != "" {
			action = strings.ToUpper(a)
		}
		result := "unknown"
		if isDigit(l["http_code"]) {
			code := toInt(l["http_code"])
			if code >= 400 {
				result = "failure"
			} else {
				result = "success"
			}
		}
		out = append(out, map[string]any{
			"id":       orStr(l["id"], ""),
			"ts":       orStr(l["created_at"], ""),
			"user":     orStr(l["user_name"], l["user_email"], l["subject_type"], ""),
			"who_kind": auditClass(userName, subjectType),
			"who_role": whoRole,
			"action":   action,
			"resource": orStr(l["resource_type"], ""),
			"result":   result,
		})
	}
	return out
}
