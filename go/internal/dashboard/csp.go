package dashboard

// CSP tile endpoints (server.py /api/csp/* 5741-5994 and /api/csp-audit 5143).
// These are read-only proxies: each fetches one or more Infoblox REST feeds
// through the shared rest.Client, runs the matching _norm_* shaper, and returns
// the exact response body Python emits — including the error/empty/ok status
// trichotomy. They live here (not a separate package) to reuse the coercion
// helpers (asMap/orStr/num/…) and normAudit that already back the /api/data
// shapers, so there is one implementation of each pattern, no duplication.

import (
	"encoding/json"
	"strconv"
	"strings"

	"bloxsmith/internal/rest"
)

// --- CSP-specific coercion helpers (mirror server.py 3367-3374/3449) ---------

// num is _num (server.py:3367): int(x) only when str(x) is all digits, else 0.
// isDigit/vToStr already render an integer-valued JSON float as "42" (no ".0"),
// so a JSON integer coerces exactly as Python's int does.
func num(v any) int {
	if isDigit(v) {
		return toInt(v)
	}
	return 0
}

// maskEmail is _mask_email (server.py:3371): PII guard keeping only the
// local-part before "@". Never emits a full email.
func maskEmail(v any) string {
	s := getStr(v)
	if i := strings.Index(s, "@"); i >= 0 {
		return s[:i]
	}
	return s
}

// toFloat parses a cube measure to float64, matching float(x or 0) with the
// TypeError/ValueError guard (server.py:3471-3474).
func toFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int:
		return float64(t)
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(t), 64); err == nil {
			return f
		}
	}
	return 0
}

// cubeRow is _cube_row (server.py:3449): cubejs rows are keyed "Cube.field";
// strip everything up to and including the first ".".
func cubeRow(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		if i := strings.Index(k, "."); i >= 0 {
			out[k[i+1:]] = v
		} else {
			out[k] = v
		}
	}
	return out
}

// strList returns body[key] when it is a JSON array, else [] (server.py:3501).
func strList(b any, key string) []any {
	if v, ok := asMap(b)[key].([]any); ok {
		return v
	}
	return []any{}
}

// cubeData pulls result.data (a list) from a cubejs response body.
func cubeData(body any) []any {
	if d, ok := asMap(asMap(body)["result"])["data"].([]any); ok {
		return d
	}
	return []any{}
}

// errored is the `http is None or http >= 400` sub-call gate (a network error
// yields status 0). Used per REST call across every tile below.
func errored(status int, err error) bool { return err != nil || status == 0 || status >= 400 }

// rowsResp builds the standard {rows,count,status} body with the ok/empty split.
func rowsResp(rows []map[string]any) map[string]any {
	st := "ok"
	if len(rows) == 0 {
		st = "empty"
	}
	return map[string]any{"rows": rows, "count": len(rows), "status": st}
}

func errRows() map[string]any {
	return map[string]any{"rows": []any{}, "count": 0, "status": "error"}
}

// --- shapers (server.py 3376-3528) ------------------------------------------

func normHostHealth(raw []any) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		h := asMap(item)
		out = append(out, map[string]any{
			"name":     getStr(h["display_name"]),
			"status":   getStr(h["composite_status"]),
			"version":  getStr(h["host_version"]),
			"ip":       getStr(h["ip_address"]),
			"nat_ip":   getStr(h["nat_ip"]),
			"location": getStr(h["location"]),
		})
	}
	return out
}

func normOnpremHosts(raw []any) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		h := asMap(item)
		appsIn := asSlice(h["applications"])
		apps := make([]any, 0, len(appsIn))
		for _, a := range appsIn {
			if m, ok := a.(map[string]any); ok {
				if n, has := m["name"]; has {
					apps = append(apps, n)
				} else {
					apps = append(apps, m)
				}
			} else {
				apps = append(apps, a)
			}
		}
		out = append(out, map[string]any{
			"name":      getStr(h["display_name"]),
			"ophid":     getStr(h["ophid"]),
			"app_count": len(appsIn),
			"apps":      apps,
		})
	}
	return out
}

func normJobs(raw []any) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		j := asMap(item)
		out = append(out, map[string]any{
			"id":         idOf(j["id"]),
			"created_at": getStr(j["created_at"]),
			"type":       orStr(j["task_type"], j["type"], ""),
			"status":     getStr(j["status"]),
			"user":       maskEmail(j["user_email"]), // PII: local-part only
		})
	}
	return out
}

func normDFP(raw []any) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		d := asMap(item)
		out = append(out, map[string]any{
			"id":     idOf(d["id"]),
			"name":   getStr(d["name"]),
			"status": orStr(d["status"], d["state"], ""),
		})
	}
	return out
}

func normDNSServices(raw []any) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		s := asMap(item)
		out = append(out, map[string]any{
			"id":      idOf(s["id"]),
			"name":    getStr(s["name"]),
			"comment": getStr(s["comment"]),
			"pool_id": getStr(s["pool_id"]),
		})
	}
	return out
}

func normCSPZones(raw []any) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		z := asMap(item)
		out = append(out, map[string]any{
			"id":      idOf(z["id"]),
			"fqdn":    getStr(z["fqdn"]),
			"view":    getStr(z["view"]),
			"comment": getStr(z["comment"]),
		})
	}
	return out
}

func normIpamUtil(raw []any) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		i := asMap(item)
		util := asMap(i["utilization"])
		out = append(out, map[string]any{
			"id":    idOf(i["id"]),
			"label": getStr(i["label"]),
			"used":  num(util["used"]),
			"total": num(util["total"]),
			"pct":   orAny(util["utilization"], util["percent"], util["pct"], ""),
		})
	}
	return out
}

func normDHCPLeases(raw []any) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		l := asMap(item)
		out = append(out, map[string]any{
			"address":  getStr(l["address"]),
			"hostname": getStr(l["hostname"]),
			"ends":     getStr(l["ends"]),
			"hardware": getStr(l["hardware"]),
			"state":    getStr(l["state"]),
		})
	}
	return out
}

func normThreats(raw []any) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		flat := cubeRow(asMap(item))
		out = append(out, map[string]any{
			"action":   getStr(flat["action"]),
			"day":      orStr(flat["timestamp"], flat["day"], ""),
			"requests": num(flat["requests"]),
		})
	}
	return out
}

func normDNSQps(raw []any) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		flat := cubeRow(asMap(item))
		out = append(out, map[string]any{
			"hour":      orStr(flat["timestamp"], flat["hour"], ""),
			"avg_value": toFloat(orAny(flat["avg_value"], 0)),
		})
	}
	return out
}

func normCtemExposure(stats, counts, matrix any) map[string]any {
	s, c, m := asMap(stats), asMap(counts), asMap(matrix)
	mrows := asSlice(m["matrix"])
	mat := make([]map[string]any, 0, len(mrows))
	for _, r := range mrows {
		mr := asMap(r)
		mat = append(mat, map[string]any{
			"severity": getStr(mr["severity"]),
			"priority": getStr(mr["priority"]),
			"count":    num(mr["count"]),
		})
	}
	hourly := []any{}
	for _, x := range asSlice(c["hourly_counts"]) {
		hourly = append(hourly, num(x))
	}
	return map[string]any{
		"total_exposures": num(orAny(c["count_7d"], c["count_24h"])),
		"count_24h":       num(c["count_24h"]),
		"count_7d":        num(c["count_7d"]),
		"count_30d":       num(c["count_30d"]),
		"hourly_counts":   hourly,
		"last_scan_at":    getStr(s["last_scan_at"]),
		"matrix":          mat,
	}
}

func normCtemAssets(providers, technologies, ports, count any) map[string]any {
	return map[string]any{
		"providers":    strList(providers, "providers"),
		"technologies": strList(technologies, "technologies"),
		"ports":        strList(ports, "ports"),
		"asset_count":  num(asMap(count)["count"]),
	}
}

func normSOC(insightTypes []any) []map[string]any {
	out := make([]map[string]any, 0, len(insightTypes))
	for _, item := range insightTypes {
		t := asMap(item)
		out = append(out, map[string]any{"id": idOf(t["id"]), "name": getStr(t["name"])})
	}
	return out
}

func normLicenseAlerts(licenses, alerts []any) ([]map[string]any, []map[string]any) {
	lic := make([]map[string]any, 0, len(licenses))
	for _, item := range licenses {
		l := asMap(item)
		lic = append(lic, map[string]any{
			"id":     idOf(l["id"]),
			"type":   orStr(l["license_type"], l["type"], ""),
			"state":  getStr(l["state"]),
			"expiry": orStr(l["expiration_date"], l["expiry"], ""),
		})
	}
	al := make([]map[string]any, 0, len(alerts))
	for _, item := range alerts {
		a := asMap(item)
		al = append(al, map[string]any{
			"id":         idOf(a["id"]),
			"title":      orStr(a["title"], a["message"], ""),
			"severity":   getStr(a["severity"]),
			"created_at": getStr(a["created_at"]),
		})
	}
	return lic, al
}

// --- tile handlers (return the full response body) --------------------------

func (s *Service) CSPHostHealth() map[string]any {
	body, st, err := s.Rest.GetEx("/api/infra/v1/detail_hosts", map[string]string{
		"_limit":  "500",
		"_fields": "display_name,composite_status,host_version,ip_address,nat_ip,location"})
	if errored(st, err) {
		return errRows()
	}
	return rowsResp(normHostHealth(rest.Unwrap(body)))
}

func (s *Service) CSPOnpremHosts() map[string]any {
	body, st, err := s.Rest.GetEx("/api/host_app/v1/on_prem_hosts",
		map[string]string{"_fields": "display_name,ophid,applications"})
	if errored(st, err) {
		return errRows()
	}
	return rowsResp(normOnpremHosts(rest.Unwrap(body)))
}

func (s *Service) CSPJobs() map[string]any {
	body, st, err := s.Rest.GetEx("/atlas-jobs-tasks/v1/jobs",
		map[string]string{"_limit": "50", "_filter": "origin=='0'"})
	if errored(st, err) {
		return errRows()
	}
	return rowsResp(normJobs(rest.Unwrap(body)))
}

func (s *Service) CSPDFP() map[string]any {
	body, st, err := s.Rest.GetEx("/api/atcdfp/v1/dfp_services", nil)
	if errored(st, err) {
		return errRows()
	}
	return rowsResp(normDFP(rest.Unwrap(body)))
}

func (s *Service) CSPMaintenance() map[string]any {
	body, st, err := s.Rest.GetEx("/atlas-maintenance-service/v1/check_global", nil)
	if errored(st, err) {
		return map[string]any{"enabled": false, "status": "error"}
	}
	return map[string]any{"enabled": truthy(asMap(body)["enabled"]), "status": "ok"}
}

func (s *Service) CSPThreats() map[string]any {
	q, _ := json.Marshal(map[string]any{
		"measures":   []string{"PortunusAggThreat_ch.requests"},
		"dimensions": []string{"PortunusAggThreat_ch.action"},
		"timeDimensions": []map[string]any{{
			"dimension": "PortunusAggThreat_ch.timestamp",
			"dateRange": "last 7 days", "granularity": "day"}},
	})
	body, st, err := s.Rest.GetEx("/api/cubejs-security/v1/query", map[string]string{"query": string(q)})
	if errored(st, err) {
		return errRows()
	}
	return rowsResp(normThreats(cubeData(body)))
}

func (s *Service) CSPDNSQps() map[string]any {
	q, _ := json.Marshal(map[string]any{
		"measures": []string{"HostMetrics.avg_value"},
		"filters": []map[string]any{{
			"member": "HostMetrics.metric_name", "operator": "equals",
			"values": []string{"dns_qps_iq"}}},
		"timeDimensions": []map[string]any{{
			"dimension": "HostMetrics.timestamp",
			"dateRange": "last 24 hours", "granularity": "hour"}},
	})
	body, st, err := s.Rest.GetEx("/api/cubejs/v1/query", map[string]string{"query": string(q)})
	if errored(st, err) {
		return errRows()
	}
	return rowsResp(normDNSQps(cubeData(body)))
}

func (s *Service) CSPDNSServices() map[string]any {
	body, st, err := s.Rest.GetEx("/api/ddi/v1/dns/service", map[string]string{"_limit": "200"})
	if errored(st, err) {
		return errRows()
	}
	return rowsResp(normDNSServices(rest.Unwrap(body)))
}

func (s *Service) CSPZones() map[string]any {
	body, st, err := s.Rest.GetEx("/api/ddi/v1/dns/zone_child",
		map[string]string{"_limit": "500", "_filter": `flat=="false"`})
	if errored(st, err) {
		return errRows()
	}
	return rowsResp(normCSPZones(rest.Unwrap(body)))
}

func (s *Service) CSPIpamUtil() map[string]any {
	body, st, err := s.Rest.GetEx("/api/ddi/v1/ipam/htree",
		map[string]string{"view": "SPACE", "_limit": "500", "_fields": "id,label,utilization"})
	if errored(st, err) {
		return errRows()
	}
	return rowsResp(normIpamUtil(rest.Unwrap(body)))
}

func (s *Service) CSPDHCPLeases() map[string]any {
	body, st, err := s.Rest.GetEx("/api/ddi/v1/dhcp/lease",
		map[string]string{"_limit": "200", "_fields": "address,hostname,ends,hardware,state"})
	if errored(st, err) {
		return errRows()
	}
	return rowsResp(normDHCPLeases(rest.Unwrap(body)))
}

// CSPCtemExposure merges 3 sub-calls; any sub-error → status=error.
func (s *Service) CSPCtemExposure() map[string]any {
	statsB, statsH, e1 := s.Rest.GetEx("/api/attack-surface/v1/account/stats", nil)
	expB, expH, e2 := s.Rest.GetEx("/api/attack-surface/v1/exposures/metrics/counts-by-period", nil)
	matB, matH, e3 := s.Rest.GetEx("/api/attack-surface/v1/exposures/metrics/severity-priority-matrix", nil)
	if errored(statsH, e1) || errored(expH, e2) || errored(matH, e3) {
		return map[string]any{"data": map[string]any{}, "status": "error"}
	}
	data := normCtemExposure(statsB, expB, matB)
	st := "empty"
	if num(data["total_exposures"]) != 0 || len(data["matrix"].([]map[string]any)) > 0 {
		st = "ok"
	}
	return map[string]any{"data": data, "status": st}
}

// CSPCtemAssets merges 4 sub-calls; any sub-error → status=error.
func (s *Service) CSPCtemAssets() map[string]any {
	provB, provH, e1 := s.Rest.GetEx("/api/attack-surface/v1/providers", nil)
	techB, techH, e2 := s.Rest.GetEx("/api/attack-surface/v1/technologies", nil)
	portB, portH, e3 := s.Rest.GetEx("/api/attack-surface/v1/ports", nil)
	cntB, cntH, e4 := s.Rest.GetEx("/api/attack-surface/v1/assets/count", map[string]string{"period": "7d"})
	if errored(provH, e1) || errored(techH, e2) || errored(portH, e3) || errored(cntH, e4) {
		return map[string]any{"data": map[string]any{}, "status": "error"}
	}
	data := normCtemAssets(provB, techB, portB, cntB)
	st := "empty"
	if num(data["asset_count"]) != 0 || len(data["providers"].([]any)) > 0 {
		st = "ok"
	}
	return map[string]any{"data": data, "status": st}
}

// CSPSoc gates on soc_enforcement_enabled, then fetches insight types.
func (s *Service) CSPSoc() map[string]any {
	gateB, gateH, ge := s.Rest.GetEx("/api/ris/v1/internal/soc_enforcement_enabled", nil)
	if errored(gateH, ge) {
		return map[string]any{"rows": []any{}, "count": 0, "enabled": false, "status": "error"}
	}
	enabled := truthy(asMap(gateB)["enabled"])
	typesB, typesH, te := s.Rest.GetEx("/api/ris/v1/insights/types", nil)
	if errored(typesH, te) {
		return map[string]any{"rows": []any{}, "count": 0, "enabled": enabled, "status": "error"}
	}
	tm := asMap(typesB)
	raw := orAny(tm["insightTypes"], tm["results"], tm["result"], []any{})
	types := normSOC(asSlice(raw))
	st := "ok"
	if len(types) == 0 {
		st = "empty"
	}
	return map[string]any{"rows": types, "count": len(types), "enabled": enabled, "status": st}
}

// CSPLicenseAlerts merges licenses + user_alerts; any sub-error → status=error.
func (s *Service) CSPLicenseAlerts() map[string]any {
	licB, licH, le := s.Rest.GetEx("/licensing/v1/licenses", map[string]string{"state": "all"})
	alB, alH, ae := s.Rest.GetEx("/atlas-notifications-mailbox/v1/user_alerts", nil)
	if errored(licH, le) || errored(alH, ae) {
		return map[string]any{"licenses": []any{}, "alerts": []any{}, "status": "error"}
	}
	lic, al := normLicenseAlerts(rest.Unwrap(licB), rest.Unwrap(alB))
	st := "empty"
	if len(lic) > 0 || len(al) > 0 {
		st = "ok"
	}
	return map[string]any{"licenses": lic, "alerts": al, "status": st}
}

// --- /api/csp-audit (server.py:5143) ----------------------------------------

// cspAuditMachine are the machine-token username prefixes (server.py:5168).
var cspAuditMachine = []string{"provider_id", "ngp.device", "service.", "federation", "test."}

// isoAllowed accepts only ISO-ish created_at values (server.py:5177): digits,
// T, Z, colon, dash, dot. Anything else is rejected to "".
func isoAllowed(v string) string {
	if v == "" {
		return ""
	}
	for _, c := range v {
		if !strings.ContainsRune("0123456789TZ:-.", c) {
			return ""
		}
	}
	return v
}

// CSPAudit is the on-demand audit-log search (server.py:5143). q/kind/since/
// until go into a _filter EXPRESSION; every user value is neutralised by
// rest.Lit (strip \ and ") since it lands inside a double-quoted literal.
func (s *Service) CSPAudit(q, kind, since, until string) map[string]any {
	q, kind, since, until = strings.TrimSpace(q), strings.TrimSpace(kind), strings.TrimSpace(since), strings.TrimSpace(until)
	var clauses []string
	if q != "" {
		clauses = append(clauses, "(user_name~"+rest.Lit(q)+" or resource_type~"+rest.Lit(q)+")")
	}
	switch kind {
	case "people":
		for _, pref := range cspAuditMachine {
			clauses = append(clauses, "not user_name~"+rest.Lit(pref))
		}
	case "machines":
		ors := make([]string, len(cspAuditMachine))
		for i, p := range cspAuditMachine {
			ors[i] = "user_name~" + rest.Lit(p)
		}
		clauses = append(clauses, "("+strings.Join(ors, " or ")+")")
	}
	if v := isoAllowed(since); v != "" {
		clauses = append(clauses, "created_at>="+rest.Lit(v))
	}
	if v := isoAllowed(until); v != "" {
		clauses = append(clauses, "created_at<="+rest.Lit(v))
	}
	params := map[string]string{"_limit": "500", "_order_by": "created_at desc"}
	if len(clauses) > 0 {
		params["_filter"] = strings.Join(clauses, " and ")
	}
	body, st, err := s.Rest.GetEx("/api/auditlog/v1/logs", params)
	if errored(st, err) {
		return map[string]any{"rows": []any{}, "count": 0, "truncated": false, "status": "error"}
	}
	rows := normAudit(rest.Unwrap(body))
	return map[string]any{"rows": rows, "count": len(rows),
		"truncated": len(rows) >= 500, "status": "ok"}
}
