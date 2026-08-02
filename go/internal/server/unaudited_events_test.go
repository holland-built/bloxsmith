package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/config"
	"bloxsmith/internal/dashboard"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/mcp"
	"bloxsmith/internal/vault"
)

// --- the ten audit events nothing pinned -------------------------------------
//
// A sweep stubbed Deps.auditAppend to a no-op and ran the package: 22 audit
// events in internal/server vanished and only 10 tests noticed. The ten events
// covered here appeared in NO test file at all — each one is either a write into
// the customer's live tenant (provision-site, provision-block, provision-subnet,
// teardown-site, iq-action-resolve) or a security-relevant decision (rbac_denied,
// write-refused-read-only, update-apply) with nothing asserting it is recorded.
//
// Every assertion below reads audit_log.jsonl FROM DISK, never the HTTP status.
// That is not a style preference: four missing audit records shipped through
// tests that asserted 200, because auditAppend only log.Printf's a refused entry
// and the handler still returns success. A status code, an SSE terminal frame and
// a spy on the call site are all green through exactly the bug.
//
// Each event gets a NEGATIVE half as well — the same route driven under a
// condition where nothing happened (a dry run, a refused write, a role that IS
// permitted). Without it, "audit unconditionally" passes every positive test
// while stamping permanent, unamendable rows against runs that changed nothing.

// uaAuditLog wires a real audit.Log on a scratch file and returns its path. The
// trust root lives in its own directory, as in production — the signing key must
// never sit beside the log it signs.
func uaAuditLog(t *testing.T) (*audit.Log, string) {
	t.Helper()
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	return audit.New(logPath, "app-v-test", "test-instance", audit.Options{TrustDir: t.TempDir()}), logPath
}

// uaDetail pulls one entry's detail object, failing when there is none.
func uaDetail(t *testing.T, entry map[string]any) map[string]any {
	t.Helper()
	det, ok := entry["detail"].(map[string]any)
	if !ok {
		t.Fatalf("audit entry has no detail object: %v", entry)
	}
	return det
}

// uaOnly returns the single entry for an event, failing loudly on 0 or 2+. Both
// "never recorded" and "recorded twice" are defects: a duplicated row for one
// teardown reads as two teardowns in a log nobody can amend.
func uaOnly(t *testing.T, logPath, event, why string) map[string]any {
	t.Helper()
	entries := auditEntries(t, logPath, event)
	if len(entries) != 1 {
		t.Fatalf("%s entries on disk = %d, want exactly 1 — %s", event, len(entries), why)
	}
	return uaDetail(t, entries[0])
}

// uaNone asserts an event left nothing on disk.
func uaNone(t *testing.T, logPath, event, why string) {
	t.Helper()
	if got := auditEntries(t, logPath, event); len(got) != 0 {
		t.Fatalf("%s entries on disk = %d, want 0 — %s; entries=%v", event, len(got), why, got)
	}
}

// =============================================================================
// iq-action-resolve / iq-action-resolve-failed  (noc.go actionStatus)
// =============================================================================

// uaMCP is a fake MCP streamable-HTTP endpoint answering the two tools
// UpdateAction drives: the pre-read that supplies old_status, and the write
// itself. updateBody is served verbatim, so a payload SuccessFieldTrue does not
// recognise drives the ok:false arm without any transport-level trickery.
type uaMCP struct {
	getBody    map[string]any
	updateBody map[string]any

	mu    sync.Mutex
	calls []string
}

func (f *uaMCP) handler(t *testing.T) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
			ID     *int   `json:"id"`
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode MCP request: %v", err)
			return
		}
		w.Header().Set("Mcp-Session-Id", "test-session")
		w.Header().Set("Content-Type", "application/json")
		switch req.Method {
		case "initialize":
			_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{}}`)
			return
		case "notifications/initialized":
			w.WriteHeader(200)
			return
		case "tools/call":
		default:
			t.Errorf("unexpected MCP method %q", req.Method)
			return
		}

		f.mu.Lock()
		f.calls = append(f.calls, req.Params.Name)
		f.mu.Unlock()

		var text []byte
		switch req.Params.Name {
		case "iq-actions_get_action":
			text, _ = json.Marshal(f.getBody)
		case "iq-actions_update_action":
			text, _ = json.Marshal(f.updateBody)
		default:
			t.Errorf("unexpected MCP tool %q", req.Params.Name)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": *req.ID,
			"result": map[string]any{
				"content": []map[string]any{{"type": "text", "text": string(text)}},
			},
		})
	}
}

// uaNOCDeps wires a Deps whose Dashboard talks to the fake MCP above, with a
// loopback Guard (-> admin, clearing the operator gate) and a real audit log.
func uaNOCDeps(t *testing.T, f *uaMCP) (*Deps, string) {
	t.Helper()
	srv := httptest.NewServer(f.handler(t))
	t.Cleanup(srv.Close)
	lg, logPath := uaAuditLog(t)
	return &Deps{
		Cfg:       &config.Config{Port: "8080"},
		Guard:     &httpx.Guard{Port: "8080"},
		Dashboard: &dashboard.Service{Mcp: mcp.New(srv.URL, func() string { return "Bearer test" })},
		Audit:     lg,
	}, logPath
}

// uaActionRequest builds the POST the /api/actions/{id}/status route receives.
// SetPathValue stands in for the ServeMux match: the handler reads the id from
// the path wildcard, and the id is the whole content of the audit row.
func uaActionRequest(id string) *http.Request {
	r := httptest.NewRequest("POST", "/api/actions/"+id+"/status", strings.NewReader("{}"))
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	r.SetPathValue("id", id)
	return r
}

// A confirmed resolve changes an IQ Action's status in the customer's tenant.
// The 200 says the write landed; the log is the only place that can still say
// WHICH action moved and from what.
func TestActionStatus_ResolveWritesAuditEntry(t *testing.T) {
	f := &uaMCP{
		getBody:    map[string]any{"action": map[string]any{"id": "act-1", "status": "active"}},
		updateBody: map[string]any{"success": true, "new_status": "resolved"},
	}
	d, logPath := uaNOCDeps(t, f)

	rr := httptest.NewRecorder()
	d.actionStatus(rr, uaActionRequest("act-1"), map[string]any{"status": "resolved"})

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	detail := uaOnly(t, logPath, "iq-action-resolve",
		"the action was resolved upstream and the 200 says so; nothing else records who did it")
	if detail["id"] != "act-1" {
		t.Fatalf("audit id = %v, want act-1 — a row that does not name the action records that AN "+
			"action was resolved, not WHICH", detail["id"])
	}
	if detail["old_status"] != "active" || detail["new_status"] != "resolved" {
		t.Fatalf("audit old_status/new_status = %v/%v, want active/resolved — the transition is the "+
			"fact the row exists to preserve", detail["old_status"], detail["new_status"])
	}
	// The negative half of iq-action-resolve-failed: a write that succeeded must
	// not also leave a failure row against the tenant.
	uaNone(t, logPath, "iq-action-resolve-failed", "the update was confirmed by upstream")
}

// The failure twin. Upstream answered with a payload SuccessFieldTrue does not
// recognise, so the write is UNCONFIRMED — it may have landed. That is exactly
// the outcome that has to be recorded, and the route returns 502, so no
// status-code assertion anywhere would have caught the row going missing.
func TestActionStatus_UnconfirmedWriteWritesFailedAuditEntry(t *testing.T) {
	f := &uaMCP{
		getBody:    map[string]any{"action": map[string]any{"id": "act-2", "status": "active"}},
		updateBody: map[string]any{"status_code": 500, "message": "upstream refused"},
	}
	d, logPath := uaNOCDeps(t, f)

	rr := httptest.NewRecorder()
	d.actionStatus(rr, uaActionRequest("act-2"), map[string]any{"status": "resolved"})

	if rr.Code != 502 {
		t.Fatalf("status = %d, want 502 on an unconfirmed write; body=%s", rr.Code, rr.Body.String())
	}
	detail := uaOnly(t, logPath, "iq-action-resolve-failed",
		"the write reached upstream and was never confirmed, so the action may have moved with nothing recording it")
	if detail["id"] != "act-2" {
		t.Fatalf("audit id = %v, want act-2", detail["id"])
	}
	if detail["new_status"] != "resolved" {
		t.Fatalf("audit new_status = %v, want resolved — the row must say what was attempted", detail["new_status"])
	}
	if msg, _ := detail["error"].(string); strings.TrimSpace(msg) == "" {
		t.Fatalf("audit detail carries no error message: %v", detail)
	}
	// The negative half of iq-action-resolve: an unconfirmed write must never be
	// recorded as a completed resolve.
	uaNone(t, logPath, "iq-action-resolve",
		"upstream never confirmed the write, so a success row would be a false claim")
}

// =============================================================================
// provision-site / teardown-site  (provision.go, the single-site SSE streams)
// =============================================================================

func uaTeardownSiteRequest(qs string) *http.Request {
	r := httptest.NewRequest("GET", "/api/teardown/site/stream?"+qs, nil)
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	return r
}

// A clean, non-dry site provision creates subnets, DHCP ranges, zones and hosts
// in the customer's tenant. Only the log names the template and the site.
func TestProvisionSiteStream_SuccessWritesAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, seedSuccessUpstream())
	rr := httptest.NewRecorder()
	d.provisionSiteStream(rr, siteStreamRequest("template="+labTemplate+"&dry=0"))

	frames := parseSSEFrames(t, rr.Body.String())
	terminalFrameOf(t, frames) // the run must actually finish, or nothing below is proven

	detail := uaOnly(t, logPath, "provision-site",
		"a whole site was created on the live tenant and the stream reported done")
	if detail["template"] != labTemplate {
		t.Fatalf("audit template = %v, want %q", detail["template"], labTemplate)
	}
	if detail["site"] != "amer-lab" {
		t.Fatalf("audit site = %v, want amer-lab — the site name is what an operator reconciles "+
			"the tenant against", detail["site"])
	}
	uaNone(t, logPath, "provision-site-error", "the run succeeded")
}

// The negative half: a dry run previews and creates NOTHING, so it must leave no
// record of having provisioned a site. Without this, dropping the !cfg.DryRun
// gate would still pass the test above while writing a permanent row claiming a
// site was built.
func TestProvisionSiteStream_DryRunWritesNoAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, seedSuccessUpstream())
	rr := httptest.NewRecorder()
	d.provisionSiteStream(rr, siteStreamRequest("template="+labTemplate+"&dry=1"))

	frames := parseSSEFrames(t, rr.Body.String())
	// The dry run must actually REACH the end of the handler, otherwise this
	// asserts on an unvisited branch rather than on the dry-run gate.
	terminalFrameOf(t, frames) // the run must actually finish, or nothing below is proven
	uaNone(t, logPath, "provision-site",
		"a preview creates nothing, and a row saying a site was provisioned cannot be taken back")
}

// A non-dry teardown DESTROYS a site — DNS zones, DHCP ranges, subnets, hosts,
// fail-forward with no rollback. StateDir is set because a real teardown refuses
// to delete anything it cannot first export (provision/export.go).
func TestTeardownSiteStream_SuccessWritesAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, teardownSuccessUpstream)
	d.StateDir = t.TempDir()
	rr := httptest.NewRecorder()
	d.teardownSiteStream(rr, uaTeardownSiteRequest("template="+labTemplate+"&dry=0&confirm=amer-lab"))

	frames := parseSSEFrames(t, rr.Body.String())
	terminalFrameOf(t, frames) // the run must actually finish, or nothing below is proven

	detail := uaOnly(t, logPath, "teardown-site",
		"a site was decommissioned on the live tenant with no rollback available")
	if detail["template"] != labTemplate {
		t.Fatalf("audit template = %v, want %q", detail["template"], labTemplate)
	}
	if detail["site"] != "amer-lab" {
		t.Fatalf("audit site = %v, want amer-lab", detail["site"])
	}
	uaNone(t, logPath, "teardown-site-error", "the teardown completed")
}

// The negative half: a dry teardown deletes nothing. A row here would say a
// customer site was destroyed when it is still standing.
func TestTeardownSiteStream_DryRunWritesNoAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, teardownSuccessUpstream)
	d.StateDir = t.TempDir()
	rr := httptest.NewRecorder()
	d.teardownSiteStream(rr, uaTeardownSiteRequest("template="+labTemplate+"&dry=1"))

	frames := parseSSEFrames(t, rr.Body.String())
	terminalFrameOf(t, frames) // the run must actually finish, or nothing below is proven
	uaNone(t, logPath, "teardown-site",
		"a dry teardown destroys nothing, so a row claiming the site is gone is a false claim")
}

// =============================================================================
// provision-block  (provision.go provisionBlock)
// =============================================================================

// uaBlockSuccessUpstream answers a clean address-block provision: the IP space
// resolves, nothing exists yet, and every create succeeds.
func uaBlockSuccessUpstream() http.HandlerFunc {
	var mu sync.Mutex
	created := 0
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(path, "/ipam/ip_space"):
			io.WriteString(w, `{"results":[{"id":"ipam/ip_space/sp-1"}]}`)
		case r.Method == "GET" && strings.HasSuffix(path, "/ipam/address_block"):
			io.WriteString(w, `{"results":[]}`) // exists(): nothing there yet
		case r.Method == "POST" && strings.HasSuffix(path, "/ipam/address_block"):
			mu.Lock()
			created++
			i := created
			mu.Unlock()
			fmt.Fprintf(w, `{"result":{"id":"ipam/address_block/b-%d"}}`, i)
		default:
			w.WriteHeader(500)
			fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, path)
		}
	}
}

const uaBlocksTemplate = "blocks/regional_address_blocks.yaml"

func uaBlockRequest() *http.Request {
	r := httptest.NewRequest("POST", "/api/provision/block", nil)
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	return r
}

// A successful block provision carves real address space out of the customer's
// IPAM. The count is the load-bearing field — it says how much.
func TestProvisionBlock_SuccessWritesAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, uaBlockSuccessUpstream())
	rr := httptest.NewRecorder()
	d.provisionBlock(rr, uaBlockRequest(), map[string]any{"template": uaBlocksTemplate, "dry": "0"})

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	body := decodeBody(t, rr)
	made, _ := body["blocks_created"].([]any)
	if len(made) == 0 {
		t.Fatalf("the run created no blocks, so this test would prove nothing about the audit row; body=%s", rr.Body.String())
	}

	detail := uaOnly(t, logPath, "provision-block",
		"address blocks now exist on the live tenant and the 200 says so")
	if detail["template"] != uaBlocksTemplate {
		t.Fatalf("audit template = %v, want %q", detail["template"], uaBlocksTemplate)
	}
	if detail["blocks_created"] != float64(len(made)) {
		t.Fatalf("audit blocks_created = %v, want %d — the row must agree with what the response "+
			"told the operator was created", detail["blocks_created"], len(made))
	}
	uaNone(t, logPath, "provision-block-error", "the run succeeded")
}

// The negative half: a dry run allocates nothing.
func TestProvisionBlock_DryRunWritesNoAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, uaBlockSuccessUpstream())
	rr := httptest.NewRecorder()
	d.provisionBlock(rr, uaBlockRequest(), map[string]any{"template": uaBlocksTemplate, "dry": "1"})

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200 on a dry run; body=%s", rr.Code, rr.Body.String())
	}
	uaNone(t, logPath, "provision-block",
		"a preview allocates no address space, so a row claiming blocks were created is a false claim")
}

// =============================================================================
// provision-subnet / provision-subnet-error  (provision.go provisionSubnetStream)
// =============================================================================

const uaBlockID = "ipam/address_block/blk-1"

// uaSubnetUpstream answers the single nextavailablesubnet allocation the
// self-service wizard makes, and refuses anything else so a handler that wanders
// off that path fails loudly rather than quietly auditing a different write.
func uaSubnetUpstream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/"+uaBlockID+"/nextavailablesubnet") {
		io.WriteString(w, `{"results":[{"id":"ipam/subnet/sn-1","address":"10.1.7.0","cidr":25}]}`)
		return
	}
	w.WriteHeader(500)
	fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, r.URL.Path)
}

func uaSubnetRequest(qs string) *http.Request {
	r := httptest.NewRequest("GET", "/api/provision/stream?"+qs, nil)
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	return r
}

// A non-dry self-service allocation takes a subnet out of the customer's address
// block. The allocated address is the field an operator reconciles against.
func TestProvisionSubnetStream_SuccessWritesAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, uaSubnetUpstream)
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=25&dry=0"))

	frames := parseSSEFrames(t, rr.Body.String())
	terminalFrameOf(t, frames) // the run must actually finish, or nothing below is proven

	detail := uaOnly(t, logPath, "provision-subnet",
		"a subnet was allocated out of the customer's address block and the stream reported done")
	if detail["block"] != uaBlockID {
		t.Fatalf("audit block = %v, want %q", detail["block"], uaBlockID)
	}
	if detail["cidr"] != "25" {
		t.Fatalf("audit cidr = %v, want \"25\"", detail["cidr"])
	}
	if detail["subnet"] != "10.1.7.0" {
		t.Fatalf("audit subnet = %v, want 10.1.7.0 — without the allocated address the row cannot "+
			"say which space was consumed", detail["subnet"])
	}
	// The negative half of provision-subnet-error: a run that allocated cleanly
	// must not also leave a failure row.
	uaNone(t, logPath, "provision-subnet-error", "the allocation succeeded")
}

// The negative half: a dry run allocates nothing, so it audits nothing at all —
// neither the success row nor an error row.
func TestProvisionSubnetStream_DryRunWritesNoAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, uaSubnetUpstream)
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=25&dry=1"))

	frames := parseSSEFrames(t, rr.Body.String())
	terminalFrameOf(t, frames) // the run must actually finish, or nothing below is proven
	uaNone(t, logPath, "",
		"a preview issues no allocation, so nothing about this run belongs in a log nobody can amend")
}

// The error twin. A non-numeric cidr fails the run AFTER the block has been
// resolved and announced, and the failure is what an operator needs recorded:
// the wizard reported an error against a real address block.
func TestProvisionSubnetStream_FailureWritesErrorAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, uaSubnetUpstream)
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=twenty-five&dry=0"))

	frame := errorFrame(t, parseSSEFrames(t, rr.Body.String()))
	if msg, _ := frame["error"].(string); strings.TrimSpace(msg) == "" {
		t.Fatalf("error frame carries no message: %v", frame)
	}

	detail := uaOnly(t, logPath, "provision-subnet-error",
		"the allocation failed against a real address block and only the log keeps that")
	if detail["block"] != uaBlockID {
		t.Fatalf("audit block = %v, want %q — a row that does not name the block cannot be "+
			"reconciled against the tenant", detail["block"], uaBlockID)
	}
	if msg, _ := detail["error"].(string); !strings.Contains(msg, "twenty-five") {
		t.Fatalf("audit error = %q, want the engine's own message naming the bad value", msg)
	}
	// The negative half of provision-subnet: a failed run allocated nothing.
	uaNone(t, logPath, "provision-subnet", "nothing was allocated, so a success row would be a false claim")
}

// =============================================================================
// rbac_denied / update-apply  (server.go updateApply)
// =============================================================================

// uaTokenDeps wires a token-guarded Deps. With Guard.Token set, a request
// carrying the matching X-Auth-Token resolves to admin and every other request
// to viewer — the only way to drive a real RBAC denial without faking the role
// resolver. UpdateApply records whether the gated handler was actually reached.
func uaTokenDeps(t *testing.T) (d *Deps, logPath string, applied *bool) {
	t.Helper()
	lg, path := uaAuditLog(t)
	reached := false
	d = &Deps{
		Cfg:     &config.Config{Port: "8080"},
		Guard:   &httpx.Guard{Port: "8080", Token: "s3cr3t-dashboard-token"},
		Audit:   lg,
		Version: "v9.9.9-test",
		UpdateApply: func(w http.ResponseWriter, r *http.Request) {
			reached = true
			w.WriteHeader(200)
		},
	}
	return d, path, &reached
}

func uaUpdateApplyRequest(token string) *http.Request {
	r := httptest.NewRequest("POST", "/api/update/apply", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	if token != "" {
		r.Header.Set("X-Auth-Token", token)
	}
	return r
}

// An authorized self-update replaces the running binary. The row is the only
// record that a human authorized it, and from which version.
func TestUpdateApply_AuthorizedWritesUpdateApplyAuditEntry(t *testing.T) {
	d, logPath, applied := uaTokenDeps(t)

	rr := httptest.NewRecorder()
	d.updateApply(rr, uaUpdateApplyRequest("s3cr3t-dashboard-token"))

	if !*applied {
		t.Fatalf("the gated update handler was never reached (status %d) — this test would be "+
			"asserting on a denial, not on an authorized apply", rr.Code)
	}
	detail := uaOnly(t, logPath, "update-apply",
		"the binary was replaced and nothing else records who authorized it")
	if detail["from"] != "v9.9.9-test" {
		t.Fatalf("audit from = %v, want v9.9.9-test — without the outgoing version the row cannot "+
			"say what was replaced", detail["from"])
	}
	// The negative half of rbac_denied: a role that IS permitted must not leave a
	// denial row. A log that records a denial for every allowed request makes the
	// real denials unfindable.
	uaNone(t, logPath, "rbac_denied", "the caller presented a valid admin token")
}

// The denial twin: a viewer asking to replace the binary is a security-relevant
// decision, and it is the row that says someone tried.
func TestUpdateApply_DeniedWritesRbacDeniedAuditEntry(t *testing.T) {
	d, logPath, applied := uaTokenDeps(t)

	rr := httptest.NewRecorder()
	d.updateApply(rr, uaUpdateApplyRequest("")) // no token -> viewer

	if *applied {
		t.Fatalf("the update handler ran for a viewer — the RBAC gate did not hold")
	}
	entries := auditEntries(t, logPath, "rbac_denied")
	if len(entries) != 1 {
		t.Fatalf("rbac_denied entries on disk = %d, want 1 — a refused privileged request that "+
			"leaves no trace is indistinguishable from one nobody made", len(entries))
	}
	if entries[0]["actor"] != "viewer" {
		t.Fatalf("audit actor = %v, want viewer — the denial records the role that was resolved, "+
			"which is the fact under dispute", entries[0]["actor"])
	}
	detail := uaDetail(t, entries[0])
	if detail["required"] != "admin" {
		t.Fatalf("audit required = %v, want admin", detail["required"])
	}
	if detail["path"] != "/api/update/apply" {
		t.Fatalf("audit path = %v, want /api/update/apply — a denial that does not name the route "+
			"cannot be investigated", detail["path"])
	}
	// The negative half of update-apply: a refused request replaced nothing.
	uaNone(t, logPath, "update-apply",
		"the apply was refused, so a row saying the binary was updated is a false claim")
}

// =============================================================================
// write-refused-read-only  (writelock.go withWriteLock)
// =============================================================================

// uaLockDeps wires the write lock over a real, unlocked vault holding one
// tenant that has NOT been marked writable, plus a real audit log. Auth and
// Account are deliberately nil: no portal switch is in force, so the identity
// resolves cleanly and the refusal is the read-only one, not "tenant-unknown".
func uaLockDeps(t *testing.T) (d *Deps, logPath, writeID string) {
	t.Helper()
	dir := t.TempDir()
	vlt := vault.New(filepath.Join(dir, "vault.json"))
	if err := vlt.Init("pass-phrase-for-test"); err != nil {
		t.Fatalf("vault init: %v", err)
	}
	if res := vlt.AddTenant("Delta", "abc123def456", nil); !res["ok"].(bool) {
		t.Fatalf("add tenant: %v", res)
	}
	lg, path := uaAuditLog(t)
	d = &Deps{Cfg: &config.Config{Port: "8080"}, Vault: vlt, Audit: lg}
	return d, path, vault.WriteID(vlt.ActiveTenantID(), vault.NoSwitch)
}

// uaLockRun drives one request through the write lock and reports whether the
// wrapped handler was reached.
func uaLockRun(t *testing.T, d *Deps, method, path string) (code int, reached bool) {
	t.Helper()
	h := d.withWriteLock(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(200)
	}))
	r := httptest.NewRequest(method, path, strings.NewReader("{}"))
	r.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	return rr.Code, reached
}

// A refused write into a read-only tenant is the security decision this control
// exists to make. The 403 tells the caller; the log is what tells everyone else
// that an authorized operator tried to change a tenant nobody opted in.
func TestWriteLock_RefusalWritesAuditEntry(t *testing.T) {
	d, logPath, _ := uaLockDeps(t)

	code, reached := uaLockRun(t, d, "POST", "/api/dns/records")

	if code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for a read-only tenant", code)
	}
	if reached {
		t.Fatalf("the refused request still reached the handler — it refused AFTER acting")
	}
	detail := uaOnly(t, logPath, "write-refused-read-only",
		"a refusal nobody can find afterwards is indistinguishable from a request nobody made")
	if detail["path"] != "/api/dns/records" {
		t.Fatalf("audit path = %v, want /api/dns/records", detail["path"])
	}
	if detail["method"] != "POST" {
		t.Fatalf("audit method = %v, want POST", detail["method"])
	}
	if detail["reason"] != "tenant-read-only" {
		t.Fatalf("audit reason = %v, want tenant-read-only — \"unknown tenant\" and \"read-only "+
			"tenant\" are different refusals and must not render the same", detail["reason"])
	}
	if s, _ := detail["tenant"].(string); strings.TrimSpace(s) == "" {
		t.Fatalf("audit detail names no tenant: %v — the identity is what an operator would mark "+
			"writable, so a row without it is unactionable", detail)
	}
}

// The negative half: a tenant that WAS opted in is not a refusal. Auditing every
// pass as a refusal would bury the real ones and misreport allowed work as
// blocked.
func TestWriteLock_PermittedTenantWritesNoAuditEntry(t *testing.T) {
	d, logPath, id := uaLockDeps(t)
	if res := d.Vault.SetWritable(id, true); !res["ok"].(bool) {
		t.Fatalf("SetWritable: %v", res)
	}

	code, reached := uaLockRun(t, d, "POST", "/api/dns/records")

	if !reached || code != 200 {
		t.Fatalf("an opted-in tenant was still refused (status %d, handler reached=%v) — this test "+
			"would be asserting on a refusal, not on a permitted write", code, reached)
	}
	uaNone(t, logPath, "write-refused-read-only",
		"the write was allowed through, so a refusal row would misreport it as blocked")
}
