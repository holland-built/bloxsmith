package dashboard

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/mcp"
)

// Since 2026-09 Infoblox's SecurityActionAssets cube spans every security
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
		if q["cube_name"] != "SecurityActionAssets" {
			t.Fatalf("query %d is on %v, want SecurityActionAssets", i, q["cube_name"])
		}
		if !hasCanonicalFilter(q["filters"]) {
			t.Errorf("query %d (measures %v) has no isCanonical = true filter: filters = %v",
				i, q["measures"], q["filters"])
		}
	}
}

// assetsCubeService fakes the MCP endpoint FetchAssets talks to. Every cube
// query is answered with replyText and its arguments are recorded, in order.
func assetsCubeService(t *testing.T, replyText string) (*Service, *[]map[string]any) {
	t.Helper()
	var mu sync.Mutex
	queries := &[]map[string]any{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var req struct {
			Method string `json:"method"`
			ID     *int   `json:"id"`
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		_ = json.Unmarshal(raw, &req)
		w = echoRPCID(w, raw)
		switch req.Method {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", "test-session")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
		case "tools/call":
			if req.Params.Name == "infoblox-portal_query_cube" {
				mu.Lock()
				*queries = append(*queries, req.Params.Arguments)
				mu.Unlock()
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": *req.ID,
				"result": map[string]any{"content": []map[string]any{{"text": replyText}}},
			})
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
		}
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
	if dims, _ := inv["dimensions"].([]any); len(dims) == 0 || dims[0] != "SecurityActionAssets.assetCqid" {
		t.Errorf("inventory dimensions = %v, want assetCqid first, so each row is one device", inv["dimensions"])
	}
	for name, q := range map[string]map[string]any{"inventory": inv, "trend": trend} {
		for _, m := range q["measures"].([]any) {
			if m == "SecurityActionAssets.count" {
				t.Errorf("%s measures = %v; count counts each (security action, device) pair", name, q["measures"])
			}
		}
	}
	if ms := trend["measures"].([]any); len(ms) != 1 || ms[0] != "SecurityActionAssets.uniqueDevices" {
		t.Errorf("trend measures = %v, want [SecurityActionAssets.uniqueDevices]", trend["measures"])
	}
}

// Grouping by six dimensions still splits a device into two rows when one of
// them, here isRisky, differs between its security actions. FetchAssets
// merges rows by assetCqid, so each device is listed once with its total.
func TestFetchAssets_MergesADeviceSplitAcrossRows(t *testing.T) {
	row := "Query Result: [" +
		"{'SecurityActionAssets.assetCqid': 'cq-1', 'SecurityActionAssets.deviceName': 'host-042', " +
		"'SecurityActionAssets.isRisky': 'false', 'SecurityActionAssets.uniqueSecurityActions': '2'}, " +
		"{'SecurityActionAssets.assetCqid': 'cq-1', 'SecurityActionAssets.deviceName': 'host-042', " +
		"'SecurityActionAssets.isRisky': 'true', 'SecurityActionAssets.uniqueSecurityActions': '1'}, " +
		"{'SecurityActionAssets.assetCqid': 'cq-2', 'SecurityActionAssets.deviceName': 'host-043', " +
		"'SecurityActionAssets.isRisky': 'false', 'SecurityActionAssets.uniqueSecurityActions': '1'}]."
	reply, _ := json.Marshal(map[string]string{"message": row})
	s, _ := assetsCubeService(t, string(reply))
	assets, _ := s.FetchAssets(context.Background())["assets"].([]any)
	if len(assets) != 2 {
		t.Fatalf("assets = %v, want 2 devices", assets)
	}
	a := assets[0].(map[string]any)
	if a["device"] != "host-042" || a["security_actions"] != 3 || a["risky"] != true {
		t.Errorf("merged asset = %v, want host-042 with security_actions 3 and risky true", a)
	}
}

// A successful cube reply comes back as rows, not as "unavailable". The other
// tests answer "[]", which the client cannot parse, so they only ever see the
// failure path.
func TestFetchAssets_ReturnsTheRowsTheCubeSends(t *testing.T) {
	row := "Query Result: [{'SecurityActionAssets.assetCqid': 'cq-1', " +
		"'SecurityActionAssets.deviceName': 'host-042', 'SecurityActionAssets.os': 'Windows', " +
		"'SecurityActionAssets.uniqueSecurityActions': '2', 'SecurityActionAssets.uniqueDevices': '1'}]."
	reply, _ := json.Marshal(map[string]string{"message": row})
	s, _ := assetsCubeService(t, string(reply))
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
		if m["member"] == "SecurityActionAssets.isCanonical" && m["operator"] == "equals" &&
			len(values) == 1 && values[0] == "true" {
			return true
		}
	}
	return false
}
