package dashboard

import (
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

const valueMetaBoth = `{"result":{"cubes":[
 {"name":"ZDDReclassifiedV1","measures":[{"name":"ZDDReclassifiedV1.totalIndicators","type":"number"}],"dimensions":[]},
 {"name":"SusToMalAggV1","measures":[{"name":"SusToMalAggV1.indicatorCount","type":"number"}],"dimensions":[]}]}}`

// valueFake is one tenant for CSPValueSecurity. bodies is keyed by the
// query's first measure, or "previous" for the blocked read with explicit
// dates; a key in fail answers 500.
type valueFake struct {
	meta   string
	bodies map[string]string
	fail   map[string]bool
}

func valueServer(t *testing.T, f valueFake) (*Service, *[]map[string]any) {
	t.Helper()
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
			if _, rel := asMap(q["timeDimensions"].([]any)[0])["dateRange"].([]any); rel {
				key = "previous"
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

func valueAllOK() map[string]string {
	return map[string]string{
		"PortunusAggThreat_ch.requests":     `{"result":{"data":[{"PortunusAggThreat_ch.requests":"393407"}]}}`,
		"previous":                          valuePrevDays("2026-09-21", "200000", "150000"),
		"ZDDReclassifiedV1.totalIndicators": `{"result":{"data":[{"ZDDReclassifiedV1.totalIndicators":"19"}]}}`,
		"SusToMalAggV1.indicatorCount":      `{"result":{"data":[{"SusToMalAggV1.indicatorCount":"24","SusToMalAggV1.avgTimeAdvantageMinutes":"754"}]}}`,
	}
}

// valuePrevDays is the earlier window by day: the first row on first, the
// rest the days after.
func valuePrevDays(first string, counts ...string) string {
	rows := []string{}
	day, _ := time.Parse("2006-01-02", first)
	for i, c := range counts {
		d := day.AddDate(0, 0, i).Format("2006-01-02") + "T00:00:00.000"
		rows = append(rows, `{"PortunusAggThreat_ch.timestamp":"`+d+`","PortunusAggThreat_ch.timestamp.day":"`+d+`","PortunusAggThreat_ch.requests":"`+c+`"}`)
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
	fixValueClock(t)
	s, seen := valueServer(t, valueFake{meta: valueMetaBoth, bodies: valueAllOK()})
	got := s.CSPValueSecurity()
	if got["status"] != "ok" || got["window"] != "last 30 days" {
		t.Fatalf("status/window = %v/%v", got["status"], got["window"])
	}
	b := valueOf(t, got, "blocked")
	if b["status"] != "ok" || b["value"] != 393407.0 || b["previous"] != 350000.0 || b["previous_status"] != "ok" {
		t.Errorf("blocked = %v", b)
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
	// Every query: the right time field, and blocked filtered to Block.
	wantDim := map[string]string{
		"PortunusAggThreat_ch.requests":     "PortunusAggThreat_ch.timestamp",
		"ZDDReclassifiedV1.totalIndicators": "ZDDReclassifiedV1.firstSeenDim",
		"SusToMalAggV1.indicatorCount":      "SusToMalAggV1.reclassified_time",
	}
	for _, q := range *seen {
		measure := getStr(q["measures"].([]any)[0])
		td := asMap(q["timeDimensions"].([]any)[0])
		_, explicit := td["dateRange"].([]any)
		wantGran := map[bool]any{true: "day", false: nil}[explicit]
		if td["dimension"] != wantDim[measure] || td["granularity"] != wantGran {
			t.Errorf("%s timeDimension = %v", measure, td)
		}
		if strings.HasPrefix(measure, "PortunusAggThreat_ch") {
			f := asMap(q["filters"].([]any)[0])
			if f["member"] != "PortunusAggThreat_ch.action" || getStr(f["values"].([]any)[0]) != "Block" {
				t.Errorf("blocked filter = %v", f)
			}
		}
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

func fixValueClock(t *testing.T) {
	valueNow = func() time.Time { return time.Date(2026, 11, 20, 15, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { valueNow = time.Now })
}

// The cube's data starting inside the earlier window (seen live: it began
// 2026-10-14) gives no trend, never a rise against a week of data.
func TestCSPValueSecurity_PreviousWindowPartlyHeldGivesNoTrend(t *testing.T) {
	fixValueClock(t)
	b := valueAllOK()
	b["previous"] = valuePrevDays("2026-10-14", "4711", "43894", "37347")
	s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: b})
	m := valueOf(t, s.CSPValueSecurity(), "blocked")
	if m["value"] != 393407.0 || m["previous"] != nil || m["previous_status"] != "partial" {
		t.Errorf("blocked = %v, want the value, no previous, previous_status partial", m)
	}
}

// A day in the earlier window that is not a number spoils the total.
func TestCSPValueSecurity_PreviousBadDayIsError(t *testing.T) {
	fixValueClock(t)
	b := valueAllOK()
	b["previous"] = valuePrevDays("2026-09-21", "10", "n/a")
	s, _ := valueServer(t, valueFake{meta: valueMetaBoth, bodies: b})
	if m := valueOf(t, s.CSPValueSecurity(), "blocked"); m["previous"] != nil || m["previous_status"] != "error" {
		t.Errorf("blocked = %v, want previous null and error", m)
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
		"PortunusAggThreat_ch.requests": true, "previous": true,
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
