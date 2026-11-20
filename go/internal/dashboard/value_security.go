package dashboard

import (
	"encoding/json"
	"time"
)

// The Value page's security section: what Infoblox stopped in the last 30
// days, as three totals. Cubes, measures and time fields were checked against
// /api/cubejs/v1/meta and by live read-only queries on the demo tenant on
// 2026-11-20:
//
//   - blocked: PortunusAggThreat_ch.requests with action Block (the meta says
//     Block includes Redirect), on timestamp. The same cube CSPThreats reads,
//     through the same security-then-main fallback (cubeGet). It counts threat
//     feed matches and custom policy / content filtering blocks together, as
//     the Security tab does. The meta marks this cube deprecated (successor
//     ThreatAggV1, sunset 2028-09-25), which is why it is not looked up in the
//     catalog: the catalog leaves deprecated cubes out.
//   - zero_day: ZDDReclassifiedV1.totalIndicators (distinct domains) on
//     firstSeenDim, the field its meta names for the reporting window. Its
//     meta also says it holds no data on when other feeds listed a domain, so
//     "how many days earlier than other feeds" is not offered.
//   - sus_to_mal: SusToMalAggV1.indicatorCount (distinct indicators) on
//     reclassified_time, the field its meta says to filter time on, and
//     avgTimeAdvantageMinutes, the average minutes between first being seen
//     as Suspicious and being reclassified.
//
// "last 30 days" in Cube.js is the 30 whole days (UTC) that end yesterday:
// live, 2026-10-21 to 2026-11-19 on 2026-11-20. The blocked trend compares it
// with the 30 whole days before, sent as explicit dates. The cube does not
// always reach that far back: on the demo tenant on 2026-11-20 its first day
// was 2026-10-14, so the earlier window held 7 days (122,733 blocked against
// 393,407) and a trend would have read "up 221%". So a third read lists the
// days the cube holds, and each window is checked against it
// (windowCoverage): a current window not fully held keeps its number with
// covered false and the days it does hold (days_from, days_to), and an
// earlier window not fully held gives no trend (previous_status "partial").
const valueWindow = "last 30 days"

// valueNow is the clock the previous window is counted back from.
var valueNow = time.Now

// CSPValueSecurity is GET /api/csp/value-security. Each number stands alone:
// a read that failed, or came back without result.data, is "error" with a null
// value (the screen says "not checked"), and the others are still shown. A
// cube the tenant's catalog does not list is "unavailable". A read that
// answered with no row or a null reading is "empty", also null, never 0.
func (s *Service) CSPValueSecurity() map[string]any {
	// The catalog only says whether the two newer cubes exist and which
	// service answers them. If it could not be fetched, they are queried
	// anyway on the main service, where the demo tenant lists them.
	zddEndpoint, susEndpoint := cubeEndpoint, cubeEndpoint
	zddListed, susListed := true, true
	if cat, err := s.CubeCatalog(); err == nil {
		c, ok := cat.Cube("ZDDReclassifiedV1")
		zddListed, zddEndpoint = ok, endpointOr(c.endpoint)
		c, ok = cat.Cube("SusToMalAggV1")
		susListed, susEndpoint = ok, endpointOr(c.endpoint)
	}

	today := valueNow().UTC().Truncate(24 * time.Hour)
	prevRange := []string{day(today, -60), day(today, -31)}
	blockedQuery := func(dateRange any) map[string]any {
		return map[string]any{
			"measures": []string{"PortunusAggThreat_ch.requests"},
			"filters": []map[string]any{{
				"member": "PortunusAggThreat_ch.action", "operator": "equals", "values": []string{"Block"}}},
			"timeDimensions": []map[string]any{{
				"dimension": "PortunusAggThreat_ch.timestamp", "dateRange": dateRange}},
		}
	}
	// Which days the cube holds at all, Block or Allow, over both windows:
	// the proof that a total covers its whole window (blockedCoverage).
	coverageQuery := map[string]any{
		"measures": []string{"PortunusAggThreat_ch.requests"},
		"timeDimensions": []map[string]any{{
			"dimension": "PortunusAggThreat_ch.timestamp", "granularity": "day",
			"dateRange": []string{prevRange[0], day(today, -1)}}},
	}

	var blocked, previous, held, zdd, sus []map[string]any
	read := func(endpoint string, q map[string]any, out *[]map[string]any) func() {
		return func() {
			qj, _ := json.Marshal(q)
			body, st, err := s.cubeGet(endpoint, qj)
			if errored(st, err) {
				return
			}
			*out = strictCubeRows(body)
		}
	}
	tasks := []func(){
		read(cubeSecurityEndpoint, blockedQuery(valueWindow), &blocked),
		read(cubeSecurityEndpoint, blockedQuery(prevRange), &previous),
		read(cubeSecurityEndpoint, coverageQuery, &held),
	}
	if zddListed {
		tasks = append(tasks, read(zddEndpoint, map[string]any{
			"measures": []string{"ZDDReclassifiedV1.totalIndicators"},
			"timeDimensions": []map[string]any{{
				"dimension": "ZDDReclassifiedV1.firstSeenDim", "dateRange": valueWindow}},
		}, &zdd))
	}
	if susListed {
		tasks = append(tasks, read(susEndpoint, map[string]any{
			"measures": []string{"SusToMalAggV1.indicatorCount", "SusToMalAggV1.avgTimeAdvantageMinutes"},
			"timeDimensions": []map[string]any{{
				"dimension": "SusToMalAggV1.reclassified_time", "dateRange": valueWindow}},
		}, &sus))
	}
	mustFanOut(tasks...)

	b := valueMetric(blocked, "requests")
	days := heldDays(held)
	cur := windowCoverage(days, day(today, -30), day(today, -1))
	b["covered"], b["days_from"], b["days_to"] = cur.covered, cur.from, cur.to
	b["window_range"] = []string{day(today, -30), day(today, -1)}
	b["previous"], b["previous_status"] = nil, "error"
	if prev := valueMetric(previous, "requests"); prev["status"] == "ok" {
		switch c := windowCoverage(days, prevRange[0], prevRange[1]).covered; c {
		case true:
			b["previous"], b["previous_status"] = prev["value"], "ok"
		case false:
			b["previous_status"] = "partial"
		}
	}
	b["previous_range"] = prevRange
	b["measure"] = "PortunusAggThreat_ch.requests"

	z := unavailableMetric()
	if zddListed {
		z = valueMetric(zdd, "totalIndicators")
	}
	z["measure"] = "ZDDReclassifiedV1.totalIndicators"

	m := unavailableMetric()
	if susListed {
		m = valueMetric(sus, "indicatorCount")
		m["ahead_minutes"] = valueMetric(sus, "avgTimeAdvantageMinutes")["value"]
	}
	m["measure"] = "SusToMalAggV1.indicatorCount"

	metrics := map[string]any{"blocked": b, "zero_day": z, "sus_to_mal": m}
	ok, failed := 0, 0
	for _, x := range metrics {
		switch asMap(x)["status"] {
		case "ok":
			ok++
		case "error":
			failed++
		}
	}
	status := "empty"
	switch {
	case failed == len(metrics):
		status = "error"
	case failed > 0:
		status = "partial"
	case ok > 0:
		status = "ok"
	}
	return map[string]any{"status": status, "window": valueWindow, "metrics": metrics}
}

func endpointOr(e string) string {
	if e == "" {
		return cubeEndpoint
	}
	return e
}

func unavailableMetric() map[string]any {
	return map[string]any{"status": "unavailable", "value": nil}
}

// valueMetric reads one measure from a one-row total (rows nil = the read
// failed). A measure missing from the row, or not a number, is a bad answer
// ("error"); a null reading or no row at all is "empty". Both stay null.
func valueMetric(rows []map[string]any, measure string) map[string]any {
	if rows == nil {
		return map[string]any{"status": "error", "value": nil}
	}
	if len(rows) == 0 {
		return map[string]any{"status": "empty", "value": nil}
	}
	raw, present := rows[0][measure]
	if present && raw == nil {
		return map[string]any{"status": "empty", "value": nil}
	}
	v := floatOrNil(raw)
	if v == nil {
		return map[string]any{"status": "error", "value": nil}
	}
	return map[string]any{"status": "ok", "value": v}
}

func day(t time.Time, offset int) string { return t.AddDate(0, 0, offset).Format("2006-01-02") }

// heldDays is the set of days (YYYY-MM-DD) the cube has a row for, from the
// coverage read; nil when that read failed or a row had no usable day.
func heldDays(rows []map[string]any) map[string]bool {
	if rows == nil {
		return nil
	}
	out := map[string]bool{}
	for _, r := range rows {
		ts := getStr(r["timestamp"])
		if len(ts) < 10 {
			return nil
		}
		out[ts[:10]] = true
	}
	return out
}

type coverage struct {
	// covered is true or false, or nil when the days could not be read.
	covered  any
	from, to any // the first and last day held inside the window, or nil
}

// windowCoverage says whether the cube holds the whole window first..last:
// a day held on or before first, and last or the day before it held (the
// newest day can still be landing). Seen live on 2026-11-20: the demo
// tenant's cube began 2026-10-14, inside the earlier window, so that window
// held 7 of its 30 days.
func windowCoverage(days map[string]bool, first, last string) coverage {
	if days == nil {
		return coverage{}
	}
	var from, to string
	early := false
	for d := range days {
		if d <= first {
			early = true
		}
		if d >= first && d <= last {
			if from == "" || d < from {
				from = d
			}
			if d > to {
				to = d
			}
		}
	}
	lastT, _ := time.Parse("2006-01-02", last)
	late := days[last] || days[day(lastT, -1)]
	c := coverage{covered: early && late}
	if from != "" {
		c.from, c.to = from, to
	}
	return c
}
