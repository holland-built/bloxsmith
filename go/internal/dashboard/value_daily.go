package dashboard

import (
	"encoding/json"
	"time"
)

// CSPValueDaily is GET /api/csp/value-daily: lookups blocked on each of the
// last 30 whole days (UTC), from the same cube, action and service as the
// blocked total in CSPValueSecurity. A second read lists the days the cube
// holds at all, so a day with no blocks (0) is told apart from a day with no
// data (null). If either read fails the status is "error" and there are no
// days, because a partial series would draw missing days as quiet ones.
func (s *Service) CSPValueDaily() map[string]any {
	today := valueNow().UTC().Truncate(24 * time.Hour)
	dateRange := []string{day(today, -30), day(today, -1)}
	query := func(blockOnly bool) map[string]any {
		q := map[string]any{
			"measures": []string{"PortunusAggThreat_ch.requests"},
			"timeDimensions": []map[string]any{{
				"dimension": "PortunusAggThreat_ch.timestamp", "granularity": "day", "dateRange": dateRange}},
		}
		if blockOnly {
			q["filters"] = []map[string]any{{
				"member": "PortunusAggThreat_ch.action", "operator": "equals", "values": []string{"Block"}}}
		}
		return q
	}
	var blocked, heldRows []map[string]any
	read := func(q map[string]any, out *[]map[string]any) func() {
		return func() {
			qj, _ := json.Marshal(q)
			body, st, err := s.cubeGet(cubeSecurityEndpoint, qj)
			if errored(st, err) {
				return
			}
			*out = strictCubeRows(body)
		}
	}
	mustFanOut(read(query(true), &blocked), read(query(false), &heldRows))

	failed := map[string]any{"status": "error", "window": valueWindow, "days": nil}
	held := heldDays(heldRows)
	if blocked == nil || held == nil {
		return failed
	}
	counts := make(map[string]any, len(blocked))
	for _, r := range blocked {
		ts := getStr(r["timestamp"])
		v := floatOrNil(r["requests"])
		if len(ts) < 10 || v == nil {
			return failed
		}
		counts[ts[:10]] = v
	}

	days := make([]map[string]any, 0, 30)
	anyHeld := false
	for i := -30; i <= -1; i++ {
		d := day(today, i)
		var v any
		if c, ok := counts[d]; ok {
			v = c
		} else if held[d] {
			v = 0.0
		}
		anyHeld = anyHeld || v != nil
		days = append(days, map[string]any{"day": d, "value": v})
	}
	status := "ok"
	if !anyHeld {
		status = "empty"
	}
	return map[string]any{"status": status, "window": valueWindow, "days": days}
}
