package dashboard

import "math"

// DHCP requests (the Network tab's DHCP Requests panel): how many DHCP
// DISCOVER messages the servers saw, and how many requests got no address,
// each as a total for Today and for the Last 30 days.
//
// Both come from HostMetricsV1, one metric_name per query (as CSPDNSHealth).
// Checked on the live demo tenant on 2026-11-20:
//   - Both are counts per 5-minute sample, not rates. All 50,000 sampled
//     dhcp_discover_iq readings were whole numbers (largest 164), and adding
//     the 5-minute rows gave the same total as adding the hourly rows for
//     yesterday (13,575 both ways), which a rate would not. 8,629 of 8,640
//     dhcp_demand_gap_iq readings were whole; the other 11 were halves and
//     thirds. So sum_value is the total.
//   - The cube keeps several copies of each series at different steps
//     ("minute", which is the 5-minute samples, "hour" and "day") and, with no
//     granularity filter, picks one by itself: the 5-minute rows for Today but
//     the day rows for the last 30 days. The day rows disagreed with the other
//     two (12,560 against 13,575 for yesterday), so every read is pinned to the
//     5-minute rows, which go back the full 30 days.
//   - dhcp_discover_iq is per host; dhcp_demand_gap_iq has one account-wide
//     row (blank host). Today they were 12,483 and 12,475.

var dhcpRequestMetrics = []struct{ Key, Metric string }{
	{"discover", "dhcp_discover_iq"},
	{"no_address", "dhcp_demand_gap_iq"},
}

var dhcpRequestWindows = []struct{ Key, Range string }{
	{"today", "today"},
	{"last_30_days", "last 30 days"},
}

// dhcpRequestTotal adds one read's rows. nil rows (the read failed) is
// "error"; no rows, or any row without a reading, is "empty", because adding
// up only the rows that have one would show a total that is too low. Both are
// a null value, never 0.
func dhcpRequestTotal(rows []map[string]any) map[string]any {
	if rows == nil {
		return map[string]any{"status": "error", "value": nil}
	}
	if len(rows) == 0 {
		return map[string]any{"status": "empty", "value": nil}
	}
	var sum float64
	for _, r := range rows {
		v, ok := floatOrNil(r["sum_value"]).(float64)
		if !ok || math.IsNaN(v) || math.IsInf(v, 0) {
			return map[string]any{"status": "empty", "value": nil}
		}
		sum += v
	}
	return map[string]any{"status": "ok", "value": sum}
}

// CSPDHCPRequests reads each metric for each window at once (four reads).
// Each total stands alone: one that failed says so and the rest are shown.
func (s *Service) CSPDHCPRequests() map[string]any {
	n := len(dhcpRequestWindows)
	results := make([][]map[string]any, len(dhcpRequestMetrics)*n)
	tasks := make([]func(), len(results))
	for i, m := range dhcpRequestMetrics {
		for j, w := range dhcpRequestWindows {
			tasks[i*n+j] = func() {
				results[i*n+j], _ = s.cubeRowsStrict(map[string]any{
					"measures": []string{cubeHost + ".sum_value", cubeHost + ".count_value"},
					"filters": []map[string]any{{
						"member": cubeHost + ".metric_name", "operator": "equals",
						"values": []string{m.Metric}}, hostTier("minute")},
					"timeDimensions": []map[string]any{{
						"dimension": cubeHost + ".timestamp", "dateRange": w.Range}},
				})
			}
		}
	}
	mustFanOut(tasks...)

	metrics := map[string]any{}
	ok, failed := 0, 0
	for i, m := range dhcpRequestMetrics {
		out := map[string]any{"metric": m.Metric}
		for j, w := range dhcpRequestWindows {
			t := dhcpRequestTotal(results[i*n+j])
			switch t["status"] {
			case "ok":
				ok++
			case "error":
				failed++
			}
			out[w.Key] = t
		}
		metrics[m.Key] = out
	}
	status := "empty"
	switch {
	case failed == len(results):
		status = "error"
	case failed > 0:
		status = "partial"
	case ok > 0:
		status = "ok"
	}
	return map[string]any{"status": status, "metrics": metrics}
}
