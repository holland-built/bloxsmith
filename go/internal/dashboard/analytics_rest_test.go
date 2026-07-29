package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

// newRestTestService spins up an httptest server and wires a Service to it, along
// with a hook to inspect every request path+query the test makes.
func newRestTestService(t *testing.T, handler http.HandlerFunc) (*Service, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	c := rest.New(srv.URL, rest.NewAuth("test-key", nil))
	return New(c, cache.New()), srv
}

// cubeQueryFromRequest decodes the "query" URL param cubejs sends, so tests
// can assert on measures/dimensions/filters without string-matching JSON.
func cubeQueryFromRequest(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	raw := r.URL.Query().Get("query")
	var q map[string]any
	if err := json.Unmarshal([]byte(raw), &q); err != nil {
		t.Fatalf("query param did not decode as JSON: %v (%s)", err, raw)
	}
	return q
}

// --- FetchDNSAnalytics --------------------------------------------------

func TestFetchDNSAnalytics_QueryShapesAndShape(t *testing.T) {
	var seen []map[string]any
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/cubejs/v1/query" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		q := cubeQueryFromRequest(t, r)
		seen = append(seen, q)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":{"data":[
			{"NstarDnsActivity.total_query_count":"270196"}
		]}}`))
	})

	got := s.FetchDNSAnalytics(context.Background())

	if len(seen) != 3 {
		t.Fatalf("cubejs calls = %d, want 3", len(seen))
	}

	// 1. volume: measures + daily-granularity 7-day timeDimension.
	vol := seen[0]
	if ms, _ := vol["measures"].([]any); len(ms) != 1 || ms[0] != "NstarDnsActivity.total_query_count" {
		t.Errorf("volume measures = %v", vol["measures"])
	}
	td := asMap(asSlice(vol["timeDimensions"])[0])
	if td["dimension"] != "NstarDnsActivity.timestamp" || td["dateRange"] != "last 7 days" || td["granularity"] != "day" {
		t.Errorf("volume timeDimensions = %+v", td)
	}

	// 2. top_clients: device dimensions, no granularity, ordered, limit 50.
	clients := seen[1]
	dims, _ := clients["dimensions"].([]any)
	if len(dims) != 2 || dims[0] != "NstarDnsActivity.device_name" || dims[1] != "NstarDnsActivity.device_ip" {
		t.Errorf("top_clients dimensions = %v", clients["dimensions"])
	}
	td2 := asMap(asSlice(clients["timeDimensions"])[0])
	if _, hasGran := td2["granularity"]; hasGran {
		t.Errorf("top_clients timeDimensions should have no granularity, got %+v", td2)
	}
	if clients["limit"] != float64(50) {
		t.Errorf("top_clients limit = %v, want 50", clients["limit"])
	}

	// 3. query_types: query_type dimension, limit 10.
	types := seen[2]
	dims3, _ := types["dimensions"].([]any)
	if len(dims3) != 1 || dims3[0] != "NstarDnsActivity.query_type" {
		t.Errorf("query_types dimensions = %v", types["dimensions"])
	}
	if types["limit"] != float64(10) {
		t.Errorf("query_types limit = %v, want 10", types["limit"])
	}

	// shape: keys present, rows stripped of the "Cube." prefix.
	for _, key := range []string{"volume", "top_clients", "query_types"} {
		rows, ok := got[key].([]any)
		if !ok || len(rows) != 1 {
			t.Fatalf("%s = %v, want 1 row", key, got[key])
		}
		row := asMap(rows[0])
		if row["total_query_count"] != "270196" {
			t.Errorf("%s row not de-prefixed: %+v", key, row)
		}
	}
}

// TestFetchDNSAnalytics_UpstreamErrorReportsUnavailable is the regression
// test for the bug this migration fixes: a dead cubejs used to collapse to
// the exact same {volume:[],top_clients:[],query_types:[]} shape as a
// tenant with genuinely no query activity. It must now surface
// availability:"error" plus a reason, alongside the (still empty)
// rows the caller already handled.
func TestFetchDNSAnalytics_UpstreamErrorReportsUnavailable(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	got := s.FetchDNSAnalytics(context.Background())

	for _, key := range []string{"volume", "top_clients", "query_types"} {
		rows, ok := got[key].([]any)
		if !ok || len(rows) != 0 {
			t.Errorf("%s = %v, want empty slice on upstream error", key, got[key])
		}
	}
	if got["availability"] != "error" {
		t.Errorf("availability = %v, want \"error\"", got["availability"])
	}
	if reason, _ := got["reason"].(string); reason == "" {
		t.Errorf("reason = %v, want a non-empty operator-safe reason", got["reason"])
	}
}

// TestFetchDNSAnalytics_GenuineEmptyReportsOk confirms the other half of the
// same contract: a successful fetch that legitimately returns zero rows
// (a tenant with no query activity) must NOT be mistaken for a dead feed —
// it reports availability:"ok" and carries no reason.
func TestFetchDNSAnalytics_GenuineEmptyReportsOk(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":{"data":[]}}`))
	})

	got := s.FetchDNSAnalytics(context.Background())

	for _, key := range []string{"volume", "top_clients", "query_types"} {
		rows, ok := got[key].([]any)
		if !ok || len(rows) != 0 {
			t.Errorf("%s = %v, want empty slice on a genuinely empty tenant", key, got[key])
		}
	}
	if got["availability"] != "ok" {
		t.Errorf("availability = %v, want \"ok\" for a genuinely empty (not dead) feed", got["availability"])
	}
	if _, has := got["reason"]; has {
		t.Errorf("reason = %v, want no reason on a healthy empty fetch", got["reason"])
	}
}

// --- FetchHostMetrics ----------------------------------------------------

func TestFetchHostMetrics_QueryShapeAndHostNameResolution(t *testing.T) {
	var seenFilters []string
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/infra/v1/detail_hosts":
			_, _ = w.Write([]byte(`{"results":[
				{"id":"uuid-1","ophid":"oph-1","display_name":"host-a.example.com"}
			]}`))
		case r.URL.Path == "/api/cubejs/v1/query":
			q := cubeQueryFromRequest(t, r)
			filters, _ := q["filters"].([]any)
			f := asMap(filters[0])
			seenFilters = append(seenFilters, getStr(f["values"].([]any)[0]))

			dims, _ := q["dimensions"].([]any)
			if len(dims) != 2 || dims[0] != "HostMetrics.host" || dims[1] != "HostMetrics.metric_name_label" {
				t.Errorf("dimensions = %v", q["dimensions"])
			}
			if f["member"] != "HostMetrics.metric_name" || f["operator"] != "equals" {
				t.Errorf("filter = %+v", f)
			}

			metricName := getStr(f["values"].([]any)[0])
			_, _ = w.Write([]byte(`{"result":{"data":[
				{"HostMetrics.host":"uuid-1","HostMetrics.metric_name_label":"` + metricName + `","HostMetrics.avg_value":"12.5"},
				{"HostMetrics.host":null,"HostMetrics.metric_name_label":"` + metricName + `","HostMetrics.avg_value":"99"}
			]}}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	})

	got := s.FetchHostMetrics(context.Background())

	if !contains(seenFilters, "host_cpu") || !contains(seenFilters, "host_memory") {
		t.Fatalf("filter values seen = %v, want host_cpu and host_memory", seenFilters)
	}

	metrics, ok := got["metrics"].([]any)
	if !ok {
		t.Fatalf("metrics not a slice: %v", got["metrics"])
	}
	// One resolved row per metric (host_cpu, host_memory); null-host rows skipped.
	if len(metrics) != 2 {
		t.Fatalf("metrics = %d rows, want 2 (null-host rows skipped)", len(metrics))
	}
	for _, m := range metrics {
		row := asMap(m)
		if row["host"] != "uuid-1" {
			t.Errorf("host = %v, want uuid-1", row["host"])
		}
		if row["host_name"] != "host-a.example.com" {
			t.Errorf("host_name = %v, want resolved display_name", row["host_name"])
		}
		if row["avg_value"] != 12.5 && row["avg_value"] != 99.0 {
			t.Errorf("avg_value = %v, want a parsed float", row["avg_value"])
		}
	}
}

func TestFetchHostMetrics_UnresolvedHostKeepsRawID(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/infra/v1/detail_hosts":
			_, _ = w.Write([]byte(`{"results":[]}`))
		case "/api/cubejs/v1/query":
			_, _ = w.Write([]byte(`{"result":{"data":[
				{"HostMetrics.host":"unknown-uuid","HostMetrics.metric_name_label":"CPU","HostMetrics.avg_value":"5"}
			]}}`))
		}
	})

	got := s.FetchHostMetrics(context.Background())
	metrics, _ := got["metrics"].([]any)
	if len(metrics) == 0 {
		t.Fatalf("metrics empty, want the unresolved row kept")
	}
	row := asMap(metrics[0])
	if row["host_name"] != "unknown-uuid" {
		t.Errorf("host_name = %v, want raw uuid kept (never invent a name)", row["host_name"])
	}
}

// TestFetchHostMetrics_UpstreamErrorReportsUnavailable is the regression
// test for the bug this migration fixes: a dead HostMetrics cube used to
// collapse to the same {"metrics":[]} shape as a tenant with genuinely no
// per-host metrics. It must now surface availability:"error" plus a
// reason, alongside the (still empty) metrics list.
func TestFetchHostMetrics_UpstreamErrorReportsUnavailable(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	})

	got := s.FetchHostMetrics(context.Background())
	metrics, ok := got["metrics"].([]any)
	if !ok || len(metrics) != 0 {
		t.Errorf("metrics = %v, want empty slice on upstream error", got["metrics"])
	}
	if got["availability"] != "error" {
		t.Errorf("availability = %v, want \"error\"", got["availability"])
	}
	if reason, _ := got["reason"].(string); reason == "" {
		t.Errorf("reason = %v, want a non-empty operator-safe reason", got["reason"])
	}
}

// TestFetchHostMetrics_GenuineEmptyReportsOk confirms the other half of the
// same contract: a successful fetch that legitimately returns no per-host
// metrics must NOT be mistaken for a dead cube — it reports
// availability:"ok" and carries no reason.
func TestFetchHostMetrics_GenuineEmptyReportsOk(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/infra/v1/detail_hosts":
			_, _ = w.Write([]byte(`{"results":[]}`))
		case "/api/cubejs/v1/query":
			_, _ = w.Write([]byte(`{"result":{"data":[]}}`))
		}
	})

	got := s.FetchHostMetrics(context.Background())
	metrics, ok := got["metrics"].([]any)
	if !ok || len(metrics) != 0 {
		t.Errorf("metrics = %v, want empty slice on a genuinely empty tenant", got["metrics"])
	}
	if got["availability"] != "ok" {
		t.Errorf("availability = %v, want \"ok\" for a genuinely empty (not dead) cube", got["availability"])
	}
	if _, has := got["reason"]; has {
		t.Errorf("reason = %v, want no reason on a healthy empty fetch", got["reason"])
	}
}

// --- hostDisplayNames: GetStrict migration -----------------------------------

// TestHostDisplayNames_UpstreamErrorReturnsEmptyMapNotPanic is the regression
// test for the bug this migration fixes: a failed detail_hosts read used to
// be indistinguishable from a genuinely empty one (both collapsed to []any{}
// via Rest.Get). The failure is now logged instead of surfaced (this map only
// feeds a display-name lookup; callers already degrade to the raw id), but it
// must still come back as an empty map rather than panicking the caller.
func TestHostDisplayNames_UpstreamErrorReturnsEmptyMapNotPanic(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
	})

	got := s.hostDisplayNames()
	if got == nil || len(got) != 0 {
		t.Fatalf("hostDisplayNames() = %v, want an empty (non-nil) map on upstream error", got)
	}
}

// TestHostDisplayNames_GenuineEmptyReturnsEmptyMap confirms the original
// behavior survives the migration: a successful read with no hosts still
// yields an empty map, exactly as before.
func TestHostDisplayNames_GenuineEmptyReturnsEmptyMap(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[]}`))
	})

	got := s.hostDisplayNames()
	if got == nil || len(got) != 0 {
		t.Fatalf("hostDisplayNames() = %v, want an empty map on a genuinely empty result", got)
	}
}

// --- FetchInsights ---------------------------------------------------------

// TestFetchInsights_UpstreamErrorReportsLookupFailure is the regression test
// for defect 1: a 500 from /api/v1/insights used to be discarded (GetEx's
// status/error both thrown away), landing in the same
// {"data":[],"unavailable":"No SOC Insights ... in the last 30 days for this
// tenant."} shape as a genuinely quiet tenant — an assertion about the
// tenant's data when the truth is the read failed. It must now report a
// lookup failure and must NOT contain the tenant-fact sentence.
func TestFetchInsights_UpstreamErrorReportsLookupFailure(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	got := s.FetchInsights()

	if got["availability"] != "error" {
		t.Errorf("availability = %v, want \"error\"", got["availability"])
	}
	msg, _ := got["unavailable"].(string)
	if msg == "" {
		t.Fatalf("expected a non-empty unavailable message, got %v", got["unavailable"])
	}
	if strings.Contains(msg, "last 30 days for this tenant") {
		t.Errorf("upstream failure must not read as a tenant fact, got %q", msg)
	}
}

// TestFetchInsights_GenuineEmptyKeepsTenantFactWording confirms the other
// half: a successful 200 with zero insights keeps the exact pre-existing
// tenant-fact wording, unchanged.
func TestFetchInsights_GenuineEmptyKeepsTenantFactWording(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"insightList":[]}`))
	})

	got := s.FetchInsights()

	if got["availability"] != "ok" {
		t.Errorf("availability = %v, want \"ok\" for a genuinely empty (not dead) feed", got["availability"])
	}
	msg, _ := got["unavailable"].(string)
	if !strings.Contains(msg, "last 30 days for this tenant") {
		t.Errorf("genuine empty result should keep the tenant-fact wording, got %q", msg)
	}
}

func contains(ss []string, v string) bool {
	for _, s := range ss {
		if s == v {
			return true
		}
	}
	return false
}
