package dashboard

import "strings"

// normSubnets is norm_subnets (server.py:3201).
func normSubnets(raw []any) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		s := asMap(item)
		u := asMap(orAny(s["utilization"], s["dhcp_utilization"], map[string]any{}))
		total := toInt(orAny(u["total"], u["total_count"], 0))
		used := toInt(orAny(u["used"], u["used_count"], 0))
		pct := 0
		if total != 0 {
			pct = roundHalfEven(float64(used) / float64(total) * 100)
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
			"total": total,
			"used":  used,
			"util":  pct,
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
		ttl := toInt(orAny(za["default_ttl"], 3600))
		negTTL := toInt(orAny(za["negative_ttl"], 3600))
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
		issues := []any{}
		if ttl < 60 {
			issues = append(issues, "TTL Too Low")
		}
		if ttl > 86400 {
			issues = append(issues, "TTL Too High")
		}
		if negTTL > 3600 {
			issues = append(issues, "High Neg-TTL")
		}
		out = append(out, map[string]any{
			"id":      idOf(z["id"]),
			"fqdn":    fqdn,
			"view":    view,
			"ttl":     ttl,
			"neg_ttl": negTTL,
			"records": 0,
			"issues":  issues,
			"anomaly": len(issues) > 0,
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
		rawStatus := orStr(h["composite_status"], asMap(h["connectivity_monitor"])["status"], "pending")
		status, ok := statusMap[strings.ToLower(rawStatus)]
		if !ok {
			status = "pending"
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
		action := strings.ToUpper(orStr(l["action"], l["http_method"], "READ"))
		code := 200
		if isDigit(l["http_code"]) {
			code = toInt(l["http_code"])
		}
		result := "success"
		if code >= 400 {
			result = "failure"
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
