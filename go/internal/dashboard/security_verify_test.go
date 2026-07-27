package dashboard

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"bloxsmith/internal/mcp"
	"bloxsmith/internal/rest"
)

// This file proves the read-back-is-source-of-truth fix for BlockDomain /
// UnblockDomain: a write reply with err == nil must never be reported as
// success on its own — the named list's actual state, read back after the
// write, is what decides "verified" vs "unverified" vs "rejected".

const testBlockListID = "block_list_1"

// newSecurityTestService wires a Service whose Mcp client posts to
// {srv}/mcp and whose Rest client's base URL is srv, so both the write tool
// call and the named-list read-back land on the same fake server.
func newSecurityTestService(t *testing.T, mcpStatus int, mcpText string, restHandler http.HandlerFunc) *Service {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		defer r.Body.Close()
		var req struct {
			Method string `json:"method"`
		}
		_ = json.Unmarshal(raw, &req)
		if req.Method == "initialize" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
			return
		}
		if req.Method != "tools/call" {
			// notifications/initialized or anything else: no reply required.
			w.WriteHeader(http.StatusOK)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(mcpStatus)
		if mcpStatus >= 400 {
			return
		}
		resp := map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{
				"content": []map[string]any{{"text": mcpText}},
			},
		}
		_ = json.NewEncoder(w).Encode(resp)
	})
	if restHandler != nil {
		mux.HandleFunc("/api/atcfw/v1/named_lists/"+testBlockListID, restHandler)
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return &Service{
		Rest: rest.New(srv.URL, rest.NewAuth("test-key", nil)),
		Mcp:  mcp.New(srv.URL+"/mcp", func() string { return "Bearer test" }),
	}
}

// namedListBody builds the read-back fixture shape verified live: a "result"
// object carrying items (domain strings) and item_count.
func namedListBody(w http.ResponseWriter, items ...string) {
	w.Header().Set("Content-Type", "application/json")
	anyItems := make([]any, len(items))
	for i, it := range items {
		anyItems[i] = it
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"result": map[string]any{
			"items":      anyItems,
			"item_count": len(items),
		},
	})
}

func TestBlockDomain_InvalidDomainYieldsInvalidOutcome(t *testing.T) {
	s := newSecurityTestService(t, http.StatusOK, `{"message":"patched"}`, nil)

	got := s.BlockDomain(context.Background(), "not a domain", testBlockListID)

	if got["outcome"] != "invalid" {
		t.Fatalf("outcome = %v, want invalid: %+v", got["outcome"], got)
	}
	if got["ok"] != false {
		t.Fatalf("ok = %v, want false: %+v", got["ok"], got)
	}
}

func TestBlockDomain_BlockListNotConfiguredYieldsInvalidOutcome(t *testing.T) {
	s := newSecurityTestService(t, http.StatusOK, `{"message":"patched"}`, nil)

	got := s.BlockDomain(context.Background(), "evil.example.com", "")

	if got["outcome"] != "invalid" {
		t.Fatalf("outcome = %v, want invalid: %+v", got["outcome"], got)
	}
}

func TestBlockDomain_MalformedBlockListIDYieldsInvalidOutcome(t *testing.T) {
	s := newSecurityTestService(t, http.StatusOK, `{"message":"patched"}`, nil)

	got := s.BlockDomain(context.Background(), "evil.example.com", "not valid!")

	if got["outcome"] != "invalid" {
		t.Fatalf("outcome = %v, want invalid: %+v", got["outcome"], got)
	}
}

func TestBlockDomain_NilMcpClientYieldsInvalidOutcome(t *testing.T) {
	s := &Service{Mcp: nil}

	got := s.BlockDomain(context.Background(), "evil.example.com", testBlockListID)

	if got["outcome"] != "invalid" {
		t.Fatalf("outcome = %v, want invalid: %+v", got["outcome"], got)
	}
}

func TestUnblockDomain_InvalidDomainYieldsInvalidOutcome(t *testing.T) {
	s := newSecurityTestService(t, http.StatusOK, `{"message":"deleted"}`, nil)

	got := s.UnblockDomain(context.Background(), "not a domain", testBlockListID)

	if got["outcome"] != "invalid" {
		t.Fatalf("outcome = %v, want invalid: %+v", got["outcome"], got)
	}
}

// TestBlockDomain_WriteRejectedYieldsRejectedOutcome proves the "rejected"
// outcome is reserved for a genuine upstream refusal (a transport-level
// failure from CallToolChecked) — never for a local guard failure, which now
// reports "invalid" instead (see the tests above).
func TestBlockDomain_WriteRejectedYieldsRejectedOutcome(t *testing.T) {
	var restCalls int32
	s := newSecurityTestService(t, http.StatusInternalServerError, "", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&restCalls, 1)
		namedListBody(w)
	})

	got := s.BlockDomain(context.Background(), "evil.example.com", testBlockListID)

	if got["outcome"] != "rejected" {
		t.Fatalf("outcome = %v, want rejected: %+v", got["outcome"], got)
	}
	if got["ok"] != false {
		t.Fatalf("ok = %v, want false: %+v", got["ok"], got)
	}
	if n := atomic.LoadInt32(&restCalls); n != 0 {
		t.Fatalf("named-list read-back was called %d times, want 0 (transport rejection should short-circuit)", n)
	}
}

func TestBlockDomain_WriteAcceptedAndReadBackShowsDomain_Verified(t *testing.T) {
	s := newSecurityTestService(t, http.StatusOK, `{"message":"patched"}`, func(w http.ResponseWriter, r *http.Request) {
		namedListBody(w, "other.example.com", "evil.example.com")
	})

	got := s.BlockDomain(context.Background(), "evil.example.com", testBlockListID)

	if got["outcome"] != "verified" {
		t.Fatalf("outcome = %v, want verified: %+v", got["outcome"], got)
	}
	if got["ok"] != true {
		t.Fatalf("ok = %v, want true: %+v", got["ok"], got)
	}
}

func TestBlockDomain_WriteAcceptedButReadBackNeverShowsDomain_Unverified(t *testing.T) {
	s := newSecurityTestService(t, http.StatusOK, `{"message":"patched"}`, func(w http.ResponseWriter, r *http.Request) {
		namedListBody(w, "other.example.com")
	})

	got := s.BlockDomain(context.Background(), "evil.example.com", testBlockListID)

	if got["outcome"] != "unverified" {
		t.Fatalf("outcome = %v, want unverified: %+v", got["outcome"], got)
	}
	if got["ok"] != false {
		t.Fatalf("ok = %v, want false: %+v", got["ok"], got)
	}
	msg, _ := got["error"].(string)
	if !strings.Contains(msg, "refresh") {
		t.Fatalf("unverified message should tell operator to refresh, got: %q", msg)
	}
}

func TestUnblockDomain_VerifiedWhenDomainAbsent(t *testing.T) {
	s := newSecurityTestService(t, http.StatusOK, `{"message":"deleted"}`, func(w http.ResponseWriter, r *http.Request) {
		namedListBody(w, "other.example.com")
	})

	got := s.UnblockDomain(context.Background(), "evil.example.com", testBlockListID)

	if got["outcome"] != "verified" {
		t.Fatalf("outcome = %v, want verified: %+v", got["outcome"], got)
	}
	if got["ok"] != true {
		t.Fatalf("ok = %v, want true: %+v", got["ok"], got)
	}
}

func TestBlockDomain_VerifiedOnSecondReadBackAttempt(t *testing.T) {
	var calls int32
	s := newSecurityTestService(t, http.StatusOK, `{"message":"patched"}`, func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n < 2 {
			namedListBody(w, "other.example.com") // domain not there yet
			return
		}
		namedListBody(w, "other.example.com", "evil.example.com") // now it's converged
	})

	got := s.BlockDomain(context.Background(), "evil.example.com", testBlockListID)

	if got["outcome"] != "verified" {
		t.Fatalf("outcome = %v, want verified after retry: %+v", got["outcome"], got)
	}
	if n := atomic.LoadInt32(&calls); n < 2 {
		t.Fatalf("expected at least 2 read-back attempts to prove the retry ran, got %d", n)
	}
}

// TestCanonDomain_CanonicalisationEquivalents covers case-fold and
// trailing-dot equivalence only. Internationalised/punycode equivalence
// (unicode domain vs. its "xn--" ASCII form) is a known, documented
// limitation of canonDomain — see its doc comment — and deliberately not
// covered here.
func TestCanonDomain_CanonicalisationEquivalents(t *testing.T) {
	cases := [][2]string{
		{"Example.COM.", "example.com"},
		{"EXAMPLE.com", "example.com"},
		{"example.com.", "example.com"},
	}
	for _, c := range cases {
		a, b := canonDomain(c[0]), canonDomain(c[1])
		if a != b {
			t.Errorf("canonDomain(%q)=%q != canonDomain(%q)=%q", c[0], a, c[1], b)
		}
	}
}
