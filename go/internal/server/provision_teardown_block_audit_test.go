package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// --- the teardown-block-error entry, read back off disk ----------------------
//
// BlockDecommissioner.deleteBlocks deletes one block at a time and returns on
// the first refusal, so Decommission() can fail with address blocks ALREADY
// GONE from the tenant. teardownBlock handled that by calling provErr and
// returning, which skips the teardown-block entry at the bottom of the handler
// — and there was no error sibling. A partial destructive teardown was the one
// outcome the audit log never mentioned. teardownSiteStream has written
// teardown-site-error on exactly this path all along; this is the match.
//
// The assertion is on the FILE because the 400 body is identical whether or not
// anything was recorded.

// partialBlockTeardownUpstream returns two address blocks, lets the FIRST
// delete through and refuses the second — a real partial delete, not a failure
// before any write. Blocks are deleted highest-cidr-first, so the /20 goes and
// the /16 survives.
func partialBlockTeardownUpstream() http.HandlerFunc {
	var mu sync.Mutex
	deletes := 0
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "DELETE":
			mu.Lock()
			deletes++
			n := deletes
			mu.Unlock()
			if n == 1 {
				io.WriteString(w, `{"result":{}}`) // this block is now really gone
				return
			}
			w.WriteHeader(500)
			io.WriteString(w, `{"error":"delete refused"}`)
		case strings.HasSuffix(path, "/ipam/ip_space"):
			io.WriteString(w, `{"results":[{"id":"ipam/ip_space/sp-1","name":"default"}]}`)
		case strings.HasSuffix(path, "/ipam/address_block"):
			io.WriteString(w, `{"results":[
				{"id":"ipam/address_block/b-16","address":"10.1.0.0","cidr":16},
				{"id":"ipam/address_block/b-20","address":"10.2.0.0","cidr":20}]}`)
		default:
			w.WriteHeader(500)
			fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, path)
		}
	}
}

const blocksTeardownTemplate = "blocks/regional_address_blocks.yaml"

func TestTeardownBlock_PartialDeleteWritesErrorAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, partialBlockTeardownUpstream())
	d.StateDir = t.TempDir() // recordPlan refuses to delete anything it cannot export first

	r := httptest.NewRequest("POST", "/api/teardown/block", nil)
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	rr := httptest.NewRecorder()
	d.teardownBlock(rr, r, map[string]any{
		"template": blocksTeardownTemplate, "dry": "0", "confirm": blocksTeardownTemplate})

	if rr.Code == 200 {
		t.Fatalf("status = 200, want an error status (the second block delete was refused); body=%s", rr.Body.String())
	}

	entries := auditEntries(t, logPath, "teardown-block-error")
	if len(entries) != 1 {
		t.Fatalf("teardown-block-error entries on disk = %d, want 1 — one address block was "+
			"already deleted from the tenant when Decommission failed, and returning through provErr "+
			"skips the teardown-block entry, so this run left no record at all", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["template"] != blocksTeardownTemplate {
		t.Fatalf("audit detail template = %v, want %q", detail["template"], blocksTeardownTemplate)
	}
	msg, ok := detail["error"].(string)
	if !ok || msg == "" {
		t.Fatalf("audit detail carries no \"error\" message: %v — without it the row cannot say "+
			"the teardown stopped part way, which is the whole reason it exists", detail)
	}
	// Pins that this really is the PARTIAL-delete path and not some earlier
	// failure that destroyed nothing: only deleteBlocks produces this message,
	// and it only gets there after the first block is gone.
	if !strings.Contains(msg, "Failed to delete block") {
		t.Fatalf("audit error = %q, want the mid-delete failure — if the run failed before any "+
			"DELETE, this test proves nothing about the case that matters", msg)
	}

	// And the success entry must NOT be there: this teardown did not complete.
	if got := auditEntries(t, logPath, "teardown-block"); len(got) != 0 {
		t.Fatalf("teardown-block (success) entries = %d, want 0 on a failed teardown; entries=%v", len(got), got)
	}
}

// --- the inventory of what is already gone, in the 400 body AND the audit row -
//
// The entry above proves a row is written. It does not prove the row, or the
// caller, is told WHICH address blocks were destroyed. This route passes
// noopEmit, so the emit stream reaches nobody here: the report on
// Decommission's returned map is the only channel, and if the handler drops it
// the operator's only lead is the block that SURVIVED.
func TestTeardownBlock_PartialDeleteNamesTheBlocksAlreadyGone(t *testing.T) {
	d, logPath := newResidualDeps(t, partialBlockTeardownUpstream())
	d.StateDir = t.TempDir()

	r := httptest.NewRequest("POST", "/api/teardown/block", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	d.teardownBlock(rr, r, map[string]any{
		"template": blocksTeardownTemplate, "dry": "0", "confirm": blocksTeardownTemplate})

	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("response body is not JSON: %v (%s)", err, rr.Body.String())
	}
	inc, ok := body["incomplete"].(map[string]any)
	if !ok {
		t.Fatalf("400 body carries no \"incomplete\" report: %s — one address block is already gone "+
			"from the tenant and the caller is told only about the one that refused", rr.Body.String())
	}
	if inc["outcome"] != "incomplete" {
		t.Fatalf("outcome = %v, want \"incomplete\"", inc["outcome"])
	}
	gone, _ := inc["blocks_deleted"].([]any)
	if len(gone) != 1 {
		t.Fatalf("blocks_deleted = %v, want the one block that was really deleted", inc["blocks_deleted"])
	}
	// The /20 is deleted first (highest cidr first), so it is the one that went.
	first, _ := gone[0].(map[string]any)
	if first["address"] != "10.2.0.0/20" {
		t.Fatalf("blocks_deleted[0].address = %v, want 10.2.0.0/20", first["address"])
	}

	// The same object has to reach the signed audit log, not just the response —
	// the response is gone the moment the operator closes the tab.
	entries := auditEntries(t, logPath, "teardown-block-error")
	if len(entries) != 1 {
		t.Fatalf("teardown-block-error entries = %d, want 1", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	auditInc, ok := detail["incomplete"].(map[string]any)
	if !ok {
		t.Fatalf("audit detail carries no \"incomplete\" report: %v", detail)
	}
	auditGone, _ := auditInc["blocks_deleted"].([]any)
	if len(auditGone) != 1 {
		t.Fatalf("audit blocks_deleted = %v, want the one deleted block", auditInc["blocks_deleted"])
	}
}

// A failure BEFORE the first delete destroys nothing, so there is no inventory
// and the report must be absent — not present-and-empty, which would read as
// "the delete loop ran and deleted none of them".
func TestTeardownBlock_FailureBeforeAnyDeleteCarriesNoReport(t *testing.T) {
	d, logPath := newResidualDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/ipam/ip_space") {
			io.WriteString(w, `{"results":[]}`) // IP space not found, before any DELETE
			return
		}
		w.WriteHeader(500)
		fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, r.URL.Path)
	})
	d.StateDir = t.TempDir()

	r := httptest.NewRequest("POST", "/api/teardown/block", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	d.teardownBlock(rr, r, map[string]any{
		"template": blocksTeardownTemplate, "dry": "0", "confirm": blocksTeardownTemplate})

	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("response body is not JSON: %v (%s)", err, rr.Body.String())
	}
	if _, present := body["incomplete"]; present {
		t.Fatalf("body claims a partial teardown when nothing was deleted: %s", rr.Body.String())
	}
	entries := auditEntries(t, logPath, "teardown-block-error")
	if len(entries) != 1 {
		t.Fatalf("teardown-block-error entries = %d, want 1", len(entries))
	}
	if _, present := residualAuditDetail(t, entries[0])["incomplete"]; present {
		t.Fatalf("audit row claims a partial teardown when nothing was deleted: %v",
			residualAuditDetail(t, entries[0]))
	}
}

// A dry run deletes nothing, so a failed preview must audit nothing — the same
// !dry gate teardownSiteStream uses.
func TestTeardownBlock_DryRunFailureWritesNoAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/ipam/ip_space") {
			io.WriteString(w, `{"results":[]}`) // IP space not found -> ProvisionError
			return
		}
		w.WriteHeader(500)
		fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, r.URL.Path)
	})
	d.StateDir = t.TempDir()

	r := httptest.NewRequest("POST", "/api/teardown/block", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	d.teardownBlock(rr, r, map[string]any{"template": blocksTeardownTemplate, "dry": "1"})

	if rr.Code == 200 {
		t.Fatalf("status = 200, want an error status; body=%s", rr.Body.String())
	}
	if got := auditEntries(t, logPath, ""); len(got) != 0 {
		t.Fatalf("audit entries = %d, want 0 (a dry run deletes nothing); entries=%v", len(got), got)
	}
}
