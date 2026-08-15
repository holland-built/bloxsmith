package provision

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// WHAT THE OPERATOR IS TOLD AFTER A BLOCK TEARDOWN DIES HALFWAY.
//
// Address-block teardown is fail-forward: no rollback, every step a DELETE, and
// a refusal on block 41 of 60 leaves 40 blocks genuinely gone. Until now
// deleteBlocks returned nil on that path and Decommission returned (nil, err),
// so the only thing the operator got back named the block that SURVIVED. The
// forty that did not survive appeared nowhere: not in the return value, not on
// the emit stream, not in the audit log.
//
// SCOPE, HONESTLY. These tests pin the CONTENT of the incomplete report and the
// event carrying it. They do NOT prove the deletes themselves are correct or
// that the ordering upstream is right — export_test.go covers the
// record-before-delete claim, and the server package covers what the HTTP layer
// does with the report.
//
// They drive the real Decommission() through a fake upstream rather than calling
// deleteBlocks directly: a direct call would stay green if the Decommission arm
// that builds the report were deleted.
//
// NO TEST HERE TOUCHES A REAL TENANT. Everything runs against httptest.

const (
	partialParentID = "ipam/address_block/b-parent" // 10.0.0.0/16, deleted LAST
	partialChildID  = "ipam/address_block/b-child"  // 10.0.1.0/24, deleted FIRST
)

// partialBlockTenant answers the two reads a block teardown makes and refuses
// the DELETE of exactly one object id. Deletes run highest-cidr-first, so
// refusing the parent means the child is already gone by the time it fires.
type partialBlockTenant struct {
	mu           sync.Mutex
	failDeleteID string
	deletes      []string
}

func (f *partialBlockTenant) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "DELETE" {
			id := strings.TrimPrefix(r.URL.Path, "/api/ddi/v1/")
			f.mu.Lock()
			f.deletes = append(f.deletes, id)
			fail := id == f.failDeleteID
			f.mu.Unlock()
			if fail {
				w.WriteHeader(500)
				w.Write([]byte(`{"error":"block is in use"}`))
				return
			}
			w.Write([]byte(`{"result":{}}`))
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/ipam/ip_space"):
			w.Write([]byte(`{"results":[{"id":"ipam/ip_space/sp-1","name":"default"}]}`))
		case strings.HasSuffix(r.URL.Path, "/ipam/address_block"):
			w.Write([]byte(`{"results":[
				{"id":"` + partialParentID + `","address":"10.0.0.0","cidr":16,"tags":{"Status":"available"}},
				{"id":"` + partialChildID + `","address":"10.0.1.0","cidr":24,"tags":{"Status":"available"}}]}`))
		default:
			w.WriteHeader(500)
			w.Write([]byte(`{"error":"unexpected upstream call"}`))
		}
	}
}

// runBlockTeardown wires an engine with a real export directory (recordPlan
// refuses to delete anything it cannot record first) and returns everything a
// caller could possibly learn from the run.
func runBlockTeardown(t *testing.T, failDeleteID string) (out M, err error, events []M, deletes []string) {
	t.Helper()
	tenant := &partialBlockTenant{failDeleteID: failDeleteID}
	srv := httptest.NewServer(tenant.handler())
	t.Cleanup(srv.Close)

	e := newTestEngine(srv)
	e.Export = &ExportWriter{Dir: t.TempDir()}
	d := e.NewBlockDecommissioner("regional-blocks", "default", false, func(m M) { events = append(events, m) })
	out, err = d.Decommission()

	tenant.mu.Lock()
	deletes = append([]string{}, tenant.deletes...)
	tenant.mu.Unlock()
	return out, err, events, deletes
}

// incompleteEvent finds the one emitted event that marks a partial teardown.
func incompleteEvent(events []M) M {
	for _, ev := range events {
		if truthy(ev["incomplete"], false) {
			return ev
		}
	}
	return nil
}

func TestBlockTeardown_PartialDeleteReportsWhatIsAlreadyGone(t *testing.T) {
	out, err, events, deletes := runBlockTeardown(t, partialParentID)

	if err == nil {
		t.Fatalf("Decommission() error = nil, want the refused parent delete")
	}
	// Pins that this is genuinely the partial-delete path: the child must have
	// been deleted BEFORE the parent refused. Without this the rest of the test
	// could pass on a run that destroyed nothing.
	if len(deletes) != 2 || deletes[0] != partialChildID {
		t.Fatalf("deletes = %v, want the child gone first then the parent refused", deletes)
	}

	if out == nil {
		t.Fatalf("Decommission() returned a nil map on a partial teardown — %s is already gone and "+
			"nothing names it. /api/teardown/block passes a no-op emitter, so this map is the only "+
			"channel it has.", partialChildID)
	}
	report := asMap(out["incomplete"])
	if report == nil {
		t.Fatalf("returned map carries no \"incomplete\" report: %v", out)
	}
	if report["outcome"] != "incomplete" {
		t.Fatalf("outcome = %v, want \"incomplete\"", report["outcome"])
	}
	if report["failed_step"] != "delete address blocks" {
		t.Fatalf("failed_step = %v", report["failed_step"])
	}
	// planned / attempted / deleted are three different numbers: two blocks were
	// planned, both DELETEs were issued, one succeeded.
	if report["planned"] != 2 || report["attempted"] != 2 || report["deleted"] != 1 {
		t.Fatalf("planned/attempted/deleted = %v/%v/%v, want 2/2/1",
			report["planned"], report["attempted"], report["deleted"])
	}
	gone := getList(report, "blocks_deleted")
	if len(gone) != 1 || pyStr(asMap(gone[0])["id"]) != partialChildID {
		t.Fatalf("blocks_deleted = %v, want exactly the child block %s", gone, partialChildID)
	}
	if pyStr(asMap(gone[0])["address"]) != "10.0.1.0/24" {
		t.Fatalf("blocks_deleted[0].address = %v, want 10.0.1.0/24 — an id alone does not tell an "+
			"operator which network is missing", asMap(gone[0])["address"])
	}
	if pyStr(report["export_path"]) == "" {
		t.Fatalf("export_path = %q, want the record written before the first delete", report["export_path"])
	}
	// The map must carry the report and NOTHING else: blocks_deleted at the top
	// level is the SUCCESS shape, and returning it here would render a partial
	// teardown as a completed one.
	if _, present := out["blocks_deleted"]; present {
		t.Fatalf("failure map carries the success-shape key \"blocks_deleted\": %v", out)
	}

	// And the stream gets the same object, for the SSE route.
	ev := incompleteEvent(events)
	if ev == nil {
		t.Fatalf("no incomplete event was emitted; events=%v", events)
	}
	if ev["operation"] != "decommission-block" || ev["failed_step"] != "delete address blocks" {
		t.Fatalf("event = %v, want operation=decommission-block failed_step=\"delete address blocks\"", ev)
	}
	if msg, _ := ev["error"].(string); !strings.Contains(msg, "Failed to delete block") {
		t.Fatalf("event error = %q, want the mid-delete failure", msg)
	}
	evReport := asMap(ev["report"])
	if evReport == nil || len(getList(evReport, "blocks_deleted")) != 1 {
		t.Fatalf("event report = %v, want the same inventory the return value carries", ev["report"])
	}
}

// The very first delete refusing is the case where the inventory is EMPTY, and
// an empty list is a load-bearing record — "nothing went" — not a missing key.
// Deletes run highest-cidr-first, so failing the child means every block
// survived.
func TestBlockTeardown_FirstDeleteRefusedReportsAnEmptyInventory(t *testing.T) {
	out, err, events, deletes := runBlockTeardown(t, partialChildID)

	if err == nil {
		t.Fatalf("Decommission() error = nil, want the refused delete")
	}
	if len(deletes) != 1 || deletes[0] != partialChildID {
		t.Fatalf("deletes = %v, want only the first (child) delete attempted", deletes)
	}
	report := asMap(out["incomplete"])
	if report == nil {
		t.Fatalf("returned map carries no \"incomplete\" report: %v", out)
	}
	gone, present := report["blocks_deleted"]
	if !present {
		t.Fatalf("blocks_deleted is absent — \"nothing was deleted\" must be stated, not implied "+
			"by a missing key: %v", report)
	}
	if len(asList(gone)) != 0 {
		t.Fatalf("blocks_deleted = %v, want empty (the first delete was refused)", gone)
	}
	if report["planned"] != 2 || report["attempted"] != 1 || report["deleted"] != 0 {
		t.Fatalf("planned/attempted/deleted = %v/%v/%v, want 2/1/0 — one DELETE issued, none succeeded, "+
			"one block never touched", report["planned"], report["attempted"], report["deleted"])
	}
	if incompleteEvent(events) == nil {
		t.Fatalf("no incomplete event was emitted; events=%v", events)
	}
}

// A clean teardown must be untouched by all of the above: same success shape,
// no incomplete report, no incomplete event.
func TestBlockTeardown_CleanRunIsUnchanged(t *testing.T) {
	out, err, events, deletes := runBlockTeardown(t, "")

	if err != nil {
		t.Fatalf("Decommission() error = %v, want nil", err)
	}
	if len(deletes) != 2 {
		t.Fatalf("deletes = %v, want both blocks", deletes)
	}
	if _, present := out["incomplete"]; present {
		t.Fatalf("a clean run carries an \"incomplete\" report: %v", out)
	}
	if len(getList(out, "blocks_deleted")) != 2 {
		t.Fatalf("blocks_deleted = %v, want both blocks", out["blocks_deleted"])
	}
	if out["name"] != "regional-blocks" || out["dry_run"] != false || out["export_written"] != true {
		t.Fatalf("success shape changed: %v", out)
	}
	if ev := incompleteEvent(events); ev != nil {
		t.Fatalf("a clean run emitted an incomplete event: %v", ev)
	}
}
