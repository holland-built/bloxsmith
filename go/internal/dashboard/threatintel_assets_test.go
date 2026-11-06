package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/mcp"
)

// Since 2026-09 Infoblox's security-action assets cube spans every security
// action, canonical or not, and its description says: "ALWAYS filter
// isCanonical = true when aggregating account-wide — otherwise similar/
// non-canonical group members are mixed in" (#253). FetchAssets aggregates
// account-wide in all three of its queries, so each must carry that filter,
// or the AI chat's asset_insights tool counts one device once per duplicate
// security action. (The Assets tab reads AssetDetails_ch_agg, see assets.go.)
func TestFetchAssets_EveryQueryIsCanonicalOnly(t *testing.T) {
	s, queries := assetsCubeService(t, `[]`)
	s.FetchAssets(context.Background())
	if len(*queries) != 3 {
		t.Fatalf("FetchAssets sent %d cube queries, want 3 (inventory, rollup, trend)", len(*queries))
	}
	for i, q := range *queries {
		if ms, _ := q["measures"].([]any); len(ms) == 0 || !strings.HasPrefix(fmt.Sprint(ms[0]), "SecurityActionAssetsV1.") {
			t.Fatalf("query %d measures %v, want the SecurityActionAssetsV1 cube", i, q["measures"])
		}
		if !hasCanonicalFilter(q["filters"]) {
			t.Errorf("query %d (measures %v) has no isCanonical = true filter: filters = %v",
				i, q["measures"], q["filters"])
		}
	}
}

// Cube.js answers "unable to process query (bad request)" to a dateRange of
// "30 days" and accepts "last 30 days" (checked live on 2026-11-06). The trend
// query used the first, so the whole Assets feed read "the query failed".
func TestFetchAssets_TrendAsksForTheLast30Days(t *testing.T) {
	s, queries := assetsCubeService(t, `[]`)
	s.FetchAssets(context.Background())
	if len(*queries) != 3 {
		t.Fatalf("FetchAssets sent %d cube queries, want 3", len(*queries))
	}
	td := timeRange(t, (*queries)[2])
	if td["dimension"] != "SecurityActionAssetsV1.createdAt" || td["dateRange"] != "last 30 days" {
		t.Errorf("trend time range = %v, want createdAt over \"last 30 days\"", td)
	}
}

// SecurityActionAssetsV1 refuses a query without a time range ("requires a
// bounded time range") and one over 400 days (checked live on 2026-11-06). The
// inventory and rollup ask for the whole 400 days, by lastDetected, so a device
// first recorded long ago still counts when it was seen recently.
func TestFetchAssets_InventoryAndRollupCoverThe400DaysInfobloxAllows(t *testing.T) {
	s, queries := assetsCubeService(t, `[]`)
	got := s.FetchAssets(context.Background())
	if len(*queries) != 3 {
		t.Fatalf("FetchAssets sent %d cube queries, want 3", len(*queries))
	}
	for i, name := range []string{"inventory", "rollup"} {
		td := timeRange(t, (*queries)[i])
		if td["dimension"] != "SecurityActionAssetsV1.lastDetected" || td["dateRange"] != "last 400 days" {
			t.Errorf("%s time range = %v, want lastDetected over \"last 400 days\"", name, td)
		}
	}
	if p, _ := got["period"].(string); !strings.Contains(p, "400 days") || !strings.Contains(p, "30 days") {
		t.Errorf("period = %q, want it to name the 400-day inventory and the 30-day trend", got["period"])
	}
}

// The MCP's query_cube cuts any range to 30 days and says so only in its text,
// so asking it after Cube.js refused would label a 30-day answer "400 days".
// FetchAssets reports the feed unavailable instead. assetsCubeService fails
// the test if the MCP is asked.
func TestFetchAssets_ARefusedQueryIsUnavailableNotAskedOfTheMCP(t *testing.T) {
	s, queries := assetsCubeServiceStatus(t, `[]`, http.StatusBadRequest)
	got := s.FetchAssets(context.Background())
	if len(*queries) != 3 {
		t.Fatalf("FetchAssets sent %d cube queries, want 3", len(*queries))
	}
	if got["unavailable"] == nil {
		t.Errorf("unavailable = nil after Cube.js refused every query, want a reason")
	}
}

func timeRange(t *testing.T, q map[string]any) map[string]any {
	t.Helper()
	tds, _ := q["timeDimensions"].([]any)
	if len(tds) != 1 {
		t.Fatalf("query %v has %d time ranges, want 1", q["measures"], len(tds))
	}
	return tds[0].(map[string]any)
}

// assetsCubeService fakes the Portal's Cube.js endpoint FetchAssets talks to.
// Every query is answered with rowsJSON as its data and recorded, in order.
// Any other call, such as one to the MCP, fails the test.
func assetsCubeService(t *testing.T, rowsJSON string) (*Service, *[]map[string]any) {
	return assetsCubeServiceStatus(t, rowsJSON, http.StatusOK)
}

func assetsCubeServiceStatus(t *testing.T, rowsJSON string, status int) (*Service, *[]map[string]any) {
	t.Helper()
	var mu sync.Mutex
	queries := &[]map[string]any{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/api/cubejs/v1/query" {
			t.Errorf("FetchAssets called %s %s; it must ask Cube.js only, never the MCP", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		var body struct {
			Query string `json:"query"`
		}
		_ = json.Unmarshal(raw, &body)
		var q map[string]any
		_ = json.Unmarshal([]byte(body.Query), &q)
		mu.Lock()
		*queries = append(*queries, q)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"result":{"data":` + rowsJSON + `}}`))
	}))
	t.Cleanup(srv.Close)
	return &Service{Mcp: mcp.New(srv.URL, func() string { return "Bearer test" }), Cache: cache.New()}, queries
}

// Every query keeps to 6 dimensions. The MCP query_cube guardrail refuses a
// 7th outright ("Query blocked by guardrail", measured live on 2026-08-06, see
// assets.go). The inventory once asked for 9, so it could never return rows.
func TestFetchAssets_QueriesStayUnderTheDimensionLimit(t *testing.T) {
	s, queries := assetsCubeService(t, `[]`)
	s.FetchAssets(context.Background())
	for i, q := range *queries {
		dims, _ := q["dimensions"].([]any)
		if len(dims) > 6 {
			t.Errorf("query %d asks for %d dimensions, the guardrail allows 6: %v", i, len(dims), dims)
		}
	}
}

// SecurityActionAssets has one row per (security action, asset) pair, and its
// count measure counts those pairs. A device two canonical security actions
// touched would count twice. The inventory groups by assetCqid, one row per
// device, and the trend counts uniqueDevices.
func TestFetchAssets_CountsEachDeviceOnce(t *testing.T) {
	s, queries := assetsCubeService(t, `[]`)
	s.FetchAssets(context.Background())
	if len(*queries) != 3 {
		t.Fatalf("FetchAssets sent %d cube queries, want 3", len(*queries))
	}
	inv, trend := (*queries)[0], (*queries)[2]
	if dims, _ := inv["dimensions"].([]any); len(dims) == 0 || dims[0] != "SecurityActionAssetsV1.assetCqid" {
		t.Errorf("inventory dimensions = %v, want assetCqid first, so each row is one device", inv["dimensions"])
	}
	for name, q := range map[string]map[string]any{"inventory": inv, "trend": trend} {
		for _, m := range q["measures"].([]any) {
			if m == "SecurityActionAssetsV1.count" {
				t.Errorf("%s measures = %v; count counts each (security action, device) pair", name, q["measures"])
			}
		}
	}
	if ms := trend["measures"].([]any); len(ms) != 1 || ms[0] != "SecurityActionAssetsV1.uniqueDevices" {
		t.Errorf("trend measures = %v, want [SecurityActionAssetsV1.uniqueDevices]", trend["measures"])
	}
}

// Grouping by six dimensions still splits a device into two rows when one of
// them, here isRisky, differs between its security actions. FetchAssets
// merges rows by assetCqid, so each device is listed once with its total.
func TestFetchAssets_MergesADeviceSplitAcrossRows(t *testing.T) {
	s, _ := assetsCubeService(t, `[`+
		`{"SecurityActionAssetsV1.assetCqid": "cq-1", "SecurityActionAssetsV1.deviceName": "host-042", `+
		`"SecurityActionAssetsV1.isRisky": false, "SecurityActionAssetsV1.uniqueSecurityActions": "2"}, `+
		`{"SecurityActionAssetsV1.assetCqid": "cq-1", "SecurityActionAssetsV1.deviceName": "host-042", `+
		`"SecurityActionAssetsV1.isRisky": true, "SecurityActionAssetsV1.uniqueSecurityActions": "1"}, `+
		`{"SecurityActionAssetsV1.assetCqid": "cq-2", "SecurityActionAssetsV1.deviceName": "host-043", `+
		`"SecurityActionAssetsV1.isRisky": false, "SecurityActionAssetsV1.uniqueSecurityActions": "1"}]`)
	assets, _ := s.FetchAssets(context.Background())["assets"].([]any)
	if len(assets) != 2 {
		t.Fatalf("assets = %v, want 2 devices", assets)
	}
	a := assets[0].(map[string]any)
	if a["device"] != "host-042" || a["security_actions"] != 3 || a["risky"] != true {
		t.Errorf("merged asset = %v, want host-042 with security_actions 3 and risky true", a)
	}
}

// A successful cube reply comes back as rows, not as "unavailable".
func TestFetchAssets_ReturnsTheRowsTheCubeSends(t *testing.T) {
	s, _ := assetsCubeService(t, `[{"SecurityActionAssetsV1.assetCqid": "cq-1", `+
		`"SecurityActionAssetsV1.deviceName": "host-042", "SecurityActionAssetsV1.os": "Windows", `+
		`"SecurityActionAssetsV1.uniqueSecurityActions": "2", "SecurityActionAssetsV1.uniqueDevices": "1"}]`)
	got := s.FetchAssets(context.Background())
	if got["unavailable"] != nil {
		t.Fatalf("unavailable = %v, want nil for a successful reply", got["unavailable"])
	}
	assets, _ := got["assets"].([]any)
	if len(assets) != 1 {
		t.Fatalf("assets = %v, want the one row the cube sent", got["assets"])
	}
	a := assets[0].(map[string]any)
	if a["device"] != "host-042" || a["os"] != "Windows" || a["security_actions"] != 2 {
		t.Errorf("asset = %v, want device host-042, os Windows, security_actions 2", a)
	}
}

func hasCanonicalFilter(v any) bool {
	filters, _ := v.([]any)
	for _, f := range filters {
		m, _ := f.(map[string]any)
		values, _ := m["values"].([]any)
		if m["member"] == "SecurityActionAssetsV1.isCanonical" && m["operator"] == "equals" &&
			len(values) == 1 && values[0] == "true" {
			return true
		}
	}
	return false
}

// The cube stops at assetInsightLimit rows, before normAssets merges them, so
// a full reply may be missing devices and the last device's total may be
// partial. The result says so, or asset_insights would present it as complete.
func TestAssembleAssetsResult_MarksAFullInventoryAsTruncated(t *testing.T) {
	full := make([]map[string]any, assetInsightLimit)
	for i := range full {
		full[i] = map[string]any{"SecurityActionAssetsV1.assetCqid": fmt.Sprintf("cq-%d", i)}
	}
	got := assembleAssetsResult(true, full, []map[string]any{}, []map[string]any{})
	if got["truncated"] != true || got["note"] == nil {
		t.Errorf("truncated = %v, note = %v; want true and a note for a reply at the row limit", got["truncated"], got["note"])
	}
	short := assembleAssetsResult(true, full[:1], []map[string]any{}, []map[string]any{})
	if short["truncated"] != false {
		t.Errorf("truncated = %v for a reply under the limit, want false", short["truncated"])
	}
}

// The rollup's groups must not overlap. isVerified differs between a device's
// security actions, so grouping by it puts one device in both the verified and
// the unverified group and the groups add up to more devices than exist. The
// rollup groups by os only, a property of the device.
func TestFetchAssets_RollupGroupsDoNotOverlap(t *testing.T) {
	s, queries := assetsCubeService(t, `[]`)
	s.FetchAssets(context.Background())
	if len(*queries) != 3 {
		t.Fatalf("FetchAssets sent %d cube queries, want 3", len(*queries))
	}
	dims, _ := (*queries)[1]["dimensions"].([]any)
	if len(dims) != 1 || dims[0] != "SecurityActionAssetsV1.os" {
		t.Errorf("rollup dimensions = %v, want [SecurityActionAssetsV1.os]", dims)
	}
}

// The rollup stops at assetRollupLimit OS groups. A reply that long may be
// missing groups, and the result says so.
func TestAssembleAssetsResult_MarksAFullRollupAsTruncated(t *testing.T) {
	full := make([]map[string]any, assetRollupLimit)
	for i := range full {
		full[i] = map[string]any{"SecurityActionAssetsV1.os": fmt.Sprintf("os-%d", i)}
	}
	got := assembleAssetsResult(true, []map[string]any{{"SecurityActionAssetsV1.assetCqid": "cq-1"}}, full, []map[string]any{})
	if got["truncated"] != true || got["note"] == nil {
		t.Errorf("truncated = %v, note = %v; want true and a note for a rollup at its limit", got["truncated"], got["note"])
	}
}
