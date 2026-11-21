package dashboard

import (
	"net/http"
	"testing"
	"time"
)

// dailyServer answers the blocked-by-day read (the one with a filter) and the
// days-held read (no filter); a nil body answers 500.
func dailyServer(t *testing.T, blocked, held *string) *Service {
	t.Helper()
	valueNow = func() time.Time { return time.Date(2026, 11, 20, 15, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { valueNow = time.Now })
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		body := held
		if _, filtered := cubeQueryFromRequest(t, r)["filters"]; filtered {
			body = blocked
		}
		if body == nil {
			w.WriteHeader(500)
			return
		}
		_, _ = w.Write([]byte(*body))
	})
	return s
}

func dailyRow(d, n string) string {
	ts := d + "T00:00:00.000"
	return `{"PortunusAggThreat_ch.timestamp":"` + ts + `","PortunusAggThreat_ch.timestamp.day":"` + ts + `","PortunusAggThreat_ch.requests":"` + n + `"}`
}

// A day the cube holds with no Block row is a real 0. A day it does not hold
// is null, never 0.
func TestCSPValueDailySeparatesZeroFromNoData(t *testing.T) {
	blocked := `{"result":{"data":[` + dailyRow("2026-11-17", "40") + `,` + dailyRow("2026-11-19", "7") + `]}}`
	held := valueHeld("2026-10-21", "2026-11-19", "2026-11-18")
	got := dailyServer(t, &blocked, &held).CSPValueDaily()
	if got["status"] != "ok" {
		t.Fatalf("status = %v", got["status"])
	}
	days := got["days"].([]map[string]any)
	if len(days) != 30 || days[0]["day"] != "2026-10-21" || days[29]["day"] != "2026-11-19" {
		t.Fatalf("days = %d, %v to %v", len(days), days[0]["day"], days[len(days)-1]["day"])
	}
	want := map[string]any{"2026-11-16": 0.0, "2026-11-17": 40.0, "2026-11-18": nil, "2026-11-19": 7.0}
	for _, d := range days {
		if w, ok := want[d["day"].(string)]; ok && d["value"] != w {
			t.Errorf("%v = %v, want %v", d["day"], d["value"], w)
		}
	}
}

func TestCSPValueDailyFailedReadIsErrorNotZero(t *testing.T) {
	ok := `{"result":{"data":[]}}`
	for name, reads := range map[string][2]*string{"blocked": {nil, &ok}, "held": {&ok, nil}} {
		got := dailyServer(t, reads[0], reads[1]).CSPValueDaily()
		if got["status"] != "error" || got["days"] != nil {
			t.Errorf("%s failed: status %v, days %v", name, got["status"], got["days"])
		}
	}
}

func TestCSPValueDailyBadReadingIsError(t *testing.T) {
	blocked := `{"result":{"data":[` + dailyRow("2026-11-17", "many") + `]}}`
	held := valueHeld("2026-10-21", "2026-11-19")
	if got := dailyServer(t, &blocked, &held).CSPValueDaily(); got["status"] != "error" {
		t.Fatalf("status = %v", got["status"])
	}
}

func TestCSPValueDailyNoDaysHeldIsEmpty(t *testing.T) {
	none := `{"result":{"data":[]}}`
	if got := dailyServer(t, &none, &none).CSPValueDaily(); got["status"] != "empty" {
		t.Fatalf("status = %v", got["status"])
	}
}
