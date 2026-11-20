package dashboard

import "encoding/json"

// valuePlatformWindow is the window for every number on the Value page's
// platform section.
const valuePlatformWindow = "last 30 days"

// valuePlatformMetrics are the HostMetricsV1 series behind CSPValuePlatform.
// Each is read as ONE tenant-wide row (no host dimension), so the cube adds
// every host up itself and there is no host-by-host total whose completeness
// would have to be proven. Field is the measure shown: "sum_value" adds 30
// days of readings up (a count of things that happened), "avg_value" averages
// them (a share). Checked on the live demo tenant on 2026-11-20:
//   - total_query_count_iq: 720 hourly rows over 30 days, each the queries
//     answered in that hour (average 35,321 an hour). The 30-day sum was
//     25,431,226. Cross-check: dns_qps_iq averaged 9.958 a second, times
//     2,592,000 seconds = 25,811,387, within 1.5% of the sum.
//   - cache_hit_ratio_iq: 30 daily rows, 34.9-58.5, so 0-100 (not a 0-1
//     fraction); 30-day average 44.70.
var valuePlatformMetrics = []struct{ Key, Metric, Field, Unit string }{
	{"queries", "total_query_count_iq", "sum_value", "queries"},
	{"cache_hit", "cache_hit_ratio_iq", "avg_value", "percent"},
}

// DHCP addresses handed out would be the 30-day sum of
// dhcp_cumulative_assigned_addresses_iq, but is switched off until Infoblox
// says whether that number is a running total (review, 2026-11-20). Summing a
// running total would count the same addresses many times.
//
// What the demo tenant returned on 2026-11-20: only one row per host per day
// (granularity "day"; no hourly or 5-minute rows to show whether it resets
// within a day). Tenant-wide 30-day sum 5,744 over 185 rows from 9 hosts. The
// busiest host (03d0ff19...) read, by day: 0 0 0 1 0 175 341 359 368 339 334
// 348 328 342 333 321 291 264 277 296 190 0 0 0 0 1 0 0 0 0. dhcp_discover_iq
// for the same host was 3,600-6,014 a day (about 3,940 while assignments were
// about 340). The series falls as well as rises, so it is not a lifetime
// counter, but a day's value near 340 held for 16 days fits both "addresses
// handed out that day" and "addresses held at the time", and nothing in the
// cube metadata says which. Set this to true once that is confirmed.
var dhcpTotalConfirmed = false

const (
	dhcpMetric        = "dhcp_cumulative_assigned_addresses_iq"
	dhcpUnavailableWh = "Not available: Infoblox doesn't say whether this number is a running total."
)

// DNS server uptime is read from dns_status_iq, but is switched off until
// Infoblox confirms what that number measures (main chat's call, 2026-11-20).
//
// What the demo tenant returned for the last 30 days on 2026-11-20: 720
// hourly rows, all account-wide (no per-host rows), values from 90.95 to 100,
// average 97.70. Most common: 100 (150 hours), 95.6522 (121), 95.5072 (41),
// 99.8413 (38). It is not a 0/1 up/down sample, and the cube metadata does
// not say what it is. It looks like "percent of DNS servers up that hour",
// but 95.6522 = 22/23 while the tenant lists 19 DNS services, so that reading
// is not proven. Set this to true once the meaning is confirmed; the fetch,
// shaping (dnsHealthMetric) and tests are already in place.
var uptimeMeaningConfirmed = false

const (
	uptimeMetric        = "dns_status_iq"
	uptimeUnavailableWh = "Not available: Infoblox doesn't say what its DNS status number measures."
	roamingCube         = "B1EndpointsDailyV1"
	// payload_protection_count: "Count of distinct endpoints (payloads) that
	// were protected for any duration during the day" (cube meta). Over a
	// 30-day range with no granularity it counts distinct endpoints across the
	// whole window: 7 on the demo tenant on 2026-11-20.
	roamingMeasure = roamingCube + ".payload_protection_count"
)

// CSPValuePlatform is the Value page's "How the platform ran — 30 days"
// feed: how much work the DNS and DHCP platform did, and how well.
//
// Each number stands alone. A read that failed, or came back 200 with no
// result.data, is "error" with a null value ("not checked" on screen), never
// 0, and so is a row whose reading is missing, null or not a number. A read
// with no rows is "empty", also null. Uptime and DHCP are "unavailable" while
// their meaning is unconfirmed (see above), and
// roaming is "unavailable" when the tenant has no B1EndpointsDailyV1 cube.
func (s *Service) CSPValuePlatform() map[string]any {
	results := make([][]map[string]any, len(valuePlatformMetrics))
	var uptimeRows, dhcpRows, roamingRows []map[string]any
	tasks := make([]func(), 0, len(valuePlatformMetrics)+3)
	for i, m := range valuePlatformMetrics {
		tasks = append(tasks, func() { results[i] = s.hostMetricRows(m.Metric, false) })
	}
	if uptimeMeaningConfirmed {
		tasks = append(tasks, func() { uptimeRows = s.hostMetricRows(uptimeMetric, true) })
	}
	if dhcpTotalConfirmed {
		tasks = append(tasks, func() { dhcpRows = s.hostMetricRows(dhcpMetric, false) })
	}
	tasks = append(tasks, func() { roamingRows = s.roamingRows() })
	mustFanOut(tasks...)

	metrics := map[string]any{}
	for i, m := range valuePlatformMetrics {
		out := tenantReading(results[i], m.Field)
		out["metric"], out["unit"] = m.Metric, m.Unit
		metrics[m.Key] = out
	}

	dhcp := map[string]any{"status": "unavailable", "value": nil, "reason": dhcpUnavailableWh}
	if dhcpTotalConfirmed {
		dhcp = tenantReading(dhcpRows, "sum_value")
	}
	dhcp["metric"], dhcp["unit"] = dhcpMetric, "addresses"
	metrics["dhcp_assigned"] = dhcp

	var uptime map[string]any
	if uptimeMeaningConfirmed {
		var names map[string]string
		for _, r := range uptimeRows {
			if getStr(r["host"]) != "" {
				names = s.hostDisplayNames()
				break
			}
		}
		uptime = dnsHealthMetric(uptimeRows, names)
	} else {
		uptime = map[string]any{"status": "unavailable", "value": nil, "hosts": []map[string]any{}, "reason": uptimeUnavailableWh}
	}
	uptime["metric"], uptime["unit"] = uptimeMetric, "percent"
	metrics["uptime"] = uptime

	roaming := s.roamingMetric(roamingRows)
	roaming["metric"], roaming["unit"] = roamingMeasure, "devices"
	metrics["roaming"] = roaming

	ok, failed, total := 0, 0, 0
	for _, v := range metrics {
		switch v.(map[string]any)["status"] {
		case "ok":
			ok++
		case "error":
			failed++
		case "unavailable":
			continue
		}
		total++
	}
	status := "empty"
	switch {
	case total > 0 && failed == total:
		status = "error"
	case failed > 0:
		status = "partial"
	case ok > 0:
		status = "ok"
	}
	return map[string]any{"status": status, "window": valuePlatformWindow, "metrics": metrics}
}

// hostMetricRows reads one HostMetricsV1 series over the window: one
// tenant-wide row, or with perHost one row per host (blank host =
// account-wide). nil means the read failed.
func (s *Service) hostMetricRows(metric string, perHost bool) []map[string]any {
	query := map[string]any{
		"measures": []string{cubeHost + ".sum_value", cubeHost + ".avg_value", cubeHost + ".count_value"},
		"filters": []map[string]any{{
			"member": cubeHost + ".metric_name", "operator": "equals", "values": []string{metric}}},
		"timeDimensions": []map[string]any{{
			"dimension": cubeHost + ".timestamp", "dateRange": valuePlatformWindow}},
	}
	if perHost {
		query["dimensions"] = []string{cubeHost + ".host"}
	}
	q, _ := json.Marshal(query)
	body, st, err := s.Rest.GetEx("/api/cubejs/v1/query", map[string]string{"query": string(q)})
	if errored(st, err) {
		return nil
	}
	return strictCubeRows(body)
}

// tenantReading is one tenant-wide number from a query with no dimensions
// (nil rows = read failed). No rows is "empty". More than one row, or a row
// whose field is missing, null or not a number, is "error" ("not checked"):
// never a partial or zero total.
func tenantReading(rows []map[string]any, field string) map[string]any {
	if rows == nil || len(rows) > 1 {
		return map[string]any{"status": "error", "value": nil}
	}
	if len(rows) == 0 {
		return map[string]any{"status": "empty", "value": nil}
	}
	v := floatOrNil(rows[0][field])
	if v == nil {
		return map[string]any{"status": "error", "value": nil}
	}
	return map[string]any{"status": "ok", "value": v}
}

// roamingRows reads the count of protected roaming devices. nil = failed.
func (s *Service) roamingRows() []map[string]any {
	q, _ := json.Marshal(map[string]any{
		"measures": []string{roamingMeasure},
		"timeDimensions": []map[string]any{{
			"dimension": roamingCube + ".timestamp", "dateRange": valuePlatformWindow}},
	})
	body, st, err := s.Rest.GetEx("/api/cubejs/v1/query", map[string]string{"query": string(q)})
	if errored(st, err) {
		return nil
	}
	return strictCubeRows(body)
}

// roamingMetric shapes the roaming read. Cube.js answers a cube or measure the
// tenant doesn't have with the same bare 400 as any other bad query, so only
// after a failed read is the tenant's cube list consulted: a list that came
// back without the cube or measure means "unavailable"; anything else
// (including the list itself failing) stays "error", "not checked".
func (s *Service) roamingMetric(rows []map[string]any) map[string]any {
	if rows == nil {
		if cat, err := s.CubeCatalog(); err == nil {
			c, ok := cat.Cube(roamingCube)
			has := false
			for _, m := range c.Measures {
				has = has || m.Name == roamingMeasure
			}
			if !ok || !has {
				return map[string]any{"status": "unavailable", "value": nil, "reason": "Not available on this tenant."}
			}
		}
		return map[string]any{"status": "error", "value": nil}
	}
	// No dimensions, so the answer is one total row (or none).
	for _, r := range rows {
		if v := floatOrNil(r["payload_protection_count"]); v != nil {
			return map[string]any{"status": "ok", "value": v}
		}
	}
	return map[string]any{"status": "empty", "value": nil}
}
