package dashboard

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/mcp"
)

// directCubeOnlyService is a tenant where the Portal's Cube.js endpoint answers
// and the MCP refuses every call, the way the Infoblox Sales key does without
// the ib-mcp-server-user group (HTTP 403 on initialize too). A panel that only
// reads cube data must still render, because the direct endpoint can answer it.
func directCubeOnlyService(t *testing.T, cubeBody string) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/cubejs/v1/query" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(cubeBody))
			return
		}
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":-32600,"message":"Authorization denied"}}`))
	}))
	t.Cleanup(srv.Close)
	return &Service{Mcp: mcp.New(srv.URL+"/mcp", func() string { return "Token k" }), Cache: cache.New()}
}

func TestCubePanelsDoNotNeedTheMCPSession(t *testing.T) {
	ctx := context.Background()

	t.Run("scalar count", func(t *testing.T) {
		s := directCubeOnlyService(t, `{"result":{"data":[{"Assets.n":"7"}]}}`)
		got := s.scalarCount(ctx, "Assets", "Assets.n", "note")
		if got["status"] != "ok" || got["total"] != 7 {
			t.Errorf("want status ok and total 7, got %v", got)
		}
	})

	t.Run("asset inventory", func(t *testing.T) {
		s := directCubeOnlyService(t, `{"result":{"data":[]}}`)
		got := s.assetInventoryUncached(ctx, AssetQuery{Sort: "name", Dir: "asc"})
		if got["availability"] == "error" {
			t.Errorf("the direct endpoint answered, but the inventory says %v", got["reason"])
		}
	})

	t.Run("asset filters", func(t *testing.T) {
		s := directCubeOnlyService(t, `{"result":{"data":[]}}`)
		got := s.assetFiltersUncached(ctx)
		if got["availability"] == "error" {
			t.Errorf("the direct endpoint answered, but the filters say %v", got["reason"])
		}
	})

	t.Run("asset detail", func(t *testing.T) {
		s := directCubeOnlyService(t, `{"result":{"data":[]}}`)
		got := s.assetDetailUncached(ctx, "cq-1")
		if got["availability"] != "empty" {
			t.Errorf("want availability empty (asset not found), got %v: %v", got["availability"], got["reason"])
		}
	})

	t.Run("security-action assets", func(t *testing.T) {
		s := directCubeOnlyService(t, `{"result":{"data":[]}}`)
		got := s.FetchAssets(ctx)
		if got["unavailable"] != nil {
			t.Errorf("the direct endpoint answered, but the panel says %v", got["unavailable"])
		}
	})
}
