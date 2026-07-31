package provision

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// ROLLBACK AFTER A HALF-FINISHED BLOCK PROVISION.
//
// Scope of this file so far: BlockProvisioner.rollback and the one branch in
// Provision that reaches it. Nothing here pins RetagBlock, FindBlocksForRetag,
// TemplateToBlockConfig, parseBlocks or blockTags.
//
// The claim under test is narrow and destructive: when a create fails partway
// through, the blocks already created upstream are deleted again, youngest
// first, and a preview run never deletes anything. The DELETE list recorded by
// the fake is what proves it — an assertion on the returned error would pass
// just as happily if rollback were never called at all.
//
// NO TEST HERE TOUCHES A REAL TENANT. Everything runs against httptest.

// blockRollbackFake is an Infoblox stand-in for the create-then-roll-back path.
//
// It branches on METHOD BEFORE PATH deliberately. exists() (GET) and
// createBlock() (POST) both hit /api/ddi/v1/ipam/address_block, and rollback's
// DELETE path CONTAINS that same string as a prefix — a handler keyed on the
// path alone would answer the POST with the existence-check fixture and go
// green for entirely the wrong reason.
type blockRollbackFake struct {
	mu sync.Mutex

	// deletePaths is every DELETE path, in arrival order. Order is the point:
	// rollback must undo youngest-first, and only a recorded sequence can fail
	// when it doesn't.
	deletePaths []string

	// posts counts creates, so a test can prove the fixture really did create
	// something before the failure it is asserting about.
	posts int

	// deleteStatus lets one test make a specific DELETE fail. nil means every
	// delete succeeds.
	deleteStatus func(path string) int
}

func (f *blockRollbackFake) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch r.Method {
		case http.MethodDelete:
			f.mu.Lock()
			f.deletePaths = append(f.deletePaths, r.URL.Path)
			f.mu.Unlock()
			status := 200
			if f.deleteStatus != nil {
				status = f.deleteStatus(r.URL.Path)
			}
			w.WriteHeader(status)
			w.Write([]byte(`{}`))
			return

		case http.MethodPost:
			// Ids are handed out in creation order so the reverse-order
			// assertion below can name them: first block created is b-1.
			f.mu.Lock()
			f.posts++
			n := f.posts
			f.mu.Unlock()
			w.WriteHeader(201)
			fmt.Fprintf(w, `{"result":{"id":"ipam/address_block/b-%d"}}`, n)
			return
		}

		// GET only, past here.
		switch {
		case strings.HasSuffix(r.URL.Path, "/ipam/ip_space"):
			w.Write([]byte(`{"results":[{"id":"ipam/ip_space/space-1","name":"default"}]}`))
		case strings.HasSuffix(r.URL.Path, "/ipam/address_block"):
			// exists(): nothing is already there, so every create proceeds to
			// the POST rather than being skipped.
			w.Write([]byte(`{"results":[]}`))
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	}
}

func (f *blockRollbackFake) deletes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.deletePaths...)
}

func (f *blockRollbackFake) postCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.posts
}

func newBlockRollbackHarness(t *testing.T, deleteStatus func(path string) int) (*Engine, *blockRollbackFake) {
	t.Helper()
	f := &blockRollbackFake{deleteStatus: deleteStatus}
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	return newTestEngine(srv), f
}

// rollbackBlockConfig is the fixture that gets a provision half-finished: two
// blocks that create cleanly, then a third whose cidr is the string "x".
//
// "x" specifically. intCoerce parses numeric strings and coerces bools, so a
// "24" or a `false` there would sail through and the fixture would be dead.
// "x" makes createBlock fail at its own cidr check, LOCALLY, before any HTTP —
// so the failure needs no call-counting in the fake and cannot be flaky.
//
// dry is explicit at every call site because BlockConfig's zero value is
// DryRun:false while the product default (TruthyDry) is true; leaving it to
// chance in either direction is how a rollback test ends up asserting about a
// preview.
func rollbackBlockConfig(dry bool) *BlockConfig {
	return &BlockConfig{
		Name: "regional-pool", IPSpace: "default", DryRun: dry, ExtraTags: M{},
		Blocks: []any{
			M{"address": "10.10.0.0", "cidr": 16, "status": "deployed"},
			M{"address": "10.20.0.0", "cidr": 16, "status": "deployed"},
			M{"address": "10.30.0.0", "cidr": "x", "status": "deployed"},
		},
	}
}

func collectSteps(steps *[]string) Emitter {
	return func(m M) {
		if s, ok := m["step"]; ok {
			*steps = append(*steps, pyStr(s))
		}
	}
}

// The wired proof: a real Provision that fails partway must delete what it
// already created, youngest first, through Provision's own error branch — not
// through a hand-called rollback. Deleting a parent before its child is the
// upstream error this ordering exists to avoid.
func TestBlockProvisionRollsBackCreatedBlocksInReverseOrder(t *testing.T) {
	e, f := newBlockRollbackHarness(t, nil)
	var steps []string
	p := e.NewBlockProvisioner(rollbackBlockConfig(false), collectSteps(&steps))

	result, err := p.Provision(false)
	if err == nil {
		t.Fatalf("Provision() error = nil, want the bad-cidr failure (result %v)", result)
	}
	if !strings.Contains(err.Error(), "cidr is not an integer") {
		t.Fatalf("Provision() error = %q, want the bad-cidr failure — the fixture failed for some "+
			"other reason and this test is not exercising what it claims", err.Error())
	}

	// Sanity: two blocks really were created upstream before the failure. Without
	// this, an empty delete list could mean "nothing to roll back" rather than
	// "rollback ran".
	if n := f.postCount(); n != 2 {
		t.Fatalf("the fake received %d create(s), want 2 — the fixture never got far enough for "+
			"reverse order to mean anything", n)
	}

	got := f.deletes()
	want := []string{
		"/api/ddi/v1/ipam/address_block/b-2",
		"/api/ddi/v1/ipam/address_block/b-1",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rollback DELETEs = %v, want %v (newest first)", got, want)
	}

	found := false
	for _, s := range steps {
		if strings.Contains(s, "Rolling back") {
			found = true
		}
	}
	if !found {
		t.Fatalf("the rollback deleted blocks without telling the operator it was doing so. steps: %v", steps)
	}
}

// Direct call to the unexported rollback, in addition to the wired test above:
// the ids it must skip only ever appear in states the wired path cannot reach
// in one run — "(dry-run)" comes from a preview, "" from a create whose response
// carried no id. Sending either upstream produces a DELETE on a nonsense path.
func TestBlockRollbackSkipsBlankAndDryRunIDs(t *testing.T) {
	e, f := newBlockRollbackHarness(t, nil)
	p := e.NewBlockProvisioner(rollbackBlockConfig(false), func(M) {})

	result := M{"blocks_created": []any{
		M{"address": "10.10.0.0", "cidr": 16, "id": ""},
		M{"address": "10.20.0.0", "cidr": 16, "id": "(dry-run)"},
		M{"address": "10.30.0.0", "cidr": 16, "id": "ipam/address_block/b-9"},
	}}
	p.rollback(result)

	got := f.deletes()
	for _, d := range got {
		if strings.Contains(d, "(dry-run)") {
			t.Fatalf("rollback sent a DELETE for a preview placeholder id: %s (all: %v)", d, got)
		}
		if d == "/api/ddi/v1/" {
			t.Fatalf("rollback sent a DELETE with an empty block id: %s (all: %v)", d, got)
		}
	}
	want := []string{"/api/ddi/v1/ipam/address_block/b-9"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rollback DELETEs = %v, want %v (only the one real id)", got, want)
	}
}

// One block refusing to delete must not strand the rest. A rollback that stops
// at the first failure leaves the blocks underneath it behind, and those are the
// ones a retry then collides with.
func TestBlockRollbackReportsAFailedDeleteAndKeepsGoing(t *testing.T) {
	e, f := newBlockRollbackHarness(t, func(path string) int {
		if strings.HasSuffix(path, "/b-2") {
			return 500
		}
		return 200
	})
	var steps []string
	p := e.NewBlockProvisioner(rollbackBlockConfig(false), collectSteps(&steps))

	p.rollback(M{"blocks_created": []any{
		M{"address": "10.10.0.0", "cidr": 16, "id": "ipam/address_block/b-1"},
		M{"address": "10.20.0.0", "cidr": 16, "id": "ipam/address_block/b-2"},
	}})

	got := f.deletes()
	want := []string{
		"/api/ddi/v1/ipam/address_block/b-2", // this one is refused with a 500
		"/api/ddi/v1/ipam/address_block/b-1", // and this one must still be tried
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rollback DELETEs = %v, want %v — a failed delete must not abandon the rest", got, want)
	}

	found := false
	for _, s := range steps {
		if strings.Contains(s, "failed to delete block id=ipam/address_block/b-2") {
			found = true
		}
	}
	if !found {
		t.Fatalf("a block was left behind upstream and nothing said so. steps: %v", steps)
	}
}

// A preview creates nothing, so there is nothing to undo. Rolling back a dry run
// would at best be noise in the stream and at worst — if the recorded ids were
// ever real — deletes an operator never asked for.
func TestBlockProvisionDryRunFailureNeverRollsBack(t *testing.T) {
	e, f := newBlockRollbackHarness(t, nil)
	var steps []string
	p := e.NewBlockProvisioner(rollbackBlockConfig(true), collectSteps(&steps))

	if _, err := p.Provision(false); err == nil {
		t.Fatal("Provision() error = nil, want the bad-cidr failure")
	}

	// Sanity: the preview really did reach the two good blocks and record them,
	// so "no rollback" below is a decision and not an empty run.
	previewed := 0
	for _, s := range steps {
		if strings.Contains(s, "[DRY-RUN] Creating address block") {
			previewed++
		}
	}
	if previewed != 2 {
		t.Fatalf("the dry run previewed %d block create(s), want 2 — it never got far enough for "+
			"a rollback to be tempting. steps: %v", previewed, steps)
	}

	if n := f.deletes(); len(n) != 0 {
		t.Fatalf("a dry run sent %d DELETE(s) upstream: %v", len(n), n)
	}
	for _, s := range steps {
		if strings.Contains(s, "Rolling back") {
			t.Fatalf("a dry run announced a rollback (%q) — nothing was created, so there is nothing "+
				"to undo. steps: %v", s, steps)
		}
	}
}
