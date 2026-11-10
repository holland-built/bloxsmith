package dashboard

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/mcp"
)

// These pin the cube decisions cube_names.go records from live checks: the V1
// queries that matched, and the asset cubes held on their old names.

// recordingCubeService answers every direct Cube.js query with body and keeps
// the query text it was sent. It also counts calls that reach the MCP.
func recordingCubeService(t *testing.T, body string) (*Service, func() []string, *atomic.Int32) {
	t.Helper()
	var mu sync.Mutex
	var seen []string
	var mcpCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/cubejs/v1/query" {
			mcpCalls.Add(1)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var req struct {
			Query string `json:"query"`
		}
		_ = json.Unmarshal(raw, &req)
		mu.Lock()
		seen = append(seen, req.Query)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	s := &Service{Mcp: mcp.New(srv.URL+"/mcp", func() string { return "Token k" }), Cache: cache.New()}
	return s, func() []string { mu.Lock(); defer mu.Unlock(); return append([]string{}, seen...) }, &mcpCalls
}

// The three asset cubes stay on their old names with no time range: V1 caps a
// range at 400 days, so any bound would quietly drop older records
// (cube_names.go). These pin that no read slips a range or a V1 name back in.
func TestAssetCubes_HeldUnboundedOnTheOldNames(t *testing.T) {
	ctx := context.Background()
	s, seen, _ := recordingCubeService(t, `{"result":{"data":[]}}`)
	s.assetInventoryUncached(ctx, normalizeAssetQuery("vm", "", "", "", 1))
	s.assetFiltersUncached(ctx)
	s.assetDetailUncached(ctx, "cq-1")
	s.CSPDiscoveryStatus(ctx)
	s.CSPAssetInsights(ctx)
	got := seen()
	if len(got) != 7 {
		t.Fatalf("want 7 reads (list, count, chips, count, detail, two tiles), got %d:\n%s", len(got), strings.Join(got, "\n"))
	}
	for _, q := range got {
		if strings.Contains(q, "timeDimensions") || strings.Contains(q, "V1.") {
			t.Errorf("asset read carries a time range or a V1 cube: %s", q)
		}
	}
	joined := strings.Join(got, "\n")
	for _, want := range []string{
		`"measures":["AssetDiscoveryStatus.count"]`,
		`"measures":["AssetInsight.count"]`,
		`"AssetDetails_ch_agg.name"`,
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("no read has %s:\n%s", want, joined)
		}
	}
	for _, p := range []ChartPicks{
		{Count: "assets", Split: "vendor", Window: "now", Over: "none", Top: 10},
		{Count: "assets", Split: "none", Window: "now", Over: "none"},
	} {
		q, _, err := BuildChartQuery(p)
		if err != nil {
			t.Fatal(err)
		}
		if b, _ := json.Marshal(q); strings.Contains(string(b), "timeDimensions") || !strings.Contains(string(b), `"AssetDetails_ch_agg.assetsCount"`) {
			t.Errorf("%+v: %s", p, b)
		}
	}
}

// The DNS query-rate panel reads V1's stored hour rows: without the
// granularity filter V1 averages 5-minute rows into other numbers.
func TestCSPDNSQps_ReadsTheStoredHourRows(t *testing.T) {
	var q map[string]any
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q = cubeQueryFromRequest(t, r)
		_, _ = w.Write([]byte(`{"result":{"data":[{"HostMetricsV1.timestamp.hour":"2026-11-10T01:00:00.000","HostMetricsV1.avg_value":10.25}]}}`))
	})
	res := s.CSPDNSQps()
	want := `{"filters":[{"member":"HostMetricsV1.metric_name","operator":"equals","values":["dns_qps_iq"]},` +
		`{"member":"HostMetricsV1.granularity","operator":"equals","values":["hour"]}],` +
		`"measures":["HostMetricsV1.avg_value"],` +
		`"timeDimensions":[{"dateRange":"last 24 hours","dimension":"HostMetricsV1.timestamp","granularity":"hour"}]}`
	if b, _ := json.Marshal(q); string(b) != want {
		t.Errorf("sent %s\nwant %s", b, want)
	}
	rows, _ := res["rows"].([]map[string]any)
	if len(rows) != 1 || rows[0]["avg_value"] != 10.25 {
		t.Errorf("rows = %v", res["rows"])
	}
}

func TestBuildChartQuery_QPSReadsTheStoredStepItDraws(t *testing.T) {
	for _, c := range []struct {
		window, over, step string
	}{
		{"24h", "hour", "hour"}, {"today", "hour", "hour"},
		{"7d", "day", "day"}, {"lastmonth", "day", "day"},
		{"30d", "none", ""}, // a one-total chart: both cubes pick the same rows
	} {
		q, _, err := BuildChartQuery(ChartPicks{Count: "qps", Split: "none", Window: c.window, Over: c.over})
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(q["filters"])
		tier := `{"member":"HostMetricsV1.granularity","operator":"equals","values":["` + c.step + `"]}`
		if has := strings.Contains(string(b), "HostMetricsV1.granularity"); has != (c.step != "") ||
			(c.step != "" && !strings.Contains(string(b), tier)) {
			t.Errorf("%s by %s: filters = %s, want step %q", c.window, c.over, b, c.step)
		}
	}
}
