package provision

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
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

// -----------------------------------------------------------------------------
// CREATE, RE-TAG, AND THE CONFIG BUILDERS.
//
// Scope added below: the happy path of Provision/createBlock (what actually
// reaches the wire), the read-failed-vs-genuinely-empty split on the IP-space
// lookup, blockTags' precedence pyramid, RetagBlock, FindBlocksForRetag's
// selector precedence, TemplateToBlockConfig and parseBlocks.
//
// Still NOT pinned by this file: pagination, IPv6, the resilient=true
// keep-going path beyond what the rollback tests above touch, and any
// concurrency between provisioners.
//
// NO TEST HERE TOUCHES A REAL TENANT. Everything runs against httptest.

// blockAPIFake is the recording Infoblox stand-in for the create/retag paths.
// It exists alongside blockRollbackFake rather than replacing it: that one is
// tuned to record DELETE ordering, this one records request BODIES and QUERY
// STRINGS, which is what "the right thing was sent upstream" needs.
//
// Method-before-path again, and for one more reason than the rollback fake had:
// exists() GETs and createBlock() POSTs the same /ipam/address_block path, and
// FindBlocksForRetag GETs it too. Keying on path alone would let a create be
// answered with a search fixture.
type blockAPIFake struct {
	mu sync.Mutex

	postBodies  []M          // decoded POST bodies, in arrival order
	patchBodies []M          // decoded PATCH bodies, in arrival order
	patchPaths  []string     // the path each PATCH went to
	blockGets   []url.Values // query params of every GET on /ipam/address_block
	deletePaths []string

	// Response knobs. Each test sets only the one it is about.
	spaceStatus int
	spaceBody   string
	blockStatus int
	blockBody   string
	postStatus  int
	patchStatus int

	// blockBodyFor, when set, answers a GET on /ipam/address_block from the
	// query it was actually given instead of replaying the static blockBody.
	// Nil in every pre-existing test, so the default behaviour is unchanged.
	// It exists so a test can make the fake answer the _filter HONESTLY —
	// a static fixture answers the same rows no matter what was asked, which
	// is precisely the blindness that lets a wrong filter pass.
	blockBodyFor func(url.Values) string
}

func (f *blockAPIFake) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch r.Method {
		case http.MethodPost:
			f.mu.Lock()
			f.postBodies = append(f.postBodies, decodeBody(r))
			n := len(f.postBodies)
			f.mu.Unlock()
			w.WriteHeader(f.postStatus)
			fmt.Fprintf(w, `{"result":{"id":"ipam/address_block/new-%d"}}`, n)
			return

		case http.MethodPatch:
			f.mu.Lock()
			f.patchBodies = append(f.patchBodies, decodeBody(r))
			f.patchPaths = append(f.patchPaths, r.URL.Path)
			f.mu.Unlock()
			w.WriteHeader(f.patchStatus)
			w.Write([]byte(`{"result":{}}`))
			return

		case http.MethodDelete:
			f.mu.Lock()
			f.deletePaths = append(f.deletePaths, r.URL.Path)
			f.mu.Unlock()
			w.WriteHeader(200)
			w.Write([]byte(`{}`))
			return
		}

		// GET only, past here.
		switch {
		case strings.HasSuffix(r.URL.Path, "/ipam/ip_space"):
			w.WriteHeader(f.spaceStatus)
			w.Write([]byte(f.spaceBody))
		case strings.HasSuffix(r.URL.Path, "/ipam/address_block"):
			q := r.URL.Query()
			f.mu.Lock()
			f.blockGets = append(f.blockGets, q)
			answer := f.blockBodyFor
			f.mu.Unlock()
			w.WriteHeader(f.blockStatus)
			if answer != nil {
				w.Write([]byte(answer(q)))
				return
			}
			w.Write([]byte(f.blockBody))
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	}
}

// decodeBody returns the request body as an M. A body that will not decode
// comes back as nil, which every assertion below fails loudly on rather than
// silently comparing two empty maps.
func decodeBody(r *http.Request) M {
	var m M
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		return nil
	}
	return m
}

func (f *blockAPIFake) posts() []M {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]M{}, f.postBodies...)
}

func (f *blockAPIFake) patches() []M {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]M{}, f.patchBodies...)
}

func (f *blockAPIFake) blockQueries() []url.Values {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]url.Values{}, f.blockGets...)
}

// newBlockAPIHarness wires the fake with everything succeeding and nothing
// already existing upstream. A test that wants a failure flips exactly one knob,
// so the knob it flipped is the only thing that can explain a red bar.
func newBlockAPIHarness(t *testing.T) (*Engine, *blockAPIFake) {
	t.Helper()
	f := &blockAPIFake{
		spaceStatus: 200,
		spaceBody:   `{"results":[{"id":"ipam/ip_space/space-1","name":"default"}]}`,
		blockStatus: 200,
		blockBody:   `{"results":[]}`,
		postStatus:  201,
		patchStatus: 200,
	}
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	return newTestEngine(srv), f
}

// nestedBlockConfig is a parent with one child inside it. DryRun is explicit
// (false) for the same reason the rollback fixture spells it out: BlockConfig's
// zero value disagrees with the product default.
func nestedBlockConfig() *BlockConfig {
	return &BlockConfig{
		Name: "regional-pool", IPSpace: "default", DryRun: false,
		ExtraTags: M{"Owner": "network-team"},
		Blocks: []any{
			M{
				"address": "10.0.0.0", "cidr": 16, "status": "deployed",
				"region": "east", "environment": "prod", "location": "dc1",
				"children": []any{
					M{"address": "10.0.1.0", "cidr": 24, "status": "deployed", "comment": "child net"},
				},
			},
		},
	}
}

// --- Provision / createBlock -------------------------------------------------

// The success path, asserted at the wire and not at the return value. A result
// map full of the right-looking addresses proves only that the local bookkeeping
// ran; the POST bodies are the only evidence the space id was resolved and
// attached, and that the Template tag — the handle every later teardown, retag
// and drift scan finds these blocks by — was actually sent.
func TestBlockProvisionPostsParentThenChildWithSpaceAndTags(t *testing.T) {
	e, f := newBlockAPIHarness(t)
	p := e.NewBlockProvisioner(nestedBlockConfig(), func(M) {})

	result, err := p.Provision(false)
	if err != nil {
		t.Fatalf("Provision() error = %v, want nil", err)
	}

	posts := f.posts()
	if len(posts) != 2 {
		t.Fatalf("upstream received %d create(s), want 2 (parent then child): %v", len(posts), posts)
	}
	// Two elements, a real sequence, not map iteration: parent must go first
	// because the child's create is nested inside it upstream.
	if got := pyStr(posts[0]["address"]); got != "10.0.0.0" {
		t.Fatalf("first create address = %q, want 10.0.0.0 (the parent must be created first)", got)
	}
	if got := pyStr(posts[1]["address"]); got != "10.0.1.0" {
		t.Fatalf("second create address = %q, want 10.0.1.0", got)
	}
	if got := pyStr(posts[0]["cidr"]); got != "16" {
		t.Fatalf("parent cidr = %q, want 16", got)
	}
	for i, post := range posts {
		if got := pyStr(post["space"]); got != "ipam/ip_space/space-1" {
			t.Fatalf("create %d carried space=%q, want the id resolved from the ip_space lookup "+
				"(a block created in the wrong space is invisible to every later lookup)", i, got)
		}
	}

	wantParentTags := M{
		"Owner": "network-team", "Template": "regional-pool", "Region": "east",
		"Environment": "prod", "Status": "deployed", "Location": "dc1",
	}
	if got := getMap(posts[0], "tags"); !reflect.DeepEqual(got, wantParentTags) {
		t.Fatalf("parent tags = %v, want %v", got, wantParentTags)
	}
	// The child inherits the template handle even though it declares no
	// region/environment/location of its own.
	childTags := getMap(posts[1], "tags")
	if got := pyStr(childTags["Template"]); got != "regional-pool" {
		t.Fatalf("child Template tag = %q, want regional-pool — an untagged child survives every "+
			"teardown of its own template", got)
	}
	if got := pyStr(posts[1]["comment"]); got != "child net" {
		t.Fatalf("child comment = %q, want %q", got, "child net")
	}

	created := getList(result, "blocks_created")
	if len(created) != 2 {
		t.Fatalf("result blocks_created = %v, want 2 entries", created)
	}
	if got := pyStr(asMap(created[0])["id"]); got != "ipam/address_block/new-1" {
		t.Fatalf("recorded id = %q, want the id upstream returned — a wrong id here is a block "+
			"that rollback cannot delete", got)
	}
}

// THE READ-FAILED / GENUINELY-EMPTY SPLIT, on the first read Provision makes.
//
// A 500 from the IP-space lookup and an empty results list are opposite facts:
// one means "we do not know", the other means "we looked and it is not there".
// If they render the same, an operator reading the error retypes the space name
// for an outage. The assertion that matters is the inequality, not either
// message on its own.
func TestBlockProvisionSpaceReadFailureReadsDifferentlyFromSpaceNotFound(t *testing.T) {
	eFail, fFail := newBlockAPIHarness(t)
	fFail.spaceStatus = 500
	fFail.spaceBody = `{"error":"boom"}`
	_, failErr := eFail.NewBlockProvisioner(nestedBlockConfig(), func(M) {}).Provision(false)

	eEmpty, fEmpty := newBlockAPIHarness(t)
	fEmpty.spaceBody = `{"results":[]}`
	_, emptyErr := eEmpty.NewBlockProvisioner(nestedBlockConfig(), func(M) {}).Provision(false)

	if failErr == nil || emptyErr == nil {
		t.Fatalf("Provision() errors = (%v, %v), want both non-nil", failErr, emptyErr)
	}
	if failErr.Error() == emptyErr.Error() {
		t.Fatalf("a failed IP-space read and an IP space that genuinely is not there both render as "+
			"%q — an operator cannot tell an outage from a typo", failErr.Error())
	}
	if !strings.Contains(failErr.Error(), "could not read IP space") {
		t.Fatalf("read-failure error = %q, want it to say the read failed", failErr.Error())
	}
	if !strings.Contains(emptyErr.Error(), "IP space not found") {
		t.Fatalf("empty-result error = %q, want it to say the space was not found", emptyErr.Error())
	}
	// Neither may create anything: one did not know the space id, the other
	// knows there is no space to create into.
	if n := len(fFail.posts()) + len(fEmpty.posts()); n != 0 {
		t.Fatalf("%d create(s) were sent after the IP-space lookup did not produce a space", n)
	}
}

// A failed existence check is not "it does not exist". Treating it as one turns
// an unavailable upstream into a duplicate create, which is the one failure
// mode this check exists to prevent. The proof is the POST count, not the error:
// an error assertion alone stays green if the create happens first and the
// failure surfaces later.
func TestBlockProvisionExistenceCheckFailureAbortsBeforeAnyCreate(t *testing.T) {
	e, f := newBlockAPIHarness(t)
	f.blockStatus = 500
	f.blockBody = `{"error":"upstream unavailable"}`

	p := e.NewBlockProvisioner(nestedBlockConfig(), func(M) {})
	_, err := p.Provision(false)
	if err == nil {
		t.Fatal("Provision() error = nil, want a refusal — the existence check could not be completed")
	}
	if !strings.Contains(err.Error(), "could not check for existing address block") {
		t.Fatalf("Provision() error = %q, want it to name the failed existence check", err.Error())
	}
	if posts := f.posts(); len(posts) != 0 {
		t.Fatalf("%d create(s) were sent after the existence check failed: %v — an unreadable upstream "+
			"was treated as an empty one", len(posts), posts)
	}
}

// Already there means leave it alone. A create sent anyway either duplicates the
// block or is rejected, and both outcomes fail a re-run of a template that
// should be idempotent.
func TestBlockProvisionSkipsCreateWhenTheBlockAlreadyExists(t *testing.T) {
	e, f := newBlockAPIHarness(t)
	f.blockBody = `{"results":[{"id":"ipam/address_block/existing-1","address":"10.0.0.0","cidr":16}]}`

	var steps []string
	p := e.NewBlockProvisioner(nestedBlockConfig(), collectSteps(&steps))
	if _, err := p.Provision(false); err != nil {
		t.Fatalf("Provision() error = %v, want nil — an existing block is not a failure", err)
	}
	if posts := f.posts(); len(posts) != 0 {
		t.Fatalf("%d create(s) were sent for blocks that already exist: %v", len(posts), posts)
	}

	skipped := 0
	for _, s := range steps {
		if strings.Contains(s, "Already exists — skipping") {
			skipped++
		}
	}
	if skipped != 2 {
		t.Fatalf("the run announced %d skip(s), want 2 — a silent skip is indistinguishable from a "+
			"block that was never attempted. steps: %v", skipped, steps)
	}
}

// A child outside its parent is a template bug, and creating it anyway produces
// a block that looks nested in the YAML and is not nested upstream — the state
// that makes a later parent-first teardown miss it entirely.
func TestBlockProvisionRefusesAChildOutsideItsParent(t *testing.T) {
	e, f := newBlockAPIHarness(t)
	cfg := nestedBlockConfig()
	parent := cfg.Blocks[0].(M)
	parent["children"] = []any{M{"address": "192.168.5.0", "cidr": 24, "status": "deployed"}}

	p := e.NewBlockProvisioner(cfg, func(M) {})
	_, err := p.Provision(false)
	if err == nil {
		t.Fatal("Provision() error = nil, want a refusal: 192.168.5.0/24 is not inside 10.0.0.0/16")
	}
	if !strings.Contains(err.Error(), "is not contained within parent") {
		t.Fatalf("Provision() error = %q, want the containment refusal", err.Error())
	}
	// Only the parent may have been created; the out-of-range child must never
	// have been sent.
	for _, post := range f.posts() {
		if pyStr(post["address"]) == "192.168.5.0" {
			t.Fatalf("the out-of-parent child was created upstream anyway: %v", post)
		}
	}
}

// --- blockTags ---------------------------------------------------------------

// The precedence pyramid in one assertion: a block's own tags beat its
// region/environment/status/location fields, those beat the template-wide
// ExtraTags, and the template name always wins the Template key. Asserted as a
// whole-map equality because blockTags builds its result by ranging over maps —
// there is no order to assert, only membership and final value.
func TestBlockTagsPrecedenceBdefTagsBeatFieldsBeatExtraTags(t *testing.T) {
	e, _ := newBlockAPIHarness(t)
	cfg := &BlockConfig{
		Name: "tmpl-1",
		ExtraTags: M{
			"Region": "from-extra", "Environment": "from-extra", "Status": "from-extra",
			"Location": "from-extra", "Template": "from-extra", "Owner": "keep-me",
		},
	}
	p := e.NewBlockProvisioner(cfg, func(M) {})

	got := p.blockTags(M{
		"region": "east", "environment": "prod", "status": "deployed", "location": "dc1",
		"tags": M{"Status": "from-bdef-tags", "Custom": "c"},
	})
	want := M{
		"Template":    "tmpl-1",         // config name beats an ExtraTags Template
		"Region":      "east",           // bdef field beats ExtraTags
		"Environment": "prod",           // ditto
		"Location":    "dc1",            // ditto
		"Status":      "from-bdef-tags", // bdef tags beat the bdef status field
		"Owner":       "keep-me",        // ExtraTags survive where nothing overrides
		"Custom":      "c",              // and bdef tags add their own keys
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("blockTags() = %v, want %v", got, want)
	}
}

// An absent field must not become a tag whose value is the empty string. An
// empty Location tag reads upstream as "we know this block has no location",
// which is a different claim from "nobody said".
func TestBlockTagsOmitsFieldsTheBlockDidNotSet(t *testing.T) {
	e, _ := newBlockAPIHarness(t)
	p := e.NewBlockProvisioner(&BlockConfig{Name: "tmpl-1", ExtraTags: M{}}, func(M) {})

	got := p.blockTags(M{"address": "10.0.0.0", "cidr": 16})
	want := M{"Template": "tmpl-1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("blockTags() = %v, want %v — an unset field must be absent, not empty", got, want)
	}
}

// --- RetagBlock --------------------------------------------------------------

func retagBlockFixture() M {
	return M{
		"id": "ipam/address_block/b-1", "address": "10.0.0.0", "cidr": 16,
		"tags": M{
			"Site": "hq", "Location": "dc1", "Provisioned": "2026-01-01",
			"Decommissioned": "2026-06-01", "Owner": "network-team", "Status": "deployed",
		},
	}
}

// Returning a block to the pool has to erase the assignment, not just relabel
// it. A block left carrying Site=hq while its Status says available is the exact
// state that makes a later allocation hand the same range to two sites. The
// PATCH body is the proof — the returned map reports the status either way.
func TestRetagBlockToAvailableClearsTheOldAssignment(t *testing.T) {
	e, f := newBlockAPIHarness(t)

	out, err := e.RetagBlock(retagBlockFixture(), "available", false)
	if err != nil {
		t.Fatalf("RetagBlock() error = %v, want nil", err)
	}

	patches := f.patches()
	if len(patches) != 1 {
		t.Fatalf("upstream received %d PATCH(es), want 1: %v", len(patches), patches)
	}
	if f.patchPaths[0] != "/api/ddi/v1/ipam/address_block/b-1" {
		t.Fatalf("PATCH path = %q, want /api/ddi/v1/ipam/address_block/b-1", f.patchPaths[0])
	}
	wantTags := M{
		"Status": "available", "Site": "unassigned", "Location": "",
		"Provisioned": "", "Decommissioned": "", "Owner": "network-team",
	}
	if got := getMap(patches[0], "tags"); !reflect.DeepEqual(got, wantTags) {
		t.Fatalf("PATCH tags = %v, want %v — a released block still advertising its old site is "+
			"the same range promised twice", got, wantTags)
	}
	if out["address"] != "10.0.0.0/16" || out["id"] != "ipam/address_block/b-1" || out["status"] != "available" {
		t.Fatalf("RetagBlock() = %v, want address 10.0.0.0/16 / id ipam/address_block/b-1 / status available", out)
	}
}

// The inverse of the test above: the reset is specific to "available". Any other
// status is a relabel of a block that is still assigned, and wiping its Site
// there would erase live ownership.
func TestRetagBlockToANonAvailableStatusKeepsTheAssignment(t *testing.T) {
	e, f := newBlockAPIHarness(t)

	if _, err := e.RetagBlock(retagBlockFixture(), "reserved", false); err != nil {
		t.Fatalf("RetagBlock() error = %v, want nil", err)
	}
	tags := getMap(f.patches()[0], "tags")
	if got := pyStr(tags["Site"]); got != "hq" {
		t.Fatalf("Site = %q after a retag to reserved, want hq preserved", got)
	}
	if got := pyStr(tags["Provisioned"]); got != "2026-01-01" {
		t.Fatalf("Provisioned = %q after a retag to reserved, want it preserved", got)
	}
	if got := pyStr(tags["Status"]); got != "reserved" {
		t.Fatalf("Status = %q, want reserved", got)
	}
}

// A preview that writes is not a preview.
func TestRetagBlockDryRunSendsNoPatch(t *testing.T) {
	e, f := newBlockAPIHarness(t)

	out, err := e.RetagBlock(retagBlockFixture(), "available", true)
	if err != nil {
		t.Fatalf("RetagBlock() error = %v, want nil", err)
	}
	if patches := f.patches(); len(patches) != 0 {
		t.Fatalf("a dry-run retag sent %d PATCH(es) upstream: %v", len(patches), patches)
	}
	// Still reports what it would do, so the preview is not silently empty.
	if out["status"] != "available" || out["address"] != "10.0.0.0/16" {
		t.Fatalf("dry-run RetagBlock() = %v, want it to still describe the intended change", out)
	}
}

// A refused PATCH must surface. Reporting success here would tell an operator a
// block was released when it is still assigned upstream.
func TestRetagBlockUpstreamRefusalIsAnError(t *testing.T) {
	e, f := newBlockAPIHarness(t)
	f.patchStatus = 500

	out, err := e.RetagBlock(retagBlockFixture(), "available", false)
	if err == nil {
		t.Fatalf("RetagBlock() error = nil (result %v), want the upstream refusal reported", out)
	}
	if !strings.Contains(err.Error(), "Failed to retag block 10.0.0.0/16") || !strings.Contains(err.Error(), "500") {
		t.Fatalf("RetagBlock() error = %q, want it to name the block and the upstream status", err.Error())
	}
	if out != nil {
		t.Fatalf("RetagBlock() returned %v alongside an error, want nil", out)
	}
}

// --- FindBlocksForRetag ------------------------------------------------------

// Selector precedence, asserted on the query string that actually left the
// process. Every case below supplies MORE than one selector on purpose: with a
// single selector the arms are indistinguishable and the test would pass under
// any ordering.
func TestFindBlocksForRetagSelectorPrecedence(t *testing.T) {
	cases := []struct {
		name        string
		template    string
		address     string
		cidr        any
		site        string
		wantTFilter string
		wantFilter  string
	}{
		{
			name: "template beats site and address", template: "tmpl-1",
			address: "10.0.0.0", cidr: 16, site: "hq",
			wantTFilter: `Template=="tmpl-1"`, wantFilter: `space=="ipam/ip_space/space-1"`,
		},
		{
			name: "site beats address when no template", address: "10.0.0.0", cidr: 16, site: "hq",
			wantTFilter: `Site=="hq"`, wantFilter: `space=="ipam/ip_space/space-1"`,
		},
		{
			name: "address+cidr last", address: "10.0.0.0", cidr: 16,
			wantTFilter: "",
			wantFilter:  `space=="ipam/ip_space/space-1" and address=="10.0.0.0" and cidr==16`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, f := newBlockAPIHarness(t)
			if _, err := e.FindBlocksForRetag("ipam/ip_space/space-1", tc.template, tc.address, tc.cidr, tc.site); err != nil {
				t.Fatalf("FindBlocksForRetag() error = %v, want nil", err)
			}
			queries := f.blockQueries()
			if len(queries) != 1 {
				t.Fatalf("upstream received %d address_block read(s), want 1: %v", len(queries), queries)
			}
			if got := queries[0].Get("_tfilter"); got != tc.wantTFilter {
				t.Fatalf("_tfilter = %q, want %q — the wrong selector won, so this retag would "+
					"touch a different set of blocks than asked for", got, tc.wantTFilter)
			}
			if got := queries[0].Get("_filter"); got != tc.wantFilter {
				t.Fatalf("_filter = %q, want %q", got, tc.wantFilter)
			}
		})
	}
}

// No selector means "every block in the space", and the caller of a retag never
// means that. The refusal has to happen before the read, so the assertion is on
// the absence of the query as much as on the error.
func TestFindBlocksForRetagRefusesWithNoSelector(t *testing.T) {
	e, f := newBlockAPIHarness(t)

	got, err := e.FindBlocksForRetag("ipam/ip_space/space-1", "", "", nil, "")
	if err == nil {
		t.Fatalf("FindBlocksForRetag() error = nil (returned %v), want a refusal — an unfiltered "+
			"retag would rewrite every block in the space", got)
	}
	if !strings.Contains(err.Error(), "template, site, or address+cidr is required") {
		t.Fatalf("FindBlocksForRetag() error = %q, want it to say which selector is missing", err.Error())
	}
	if queries := f.blockQueries(); len(queries) != 0 {
		t.Fatalf("the unfiltered retag read upstream anyway: %v", queries)
	}
}

// Read-failed versus genuinely-nothing-matched, on the retag search. Both hand
// back "no blocks" to a careless caller; only one of them means the selector
// found nothing.
func TestFindBlocksForRetagFailedReadIsNotAnEmptyMatch(t *testing.T) {
	eFail, fFail := newBlockAPIHarness(t)
	fFail.blockStatus = 500
	fFail.blockBody = `{"error":"boom"}`
	failRows, failErr := eFail.FindBlocksForRetag("ipam/ip_space/space-1", "tmpl-1", "", nil, "")
	if failErr == nil {
		t.Fatalf("FindBlocksForRetag() error = nil on a 500 (rows %v), want the read failure reported", failRows)
	}
	if !strings.Contains(failErr.Error(), "could not read address blocks for retag") {
		t.Fatalf("read-failure error = %q, want it to say the read failed", failErr.Error())
	}
	if failRows != nil {
		t.Fatalf("FindBlocksForRetag() returned %v alongside a read failure, want nil rows", failRows)
	}

	eEmpty, _ := newBlockAPIHarness(t)
	emptyRows, emptyErr := eEmpty.FindBlocksForRetag("ipam/ip_space/space-1", "tmpl-1", "", nil, "")
	if emptyErr != nil {
		t.Fatalf("FindBlocksForRetag() error = %v on an empty match, want nil — nothing matching is "+
			"a legitimate answer", emptyErr)
	}
	if len(emptyRows) != 0 {
		t.Fatalf("FindBlocksForRetag() = %v, want no rows", emptyRows)
	}
}

// --- TemplateToBlockConfig ---------------------------------------------------

// A template with no address_blocks describes nothing. Building a config from it
// anyway produces a provision run that reports success having created zero
// blocks, which reads exactly like a run that worked.
func TestTemplateToBlockConfigRefusesATemplateWithNoBlocks(t *testing.T) {
	for _, tc := range []struct {
		name     string
		template M
		wantMsg  string
	}{
		{"key absent", M{"name": "tmpl-1"}, "address_blocks (non-empty list) is required"},
		{"empty list", M{"name": "tmpl-1", "address_blocks": []any{}}, "address_blocks (non-empty list) is required"},
		// A list holding only junk is refused for the sharper reason — the
		// entry it cannot read, named by position — not for being empty.
		{"only unusable entries", M{"name": "tmpl-1", "address_blocks": []any{"not-a-mapping"}}, "address_blocks[0]"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := TemplateToBlockConfig(tc.template, M{})
			if err == nil {
				t.Fatalf("TemplateToBlockConfig() error = nil (cfg %+v), want a refusal — a template "+
					"with no usable blocks would provision nothing and report success", cfg)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Fatalf("error = %q, want it to contain %q", err.Error(), tc.wantMsg)
			}
		})
	}
}

// Preview unless told otherwise. If an unspecified "dry" defaulted to false, a
// caller who forgot the flag would write to a live tenant.
func TestTemplateToBlockConfigDefaultsToDryRun(t *testing.T) {
	template := M{"name": "tmpl-1", "address_blocks": []any{M{"address": "10.0.0.0", "cidr": 16}}}

	cfg, err := TemplateToBlockConfig(template, M{})
	if err != nil {
		t.Fatalf("TemplateToBlockConfig() error = %v, want nil", err)
	}
	if !cfg.DryRun {
		t.Fatal("DryRun = false with no dry param — an omitted flag must preview, not write")
	}
	if cfg.IPSpace != defaultIPSpace {
		t.Fatalf("IPSpace = %q, want the default %q when neither params nor template name one",
			cfg.IPSpace, defaultIPSpace)
	}
}

func TestTemplateToBlockConfigParamsBeatTheTemplate(t *testing.T) {
	template := M{
		"name": "yaml-name", "ip_space": "yaml-space",
		"tags":           M{"Owner": "yaml-owner", "CostCentre": 4321},
		"address_blocks": []any{M{"address": "10.0.0.0", "cidr": 16}},
	}
	params := M{"name": "param-name", "ip_space": "param-space", "dry": "false"}

	cfg, err := TemplateToBlockConfig(template, params)
	if err != nil {
		t.Fatalf("TemplateToBlockConfig() error = %v, want nil", err)
	}
	if cfg.Name != "param-name" {
		t.Fatalf("Name = %q, want param-name (the caller's value wins over the file's)", cfg.Name)
	}
	if cfg.IPSpace != "param-space" {
		t.Fatalf("IPSpace = %q, want param-space", cfg.IPSpace)
	}
	if cfg.DryRun {
		t.Fatal("DryRun = true with dry=\"false\" — an explicit opt-out must be honoured")
	}
	wantTags := M{"Owner": "yaml-owner", "CostCentre": "4321"}
	if !reflect.DeepEqual(cfg.ExtraTags, wantTags) {
		t.Fatalf("ExtraTags = %v, want %v (tag values are stringified, so 4321 is \"4321\")",
			cfg.ExtraTags, wantTags)
	}
}

// --- parseBlocks -------------------------------------------------------------

// Well-formed input only. What is pinned: the default fill, the recursion into
// children, and the stringification of tag values. What is NOT pinned: cidr,
// which passes through untouched here and is validated later by createBlock.
// Malformed entries no longer belong in this fixture — they refuse the whole
// parse now, and that refusal is pinned by the two tests below.
func TestParseBlocksFillsDefaultsAndRecursesIntoChildren(t *testing.T) {
	got, err := parseBlocks([]any{
		M{
			"address": "  10.0.0.0  ", "cidr": 16, "region": "east",
			"tags": M{"CostCentre": 4321, "Critical": true},
			"children": []any{
				M{"address": "10.0.1.0", "cidr": 24, "status": "reserved", "comment": "child"},
			},
		},
	}, "address_blocks")
	if err != nil {
		t.Fatalf("parseBlocks() error = %v, want nil — every entry here is well-formed", err)
	}

	want := []any{
		M{
			"address": "10.0.0.0", "cidr": 16, "region": "east", "environment": "",
			"status": "available", "location": "", "comment": "",
			"tags": M{"CostCentre": "4321", "Critical": "True"},
			"children": []any{
				M{
					"address": "10.0.1.0", "cidr": 24, "region": "", "environment": "",
					"status": "reserved", "location": "", "comment": "child",
					"tags": M{}, "children": []any{},
				},
			},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseBlocks() = %#v\nwant %#v", got, want)
	}
}

// --- exists(): the lookup that decides create-vs-skip --------------------------
//
// HONEST SCOPE. The two tests below pin ONE thing: the shape of the _filter
// exists() sends, and the consequence of getting it wrong. exists() is the sole
// gate between "create this block on a live tenant" and "skip it". Every other
// test in this file that reaches a create is answered by a fixture that replays
// the same rows whatever it is asked, so none of them can notice a filter that
// selects the wrong object — dropping the cidr term from the query left the
// whole package green.
//
// What a missing cidr term costs on a live tenant: 10.0.0.0/16 and 10.0.0.0/24
// become the same object to the lookup, so a /24 that genuinely is not there is
// reported as already existing, silently never created, and the run reports
// success having done nothing.
//
// Still NOT pinned here: pagination of the existence read, IPv6, and the
// space-id term's own correctness beyond its presence in the string.

// The query itself. The cidr term is asserted separately from the space and
// address terms on purpose: a single "the whole filter equals X" assertion is
// one string and says nothing about WHICH term went missing, and a contains-all
// loop would let a reader assume the address term alone was doing the work.
func TestBlockExistenceCheckFiltersOnCidrNotJustAddress(t *testing.T) {
	e, f := newBlockAPIHarness(t)
	// nestedBlockConfig is 10.0.0.0/16 with a 10.0.1.0/24 child, so the two
	// existence reads carry two DIFFERENT cidrs — a filter built from a
	// hardcoded or stale cidr cannot satisfy both.
	p := e.NewBlockProvisioner(nestedBlockConfig(), func(M) {})
	if _, err := p.Provision(false); err != nil {
		t.Fatalf("Provision() error = %v, want nil", err)
	}

	queries := f.blockQueries()
	if len(queries) != 2 {
		t.Fatalf("upstream received %d existence read(s), want 2 (parent then child): %v", len(queries), queries)
	}

	for i, want := range []struct{ address, cidr string }{
		{"10.0.0.0", "16"},
		{"10.0.1.0", "24"},
	} {
		filter := queries[i].Get("_filter")
		if filter == "" {
			t.Fatalf("existence read %d sent no _filter at all — an unfiltered read returns every "+
				"block in the tenant and every create would be skipped", i)
		}
		if !strings.Contains(filter, `space=="ipam/ip_space/space-1"`) {
			t.Fatalf("existence read %d _filter = %q, want the resolved space id — a check that "+
				"ignores the space finds a same-numbered block in a different space", i, filter)
		}
		if !strings.Contains(filter, fmt.Sprintf(`address==%q`, want.address)) {
			t.Fatalf("existence read %d _filter = %q, want the address term for %s", i, filter, want.address)
		}
		// The term this whole file previously could not miss. Dropping ONLY
		// this one leaves the two assertions above satisfied.
		if !strings.Contains(filter, "cidr=="+want.cidr) {
			t.Fatalf("existence read %d _filter = %q, want it to constrain cidr==%s — without the cidr "+
				"term %s/%s and any other prefix at the same address are one object to this lookup, so a "+
				"block that does not exist is reported as existing and never created",
				i, filter, want.cidr, want.address, want.cidr)
		}
	}
}

// blockFilterMatches answers a _filter the way a tenant would: the row comes
// back only if EVERY term in the filter holds against it. Terms are
// `key=="value"` or `key==value`, joined by " and " — the exact shape exists()
// builds. An unparseable term or an unknown key refuses to match rather than
// falling through to a yes, so a malformed filter can never be mistaken for a
// hit.
func blockFilterMatches(filter string, row map[string]string) bool {
	for _, term := range strings.Split(filter, " and ") {
		key, want, ok := strings.Cut(strings.TrimSpace(term), "==")
		if !ok {
			return false
		}
		got, known := row[key]
		if !known || got != strings.Trim(want, `"`) {
			return false
		}
	}
	return true
}

// THE CONSEQUENCE, not the string. A tenant holding 10.0.0.0/16 is asked to
// provision 10.0.0.0/24 — a different, real block that does not exist yet. The
// fake answers the filter honestly, so the correct query finds nothing and the
// create must go out.
//
// This is the test that catches the mutation semantically: strip the cidr term
// and the fake legitimately returns the /16, exists() says "already there", and
// the create silently never happens — a provision that reports success and
// created nothing.
func TestBlockProvisionCreatesASubnetOfAnExistingBlockAtTheSameAddress(t *testing.T) {
	e, f := newBlockAPIHarness(t)

	// What the tenant already holds: the /16 only. Nothing at /24.
	existing := map[string]string{
		"space":   "ipam/ip_space/space-1",
		"address": "10.0.0.0",
		"cidr":    "16",
	}
	f.blockBodyFor = func(q url.Values) string {
		if blockFilterMatches(q.Get("_filter"), existing) {
			return `{"results":[{"id":"ipam/address_block/existing-16","address":"10.0.0.0","cidr":16}]}`
		}
		return `{"results":[]}`
	}

	var steps []string
	p := e.NewBlockProvisioner(&BlockConfig{
		Name: "regional-pool", IPSpace: "default", DryRun: false, ExtraTags: M{},
		Blocks: []any{M{"address": "10.0.0.0", "cidr": 24, "status": "deployed"}},
	}, collectSteps(&steps))

	if _, err := p.Provision(false); err != nil {
		t.Fatalf("Provision() error = %v, want nil", err)
	}

	// Guard: the fixture is only meaningful if the fake was actually consulted
	// and would have said yes to a /16 query. Without this an empty match could
	// mean the honest-answer knob was never wired up.
	if !blockFilterMatches(`space=="ipam/ip_space/space-1" and address=="10.0.0.0" and cidr==16`, existing) {
		t.Fatal("the fixture does not report the /16 as existing — this test cannot distinguish anything")
	}

	posts := f.posts()
	if len(posts) != 1 {
		t.Fatalf("upstream received %d create(s), want 1 for 10.0.0.0/24: %v\n"+
			"The tenant holds 10.0.0.0/16 and nothing at /24, so the /24 must be created. Zero creates "+
			"means the existence check matched the /16 — it is not comparing cidr, and this block would "+
			"never be provisioned on a live tenant while the run reported success.", len(posts), posts)
	}
	if got := pyStr(posts[0]["address"]); got != "10.0.0.0" {
		t.Fatalf("create address = %q, want 10.0.0.0", got)
	}
	if got := pyStr(posts[0]["cidr"]); got != "24" {
		t.Fatalf("create cidr = %q, want 24 — the /16 must not be re-created", got)
	}

	for _, s := range steps {
		if strings.Contains(s, "Already exists — skipping") {
			t.Fatalf("the run skipped 10.0.0.0/24 as already existing (%q) — the only block upstream is "+
				"10.0.0.0/16, a different range. steps: %v", s, steps)
		}
	}
}

// RAW TEMPLATE ADDRESS vs MASKED NETWORK ADDRESS.
//
// Every fixture above writes addresses that are already network addresses, so
// masking is a no-op and the two cannot be told apart. These two tests use a
// HOST address (10.0.1.5/24) — the only shape where the existence check and the
// create can disagree about which object they mean.
//
// Still NOT pinned: IPv6 and pagination of the existence read.
// FindBlocksForRetag had the same raw-address bug; it is now fixed and pinned
// by the two tests at the end of this file.

// THE CONSEQUENCE. A previous run of this same template created 10.0.1.0/24
// (createBlock POSTs the masked address). Re-running it must recognise its own
// block and skip. Checking the raw 10.0.1.5 finds nothing and creates a
// DUPLICATE block on a live tenant, which is why zero POSTs is the assertion
// and not merely "no error".
func TestBlockProvisionRerunMatchesItsOwnHostAddressedBlock(t *testing.T) {
	e, f := newBlockAPIHarness(t)

	// What the tenant holds after the first run: the MASKED address, stored the
	// way createBlock wrote it. cidr is a string because blockFilterMatches
	// compares strings — same idiom as the /16 fixture above.
	existing := map[string]string{
		"space":   "ipam/ip_space/space-1",
		"address": "10.0.1.0",
		"cidr":    "24",
	}
	f.blockBodyFor = func(q url.Values) string {
		if blockFilterMatches(q.Get("_filter"), existing) {
			return `{"results":[{"id":"ipam/address_block/existing-24","address":"10.0.1.0","cidr":24}]}`
		}
		return `{"results":[]}`
	}

	// Guard: if the fixture would not answer yes to the correct query, this test
	// could pass for the wrong reason (an empty tenant also produces no match).
	if !blockFilterMatches(`space=="ipam/ip_space/space-1" and address=="10.0.1.0" and cidr==24`, existing) {
		t.Fatal("the fixture does not report 10.0.1.0/24 as existing — this test cannot distinguish anything")
	}

	var steps []string
	// DryRun is spelled out: the dry-run path never calls exists() at all, so a
	// defaulted-true config would skip the code under test entirely.
	p := e.NewBlockProvisioner(&BlockConfig{
		Name: "regional-pool", IPSpace: "default", DryRun: false, ExtraTags: M{},
		Blocks: []any{M{"address": "10.0.1.5", "cidr": 24, "status": "deployed"}},
	}, collectSteps(&steps))

	if _, err := p.Provision(false); err != nil {
		t.Fatalf("Provision() error = %v, want nil", err)
	}

	if posts := f.posts(); len(posts) != 0 {
		t.Fatalf("upstream received %d create(s), want 0: %v\n"+
			"The tenant already holds 10.0.1.0/24, which is exactly what this template creates "+
			"(10.0.1.5/24 masks to 10.0.1.0). A create here is a DUPLICATE block on a live tenant, "+
			"issued because the existence check looked up the raw template address instead of the "+
			"masked one it would go on to POST.", len(posts), posts)
	}

	skipped := 0
	for _, s := range steps {
		if strings.Contains(s, "Already exists — skipping") {
			skipped++
		}
	}
	if skipped != 1 {
		t.Fatalf("saw %d \"Already exists — skipping\" step(s), want exactly 1. steps: %v\n"+
			"The run must SAY it recognised its own block, not merely happen to send no POST.", skipped, steps)
	}
}

// THE QUERY, and the agreement between the two calls. Asserted against an EMPTY
// tenant so the create actually goes out and both wire messages can be compared:
// the address the GET filtered on and the address the POST creates must be the
// same string. Asserting only the filter would leave open that the fix moved the
// disagreement rather than removing it.
func TestBlockExistenceCheckQueriesTheMaskedAddress(t *testing.T) {
	e, f := newBlockAPIHarness(t) // default: nothing exists upstream

	p := e.NewBlockProvisioner(&BlockConfig{
		Name: "regional-pool", IPSpace: "default", DryRun: false, ExtraTags: M{},
		Blocks: []any{M{"address": "10.0.1.5", "cidr": 24, "status": "deployed"}},
	}, func(M) {})

	if _, err := p.Provision(false); err != nil {
		t.Fatalf("Provision() error = %v, want nil", err)
	}

	queries := f.blockQueries()
	if len(queries) != 1 {
		t.Fatalf("upstream received %d existence read(s), want 1: %v", len(queries), queries)
	}
	filter := queries[0].Get("_filter")
	if !strings.Contains(filter, `address=="10.0.1.0"`) {
		t.Fatalf("existence read _filter = %q, want address==\"10.0.1.0\" — the create POSTs the masked "+
			"network address, so the check must look for that same object", filter)
	}
	// The negative matters on its own: a filter carrying BOTH terms would satisfy
	// the assertion above while still asking about the wrong object.
	if strings.Contains(filter, `address=="10.0.1.5"`) {
		t.Fatalf("existence read _filter = %q, still carries the raw template address 10.0.1.5 — no block "+
			"is ever stored under a host address, so this check can never match and every re-run "+
			"duplicates the block", filter)
	}

	posts := f.posts()
	if len(posts) != 1 {
		t.Fatalf("upstream received %d create(s), want 1 (the tenant is empty): %v", len(posts), posts)
	}
	// The check and the create must name the same object, whatever that object is.
	if got := pyStr(posts[0]["address"]); !strings.Contains(filter, fmt.Sprintf("address==%q", got)) {
		t.Fatalf("the create POSTed address %q but the existence read filtered on %q — the check and the "+
			"create are asking about different blocks, so the check can never prevent a duplicate", got, filter)
	}
}

// --- FindBlocksForRetag: the same raw-address bug (finding B-F1) -------------
//
// The retag selector arm above (TestFindBlocksForRetagSelectorPrecedence) uses
// 10.0.0.0/16, which is already a network address, so masking is a no-op there
// and a raw-address lookup is indistinguishable from a masked one. These tests
// use a HOST address, the only shape that tells them apart.

// THE CONSEQUENCE, not the string. The tenant holds the block as createBlock
// stored it (10.0.1.0/24). An operator retagging 10.0.1.5/24 means that block.
// Filtering on the raw 10.0.1.5 matches nothing, and the route reports
// {"changed": []} with a 200 — a retag that says it worked and changed nothing.
// So the assertion is that a row comes back, not merely that no error did.
func TestFindBlocksForRetagMatchesAHostAddressedSelector(t *testing.T) {
	e, f := newBlockAPIHarness(t)

	existing := map[string]string{
		"space":   "ipam/ip_space/space-1",
		"address": "10.0.1.0",
		"cidr":    "24",
	}
	f.blockBodyFor = func(q url.Values) string {
		if blockFilterMatches(q.Get("_filter"), existing) {
			return `{"results":[{"id":"ipam/address_block/existing-24","address":"10.0.1.0","cidr":24}]}`
		}
		return `{"results":[]}`
	}

	// Guard: an empty tenant also produces no match, so without this the test
	// could pass for the wrong reason if the fixture were mis-wired.
	if !blockFilterMatches(`space=="ipam/ip_space/space-1" and address=="10.0.1.0" and cidr==24`, existing) {
		t.Fatal("the fixture does not report 10.0.1.0/24 as existing — this test cannot distinguish anything")
	}

	rows, err := e.FindBlocksForRetag("ipam/ip_space/space-1", "", "10.0.1.5", 24, "")
	if err != nil {
		t.Fatalf("FindBlocksForRetag() error = %v, want nil", err)
	}
	if len(rows) != 1 {
		t.Fatalf("FindBlocksForRetag() returned %d row(s), want 1: %v\n"+
			"The tenant holds 10.0.1.0/24, which is exactly the block 10.0.1.5/24 names "+
			"(blocks are stored at the masked network address). No rows means the lookup asked for the "+
			"raw selector, so the retag would rewrite NOTHING while reporting success.", len(rows), rows)
	}
	if got := pyStr(asMap(rows[0])["id"]); got != "ipam/address_block/existing-24" {
		t.Fatalf("matched block id = %q, want ipam/address_block/existing-24", got)
	}
}

// THE QUERY. Asserted against the default empty tenant so nothing about the
// fixture can explain the filter. The negative is separate on purpose: a filter
// carrying BOTH addresses would satisfy the positive while still naming an
// object no block is ever stored under.
func TestFindBlocksForRetagQueriesTheMaskedAddress(t *testing.T) {
	e, f := newBlockAPIHarness(t)

	if _, err := e.FindBlocksForRetag("ipam/ip_space/space-1", "", "10.0.1.5", 24, ""); err != nil {
		t.Fatalf("FindBlocksForRetag() error = %v, want nil", err)
	}

	queries := f.blockQueries()
	if len(queries) != 1 {
		t.Fatalf("upstream received %d retag read(s), want 1: %v", len(queries), queries)
	}
	filter := queries[0].Get("_filter")
	if !strings.Contains(filter, `address=="10.0.1.0"`) {
		t.Fatalf("retag read _filter = %q, want address==\"10.0.1.0\" — blocks are stored at the masked "+
			"network address, so the retag lookup must name that same object", filter)
	}
	if strings.Contains(filter, `address=="10.0.1.5"`) {
		t.Fatalf("retag read _filter = %q, still carries the raw host address 10.0.1.5 — no block is ever "+
			"stored under a host address, so this lookup can never match and the retag silently "+
			"changes nothing", filter)
	}
	if !strings.Contains(filter, "cidr==24") {
		t.Fatalf("retag read _filter = %q, want the cidr==24 term — without it every prefix at that "+
			"address is one object to this lookup and the retag rewrites blocks it was not asked about", filter)
	}
}

// A selector that cannot be parsed must REFUSE, out loud and before the read.
// The tempting alternative — fall back to the raw string — is what this whole
// fix removes: it would put the silent-no-op back for exactly the inputs that
// trigger it, and "matched nothing" is indistinguishable from a legitimate
// empty result. So the assertions are the error AND the absence of any query.
func TestFindBlocksForRetagRefusesAnUnparseableSelector(t *testing.T) {
	cases := []struct {
		name    string
		address string
		cidr    any
		wantMsg string
		raw     string // must not appear in any query that (wrongly) went out
	}{
		{
			name: "cidr is not a number", address: "10.0.1.5", cidr: "twenty-four",
			wantMsg: "cidr is not an integer", raw: "10.0.1.5",
		},
		{
			name: "address is not an address", address: "not-an-ip", cidr: 24,
			wantMsg: "Invalid retag selector", raw: "not-an-ip",
		},
		{
			name: "cidr out of range for the family", address: "10.0.1.5", cidr: 99,
			wantMsg: "Invalid retag selector", raw: "10.0.1.5",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, f := newBlockAPIHarness(t)

			rows, err := e.FindBlocksForRetag("ipam/ip_space/space-1", "", tc.address, tc.cidr, "")
			if err == nil {
				t.Fatalf("FindBlocksForRetag(%q, %v) error = nil (returned %v), want a refusal — an "+
					"unparseable selector cannot be masked, and passing it through raw retags nothing "+
					"while reporting success", tc.address, tc.cidr, rows)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Fatalf("error = %q, want it to contain %q so the operator can see WHICH selector was "+
					"rejected", err.Error(), tc.wantMsg)
			}
			if rows != nil {
				t.Fatalf("FindBlocksForRetag() returned %v alongside a refusal, want nil rows", rows)
			}
			for _, q := range f.blockQueries() {
				t.Fatalf("the rejected selector read upstream anyway (_filter %q) — the refusal must "+
					"happen before the read, and the raw %q must never reach a filter",
					q.Get("_filter"), tc.raw)
			}
		})
	}
}

// --- a malformed template entry refuses, before any tenant call --------------
//
// The defect this pins: parseBlocks used to skip any entry that was not a
// mapping, so a template listing three address blocks provisioned two, reported
// success, and previewed the same under-count — an operator who checked first
// still could not see the missing block. Partial presented as complete.
//
// Both tests run the route's own sequence (build the config, then provision
// only if it built) against a fake that records EVERY request. Asserting on the
// error alone would pass just as happily if the refusal came after the first
// create; the recorded-request count is what proves nothing reached upstream.
// NO REAL TENANT: httptest only.

type blockRefusalFake struct {
	mu       sync.Mutex
	requests []string // "METHOD path", in arrival order
}

func (f *blockRefusalFake) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.requests = append(f.requests, r.Method+" "+r.URL.Path)
		f.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		// Answer well enough that a provision run which SHOULD have been
		// refused gets all the way to a create — otherwise a mutation that
		// reintroduces the silent skip could go green on an upstream error
		// instead of failing on the request count.
		switch {
		case r.Method == http.MethodPost:
			w.WriteHeader(201)
			w.Write([]byte(`{"result":{"id":"ipam/address_block/b-1"}}`))
		case strings.HasSuffix(r.URL.Path, "/ipam/ip_space"):
			w.Write([]byte(`{"results":[{"id":"ipam/ip_space/space-1","name":"default"}]}`))
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	}
}

func (f *blockRefusalFake) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.requests...)
}

func newBlockRefusalHarness(t *testing.T) (*Engine, *blockRefusalFake) {
	t.Helper()
	f := &blockRefusalFake{}
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	return newTestEngine(srv), f
}

func TestTemplateToBlockConfigRefusesAMalformedEntryNamingItAndCallsNoTenant(t *testing.T) {
	good := M{"address": "10.0.0.0", "cidr": 16}
	for _, tc := range []struct {
		name     string
		template M
		wantAt   string
	}{
		{
			// The decision doc's case: three listed, one unreadable.
			name: "top-level entry",
			template: M{"name": "tmpl-1", "address_blocks": []any{
				good,
				"junk",
				M{"address": "10.2.0.0", "cidr": 16},
			}},
			wantAt: "address_blocks[1]",
		},
		{
			// A child is provisioned by the same recursion, so it must refuse
			// the same way — and the error has to say WHICH child, not just
			// which parent.
			name: "nested child",
			template: M{"name": "tmpl-1", "address_blocks": []any{
				M{"address": "10.0.0.0", "cidr": 16, "children": []any{
					M{"address": "10.0.1.0", "cidr": 24},
					"junk",
				}},
			}},
			wantAt: "address_blocks[0].children[1]",
		},
		{
			// A stray YAML null reads as an empty line in the file, so it is
			// the likeliest real-world typo of the lot.
			name:     "yaml null entry",
			template: M{"name": "tmpl-1", "address_blocks": []any{good, nil}},
			wantAt:   "address_blocks[1]",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e, f := newBlockRefusalHarness(t)

			cfg, err := TemplateToBlockConfig(tc.template, M{"dry": false})
			if err == nil {
				// Do what both routes do when the config builds, so a silent
				// skip shows up as real tenant traffic rather than only as a
				// nil error: server/provision.go:249 and :505.
				var steps []string
				result, provErr := e.NewBlockProvisioner(cfg, collectSteps(&steps)).Provision(false)
				t.Fatalf("TemplateToBlockConfig() error = nil, want a refusal naming %s. It parsed "+
					"%d block(s) from a template listing more, and provisioning went ahead: result %v, "+
					"err %v, requests %v", tc.wantAt, len(cfg.Blocks), result, provErr, f.seen())
			}
			if !strings.Contains(err.Error(), tc.wantAt) {
				t.Fatalf("error = %q, want it to contain %q — an error that does not name the entry "+
					"sends the operator hunting through the file", err.Error(), tc.wantAt)
			}
			if cfg != nil {
				t.Fatalf("TemplateToBlockConfig() returned a config (%+v) alongside a refusal, want nil — "+
					"a half-read template must not be provisionable", cfg)
			}
			if got := f.seen(); len(got) != 0 {
				t.Fatalf("the fake received %d request(s) %v, want none — the refusal must land before "+
					"anything touches the tenant", len(got), got)
			}
		})
	}
}

// The refusal is a REFUSAL, not a filter: a template whose entries are all
// readable still builds, with every listed block present. Without this, the
// test above would pass just as well if parseBlocks refused everything.
func TestTemplateToBlockConfigStillBuildsWhenEveryEntryIsAMapping(t *testing.T) {
	template := M{"name": "tmpl-1", "address_blocks": []any{
		M{"address": "10.0.0.0", "cidr": 16, "children": []any{M{"address": "10.0.1.0", "cidr": 24}}},
		M{"address": "10.2.0.0", "cidr": 16},
	}}

	cfg, err := TemplateToBlockConfig(template, M{})
	if err != nil {
		t.Fatalf("TemplateToBlockConfig() error = %v, want nil", err)
	}
	if len(cfg.Blocks) != 2 {
		t.Fatalf("parsed %d top-level block(s), want 2 — the template lists 2", len(cfg.Blocks))
	}
	if n := len(getList(asMap(cfg.Blocks[0]), "children")); n != 1 {
		t.Fatalf("parsed %d child block(s) under address_blocks[0], want 1", n)
	}
}
