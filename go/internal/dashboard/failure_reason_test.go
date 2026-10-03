package dashboard

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/mcp"
)

// refusedService is a tenant whose user lacks the ib-mcp-server-user group:
// every MCP call, the handshake included, and the Cube.js endpoint answer
// HTTP 403 "Authorization denied". The panels must say why, not just fail.
func refusedService(t *testing.T) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":-32600,"message":"Authorization denied"}}`))
	}))
	t.Cleanup(srv.Close)
	return &Service{Mcp: mcp.New(srv.URL+"/mcp", func() string { return "Token k" }), Cache: cache.New()}
}

func wantGroupNamed(t *testing.T, what, got string) {
	t.Helper()
	if !strings.Contains(got, "ib-mcp-server-user") || !strings.Contains(got, "PTCI-4674") {
		t.Errorf("%s: want the missing group and ticket named, got %q", what, got)
	}
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func TestRefusedCallsNameTheMissingGroup(t *testing.T) {
	ctx := context.Background()
	s := refusedService(t)

	wantGroupNamed(t, "asset inventory", str(s.assetInventoryUncached(ctx, AssetQuery{Sort: "name", Dir: "asc"})["reason"]))
	wantGroupNamed(t, "asset filters", str(s.assetFiltersUncached(ctx)["reason"]))
	wantGroupNamed(t, "asset detail", str(s.assetDetailUncached(ctx, "cq-1")["reason"]))
	wantGroupNamed(t, "IQ actions list", str(s.FetchActions(ctx)["unavailable"]))
	wantGroupNamed(t, "IQ action detail", str(s.GetAction(ctx, "a1")["unavailable"]))
	wantGroupNamed(t, "threat lookup", str(s.ThreatLookup(ctx, "example.com")["reason"]))
	wantGroupNamed(t, "ask: search_entity", s.RunAITool(ctx, "search_entity", map[string]any{"query": "example.com"}))

	for name, res := range map[string]map[string]any{
		"block":   s.BlockDomain(ctx, "bad.example.com", "list-1"),
		"unblock": s.UnblockDomain(ctx, "bad.example.com", "list-1"),
	} {
		wantGroupNamed(t, name, str(res["error"]))
		// The handshake was refused, so nothing was sent: safe to retry.
		if res["outcome"] != "rejected" {
			t.Errorf("%s: outcome = %v, want rejected (nothing was sent)", name, res["outcome"])
		}
	}
}

// A Block or Unblock whose reply never arrives may already have landed. It must
// not read "rejected" (the Security tab's wording for "nothing applied, safe to
// retry") next to a Retry button; it reads "unverified", which asks the person
// to re-check first.
func TestATimedOutBlockIsUnverifiedNotRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var req struct {
			Method string `json:"method"`
			ID     int    `json:"id"`
		}
		_ = json.Unmarshal(raw, &req)
		switch req.Method {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", "s1")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + itoa(req.ID) + `,"result":{}}`))
		case "tools/call":
			<-r.Context().Done()
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(srv.Close)
	s := &Service{Mcp: mcp.New(srv.URL+"/mcp", func() string { return "Token k" })}

	for name, call := range map[string]func(context.Context) map[string]any{
		"block":   func(c context.Context) map[string]any { return s.BlockDomain(c, "bad.example.com", "list-1") },
		"unblock": func(c context.Context) map[string]any { return s.UnblockDomain(c, "bad.example.com", "list-1") },
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		res := call(ctx)
		cancel()
		if res["outcome"] != "unverified" {
			t.Fatalf("%s: outcome = %v, want unverified (the write may have landed); error: %v", name, res["outcome"], res["error"])
		}
		if !strings.Contains(str(res["error"]), "did not answer") {
			t.Errorf("%s: want the error to say Infoblox did not answer, got %q", name, str(res["error"]))
		}
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
