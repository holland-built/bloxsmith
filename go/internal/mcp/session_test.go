package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// sessionServer hands out a numbered session per initialize and records, for
// every later call, which key and which session id arrived together. A session
// listed in expired answers 404, the way the CSP does for a session it dropped.
type sessionServer struct {
	mu      sync.Mutex
	issued  int
	inits   []string // Authorization header of each initialize
	calls   []string // "<Authorization> <Mcp-Session-Id>" of each tools/call
	expired map[string]bool
}

func (s *sessionServer) handler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     int    `json:"id"`
		Method string `json:"method"`
	}
	body, _ := decodeBody(r)
	_ = json.Unmarshal(body, &req)

	s.mu.Lock()
	defer s.mu.Unlock()
	switch req.Method {
	case "initialize":
		s.issued++
		s.inits = append(s.inits, r.Header.Get("Authorization"))
		w.Header().Set("Mcp-Session-Id", "session-"+string(rune('0'+s.issued)))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":{}}`, req.ID)))
	case "notifications/initialized":
		w.WriteHeader(http.StatusOK)
	default:
		sid := r.Header.Get("Mcp-Session-Id")
		s.calls = append(s.calls, r.Header.Get("Authorization")+" "+sid)
		if s.expired[sid] {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":{}}`, req.ID)))
	}
}

// A tenant switch changes the key the client sends. A session that was opened
// under the old key must not travel with the new one: the client opens a new
// session for the new tenant.
func TestInitializeOpensANewSessionWhenTheKeyChanges(t *testing.T) {
	s := &sessionServer{}
	srv := httptest.NewServer(http.HandlerFunc(s.handler))
	defer srv.Close()

	key := "Bearer tenant-a"
	c := New(srv.URL, func() string { return key })
	ctx := t.Context()

	if err := c.Initialize(ctx); err != nil {
		t.Fatalf("first Initialize: %v", err)
	}
	if _, err := c.CallTool(ctx, "x", nil); err != nil {
		t.Fatalf("call as tenant A: %v", err)
	}

	key = "Bearer tenant-b"
	if err := c.Initialize(ctx); err != nil {
		t.Fatalf("Initialize after the switch: %v", err)
	}
	if _, err := c.CallTool(ctx, "x", nil); err != nil {
		t.Fatalf("call as tenant B: %v", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.inits) != 2 || s.inits[1] != "Bearer tenant-b" {
		t.Fatalf("want a second handshake made with tenant B's key, got handshakes %v", s.inits)
	}
	want := []string{"Bearer tenant-a session-1", "Bearer tenant-b session-2"}
	if len(s.calls) != 2 || s.calls[0] != want[0] || s.calls[1] != want[1] {
		t.Fatalf("tenant B's call must carry tenant B's own session, got %v want %v", s.calls, want)
	}
}

// The server can drop a session at any time and answers 404 to it. The failed
// call is reported, and the next Initialize opens a fresh session instead of
// believing the dead one is still good.
func TestInitializeOpensANewSessionAfterAnExpiredOne(t *testing.T) {
	s := &sessionServer{expired: map[string]bool{"session-1": true}}
	srv := httptest.NewServer(http.HandlerFunc(s.handler))
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer tenant-a" })
	ctx := t.Context()

	if err := c.Initialize(ctx); err != nil {
		t.Fatalf("first Initialize: %v", err)
	}
	if _, err := c.CallTool(ctx, "x", nil); err == nil {
		t.Fatal("a call on an expired session must fail")
	}
	if err := c.Initialize(ctx); err != nil {
		t.Fatalf("Initialize after the expiry: %v", err)
	}
	if _, err := c.CallTool(ctx, "x", nil); err != nil {
		t.Fatalf("the call after a fresh handshake must work: %v", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.issued != 2 {
		t.Fatalf("want a second handshake after the 404, got %d sessions issued", s.issued)
	}
}
