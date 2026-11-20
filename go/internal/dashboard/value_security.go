package dashboard

import (
	"encoding/json"
	"strings"
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
// 393,407) and a trend would have read "up 221%". The earlier total is only
// used when the cube has a row on that window's first day.
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
	prevRange := []string{
		today.AddDate(0, 0, -60).Format("2006-01-02"),
		today.AddDate(0, 0, -31).Format("2006-01-02"),
	}
	blockedQuery := func(dateRange any) map[string]any {
		td := map[string]any{"dimension": "PortunusAggThreat_ch.timestamp", "dateRange": dateRange}
		if _, explicit := dateRange.([]string); explicit {
			// By day, so a window the cube only partly holds can be told
			// from a quiet one (blockedPrevious).
			td["granularity"] = "day"
		}
		return map[string]any{
			"measures": []string{"PortunusAggThreat_ch.requests"},
			"filters": []map[string]any{{
				"member": "PortunusAggThreat_ch.action", "operator": "equals", "values": []string{"Block"}}},
			"timeDimensions": []map[string]any{td},
		}
	}

	var blocked, previous, zdd, sus []map[string]any
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
	b["previous"], b["previous_status"] = blockedPrevious(previous, prevRange[0])
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

// blockedPrevious is the earlier window's total and why it may be missing:
// "ok"; "error" (the read failed or a day's reading was not a number);
// "partial" (the cube has no row on the window's first day, so it does not
// hold the whole window and a comparison would be against fewer days).
func blockedPrevious(rows []map[string]any, firstDay string) (any, string) {
	if rows == nil {
		return nil, "error"
	}
	var sum float64
	covered := false
	for _, r := range rows {
		v := floatOrNil(r["requests"])
		if v == nil {
			return nil, "error"
		}
		sum += v.(float64)
		if strings.HasPrefix(getStr(r["timestamp"]), firstDay) {
			covered = true
		}
	}
	if !covered {
		return nil, "partial"
	}
	return sum, "ok"
}
