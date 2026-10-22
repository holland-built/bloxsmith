package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"sync/atomic"
	"testing"
)

// roundTrip marshals v and reads it back, so assertions see what the wire
// sees ([]any and float64) rather than the Go types that built it.
func roundTrip(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// --- BuildChartQuery ----------------------------------------------------

// TestBuildChartQuery_EveryAllowedCombination walks the whole allow-list and
// checks each pick builds the query its cube needs. The expectations are
// written out here rather than derived from chartCatalog, so a catalog typo
// fails a test instead of being copied into it.
func TestBuildChartQuery_EveryAllowedCombination(t *testing.T) {
	measures := map[string]string{
		"dns":     "NetworkNstarDnsActivity.total_query_count",
		"threats": "PortunusAggThreat_ch.requests",
		"qps":     "HostMetrics.avg_value",
	}
	cubes := map[string]string{"dns": "NetworkNstarDnsActivity", "threats": "PortunusAggThreat_ch", "qps": "HostMetrics"}
	endpoints := map[string]string{
		"dns":     "/api/cubejs/v1/query",
		"threats": "/api/cubejs-security/v1/query",
		"qps":     "/api/cubejs/v1/query",
	}
	dims := map[string][]any{
		"device": {"NetworkNstarDnsActivity.device_name", "NetworkNstarDnsActivity.device_ip"},
		"qtype":  {"NetworkNstarDnsActivity.query_type"},
		"action": {"PortunusAggThreat_ch.action"},
	}
	ranges := map[string]string{"today": "today", "7d": "last 7 days", "30d": "last 30 days"}

	combos := ChartCombos()
	if len(combos) == 0 {
		t.Fatal("no allowed combinations")
	}
	for _, p := range combos {
		q, endpoint, err := BuildChartQuery(p)
		if err != nil {
			t.Errorf("%+v: refused an allowed pick: %v", p, err)
			continue
		}
		q = roundTrip(t, q)
		if endpoint != endpoints[p.Count] {
			t.Errorf("%+v: endpoint = %s, want %s", p, endpoint, endpoints[p.Count])
		}
		if ms := asSlice(q["measures"]); len(ms) != 1 || ms[0] != measures[p.Count] {
			t.Errorf("%+v: measures = %v", p, q["measures"])
		}
		if p.Split == "none" {
			if _, ok := q["dimensions"]; ok {
				t.Errorf("%+v: no split but dimensions = %v", p, q["dimensions"])
			}
		} else if got := asSlice(q["dimensions"]); !reflect.DeepEqual(got, dims[p.Split]) {
			t.Errorf("%+v: dimensions = %v, want %v", p, got, dims[p.Split])
		}
		td := asMap(asSlice(q["timeDimensions"])[0])
		if td["dimension"] != cubes[p.Count]+".timestamp" || td["dateRange"] != ranges[p.Window] {
			t.Errorf("%+v: timeDimensions = %+v", p, td)
		}
		if p.Over == "none" {
			if _, ok := td["granularity"]; ok {
				t.Errorf("%+v: one total but granularity = %v", p, td["granularity"])
			}
		} else if td["granularity"] != p.Over {
			t.Errorf("%+v: granularity = %v, want %s", p, td["granularity"], p.Over)
		}
		if p.Top > 0 {
			if q["limit"] != float64(p.Top) {
				t.Errorf("%+v: limit = %v", p, q["limit"])
			}
			if asMap(q["order"])[measures[p.Count]] != "desc" {
				t.Errorf("%+v: order = %v, want the measure descending", p, q["order"])
			}
		} else if _, ok := q["limit"]; ok {
			t.Errorf("%+v: no top N but limit = %v", p, q["limit"])
		}
		f := asSlice(q["filters"])
		if p.Count == "qps" {
			want := []any{map[string]any{"member": "HostMetrics.metric_name", "operator": "equals", "values": []any{"dns_qps_iq"}}}
			if !reflect.DeepEqual(f, want) {
				t.Errorf("%+v: filters = %v, want the dns_qps_iq filter", p, f)
			}
		} else if len(f) != 0 {
			t.Errorf("%+v: filters = %v, want none", p, f)
		}
	}
}

// TestChartCombos_FollowThePickerRules pins the rules themselves: by hour only
// with today, by day only with 7 or 30 days, top N only for a split with no
// time slicing, and each measure split only by its own cube's fields.
func TestChartCombos_FollowThePickerRules(t *testing.T) {
	splits := map[string]map[string]bool{
		"dns":     {"device": true, "qtype": true, "none": true},
		"threats": {"action": true, "none": true},
		"qps":     {"none": true},
	}
	seen := map[ChartPicks]bool{}
	for _, p := range ChartCombos() {
		if seen[p] {
			t.Errorf("duplicate combination %+v", p)
		}
		seen[p] = true
		if !splits[p.Count][p.Split] {
			t.Errorf("%+v: %s cannot be split by %s", p, p.Count, p.Split)
		}
		if p.Over == "hour" && p.Window != "today" {
			t.Errorf("%+v: by hour is only for today", p)
		}
		if p.Over == "day" && p.Window == "today" {
			t.Errorf("%+v: by day is only for 7 or 30 days", p)
		}
		wantTop := p.Split != "none" && p.Over == "none"
		if wantTop != (p.Top > 0) {
			t.Errorf("%+v: top N must be set exactly when split and no over-time", p)
		}
		if p.Split == "none" && p.Over == "none" {
			t.Errorf("%+v: a single total has no chart to draw", p)
		}
	}
	// The four charts the owner will build by picking must all be reachable.
	for _, p := range []ChartPicks{
		{Count: "dns", Split: "device", Window: "7d", Over: "none", Top: 10},
		{Count: "dns", Split: "none", Window: "today", Over: "hour"},
		{Count: "threats", Split: "action", Window: "30d", Over: "day"},
		{Count: "dns", Split: "qtype", Window: "7d", Over: "none", Top: 10},
	} {
		if !seen[p] {
			t.Errorf("%+v: missing from the allow-list", p)
		}
	}
}

func TestBuildChartQuery_RefusesPicksOutsideTheCatalog(t *testing.T) {
	for _, p := range []ChartPicks{
		{Count: "domains", Split: "none", Window: "7d", Over: "day"},            // unknown measure
		{Count: "threats", Split: "qtype", Window: "7d", Over: "none", Top: 10}, // field from another cube
		{Count: "qps", Split: "device", Window: "7d", Over: "none", Top: 10},    // HostMetrics has no split
		{Count: "dns", Split: "none", Window: "7d", Over: "hour"},               // by hour needs today
		{Count: "dns", Split: "none", Window: "today", Over: "day"},             // by day needs 7/30 days
		{Count: "dns", Split: "device", Window: "7d", Over: "none", Top: 1000},  // top outside 5/10/25
		{Count: "dns", Split: "device", Window: "7d", Over: "none"},             // split with no top
		{Count: "dns", Split: "none", Window: "7d", Over: "day", Top: 10},       // top with no split
		{Count: "dns", Split: "none", Window: "90d", Over: "day"},               // unknown window
		{Count: "dns", Split: "none", Window: "7d", Over: "none"},               // one bare total
		{Count: "dns", Split: "device", Window: "7d", Over: "day"},              // device over time
	} {
		if q, ep, err := BuildChartQuery(p); err == nil {
			t.Errorf("%+v: accepted, built %v for %s", p, q, ep)
		}
	}
}

// --- RunChart ------------------------------------------------------------

func TestRunChart_SecurityGoesToTheSecurityService(t *testing.T) {
	var path string
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		q := cubeQueryFromRequest(t, r)
		if ms := asSlice(q["measures"]); len(ms) != 1 || ms[0] != "PortunusAggThreat_ch.requests" {
			t.Errorf("measures = %v", q["measures"])
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":{"data":[
			{"PortunusAggThreat_ch.action":"block","PortunusAggThreat_ch.timestamp.day":"2026-10-20T00:00:00.000","PortunusAggThreat_ch.requests":"41"}
		]}}`))
	})
	got := s.RunChart(context.Background(), ChartPicks{Count: "threats", Split: "action", Window: "30d", Over: "day"})
	if path != "/api/cubejs-security/v1/query" {
		t.Fatalf("security query went to %s", path)
	}
	if got["status"] != "ok" || got["endpoint"] != "/api/cubejs-security/v1/query" {
		t.Fatalf("status/endpoint = %v/%v", got["status"], got["endpoint"])
	}
	rows, _ := got["rows"].([]map[string]any)
	if len(rows) != 1 || rows[0]["PortunusAggThreat_ch.action"] != "block" {
		t.Fatalf("rows lost their Cube.field keys: %v", got["rows"])
	}
	if got["query"] == nil {
		t.Fatal("response must carry the query it ran")
	}
}

func TestRunChart_DisallowedPickSendsNothingUpstream(t *testing.T) {
	var calls int32
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
	})
	got := s.RunChart(context.Background(), ChartPicks{Count: "threats", Split: "qtype", Window: "7d", Over: "none", Top: 10})
	if got["status"] != "invalid" {
		t.Fatalf("status = %v, want invalid", got["status"])
	}
	if atomic.LoadInt32(&calls) != 0 {
		t.Fatalf("a refused pick reached the tenant %d times", calls)
	}
}

func TestRunChart_UpstreamErrorIsNotEmpty(t *testing.T) {
	var calls int32
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		http.Error(w, "boom", http.StatusBadGateway)
	})
	p := ChartPicks{Count: "dns", Split: "none", Window: "7d", Over: "day"}
	got := s.RunChart(context.Background(), p)
	if got["status"] != "error" {
		t.Fatalf("status = %v, want error", got["status"])
	}
	if got["reason"] == nil || got["reason"] == "" {
		t.Fatal("an error must say why")
	}
	// A failure is not cached, so the next pick tries again.
	s.RunChart(context.Background(), p)
	if atomic.LoadInt32(&calls) != 2 {
		t.Fatalf("upstream calls = %d, want 2 (errors must not be cached)", calls)
	}
}

func TestRunChart_GenuinelyEmptyIsEmptyAndCached(t *testing.T) {
	var calls int32
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":{"data":[]}}`))
	})
	p := ChartPicks{Count: "qps", Split: "none", Window: "today", Over: "hour"}
	got := s.RunChart(context.Background(), p)
	if got["status"] != "empty" {
		t.Fatalf("status = %v, want empty", got["status"])
	}
	if rows, ok := got["rows"].([]map[string]any); !ok || rows == nil || len(rows) != 0 {
		t.Fatalf("rows = %#v, want a non-nil empty list", got["rows"])
	}
	s.RunChart(context.Background(), p)
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("upstream calls = %d, want 1 (a good answer is cached)", calls)
	}
}

// --- ChartOptions ----------------------------------------------------------

// TestChartOptions_EveryFieldHasAPlainName: the screen takes every label from
// this payload, so a field with no plain name would show up raw.
func TestChartOptions_EveryFieldHasAPlainName(t *testing.T) {
	opts := roundTrip(t, ChartOptions())
	names := asMap(opts["names"])
	for _, p := range ChartCombos() {
		q, _, err := BuildChartQuery(p)
		if err != nil {
			t.Fatal(err)
		}
		q = roundTrip(t, q)
		fields := append([]any{}, asSlice(q["measures"])...)
		fields = append(fields, asSlice(q["dimensions"])...)
		fields = append(fields, asMap(asSlice(q["timeDimensions"])[0])["dimension"])
		for _, f := range fields {
			if n, _ := names[f.(string)].(string); n == "" {
				t.Errorf("%s has no plain name", f)
			}
		}
	}
	vals := asMap(asMap(opts["values"])["PortunusAggThreat_ch.action"])
	// The tenant sends these capitalised (measured live 2026-10-21).
	if vals["Block"] != "Blocked" || vals["Allow"] != "Allowed" {
		t.Errorf("action values = %v, want Block->Blocked, Allow->Allowed", vals)
	}
	if len(asSlice(opts["combos"])) != len(ChartCombos()) {
		t.Errorf("options must carry the whole allow-list")
	}
	for _, k := range []string{"counts", "splits", "windows", "overs", "tops"} {
		if len(asSlice(opts[k])) == 0 {
			t.Errorf("options[%s] is empty", k)
		}
	}
}

// TestChartOptions_MatchesTheUIFixture keeps tests/chart-options.json,
// which the UI's node tests and Playwright read, identical to what the server
// sends. UPDATE_CHART_FIXTURE=1 rewrites it.
func TestChartOptions_MatchesTheUIFixture(t *testing.T) {
	const path = "../../../tests/chart-options.json"
	want, err := json.MarshalIndent(ChartOptions(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, '\n')
	if os.Getenv("UPDATE_CHART_FIXTURE") == "1" {
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run with UPDATE_CHART_FIXTURE=1 to write it)", err)
	}
	if string(got) != string(want) {
		t.Fatalf("%s is out of date; run with UPDATE_CHART_FIXTURE=1", path)
	}
}
