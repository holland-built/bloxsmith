package server

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// --- the retag-block-error entry, read back off disk -------------------------
//
// retagBlock PATCHes the address blocks it found ONE AT A TIME and returns on
// the first refusal. That arm went out through provErr, which discards the
// `changed` slice and skips the retag-block entry at the bottom of the handler,
// so a run that re-tagged three blocks and failed on the fourth left no record
// that anything had been changed at all. Block tags are the filter teardown
// selects by, so the already-retagged blocks are exactly the ones that later go
// missing from a cleanup.
//
// The assertion is on the FILE, not the status code: the 400 body is
// byte-identical whether or not anything was recorded, which is how the gap
// survived.

// partialRetagUpstream returns two address blocks, lets the FIRST retag PATCH
// through and refuses the second — a real partial retag, not a failure before
// any write. When refuse is false every PATCH succeeds, for the clean-run half.
func partialRetagUpstream(refuseSecond bool) http.HandlerFunc {
	var mu sync.Mutex
	patches := 0
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "PATCH":
			mu.Lock()
			patches++
			n := patches
			mu.Unlock()
			if refuseSecond && n == 2 {
				w.WriteHeader(500)
				io.WriteString(w, `{"error":"retag refused"}`)
				return
			}
			io.WriteString(w, `{"result":{}}`) // this block's tags really changed
		case strings.HasSuffix(path, "/ipam/ip_space"):
			io.WriteString(w, `{"results":[{"id":"ipam/ip_space/sp-1","name":"default"}]}`)
		case strings.HasSuffix(path, "/ipam/address_block"):
			io.WriteString(w, `{"results":[
				{"id":"ipam/address_block/b-1","address":"10.1.0.0","cidr":16},
				{"id":"ipam/address_block/b-2","address":"10.2.0.0","cidr":16}]}`)
		default:
			w.WriteHeader(500)
			fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, path)
		}
	}
}

const retagTemplate = "blocks/regional_address_blocks.yaml"

func TestRetagBlock_PartialRetagWritesErrorAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, partialRetagUpstream(true))

	rr := httptest.NewRecorder()
	d.retagBlock(rr, retagRequest(""), map[string]any{
		"template": retagTemplate, "status": "reserved", "dry": "0"})

	if rr.Code == 200 {
		t.Fatalf("status = 200, want an error status (the second retag PATCH was refused); body=%s", rr.Body.String())
	}

	entries := auditEntries(t, logPath, "retag-block-error")
	if len(entries) != 1 {
		t.Fatalf("retag-block-error entries on disk = %d, want 1 — one address block was already "+
			"re-tagged upstream when the loop stopped, and returning through provErr discards the "+
			"changed list AND skips the retag-block entry, so the run left no record at all", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["template"] != retagTemplate {
		t.Fatalf("audit detail template = %v, want %q", detail["template"], retagTemplate)
	}
	if detail["status"] != "reserved" {
		t.Fatalf("audit detail status = %v, want \"reserved\" — the row has to say which tag value "+
			"the surviving blocks now carry, or it cannot be used to find them", detail["status"])
	}
	// The load-bearing field: how far the loop got before it stopped. Without it
	// the row says a retag failed, not that one block is already re-tagged.
	if detail["count"] != float64(1) {
		t.Fatalf("audit detail count = %v, want 1 (the first block's PATCH succeeded); detail=%v",
			detail["count"], detail)
	}
	msg, ok := detail["error"].(string)
	if !ok || !strings.Contains(msg, "Failed to retag block") {
		t.Fatalf("audit error = %v, want the mid-loop PATCH failure — if the run failed before any "+
			"PATCH, this test proves nothing about the case that matters", detail["error"])
	}

	// And the success entry must NOT be there: this retag did not complete.
	if got := auditEntries(t, logPath, "retag-block"); len(got) != 0 {
		t.Fatalf("retag-block (success) entries = %d, want 0 on a failed retag; entries=%v", len(got), got)
	}
}

// The counterpart that keeps the test above honest: a run where every PATCH
// succeeds changed nothing unexpectedly, so it must write the plain retag-block
// row and NO error row. Without this, appending unconditionally inside the loop
// would pass the test above while filing every healthy retag as a failure.
func TestRetagBlock_CleanRetagWritesNoErrorAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, partialRetagUpstream(false))

	rr := httptest.NewRecorder()
	d.retagBlock(rr, retagRequest(""), map[string]any{
		"template": retagTemplate, "status": "reserved", "dry": "0"})

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200 (every PATCH succeeded); body=%s", rr.Code, rr.Body.String())
	}
	if got := auditEntries(t, logPath, "retag-block-error"); len(got) != 0 {
		t.Fatalf("retag-block-error entries = %d, want 0 — nothing failed, and a row claiming a "+
			"partial retag sends an operator hunting blocks that are all consistent; entries=%v", len(got), got)
	}
	entries := auditEntries(t, logPath, "retag-block")
	if len(entries) != 1 {
		t.Fatalf("retag-block entries = %d, want 1 (the untouched success entry)", len(entries))
	}
	if got := residualAuditDetail(t, entries[0])["count"]; got != float64(2) {
		t.Fatalf("retag-block count = %v, want 2 — the success entry must stay exactly as it was", got)
	}
}
