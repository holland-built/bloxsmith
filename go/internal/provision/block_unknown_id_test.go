package provision

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// AN ADDRESS BLOCK THAT WAS CREATED AND CANNOT BE NAMED.
//
// createBlock reads its new block's id out of the create response. When upstream
// answers 200/201 with a body carrying no `result` object — a case createBlock
// already has an explicit branch for (`if block == nil { block = M{} }`) — the
// block EXISTS on the customer's network and this code has no id for it.
//
// Recorded as "", it fell into rollback's `if blockID == "" { continue }`, which
// touches neither counter, and the outcome switch read the counters alone. The
// report for two live /16s was `outcome: "not_needed", attempted: 0, deleted: 0,
// residual: []` — "rollback ran and found nothing to undo" — written into an
// append-only signed audit log.
//
// The site half of this is site_unknown_id_test.go; block_rollback_report_test.go
// owns the counter arithmetic for deletes that were actually SENT, and nothing
// here re-asserts it.
//
// NO TEST HERE TOUCHES A REAL TENANT. Everything runs against httptest.

// blockUnknownIDFake answers the whole block-create path with creates that carry
// no `result` object. That single injection is all this file needs; the delete
// side is recorded so "no DELETE was sent" can be stated rather than assumed.
type blockUnknownIDFake struct {
	mu          sync.Mutex
	deletePaths []string
	posts       int
}

func (f *blockUnknownIDFake) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodDelete:
			f.mu.Lock()
			f.deletePaths = append(f.deletePaths, r.URL.Path)
			f.mu.Unlock()
			w.WriteHeader(200)
			w.Write([]byte(`{}`))
			return
		case http.MethodPost:
			f.mu.Lock()
			f.posts++
			f.mu.Unlock()
			w.WriteHeader(201)
			w.Write([]byte(`{}`))
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/ipam/ip_space"):
			w.Write([]byte(`{"results":[{"id":"ipam/ip_space/space-1","name":"default"}]}`))
		case strings.HasSuffix(r.URL.Path, "/ipam/address_block"):
			// exists(): nothing is there yet, so every create reaches the POST.
			w.Write([]byte(`{"results":[]}`))
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	}
}

func newBlockUnknownIDHarness(t *testing.T) (*Engine, *blockUnknownIDFake) {
	t.Helper()
	f := &blockUnknownIDFake{}
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	return newTestEngine(srv), f
}

func (f *blockUnknownIDFake) counts() (posts int, dels []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.posts, append([]string{}, f.deletePaths...)
}

// A rollback that could not remove what this run created never reports success,
// and every unnameable block gets a residual row naming its address.
func TestBlockRollback_UnnameableBlocksBecomeResidual(t *testing.T) {
	e, f := newBlockUnknownIDHarness(t)

	// rollbackBlockConfig's third block has cidr "x", so the run fails after two
	// real creates and reaches Provision's own rollback branch.
	failValue, err := e.NewBlockProvisioner(rollbackBlockConfig(false), func(M) {}).Provision(false)
	if err == nil {
		t.Fatal("want the bad-cidr failure")
	}
	posts, dels := f.counts()
	if posts != 2 {
		t.Fatalf("posts = %d, want 2 — the fixture never created anything, so a residual "+
			"assertion would be about an empty run", posts)
	}
	if len(dels) != 0 {
		t.Errorf("DELETEs = %v, want none — there is no id to delete either block by", dels)
	}

	rb := asMap(failValue["rollback"])
	if rb == nil {
		t.Fatalf("failure value carried no rollback report: %v", failValue)
	}
	if got := pyStr(rb["outcome"]); got != "incomplete" {
		t.Errorf("outcome = %q, want %q — two live /16s were left behind", got, "incomplete")
	}
	rows := getList(rb, "residual")
	if len(rows) != 2 {
		t.Fatalf("residual has %d row(s), want 2 — one per created block: %v", len(rows), rows)
	}
	// Reverse creation order, matching every other delete in this rollback.
	wantLabels := []string{"10.20.0.0/16", "10.10.0.0/16"}
	for i, row := range rows {
		rm := asMap(row)
		if got := pyStr(rm["kind"]); got != "address_block" {
			t.Errorf("residual[%d] kind = %q, want %q", i, got, "address_block")
		}
		if got := pyStr(rm["id"]); got != "" {
			t.Errorf("residual[%d] id = %q, want \"\" — there is no id to publish", i, got)
		}
		if got := pyStr(rm["label"]); got != wantLabels[i] {
			t.Errorf("residual[%d] label = %q, want %q", i, got, wantLabels[i])
		}
		if got, _ := intCoerce(rm["status"]); got != 0 {
			t.Errorf("residual[%d] status = %v, want 0 — no request was sent", i, rm["status"])
		}
		if pyStr(rm["reason"]) == "" {
			t.Errorf("residual[%d] carries no reason", i)
		}
	}
	// The counters describe REQUESTS. Nothing was sent, so they stay level and the
	// outcome word is what carries the meaning.
	att, _ := intCoerce(rb["attempted"])
	del, _ := intCoerce(rb["deleted"])
	if att != 0 || del != 0 {
		t.Errorf("attempted=%d deleted=%d, want 0/0 — no DELETE was sent", att, del)
	}
}

// No marker string may ever be sent upstream as an id: DELETE
// /api/ddi/v1/(unknown-id) is a request that is certain to fail, and its failure
// would append a residual row blaming upstream for a missing id.
func TestBlockRollback_NoMarkerIsSentAsAnID(t *testing.T) {
	e, f := newBlockUnknownIDHarness(t)

	if _, err := e.NewBlockProvisioner(rollbackBlockConfig(false), func(M) {}).Provision(false); err == nil {
		t.Fatal("want the bad-cidr failure")
	}
	_, dels := f.counts()
	for _, d := range dels {
		for _, marker := range []string{idUnknown, "(dry-run)"} {
			if strings.Contains(d, marker) {
				t.Errorf("DELETE %s — a marker was sent upstream as an id", d)
			}
		}
	}
}

// A DRY RUN creates nothing, so it can never record an unknown id: "(dry-run)"
// stays the right word for a preview.
func TestBlockProvision_DryRunRecordsNoUnknownID(t *testing.T) {
	e, f := newBlockUnknownIDHarness(t)

	failValue, err := e.NewBlockProvisioner(rollbackBlockConfig(true), func(M) {}).Provision(false)
	if err == nil {
		t.Fatal("want the bad-cidr failure")
	}
	if posts, _ := f.counts(); posts != 0 {
		t.Fatalf("posts = %d, want 0 — a dry run must create nothing", posts)
	}
	// A dry-run failure skips rollback entirely, so the report is the tell.
	rb := asMap(failValue["rollback"])
	if got := pyStr(rb["outcome"]); got != "skipped_dry_run" {
		t.Errorf("outcome = %q, want %q", got, "skipped_dry_run")
	}
	if rows := getList(rb, "residual"); len(rows) != 0 {
		t.Errorf("residual = %v, want empty — a preview created nothing to strand", rows)
	}
}
