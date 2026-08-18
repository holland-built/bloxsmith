package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/config"
	"bloxsmith/internal/dashboard"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/mcp"
	"bloxsmith/internal/rest"
)

// --- the block-domain / unblock-domain audit entries, read back off disk -----
//
// Both handlers used to record only the "verified" outcome. "unverified" means
// the write WAS submitted to the customer's live block list and read-back
// merely failed to confirm it inside the budget — the domain may well be
// blocked (or unblocked) right now. Neither route is in DefaultMutatingPaths,
// so there is no "write-authorized" row either: an unverified write left zero
// trace anywhere.
//
// These tests assert on audit_log.jsonl for that reason. The HTTP status has
// always distinguished the outcomes (504 for unverified), so a status-code
// assertion stays green whether or not anything was recorded. Only the file
// tells "recorded" from "returned an honest status and forgot about it".
//
// The negative test (invalid) is what stops "just audit unconditionally" from
// passing: every "invalid" return in dashboard/security.go happens before
// CallToolChecked is called, so no request was ever built and a record would be
// a lie. "rejected" is NOT such a case — it is a transport error, which cannot
// tell "never sent" from "sent, outcome unknown" (see isMcpTransportError), so
// it is recorded.

const (
	auditBlockListID  = "block_list_1"
	securityTestToken = "test-auth-token"
)

// newSecurityAuditDeps wires a Deps whose Dashboard talks to one fake server
// serving BOTH the MCP write tool (at /mcp) and the named-list read-back, so
// the handler runs end to end against httptest only. Guard/audit setup mirrors
// edit_audit_test.go: loopback Guard (127.0.0.1 -> SameOrigin -> admin) and a
// real audit.Log on a scratch file whose path is returned for on-disk asserts.
//
// mcpStatus/mcpText drive the write tool's reply (>=400 is the transport
// failure that yields "rejected"); listItems is what every read-back GET
// reports the named list currently holds, which is what decides
// verified vs. unverified.
func newSecurityAuditDeps(t *testing.T, blockListID string, mcpStatus int, mcpText string, listItems []string) (*Deps, string) {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		defer r.Body.Close()
		// Answer the question that was actually asked. internal/mcp rejects a reply
		// carrying a different JSON-RPC id (#143), and a fake that always says
		// "id":1 mis-addresses every call after the first on a client.
		w = echoRPCID(w, raw)
		var req struct {
			Method string `json:"method"`
		}
		_ = json.Unmarshal(raw, &req)
		switch req.Method {
		case "initialize":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
		case "tools/call":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(mcpStatus)
			if mcpStatus >= 400 {
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": 1,
				"result": map[string]any{"content": []map[string]any{{"text": mcpText}}},
			})
		default:
			w.WriteHeader(http.StatusOK) // notifications/initialized
		}
	})
	mux.HandleFunc("/api/atcfw/v1/named_lists/"+auditBlockListID, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		items := make([]any, len(listItems))
		for i, it := range listItems {
			items[i] = it
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{"items": items, "item_count": len(items)},
		})
	})

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	restClient := rest.New(srv.URL, rest.NewAuth("test-key", nil))
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	d := &Deps{
		Cfg:       &config.Config{Port: "8080", BlockListID: blockListID},
		Rest:      restClient,
		Guard:     &httpx.Guard{Port: "8080", Token: securityTestToken},
		Dashboard: &dashboard.Service{Rest: restClient, Mcp: mcp.New(srv.URL+"/mcp", func() string { return "Bearer test" })},
		// Trust root in its own directory, as in production — the key must never
		// sit beside the log it signs.
		Audit: audit.New(logPath, "app-v-test", "test-instance", audit.Options{TrustDir: t.TempDir()}),
	}
	return d, logPath
}

func securityWriteRequest(path, domain string) *http.Request {
	req := httptest.NewRequest("POST", path, strings.NewReader(`{"domain":"`+domain+`"}`))
	req.RemoteAddr = "127.0.0.1:12345"                // loopback -> SameOrigin -> admin
	req.Header.Set("X-Auth-Token", securityTestToken) // each handler runs its own _authed gate
	return req
}

// TestBlockDomain_UnverifiedIsStillAudited: the PATCH went to the live block
// list, read-back never confirmed it. The change may have landed; a missing
// entry is an untraceable write.
func TestBlockDomain_UnverifiedIsStillAudited(t *testing.T) {
	// Read-back never shows the domain -> "unverified".
	d, logPath := newSecurityAuditDeps(t, auditBlockListID, 200, `{"message":"patched"}`, []string{"other.example.com"})

	rr := httptest.NewRecorder()
	d.body(d.blockDomain)(rr, securityWriteRequest("/api/block-domain", "evil.example.com"))

	if rr.Code != 504 {
		t.Fatalf("status = %d, want 504 (unverified); body=%s", rr.Code, rr.Body.String())
	}
	entries := auditEntries(t, logPath, "block-domain")
	if len(entries) != 1 {
		t.Fatalf("block-domain entries on disk = %d, want 1 — an unverified write was still SUBMITTED "+
			"to the live block list, and these routes have no write-authorized row to fall back on", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["domain"] != "evil.example.com" {
		t.Fatalf("audit domain = %v, want evil.example.com", detail["domain"])
	}
	if detail["outcome"] != "unverified" {
		t.Fatalf("audit outcome = %v, want \"unverified\" — folding an unconfirmed write in with a "+
			"confirmed one tells the reader the block took effect when nobody knows that", detail["outcome"])
	}
}

// TestUnblockDomain_UnverifiedIsStillAudited: same hole on the removal side —
// a domain may have been taken OFF the customer's block list with no record.
func TestUnblockDomain_UnverifiedIsStillAudited(t *testing.T) {
	// Read-back still shows the domain present -> removal unconfirmed.
	d, logPath := newSecurityAuditDeps(t, auditBlockListID, 200, `{"message":"deleted"}`, []string{"evil.example.com"})

	rr := httptest.NewRecorder()
	d.body(d.unblockDomain)(rr, securityWriteRequest("/api/unblock-domain", "evil.example.com"))

	if rr.Code != 504 {
		t.Fatalf("status = %d, want 504 (unverified); body=%s", rr.Code, rr.Body.String())
	}
	entries := auditEntries(t, logPath, "unblock-domain")
	if len(entries) != 1 {
		t.Fatalf("unblock-domain entries on disk = %d, want 1 — the delete was submitted to the live "+
			"block list; unconfirmed is not the same as never happened", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["domain"] != "evil.example.com" {
		t.Fatalf("audit domain = %v, want evil.example.com", detail["domain"])
	}
	if detail["outcome"] != "unverified" {
		t.Fatalf("audit outcome = %v, want \"unverified\"", detail["outcome"])
	}
}

// TestBlockDomain_VerifiedNamesItsOutcome: the confirmed case must keep being
// recorded, and must say "verified" so it reads differently from the above.
func TestBlockDomain_VerifiedNamesItsOutcome(t *testing.T) {
	d, logPath := newSecurityAuditDeps(t, auditBlockListID, 200, `{"message":"patched"}`,
		[]string{"other.example.com", "evil.example.com"})

	rr := httptest.NewRecorder()
	d.body(d.blockDomain)(rr, securityWriteRequest("/api/block-domain", "evil.example.com"))

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200 (verified); body=%s", rr.Code, rr.Body.String())
	}
	entries := auditEntries(t, logPath, "block-domain")
	if len(entries) != 1 {
		t.Fatalf("block-domain entries on disk = %d, want 1", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["outcome"] != "verified" {
		t.Fatalf("audit outcome = %v, want \"verified\" — a read-back-confirmed block must be "+
			"distinguishable on disk from one that was only submitted", detail["outcome"])
	}
}

// TestBlockDomain_InvalidIsNotAudited: BLOCK_LIST_ID unset is a local fault.
// Nothing was ever sent upstream, so there is no change to account for.
func TestBlockDomain_InvalidIsNotAudited(t *testing.T) {
	d, logPath := newSecurityAuditDeps(t, "", 200, `{"message":"patched"}`, nil)

	rr := httptest.NewRecorder()
	d.body(d.blockDomain)(rr, securityWriteRequest("/api/block-domain", "evil.example.com"))

	if rr.Code != 400 {
		t.Fatalf("status = %d, want 400 (invalid); body=%s", rr.Code, rr.Body.String())
	}
	if n := len(auditEntries(t, logPath, "")); n != 0 {
		t.Fatalf("audit entries on disk = %d, want 0 — \"invalid\" never reached upstream, so a "+
			"record would claim a block-list change that did not happen", n)
	}
}

// TestUnblockDomain_RejectedIsStillAudited: a transport error on the removal
// side. It was recorded as "upstream refused it, nothing was applied" and
// therefore audited nowhere — but CallToolChecked wraps EVERY CallTool error as
// ErrTransport, including a timeout that fires after the DELETE was dispatched
// and a gateway error raised once the tool may already have run. The domain may
// be off the customer's block list right now.
func TestUnblockDomain_RejectedIsStillAudited(t *testing.T) {
	d, logPath := newSecurityAuditDeps(t, auditBlockListID, 500, "", []string{"evil.example.com"})

	rr := httptest.NewRecorder()
	d.body(d.unblockDomain)(rr, securityWriteRequest("/api/unblock-domain", "evil.example.com"))

	if rr.Code != 502 {
		t.Fatalf("status = %d, want 502 (rejected); body=%s", rr.Code, rr.Body.String())
	}
	entries := auditEntries(t, logPath, "unblock-domain")
	if len(entries) != 1 {
		t.Fatalf("unblock-domain entries on disk = %d, want 1 — a transport error cannot tell "+
			"\"never sent\" from \"sent, outcome unknown\", and these routes have no write-authorized "+
			"row to fall back on", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["domain"] != "evil.example.com" {
		t.Fatalf("audit domain = %v, want evil.example.com", detail["domain"])
	}
	if detail["outcome"] != "rejected" {
		t.Fatalf("audit outcome = %v, want \"rejected\" — the row must stay distinguishable from a "+
			"confirmed removal and from an unconfirmed one", detail["outcome"])
	}
}

// TestBlockDomain_RejectedIsStillAudited: the same unknown outcome on the
// blocking side — the PATCH may already have added the domain to the live list.
func TestBlockDomain_RejectedIsStillAudited(t *testing.T) {
	d, logPath := newSecurityAuditDeps(t, auditBlockListID, 500, "", []string{"other.example.com"})

	rr := httptest.NewRecorder()
	d.body(d.blockDomain)(rr, securityWriteRequest("/api/block-domain", "evil.example.com"))

	if rr.Code != 502 {
		t.Fatalf("status = %d, want 502 (rejected); body=%s", rr.Code, rr.Body.String())
	}
	entries := auditEntries(t, logPath, "block-domain")
	if len(entries) != 1 {
		t.Fatalf("block-domain entries on disk = %d, want 1 — \"rejected\" names a transport error, "+
			"not a refusal by the tenant", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["outcome"] != "rejected" {
		t.Fatalf("audit outcome = %v, want \"rejected\"", detail["outcome"])
	}
}
