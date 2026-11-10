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

// These pin the V1 queries cube_names.go records as matching the old cubes
// live. Each one checks the part that made the numbers match, not only the
// cube name.

// recordingCubeService answers every direct Cube.js query with body and keeps
// the query text it was sent. It counts MCP calls, which must stay at zero:
// the MCP would cut a time range to 30 days.
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

const assetsRange = `"timeDimensions":[{"dateRange":"from 365 days ago to now","dimension":"AssetDetailsAggV1.updated_at"}]`

func TestAssetReads_AskV1WithARangeAndATieBreaker(t *testing.T) {
	ctx := context.Background()

	s, seen, mcpCalls := recordingCubeService(t, `{"result":{"data":[]}}`)
	s.assetInventoryUncached(ctx, normalizeAssetQuery("vm", "", "", "", 1))
	got := strings.Join(seen(), "\n")
	for _, want := range []string{
		// The list: assetName (V1's name), the last_seen sort then cqid, page 2.
		`"dimensions":["AssetDetailsAggV1.cqid","AssetDetailsAggV1.assetName","AssetDetailsAggV1.taxonomy_type_label","AssetDetailsAggV1.providers_label","AssetDetailsAggV1.vendor","AssetDetailsAggV1.last_seen"]`,
		`"order":{"AssetDetailsAggV1.last_seen":"desc","AssetDetailsAggV1.cqid":"asc"}`,
		`"offset":50`,
		`{"member":"AssetDetailsAggV1.assetName","operator":"contains","values":["vm"]}`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("list query lacks %s\nsent:\n%s", want, got)
		}
	}
	if n := strings.Count(got, assetsRange); n != 2 {
		t.Errorf("want the snapshot range on both the list and the count, found it %d times in:\n%s", n, got)
	}

	s, seen, _ = recordingCubeService(t, `{"result":{"data":[]}}`)
	s.assetFiltersUncached(ctx)
	got = strings.Join(seen(), "\n")
	if !strings.Contains(got, `"order":{"AssetDetailsAggV1.assetsCount":"desc","AssetDetailsAggV1.taxonomy_type_label":"asc"}`) ||
		strings.Count(got, assetsRange) != 2 {
		t.Errorf("type chips: want count desc then label asc, and the range on both reads; sent:\n%s", got)
	}

	s, seen, _ = recordingCubeService(t, `{"result":{"data":[]}}`)
	s.assetDetailUncached(ctx, "cq-1")
	if got = strings.Join(seen(), "\n"); !strings.Contains(got, assetsRange) {
		t.Errorf("detail read lacks the snapshot range; sent:\n%s", got)
	}

	if mcpCalls.Load() != 0 {
		t.Errorf("an asset read went to the MCP %d times", mcpCalls.Load())
	}
}

// A refused V1 query (no range, say) must not be retried on the MCP, whose
// answer to a time-bounded query covers only 30 days.
func TestAssetReads_DoNotFallBackToTheMCP(t *testing.T) {
	s, _, mcpCalls := recordingCubeService(t, `{"error":"requires a bounded time range"}`)
	got := s.assetInventoryUncached(context.Background(), defaultQuery())
	if got["availability"] != "error" {
		t.Errorf("availability = %v, want error", got["availability"])
	}
	if mcpCalls.Load() != 0 {
		t.Errorf("fell back to the MCP %d times", mcpCalls.Load())
	}
}

func TestAssetRows_ReadAssetName(t *testing.T) {
	rows := normAssetRows([]map[string]any{{"AssetDetailsAggV1.cqid": "c1", "AssetDetailsAggV1.assetName": "host-a"}})
	if n := rows[0].(map[string]any)["name"]; n != "host-a" {
		t.Errorf("name = %v, want host-a from assetName", n)
	}
}

func TestScalarTiles_AskV1WithTheirRange(t *testing.T) {
	for _, c := range []struct {
		name string
		call func(*Service) map[string]any
		want string
	}{
		{"discovery status", func(s *Service) map[string]any { return s.CSPDiscoveryStatus(context.Background()) },
			`{"measures":["AssetDiscoveryStatusV1.rowCount"],"timeDimensions":[{"dateRange":"from 365 days ago to now","dimension":"AssetDiscoveryStatusV1.updated_at"}]}`},
		// evaluation_time, not sync_time: sync_time counted differently on V1.
		{"asset insights", func(s *Service) map[string]any { return s.CSPAssetInsights(context.Background()) },
			`{"measures":["AssetInsightV1.count"],"timeDimensions":[{"dateRange":"from 365 days ago to now","dimension":"AssetInsightV1.evaluation_time"}]}`},
	} {
		s, seen, mcpCalls := recordingCubeService(t,
			`{"result":{"data":[{"AssetDiscoveryStatusV1.rowCount":"16505","AssetInsightV1.count":"2954"}]}}`)
		res := c.call(s)
		if q := seen(); len(q) != 1 || q[0] != c.want {
			t.Errorf("%s: sent %v\nwant %s", c.name, q, c.want)
		}
		if res["status"] != "ok" || (res["total"] != 16505 && res["total"] != 2954) {
			t.Errorf("%s: got %v", c.name, res)
		}
		if mcpCalls.Load() != 0 {
			t.Errorf("%s: went to the MCP", c.name)
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

// New assets are windowed on first_seen, which V1 accepts on its own; the
// snapshot range is only for "now".
func TestBuildChartQuery_NewAssetsKeepTheirOwnRangeAndATieBreaker(t *testing.T) {
	q, _, err := BuildChartQuery(ChartPicks{Count: "newassets", Split: "vendor", Window: "30d", Over: "none", Top: 10})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"dimensions":["AssetDetailsAggV1.vendor"],"limit":10,"measures":["AssetDetailsAggV1.assetsCount"],` +
		`"order":{"AssetDetailsAggV1.assetsCount":"desc","AssetDetailsAggV1.vendor":"asc"},` +
		`"timeDimensions":[{"dateRange":"last 30 days","dimension":"AssetDetailsAggV1.first_seen"}]}`
	if b, _ := json.Marshal(q); string(b) != want {
		t.Errorf("sent %s\nwant %s", b, want)
	}
}

func TestCubeOrder_KeepsItsOrder(t *testing.T) {
	b, _ := json.Marshal(cubeOrder{{"X.last_seen", "desc"}, {"X.cqid", "asc"}})
	if string(b) != `{"X.last_seen":"desc","X.cqid":"asc"}` {
		t.Errorf("got %s", b)
	}
}
