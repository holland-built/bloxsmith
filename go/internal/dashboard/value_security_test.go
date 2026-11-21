package dashboard

import (
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

const valueMetaBoth = `{"result":{"cubes":[
 {"name":"ZDDReclassifiedV1","measures":[{"name":"ZDDReclassifiedV1.totalIndicators","type":"number"}],"dimensions":[]},
 {"name":"SusToMalAggV1","measures":[{"name":"SusToMalAggV1.indicatorCount","type":"number"}],"dimensions":[]}]}}`

// valueFake is one tenant for CSPValueSecurity. bodies is keyed by the
// query's first measure, "previous" for the blocked read with explicit dates,
// or "held" for the by-day read of the days the cube holds; a key in fail
// answers 500.
type valueFake struct {
	meta   string
	bodies map[string]string
	fail   map[string]bool
}

// valueServer is the fake tenant, with the clock fixed at 2026-11-20: the
// current window is 2026-10-21..2026-11-19, the earlier 2026-09-21..2026-10-20.
func valueServer(t *testing.T, f valueFake) (*Service, *[]map[string]any) {
	t.Helper()
	valueNow = func() time.Time { return time.Date(2026, 11, 20, 15, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { valueNow = time.Now })
	var mu sync.Mutex
	seen := []map[string]any{}
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case cubeSecurityMetaPath:
			_, _ = w.Write([]byte(`{"result":{"cubes":[]}}`))
		case cubeMetaPath:
			if f.meta == "" {
				w.WriteHeader(502)
				return
			}
			_, _ = w.Write([]byte(f.meta))
		case cubeEndpoint, cubeSecurityEndpoint:
			q := cubeQueryFromRequest(t, r)
			mu.Lock()
			seen = append(seen, q)
			mu.Unlock()
			key := getStr(q["measures"].([]any)[0])
			td := asMap(q["timeDimensions"].([]any)[0])
			if _, explicit := td["dateRange"].([]any); explicit {
				key = "previous"
				if td["granularity"] == "day" {
					key = "held"
				}
			}
			if f.fail[key] {
				w.WriteHeader(500)
				return
			}
			_, _ = w.Write([]byte(f.bodies[key]))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	})
	return s, &seen
}

// valueAllOK holds every day of both windows.
func valueAllOK() map[string]string {
	return map[string]string{
		"PortunusAggThreat_ch.requests":     `{"result":{"data":[{"PortunusAggThreat_ch.requests":"393407"}]}}`,
		"previous":                          `{"result":{"data":[{"PortunusAggThreat_ch.requests":"350000"}]}}`,
		"held":                              valueHeld("2026-09-21", "2026-11-19"),
		"ZDDReclassifiedV1.totalIndicators": `{"result":{"data":[{"ZDDReclassifiedV1.totalIndicators":"19"}]}}`,
		"SusToMalAggV1.indicatorCount":      `{"result":{"data":[{"SusToMalAggV1.indicatorCount":"24","SusToMalAggV1.avgTimeAdvantageMinutes":"754"}]}}`,
	}
}

// valueHeld is the by-day read of the days the cube holds: one row a day from
// first to last, inclusive, leaving out the days in skip.
func valueHeld(first, last string, skip ...string) string {
	rows := []string{}
	end, _ := time.Parse("2006-01-02", last)
	for d, _ := time.Parse("2006-01-02", first); !d.After(end); d = d.AddDate(0, 0, 1) {
		if slices.Contains(skip, d.Format("2006-01-02")) {
			continue
		}
		ts := d.Format("2006-01-02") + "T00:00:00.000"
		rows = append(rows, `{"PortunusAggThreat_ch.timestamp":"`+ts+`","PortunusAggThreat_ch.timestamp.day":"`+ts+`","PortunusAggThreat_ch.requests":"100"}`)
	}
	return `{"result":{"data":[` + strings.Join(rows, ",") + `]}}`
}

func valueOf(t *testing.T, got map[string]any, key string) map[string]any {
	t.Helper()
	m, ok := asMap(got["metrics"])[key].(map[string]any)
	if !ok {
		t.Fatalf("metrics[%q] missing: %v", key, got["metrics"])
	}
	return m
}

func TestCSPValueSecurity_AllRead(t *testing.T) {
	s, seen := valueServer(t, valueFake{meta: valueMetaBoth, bodies: valueAllOK()})
	got := s.CSPValueSecurity()
	if got["status"] != "ok" || got["window"] != "last 30 days" {
		t.Fatalf("status/window = %v/%v", got["status"], got["window"])
	}
	b := valueOf(t, got, "blocked")
	if b["status"] != "ok" || b["value"] != 393407.0 || b["previous"] != 350000.0 || b["previous_status"] != "ok" {
		t.Errorf("blocked = %v", b)
	}
	if b["covered"] != true || b["days_from"] != "2026-10-21" || b["days_to"] != "2026-11-19" {
		t.Errorf("coverage = %v %v %v, want the whole current window held", b["covered"], b["days_from"], b["days_to"])
	}
	if wr := b["window_range"].([]string); wr[0] != "2026-10-21" || wr[1] != "2026-11-19" {
		t.Errorf("window_range = %v", wr)
	}
	if pr := b["previous_range"].([]string); pr[0] != "2026-09-21" || pr[1] != "2026-10-20" {
		t.Errorf("previous_range = %v, want the 30 days before 2026-10-21", pr)
	}
	if z := valueOf(t, got, "zero_day"); z["status"] != "ok" || z["value"] != 19.0 {
		t.Errorf("zero_day = %v", z)
	}
	if m := valueOf(t, got, "sus_to_mal"); m["status"] != "ok" || m["value"] != 24.0 || m["ahead_minutes"] != 754.0 {
		t.Errorf("sus_to_mal = %v", m)
	}
	// Every query: the right time field, blocked filtered to Block, and the
	// days-held read unfiltered, by day, over both windows.
	wantDim := map[string]string{
		"PortunusAggThreat_ch.requests":     "PortunusAggThreat_ch.timestamp",
		"ZDDReclassifiedV1.totalIndicators": "ZDDReclassifiedV1.firstSeenDim",
		"SusToMalAggV1.indicatorCount":      "SusToMalAggV1.reclassified_time",
	}
	heldReads := 0
	for _, q := range *seen {
		measure := getStr(q["measures"].([]any)[0])
		td := asMap(q["timeDimensions"].([]any)[0])
		if td["dimension"] != wantDim[measure] {
			t.Errorf("%s timeDimension = %v", measure, td)
		}
		if td["granularity"] == "day" {
			heldReads++
			dr := td["dateRange"].([]any)
			if q["filters"] != nil || dr[0] != "2026-09-21" || dr[1] != "2026-11-19" {
				t.Errorf("days-held read = %v", q)
			}
			continue
		}
		if td["granularity"] != nil {
			t.Errorf("%s timeDimension = %v, want one total", measure, td)
		}
		if strings.HasPrefix(measure, "PortunusAggThreat_ch") {
			f := asMap(q["filters"].([]any)[0])
			if f["member"] != "PortunusAggThreat_ch.action" || getStr(f["values"].([]any)[0]) != "Block" {
				t.Errorf("blocked filter = %v", f)
			}
		}
	}
	if heldReads != 1 {
		t.Errorf("days-held reads = %d, want 1", heldReads)
	}
}

// A missing, null or non-numeric measure is never read as 0.
func TestCSPValueSecurity_BadMeasureIsNull(t *testing.T) {
	for name, row := range map[string]string{
		"missing":     `{}`,
		"null":        `{"ZDDReclassifiedV1.totalIndicators":null}`,
		"non-numeric": `{"ZDDReclassifiedV1.totalIndicators":"n/a"}`,
	} {
		b := valueAllOK()
		b["ZDDReclassifiedV1.totalIndicators"] = `{"result":{"data":[` + row + `]}}`
		s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: b})
		got := s.CSPValueSecurity()
		z := valueOf(t, got, "zero_day")
		if z["value"] != nil || z["status"] == "ok" {
			t.Errorf("%s: zero_day = %v, want a null value", name, z)
		}
		if b := valueOf(t, got, "blocked"); b["value"] != 393407.0 {
			t.Errorf("%s: blocked = %v, want still shown", name, b)
		}
	}
}

func TestCSPValueSecurity_OneFailsOthersStillShown(t *testing.T) {
	s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: valueAllOK(),
		fail: map[string]bool{"SusToMalAggV1.indicatorCount": true}})
	got := s.CSPValueSecurity()
	if got["status"] != "partial" {
		t.Errorf("status = %v, want partial", got["status"])
	}
	if m := valueOf(t, got, "sus_to_mal"); m["status"] != "error" || m["value"] != nil || m["ahead_minutes"] != nil {
		t.Errorf("sus_to_mal = %v, want error with nulls", m)
	}
	if z := valueOf(t, got, "zero_day"); z["value"] != 19.0 {
		t.Errorf("zero_day = %v", z)
	}
}

// The previous window failing loses only the trend, not the number.
func TestCSPValueSecurity_PreviousFailsKeepsBlocked(t *testing.T) {
	s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: valueAllOK(), fail: map[string]bool{"previous": true}})
	b := valueOf(t, s.CSPValueSecurity(), "blocked")
	if b["status"] != "ok" || b["value"] != 393407.0 || b["previous"] != nil || b["previous_status"] != "error" {
		t.Errorf("blocked = %v, want the value and a null previous", b)
	}
}

// The cube's data starting inside the earlier window (seen live: it began
// 2026-10-14) gives no trend, never a rise against a week of data. The
// current window is still fully held, so its number stands as 30 days.
func TestCSPValueSecurity_PreviousWindowPartlyHeldGivesNoTrend(t *testing.T) {
	b := valueAllOK()
	b["held"] = valueHeld("2026-10-14", "2026-11-19")
	s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: b})
	m := valueOf(t, s.CSPValueSecurity(), "blocked")
	if m["value"] != 393407.0 || m["previous"] != nil || m["previous_status"] != "partial" || m["covered"] != true {
		t.Errorf("blocked = %v, want the value, covered, no previous, previous_status partial", m)
	}
}

// Data on only the earlier window's first days is not the whole window: one
// row on the first day used to pass as a complete 30-day total.
func TestCSPValueSecurity_PreviousWindowOnlyItsFirstDaysGivesNoTrend(t *testing.T) {
	b := valueAllOK()
	b["held"] = valueHeld("2026-09-21", "2026-09-22")
	s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: b})
	m := valueOf(t, s.CSPValueSecurity(), "blocked")
	if m["previous"] != nil || m["previous_status"] != "partial" {
		t.Errorf("blocked = %v, want no previous, previous_status partial", m)
	}
}

// A current window the cube only partly holds keeps its number but says which
// days it counts, so the screen can say "since" rather than 30 days.
func TestCSPValueSecurity_CurrentWindowPartlyHeld(t *testing.T) {
	b := valueAllOK()
	b["held"] = valueHeld("2026-11-02", "2026-11-19")
	s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: b})
	m := valueOf(t, s.CSPValueSecurity(), "blocked")
	if m["status"] != "ok" || m["value"] != 393407.0 || m["covered"] != false || m["days_from"] != "2026-11-02" || m["days_to"] != "2026-11-19" {
		t.Errorf("blocked = %v, want the value, covered false, days 2026-11-02 to 2026-11-19", m)
	}
	if m["previous"] != nil || m["previous_status"] != "partial" {
		t.Errorf("blocked previous = %v / %v, want none", m["previous"], m["previous_status"])
	}
}

// Data that stops before the window's end is not the whole window either.
func TestCSPValueSecurity_CurrentWindowEndsEarly(t *testing.T) {
	b := valueAllOK()
	b["held"] = valueHeld("2026-09-21", "2026-11-10")
	s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: b})
	m := valueOf(t, s.CSPValueSecurity(), "blocked")
	if m["covered"] != false || m["days_to"] != "2026-11-10" || m["previous_status"] != "ok" {
		t.Errorf("blocked = %v, want covered false to 2026-11-10, earlier window still whole", m)
	}
}

// The newest day may still be landing: data through the day before yesterday
// still covers the window.
func TestCSPValueSecurity_NewestDayStillLanding(t *testing.T) {
	b := valueAllOK()
	b["held"] = valueHeld("2026-09-21", "2026-11-18")
	s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: b})
	if m := valueOf(t, s.CSPValueSecurity(), "blocked"); m["covered"] != true {
		t.Errorf("blocked = %v, want covered", m)
	}
}

// A day missing from the middle of the current window means the number is not
// a 30-day total, even though both ends of the window are held.
func TestCSPValueSecurity_GapInCurrentWindow(t *testing.T) {
	b := valueAllOK()
	b["held"] = valueHeld("2026-09-21", "2026-11-19", "2026-11-05")
	s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: b})
	m := valueOf(t, s.CSPValueSecurity(), "blocked")
	if m["value"] != 393407.0 || m["covered"] != false || m["days_held"] != 29 {
		t.Errorf("blocked = %v, want the value, covered false, 29 days held", m)
	}
	if m["days_from"] != "2026-10-21" || m["days_to"] != "2026-11-19" {
		t.Errorf("days = %v to %v", m["days_from"], m["days_to"])
	}
}

// A day missing from the middle of the earlier window gives no trend.
func TestCSPValueSecurity_GapInPreviousWindowGivesNoTrend(t *testing.T) {
	b := valueAllOK()
	b["held"] = valueHeld("2026-09-21", "2026-11-19", "2026-10-05")
	s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: b})
	m := valueOf(t, s.CSPValueSecurity(), "blocked")
	if m["covered"] != true || m["previous"] != nil || m["previous_status"] != "partial" {
		t.Errorf("blocked = %v, want covered, no previous, previous_status partial", m)
	}
}

// Only the current window's newest day can still be landing. The earlier
// window's last day is a month old, so without it there is no trend.
func TestCSPValueSecurity_PreviousWindowMissingLastDayGivesNoTrend(t *testing.T) {
	b := valueAllOK()
	b["held"] = valueHeld("2026-09-21", "2026-11-18", "2026-10-20")
	s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: b})
	m := valueOf(t, s.CSPValueSecurity(), "blocked")
	if m["covered"] != true || m["previous"] != nil || m["previous_status"] != "partial" {
		t.Errorf("blocked = %v, want current covered, no previous, previous_status partial", m)
	}
}

// Only the newest day may be absent. The day before it missing is a real gap,
// whether or not the newest day arrived.
func TestWindowCoverage_NewestDayAllowance(t *testing.T) {
	const first, last = "2026-10-21", "2026-11-19"
	for name, tc := range map[string]struct {
		through string
		skip    []string
		want    bool
	}{
		"every day":                        {through: last, want: true},
		"only the newest missing":          {through: "2026-11-18", want: true},
		"newest and day before missing":    {through: "2026-11-17", want: false},
		"day before missing, newest held":  {through: last, skip: []string{"2026-11-18"}, want: false},
		"first day missing":                {through: last, skip: []string{first}, want: false},
		"middle day missing":               {through: last, skip: []string{"2026-11-05"}, want: false},
		"middle missing and newest absent": {through: "2026-11-18", skip: []string{"2026-11-05"}, want: false},
	} {
		days := map[string]bool{}
		end, _ := time.Parse("2006-01-02", tc.through)
		for d, _ := time.Parse("2006-01-02", first); !d.After(end); d = d.AddDate(0, 0, 1) {
			if !slices.Contains(tc.skip, d.Format("2006-01-02")) {
				days[d.Format("2006-01-02")] = true
			}
		}
		if got := windowCoverage(days, first, last, true).covered; got != tc.want {
			t.Errorf("%s: covered = %v, want %v", name, got, tc.want)
		}
	}
}

// The days-held read failing proves nothing: coverage is unknown and there is
// no trend, but the number itself still shows.
func TestCSPValueSecurity_DaysHeldReadFails(t *testing.T) {
	s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: valueAllOK(), fail: map[string]bool{"held": true}})
	m := valueOf(t, s.CSPValueSecurity(), "blocked")
	if m["value"] != 393407.0 || m["covered"] != nil || m["previous"] != nil || m["previous_status"] != "error" {
		t.Errorf("blocked = %v, want the value, covered null, previous error", m)
	}
}

// A 200 without result.data, or a row that isn't a record, did not deliver.
func TestCSPValueSecurity_200WithoutResultDataIsNotChecked(t *testing.T) {
	for _, body := range []string{`{"result":{}}`, `{"result":{"data":[null]}}`} {
		b := valueAllOK()
		b["PortunusAggThreat_ch.requests"] = body
		s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: b})
		if m := valueOf(t, s.CSPValueSecurity(), "blocked"); m["status"] != "error" || m["value"] != nil {
			t.Errorf("%s: blocked = %v, want error and null", body, m)
		}
	}
}

func TestCSPValueSecurity_AllFailIsError(t *testing.T) {
	s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: valueAllOK(), fail: map[string]bool{
		"PortunusAggThreat_ch.requests": true, "previous": true, "held": true,
		"ZDDReclassifiedV1.totalIndicators": true, "SusToMalAggV1.indicatorCount": true}})
	if got := s.CSPValueSecurity(); got["status"] != "error" {
		t.Errorf("status = %v, want error", got["status"])
	}
}

// A cube the tenant does not list is "unavailable", is never queried, and the
// others still show.
func TestCSPValueSecurity_CubeMissingFromMeta(t *testing.T) {
	meta := `{"result":{"cubes":[{"name":"SusToMalAggV1","measures":[{"name":"SusToMalAggV1.indicatorCount","type":"number"}],"dimensions":[]}]}}`
	s, seen := valueServer(t, valueFake{meta: meta, bodies: valueAllOK()})
	got := s.CSPValueSecurity()
	if z := valueOf(t, got, "zero_day"); z["status"] != "unavailable" || z["value"] != nil {
		t.Errorf("zero_day = %v, want unavailable", z)
	}
	if got["status"] != "ok" {
		t.Errorf("status = %v, want ok (unavailable is not a failure)", got["status"])
	}
	for _, q := range *seen {
		if strings.HasPrefix(getStr(q["measures"].([]any)[0]), "ZDD") {
			t.Errorf("queried a cube the tenant does not list: %v", q)
		}
	}
}

// No catalog: the two newer cubes are still tried, on the main service.
func TestCSPValueSecurity_CatalogFailsStillQueries(t *testing.T) {
	s, _ := valueServer(t, valueFake{bodies: valueAllOK()})
	got := s.CSPValueSecurity()
	if z := valueOf(t, got, "zero_day"); z["value"] != 19.0 {
		t.Errorf("zero_day = %v", z)
	}
}
