package server

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/httpx"
)

// newRetagTestDeps builds a Deps wired for retagBlock: an httptest upstream,
// a tokenless Guard (so a loopback RemoteAddr resolves to admin, satisfying
// the "operator" gate), and a real audit.Log writing to a scratch file.
func newRetagTestDeps(t *testing.T, upstream http.HandlerFunc) *Deps {
	t.Helper()
	d, closeSrv := newTestDeps(t, upstream)
	t.Cleanup(closeSrv)
	d.Guard = &httpx.Guard{Port: "8080"}
	d.Audit = audit.New(filepath.Join(t.TempDir(), "audit_log.jsonl"), "app-v-test", "test-instance")
	return d
}

func retagRequest(body string) *http.Request {
	r := httptest.NewRequest("POST", "/api/retag/block", nil)
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	_ = body
	return r
}

// TestRetagBlock_UpstreamErrorIs502NotBadIPSpace is the regression test for
// the bug this migration fixes: Rest.Get swallowed a failed ip_space read
// into an empty slice, which retagBlock then reported as "IP space not
// found" — a wrong, misleading 400. A failed READ must 502, never masquerade
// as a genuine "does not exist" result.
func TestRetagBlock_UpstreamErrorIs502NotBadIPSpace(t *testing.T) {
	calls := 0
	d := newRetagTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
	})

	r := retagRequest("")
	rr := httptest.NewRecorder()
	d.retagBlock(rr, r, map[string]any{
		"template": "tmpl", "site": "site1", "address": "10.0.0.0", "cidr": float64(24),
		"ip_space": "default",
	})

	if rr.Code != 502 {
		t.Fatalf("status = %d, want 502 (upstream 500 must NOT become the 'IP space not found' 400); body=%s", rr.Code, rr.Body.String())
	}
	body := decodeBody(t, rr)
	if body["error"] != "upstream request failed" {
		t.Fatalf("error = %v, want 'upstream request failed'", body["error"])
	}
	if calls != 1 {
		t.Fatalf("upstream calls = %d, want exactly 1", calls)
	}
}

// TestRetagBlock_GenuineEmptySpace_Returns400NotFound confirms the original
// not-found behavior survives the migration: a successful read that
// genuinely finds no matching ip_space still 400s with the "IP space not
// found" message, not a 502.
func TestRetagBlock_GenuineEmptySpace_Returns400NotFound(t *testing.T) {
	d := newRetagTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[]}`))
	})

	r := retagRequest("")
	rr := httptest.NewRecorder()
	d.retagBlock(rr, r, map[string]any{
		"template": "tmpl", "site": "site1", "address": "10.0.0.0", "cidr": float64(24),
		"ip_space": "missing-space",
	})

	if rr.Code != 400 {
		t.Fatalf("status = %d, want 400; body=%s", rr.Code, rr.Body.String())
	}
	body := decodeBody(t, rr)
	if body["error"] != "IP space not found: missing-space" {
		t.Fatalf("error = %v, want 'IP space not found: missing-space'", body["error"])
	}
}
