package mcp

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestConcurrentInitializeSingleHandshake verifies Initialize is idempotent
// under concurrent callers: exactly one handshake reaches the server no
// matter how many goroutines call it at once.
func TestConcurrentInitializeSingleHandshake(t *testing.T) {
	var initCount int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     *int   `json:"id"`
			Method string `json:"method"`
		}
		body, _ := decodeBody(r)
		_ = json.Unmarshal(body, &req)

		switch req.Method {
		case "initialize":
			atomic.AddInt32(&initCount, 1)
			w.Header().Set("Mcp-Session-Id", "test-session")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
		case "notifications/initialized":
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
		}
	}))
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })

	const n = 8
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = c.Initialize(t.Context())
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("goroutine %d: Initialize returned error: %v", i, err)
		}
	}
	if got := atomic.LoadInt32(&initCount); got != 1 {
		t.Fatalf("expected exactly 1 handshake to reach the server, got %d", got)
	}
}

// TestStalledToolCallReturnsWithinDeadline verifies the bounded-deadline
// fallback in post(): a ctx with no deadline is wrapped in callTimeout, so a
// server that never responds still returns an error instead of hanging.
func TestStalledToolCallReturnsWithinDeadline(t *testing.T) {
	old := callTimeout
	callTimeout = 2 * time.Second
	defer func() { callTimeout = old }()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
		}
		body, _ := decodeBody(r)
		_ = json.Unmarshal(body, &req)

		if req.Method == "tools/call" {
			// Simulate a stalled upstream call: sleep, but bail out early if
			// the client cancels (bounded deadline from post()) so the test
			// server doesn't hang on Close().
			select {
			case <-time.After(30 * time.Second):
			case <-r.Context().Done():
			}
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })

	start := time.Now()
	_, err := c.CallTool(t.Context(), "infoblox-portal_make_get_request", map[string]any{})
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected an error from a stalled tools/call, got nil")
	}
	if elapsed >= 15*time.Second {
		t.Fatalf("expected the call to return within 15s (bounded deadline), took %v", elapsed)
	}
}

// decodeBody reads the request body so the handler can dispatch on method.
func decodeBody(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	return io.ReadAll(r.Body)
}
