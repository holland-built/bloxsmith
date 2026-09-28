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
// or the Assets panel counts one device once per duplicate security action.
func TestFetchAssets_EveryQueryIsCanonicalOnly(t *testing.T) {
	var mu sync.Mutex
	var queries []map[string]any
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
				queries = append(queries, req.Params.Arguments)
				mu.Unlock()
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": *req.ID,
				"result": map[string]any{"content": []map[string]any{{"text": "[]"}}},
			})
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
		}
	}))
	t.Cleanup(srv.Close)
	s := &Service{Mcp: mcp.New(srv.URL, func() string { return "Bearer test" }), Cache: cache.New()}

	s.FetchAssets(context.Background())

	mu.Lock()
	defer mu.Unlock()
	if len(queries) != 3 {
		t.Fatalf("FetchAssets sent %d cube queries, want 3 (inventory, rollup, trend)", len(queries))
	}
	for i, q := range queries {
		if q["cube_name"] != "SecurityActionAssets" {
			t.Fatalf("query %d is on %v, want SecurityActionAssets", i, q["cube_name"])
		}
		if !hasCanonicalFilter(q["filters"]) {
			t.Errorf("query %d (measures %v) has no isCanonical = true filter: filters = %v",
				i, q["measures"], q["filters"])
		}
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
