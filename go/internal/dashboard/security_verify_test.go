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
// call and the named-list read-back land on the same fake server. The
// returned callRecorder holds every tools/call with its arguments: the
// read-back fixtures below are pre-seeded, so "verified" is reachable without
// the write ever having happened, and only the recorder can tell the two
// apart.
func newSecurityTestService(t *testing.T, mcpStatus int, mcpText string, restHandler http.HandlerFunc) (*Service, *callRecorder) {
	t.Helper()
	rec := &callRecorder{}
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		defer r.Body.Close()
		var req struct {
			Method string `json:"method"`
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
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
		// Recorded before the status branch below, so a write that was
		// dispatched and then failed at the transport level is still visible
		// as "it was sent".
		rec.record(req.Params.Name, req.Params.Arguments)
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
	}, rec
}

// assertWriteWire pins the write that actually went upstream: the right tool,
// the CONFIGURED block list in the endpoint path, and the domain inside the
// request body (checked separately from task_description, which mentions the
// domain too and would otherwise mask a garbage body). Without this, a test
// named "...WriteAcceptedAndReadBack..." passes on a PATCH to any endpoint
// with any body — the read-back fixture supplies the verdict on its own.
func assertWriteWire(t *testing.T, rec *callRecorder, tool, wantEndpoint, domain string) {
	t.Helper()
	c := rec.onlyCallTo(t, tool)
	if got := c.arg("endpoint"); got != wantEndpoint {
		t.Fatalf("%s endpoint = %q, want %q (args: %s)", tool, got, wantEndpoint, c.argsJSON())
	}
	if got := c.arg("service_name"); got != "Atcfw" {
		t.Fatalf("%s service_name = %q, want %q (args: %s)", tool, got, "Atcfw", c.argsJSON())
	}
	if body := c.bodyJSON(); !strings.Contains(body, `"`+domain+`"`) {
		t.Fatalf("%s body = %s, want it to carry the domain %q", tool, body, domain)
	}
}

// assertBlockWrite / assertUnblockWrite name the two real write paths so each
// test states which one it expects, and fails if the other (or neither) ran.
func assertBlockWrite(t *testing.T, rec *callRecorder, domain, blockListID string) {
	t.Helper()
	assertWriteWire(t, rec, "infoblox-portal_make_patch_request", "/named_lists/"+blockListID, domain)
}

func assertUnblockWrite(t *testing.T, rec *callRecorder, domain, blockListID string) {
	t.Helper()
	assertWriteWire(t, rec, "infoblox-portal_make_delete_request", "/named_lists/"+blockListID+"/items", domain)
}

// assertNoWrite pins the local-guard tests: nothing may reach the wire at all.
func assertNoWrite(t *testing.T, rec *callRecorder) {
	t.Helper()
	if names := rec.toolNames(); len(names) != 0 {
		t.Fatalf("a locally-rejected request must send nothing upstream, got %v", names)
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
	s, rec := newSecurityTestService(t, http.StatusOK, `{"message":"patched"}`, nil)

	got := s.BlockDomain(context.Background(), "not a domain", testBlockListID)

	if got["outcome"] != "invalid" {
		t.Fatalf("outcome = %v, want invalid: %+v", got["outcome"], got)
	}
	if got["ok"] != false {
		t.Fatalf("ok = %v, want false: %+v", got["ok"], got)
	}
	assertNoWrite(t, rec)
}

func TestBlockDomain_BlockListNotConfiguredYieldsInvalidOutcome(t *testing.T) {
	s, rec := newSecurityTestService(t, http.StatusOK, `{"message":"patched"}`, nil)

	got := s.BlockDomain(context.Background(), "evil.example.com", "")

	if got["outcome"] != "invalid" {
		t.Fatalf("outcome = %v, want invalid: %+v", got["outcome"], got)
	}
	assertNoWrite(t, rec)
}

func TestBlockDomain_MalformedBlockListIDYieldsInvalidOutcome(t *testing.T) {
	s, rec := newSecurityTestService(t, http.StatusOK, `{"message":"patched"}`, nil)

	got := s.BlockDomain(context.Background(), "evil.example.com", "not valid!")

	if got["outcome"] != "invalid" {
		t.Fatalf("outcome = %v, want invalid: %+v", got["outcome"], got)
	}
	assertNoWrite(t, rec)
}

func TestBlockDomain_NilMcpClientYieldsInvalidOutcome(t *testing.T) {
	s := &Service{Mcp: nil}

	got := s.BlockDomain(context.Background(), "evil.example.com", testBlockListID)

	if got["outcome"] != "invalid" {
		t.Fatalf("outcome = %v, want invalid: %+v", got["outcome"], got)
	}
}

func TestUnblockDomain_InvalidDomainYieldsInvalidOutcome(t *testing.T) {
	s, rec := newSecurityTestService(t, http.StatusOK, `{"message":"deleted"}`, nil)

	got := s.UnblockDomain(context.Background(), "not a domain", testBlockListID)

	if got["outcome"] != "invalid" {
		t.Fatalf("outcome = %v, want invalid: %+v", got["outcome"], got)
	}
	assertNoWrite(t, rec)
}

// TestBlockDomain_WriteRejectedYieldsRejectedOutcome proves the "rejected"
// outcome is reserved for a genuine upstream refusal (a transport-level
// failure from CallToolChecked) — never for a local guard failure, which now
// reports "invalid" instead (see the tests above).
func TestBlockDomain_WriteRejectedYieldsRejectedOutcome(t *testing.T) {
	var restCalls int32
	s, rec := newSecurityTestService(t, http.StatusInternalServerError, "", func(w http.ResponseWriter, r *http.Request) {
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
	// "rejected" is only honest if the write was genuinely attempted: the
	// transport error has to come from a real block PATCH, not from never
	// having sent one.
	assertBlockWrite(t, rec, "evil.example.com", testBlockListID)
}

func TestBlockDomain_WriteAcceptedAndReadBackShowsDomain_Verified(t *testing.T) {
	s, rec := newSecurityTestService(t, http.StatusOK, `{"message":"patched"}`, func(w http.ResponseWriter, r *http.Request) {
		namedListBody(w, "other.example.com", "evil.example.com")
	})

	got := s.BlockDomain(context.Background(), "evil.example.com", testBlockListID)

	if got["outcome"] != "verified" {
		t.Fatalf("outcome = %v, want verified: %+v", got["outcome"], got)
	}
	if got["ok"] != true {
		t.Fatalf("ok = %v, want true: %+v", got["ok"], got)
	}
	// The read-back fixture already contains the domain, so "verified" alone
	// proves nothing about the write. This is the half of the test its name
	// promises.
	assertBlockWrite(t, rec, "evil.example.com", testBlockListID)
}

func TestBlockDomain_WriteAcceptedButReadBackNeverShowsDomain_Unverified(t *testing.T) {
	s, rec := newSecurityTestService(t, http.StatusOK, `{"message":"patched"}`, func(w http.ResponseWriter, r *http.Request) {
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
	// "write submitted" is the first clause of the unverified message; it has
	// to be true.
	assertBlockWrite(t, rec, "evil.example.com", testBlockListID)
}

// TestBlockDomain_ReadBackAlwaysErrors_YieldsUnverifiedNeverVerifiedOrRejected
// pins the case that differs from the "read succeeds but domain absent" test
// above: every read-back GET itself fails (HTTP 500, not a well-formed
// "domain not there yet" body). verifyState's retry loop treats a read error
// the same as a non-match and simply exhausts its budget, so the outcome
// must land on "unverified" — the write was submitted and its result is
// simply unknown. It must NOT be "verified" (we never observed the domain
// present) and must NOT be "rejected" (the write itself was never refused;
// only the confirmation read failed, and "rejected" is reserved for a
// transport-level refusal of the WRITE — see
// TestBlockDomain_WriteRejectedYieldsRejectedOutcome).
func TestBlockDomain_ReadBackAlwaysErrors_YieldsUnverifiedNeverVerifiedOrRejected(t *testing.T) {
	var readCalls int32
	s, rec := newSecurityTestService(t, http.StatusOK, `{"message":"patched"}`, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&readCalls, 1)
		w.WriteHeader(http.StatusInternalServerError)
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
	if n := atomic.LoadInt32(&readCalls); n < 2 {
		t.Fatalf("expected the read-back retry loop to run (>=2 attempts) even though every read errors, got %d", n)
	}
	// This test's whole premise is "the WRITE was submitted, only the
	// confirmation read failed" — which is only distinguishable from "no write
	// happened" here.
	assertBlockWrite(t, rec, "evil.example.com", testBlockListID)
}

func TestUnblockDomain_VerifiedWhenDomainAbsent(t *testing.T) {
	s, rec := newSecurityTestService(t, http.StatusOK, `{"message":"deleted"}`, func(w http.ResponseWriter, r *http.Request) {
		namedListBody(w, "other.example.com")
	})

	got := s.UnblockDomain(context.Background(), "evil.example.com", testBlockListID)

	if got["outcome"] != "verified" {
		t.Fatalf("outcome = %v, want verified: %+v", got["outcome"], got)
	}
	if got["ok"] != true {
		t.Fatalf("ok = %v, want true: %+v", got["ok"], got)
	}
	// The fixture never contained the domain, so "absent" is true whether or
	// not anything was deleted: only the recorded DELETE proves the unblock.
	assertUnblockWrite(t, rec, "evil.example.com", testBlockListID)
}

func TestBlockDomain_VerifiedOnSecondReadBackAttempt(t *testing.T) {
	var calls int32
	s, rec := newSecurityTestService(t, http.StatusOK, `{"message":"patched"}`, func(w http.ResponseWriter, r *http.Request) {
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
	// Exactly one write, before the retry loop — the retry is on the READ, and
	// must never re-issue the mutation.
	assertBlockWrite(t, rec, "evil.example.com", testBlockListID)
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
