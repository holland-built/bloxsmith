package dashboard

import (
	"math"
	"time"
)

// Failed DNS lookups over a chosen window (the Dns tab's Failed Lookups
// panel): the total, split by response code, and the ten names that failed
// most.
//
// Two sources, picked by how far back the window reaches. Both were checked
// against /api/cubejs/v1/meta and live data on the demo tenant on 2026-11-20:
//   - NetworkInsightsDnsRawLogsV1 (the old name without V1 is deprecated)
//     stores failed lookups only, one row per failure, and keeps about three
//     days: its oldest row that day was 2026-11-17 00:00 UTC. The count is
//     failedTransactionCount.
//   - DnsActivityV1 is the query logs, every lookup. Its own notes say a
//     failure is rcode notEquals 0; the count is total_query_count.
//
// For Today and Yesterday the two agreed to the lookup (NXDOMAIN 532,584 and
// 534,204 from both). For This week the failure records came up short (2.12
// million NXDOMAIN against 2.68 million in the query logs) because their
// first days had already gone, which is why a window reaching past
// rawLogsReach reads the query logs.

// DNSFailureWindows are the windows the route accepts, as Cube.js relative
// date ranges. Anything else is refused before a query is made.
var DNSFailureWindows = []string{"today", "yesterday", "this week", "last 30 days"}

// ValidDNSFailureWindow reports whether w is one of DNSFailureWindows.
func ValidDNSFailureWindow(w string) bool {
	for _, v := range DNSFailureWindows {
		if v == w {
			return true
		}
	}
	return false
}

const (
	cubeFailedDNS = "NetworkInsightsDnsRawLogsV1"
	cubeQueryLogs = "DnsActivityV1"

	srcFailureRecords = "failure_records"
	srcQueryLogs      = "query_logs"
)

// rawLogsReach is how far back the failure records are trusted to reach.
const rawLogsReach = 72 * time.Hour

// dnsFailuresNow is the clock the source choice reads; tests replace it.
var dnsFailuresNow = time.Now

// dnsFailureWindowStart is where Cube.js starts window, in UTC (the queries
// send no timezone). Checked live on 2026-11-20: "this week" began on Monday
// 2026-11-16, and "last 30 days" ran 2026-10-21 to 2026-11-19, so it starts
// 30 days before today and leaves today out.
func dnsFailureWindowStart(window string, now time.Time) time.Time {
	now = now.UTC()
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	switch window {
	case "today":
		return day
	case "yesterday":
		return day.AddDate(0, 0, -1)
	case "this week":
		return day.AddDate(0, 0, -((int(day.Weekday()) + 6) % 7))
	default:
		return day.AddDate(0, 0, -30)
	}
}

// dnsFailureSource picks the failure records when the whole window lies
// within rawLogsReach of now, and the query logs otherwise.
func dnsFailureSource(window string, now time.Time) string {
	if now.Sub(dnsFailureWindowStart(window, now)) <= rawLogsReach {
		return srcFailureRecords
	}
	return srcQueryLogs
}

// dnsFailureQuery is one read against source: the failure count grouped by
// dim, biggest first, with at most limit rows (0 = no limit).
func dnsFailureQuery(source, window, dim string, limit int) map[string]any {
	cube, measure := cubeFailedDNS, "failedTransactionCount"
	if source == srcQueryLogs {
		cube, measure = cubeQueryLogs, "total_query_count"
	}
	q := map[string]any{
		"measures":       []string{cube + "." + measure},
		"dimensions":     []string{cube + "." + dim},
		"timeDimensions": []map[string]any{{"dimension": cube + ".timestamp", "dateRange": window}},
		"order":          map[string]any{cube + "." + measure: "desc"},
	}
	if source == srcQueryLogs {
		q["filters"] = []map[string]any{{"member": cube + ".rcode", "operator": "notEquals", "values": []string{"0"}}}
	}
	if limit > 0 {
		q["limit"] = limit
	}
	return q
}

// failCount is a row's failure count from either source, or nil.
func failCount(r map[string]any) any {
	if v, ok := r["failedTransactionCount"]; ok {
		return floatOrNil(v)
	}
	return floatOrNil(r["total_query_count"])
}

// readableRcode reports whether a row's response code is a whole number. A
// missing or garbled code could belong to any group.
func readableRcode(rcode any) bool {
	v, ok := floatOrNil(rcode).(float64)
	return ok && v >= 0 && !math.IsInf(v, 0) && v == math.Trunc(v)
}

// dnsFailureCodeKey files a readable response code under the panel's four
// groups; a code other than 2, 3 or 5 is Other.
func dnsFailureCodeKey(rcode any) string {
	switch floatOrNil(rcode) {
	case 2.0:
		return "servfail"
	case 3.0:
		return "nxdomain"
	case 5.0:
		return "refused"
	}
	return "other"
}

// dnsFailureCodes adds the per-code rows into the four groups and the total.
// A group with a row whose count is missing is nil ("couldn't tell"), and so
// is the total. No rows at all is nil throughout too, because it can mean
// nothing failed or that DNS logging sent nothing. So is any row whose code
// can't be read, since its count could belong to any group. When other rows
// were read, a group with no rows of its own is a real 0.
func dnsFailureCodes(rows []map[string]any) (map[string]any, any) {
	codes := map[string]any{"servfail": nil, "nxdomain": nil, "refused": nil, "other": nil}
	if len(rows) == 0 {
		return codes, nil
	}
	for _, r := range rows {
		if !readableRcode(r["rcode"]) {
			return codes, nil
		}
	}
	sums := map[string]float64{}
	unknown := map[string]bool{}
	for _, r := range rows {
		k := dnsFailureCodeKey(r["rcode"])
		v, ok := failCount(r).(float64)
		if !ok {
			unknown[k] = true
			continue
		}
		sums[k] += v
	}
	var total any = 0.0
	for k := range codes {
		if unknown[k] {
			total = nil
			continue
		}
		codes[k] = sums[k]
		if t, ok := total.(float64); ok {
			total = t + sums[k]
		}
	}
	return codes, total
}

// CSPDNSFailures is the Failed Lookups panel for window (one of
// DNSFailureWindows; the route refuses anything else). Two reads at once: the
// count by response code, which also gives the total, and the top ten names.
//
// A read that failed, or answered 200 without result.data, is "error" with
// nulls, which the screen shows as "not checked", never 0. The by-code read
// carries the total, so when it fails the whole answer is "error" (and is not
// cached); when only the names fail it is "partial".
func (s *Service) CSPDNSFailures(window string) map[string]any {
	source := dnsFailureSource(window, dnsFailuresNow())
	var codeRows, nameRows []map[string]any
	mustFanOut(
		func() { codeRows, _ = s.cubeRowsStrict(dnsFailureQuery(source, window, "rcode", 0)) },
		func() { nameRows, _ = s.cubeRowsStrict(dnsFailureQuery(source, window, "qname", 10)) },
	)

	codes, total := dnsFailureCodes(codeRows)
	codesStatus := "ok"
	if codeRows == nil {
		codesStatus = "error"
	}
	// names stays a plain nil (JSON null) when its read failed.
	var names any
	namesStatus := "error"
	if nameRows != nil {
		namesStatus = "ok"
		list := make([]map[string]any, 0, len(nameRows))
		for _, r := range nameRows {
			list = append(list, map[string]any{"name": getStr(r["qname"]), "count": failCount(r)})
		}
		names = list
	}

	status := "ok"
	switch {
	case codesStatus == "error":
		status = "error"
	case namesStatus == "error":
		status = "partial"
	case len(codeRows) == 0 && len(nameRows) == 0:
		status = "empty"
	}
	return map[string]any{
		"status": status, "window": window, "source": source,
		"total": total, "codes": codes, "codes_status": codesStatus,
		"names": names, "names_status": namesStatus,
	}
}
