package provision

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
)

// THE FAILURE RETURN VALUE.
//
// Scope: what SiteProvisioner.Provision hands back when it FAILS. Until now it
// handed back nil, so everything rollback learned — which objects it could not
// delete, whether it deleted anything at all — died inside the function and the
// caller had only err.Error() to render. Objects left live on a customer's
// tenant were unnamed anywhere a human or an audit log could see them.
//
// Two things are asserted here and nowhere else:
//
//  1. The report EXISTS on every failure path, with an explicit outcome word.
//     An empty residual list cannot distinguish "rollback deleted all 6 objects"
//     from "rollback ran and there was nothing to delete" from "rollback never
//     ran because this was a preview" — all three produce []. Cardinality is not
//     a status, and this value is destined for an append-only signed audit log
//     that can never be amended afterwards.
//
//  2. The failure return carries ONLY the report. The internal result map is a
//     mixed bag after rollback — pre-existing block, live reused zones, and
//     tombstones of deleted subnets, all side by side — so exporting it would
//     state things that are not true.
//
// Reuses siteRollbackFake / siteRollbackConfig / newSiteRollbackHarness /
// collectSteps from site_rollback_test.go and block_test.go. NO TEST HERE
// TOUCHES A REAL TENANT.

// rbReport pulls the report out of a failure return and proves the failure
// return is nothing BUT the report. Every assertion below runs through it, so a
// regression that starts re-exporting the construction scratchpad fails every
// test in this file rather than slipping through the one that forgot to look.
func rbReport(t *testing.T, out M) M {
	t.Helper()
	if out == nil {
		t.Fatal("Provision() returned a nil map on the failure path — the rollback report died inside " +
			"the function and the caller has only err.Error() to show for objects left live upstream")
	}
	v, ok := out["rollback"]
	if !ok {
		t.Fatalf("failure map has no \"rollback\" key: %v\nPresence is unconditional on the failure path; "+
			"no meaning may ever be carried by a missing key", out)
	}
	rep, ok := v.(M)
	if !ok {
		t.Fatalf("rollback = %T (%v), want map[string]any — canonicalJSON's type switch rejects anything "+
			"else and auditAppend swallows that error, so the audit entry would be silently dropped", v, v)
	}
	for _, k := range []string{"subnets", "hosts", "block_id", "dhcp_ranges", "reverse_zones", "dns_zone_id"} {
		if _, present := out[k]; present {
			t.Fatalf("failure map exported construction key %q (full map: %v)\n"+
				"After rollback those keys are not a description of live state: block_id names a "+
				"PRE-EXISTING block rollback never deletes, reused zones and \"(exists)\" hosts are live "+
				"and were never ours, and every subnet/host this run created is a tombstone rollback just "+
				"deleted. Returning them tells the next caller to render deleted objects as live ones.", k, out)
		}
	}
	if len(out) != 1 {
		t.Fatalf("failure map has %d keys (%v), want exactly 1 (\"rollback\")", len(out), out)
	}
	return rep
}

func rbInt(t *testing.T, rep M, key string) int {
	t.Helper()
	v, ok := rep[key]
	if !ok {
		t.Fatalf("rollback report has no %q: %v", key, rep)
	}
	n, ok := v.(int)
	if !ok {
		t.Fatalf("rollback report %q = %T (%v), want int — canonicalJSON has no case for other numeric "+
			"types and auditAppend drops the entry silently when encoding fails", key, v, v)
	}
	return n
}

func rbResidual(t *testing.T, rep M) []any {
	t.Helper()
	v, ok := rep["residual"]
	if !ok {
		t.Fatalf("rollback report has no \"residual\": %v", rep)
	}
	list, ok := v.([]any)
	if !ok {
		t.Fatalf("residual = %T (%v), want []any — []M is []map[string]any, which canonicalJSON's type "+
			"switch does NOT accept", v, v)
	}
	return list
}

// rbTuples renders residual entries as kind|id|status so a test can compare the
// SET of objects reported as left behind. Comparing tuples rather than checking
// that the fields are merely non-empty is the point: a residual that names the
// wrong object, or blames a subnet's refused delete on a host, is exactly as
// useless to an operator as no residual at all, and passes any non-empty check.
func rbTuples(t *testing.T, rep M) []string {
	t.Helper()
	var got []string
	for _, e := range rbResidual(t, rep) {
		m, ok := e.(M)
		if !ok {
			t.Fatalf("residual entry = %T (%v), want map[string]any", e, e)
		}
		got = append(got, fmt.Sprintf("%v|%v|%v", m["kind"], m["id"], m["status"]))
	}
	sort.Strings(got)
	return got
}

func rbOutcome(t *testing.T, rep M) string {
	t.Helper()
	s, ok := rep["outcome"].(string)
	if !ok {
		t.Fatalf("outcome = %T (%v), want string", rep["outcome"], rep["outcome"])
	}
	return s
}

// T1. THE DIAGNOSIS REPRO — objects genuinely left upstream must be named.
//
// The host create fails, so rollback runs over a fully-built site; upstream then
// refuses both subnet DELETEs. Those two subnets are still live on the customer's
// tenant and nothing else in the system will ever mention them again. This is the
// scenario the whole change exists for, so the assertion is the concrete
// (kind, id, status) tuples, not a count and not a non-empty check.
func TestRBSiteProvisionFailureReportsIncompleteWithNamedResiduals(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.hostStatus = 500
	f.deleteStatus = func(path string) int {
		if strings.Contains(path, "/ipam/subnet/") {
			return 500
		}
		return 200
	}

	var steps []string
	p := e.NewSiteProvisioner(siteRollbackConfig(false), collectSteps(&steps))

	out, err := p.Provision()
	if err == nil {
		t.Fatalf("Provision() error = nil, want the host-create failure (out %v)", out)
	}
	if !strings.Contains(err.Error(), "Failed to create host") {
		t.Fatalf("Provision() error = %q, want the host-create failure — the fixture broke somewhere else "+
			"and this test is not exercising a rollback over a fully-built site", err.Error())
	}

	rep := rbReport(t, out)
	if got := rbOutcome(t, rep); got != "incomplete" {
		t.Fatalf("outcome = %q, want \"incomplete\" — two subnets are still live upstream", got)
	}
	attempted, deleted := rbInt(t, rep, "attempted"), rbInt(t, rep, "deleted")
	if attempted <= deleted {
		t.Fatalf("attempted = %d, deleted = %d, want attempted > deleted — the two refused subnet DELETEs "+
			"must show up as the gap between them", attempted, deleted)
	}
	if attempted-deleted != 2 {
		t.Fatalf("attempted = %d, deleted = %d — want exactly 2 failures (both subnets). DELETEs: %v",
			attempted, deleted, f.deletes())
	}

	want := []string{
		"subnet|ipam/subnet/s-1|500",
		"subnet|ipam/subnet/s-2|500",
	}
	got := rbTuples(t, rep)
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("residual tuples (kind|id|status) = %v,\nwant %v\n"+
			"Those two subnets exist on the customer's tenant right now. An entry naming the wrong kind or "+
			"the wrong id sends the operator to clean up something that is fine and leaves the real orphans "+
			"in place. Full residual: %v", got, want, rbResidual(t, rep))
	}

	// The label is what a human reads in the Provision log and in the audit
	// entry. createSubnet records "address" already carrying the prefix, and
	// these entries have no "cidr" key — so appending one rendered every
	// subnet as "10.10.1.0/24/". A trailing slash is the visible symptom of a
	// label built from a field that was never there, and this value is written
	// into an append-only signed log that cannot be corrected afterwards.
	for _, e := range rbResidual(t, rep) {
		m, ok := e.(map[string]any)
		if !ok {
			t.Fatalf("residual entry = %T, want map[string]any", e)
		}
		label, _ := m["label"].(string)
		if label == "" || strings.HasSuffix(label, "/") {
			t.Fatalf("residual label = %q for id=%v — want the recorded address (e.g. \"10.10.1.0/24\"). "+
				"A trailing slash means the label is formatting a key these entries do not carry.",
				label, m["id"])
		}
	}
}

// T2. A ROLLBACK THAT SUCCEEDED SAYS SO — and says how much it undid.
//
// Same failure, every DELETE accepted. The old design wrote an empty list here,
// which is byte-for-byte what a rollback that had nothing to do writes. "complete"
// with attempted == deleted > 0 is the difference, and the counts are what make
// it verifiable rather than a claim.
func TestRBSiteProvisionFailureCleanRollbackReportsComplete(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.hostStatus = 500

	var steps []string
	p := e.NewSiteProvisioner(siteRollbackConfig(false), collectSteps(&steps))

	out, err := p.Provision()
	if err == nil {
		t.Fatalf("Provision() error = nil, want the host-create failure (out %v)", out)
	}

	rep := rbReport(t, out)
	if got := rbOutcome(t, rep); got != "complete" {
		t.Fatalf("outcome = %q, want \"complete\" — every DELETE was accepted. report: %v", got, rep)
	}
	attempted, deleted := rbInt(t, rep, "attempted"), rbInt(t, rep, "deleted")
	if attempted == 0 {
		t.Fatalf("attempted = 0, but the run built subnets, ranges and zones before it failed — "+
			"\"complete\" over zero deletes would be vacuously true. DELETEs: %v", f.deletes())
	}
	if deleted != attempted {
		t.Fatalf("deleted = %d, attempted = %d, want equal", deleted, attempted)
	}
	if n := len(f.deletes()); n != attempted {
		t.Fatalf("attempted = %d but the fake recorded %d DELETE(s): %v — the count must be the DELETEs "+
			"actually issued, not the size of the recorded object lists", attempted, n, f.deletes())
	}
	if res := rbResidual(t, rep); len(res) != 0 {
		t.Fatalf("residual = %v, want empty", res)
	}
}

// T3. A PREVIEW ROLLS BACK NOTHING — and that is a stated outcome, not a silence.
//
// A dry run creates nothing, so rollback deliberately does not run. Under the
// old design that produced an ABSENT key, indistinguishable from any record
// written before this change existed. "skipped_dry_run" is permanently
// distinguishable from both a real rollback and a legacy entry.
func TestRBSiteProvisionDryRunFailureReportsSkipped(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.previewAddrs = []string{"10.10.1.0", "not-an-ip"}

	var steps []string
	p := e.NewSiteProvisioner(siteRollbackConfig(true), collectSteps(&steps))

	out, err := p.Provision()
	if err == nil {
		t.Fatalf("Provision() error = nil, want the unusable-address failure (out %v)", out)
	}
	if !strings.Contains(err.Error(), "not-an-ip") {
		t.Fatalf("Provision() error = %q, want the unusable-address failure — the dry run broke for some "+
			"other reason", err.Error())
	}

	rep := rbReport(t, out)
	if got := rbOutcome(t, rep); got != "skipped_dry_run" {
		t.Fatalf("outcome = %q, want \"skipped_dry_run\" — a preview created nothing, so rollback must "+
			"not run and must not claim it did. report: %v", got, rep)
	}
	if n := rbInt(t, rep, "attempted"); n != 0 {
		t.Fatalf("attempted = %d, want 0 on a dry run", n)
	}
	if n := rbInt(t, rep, "deleted"); n != 0 {
		t.Fatalf("deleted = %d, want 0 on a dry run", n)
	}
	if d := f.deletes(); len(d) != 0 {
		t.Fatalf("a dry run sent %d DELETE(s) upstream: %v", len(d), d)
	}
	for _, s := range steps {
		if strings.Contains(s, "Rolling back") {
			t.Fatalf("a dry run announced a rollback (%q). steps: %v", s, steps)
		}
	}
}

// T13. A FAILURE THAT CREATED NOTHING IS NOT A SUCCESSFUL CLEANUP.
//
// The very first upstream read fails, so the run never creates an object, but
// rollback still runs (it is not a dry run). Under the old design this wrote
// "rollback_residual": [] into a signed, append-only log where it reads as
// "rollback ran and deleted everything" — permanently, unamendably wrong about a
// tenant nothing was ever done to. "not_needed" is the honest word.
func TestRBSiteProvisionFailureBeforeAnyCreateReportsNotNeeded(t *testing.T) {
	var mu sync.Mutex
	deletes := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			mu.Lock()
			deletes++
			mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"upstream unavailable"}`))
	}))
	t.Cleanup(srv.Close)

	var steps []string
	p := newTestEngine(srv).NewSiteProvisioner(siteRollbackConfig(false), collectSteps(&steps))

	out, err := p.Provision()
	if err == nil {
		t.Fatalf("Provision() error = nil, want the IP space lookup failure (out %v)", out)
	}
	if !strings.Contains(err.Error(), "could not read IP space") {
		t.Fatalf("Provision() error = %q, want the IP space lookup failure — the run got further than the "+
			"first read and this test is no longer about a run that created nothing", err.Error())
	}

	rep := rbReport(t, out)
	if got := rbOutcome(t, rep); got != "not_needed" {
		t.Fatalf("outcome = %q, want \"not_needed\" — nothing was ever created, so there was nothing to "+
			"undo. \"complete\" here signs a claim that a cleanup happened, into a log that can never be "+
			"amended. report: %v", got, rep)
	}
	if n := rbInt(t, rep, "attempted"); n != 0 {
		t.Fatalf("attempted = %d, want 0", n)
	}
	if n := rbInt(t, rep, "deleted"); n != 0 {
		t.Fatalf("deleted = %d, want 0", n)
	}
	if res := rbResidual(t, rep); len(res) != 0 {
		t.Fatalf("residual = %v, want empty", res)
	}
	mu.Lock()
	defer mu.Unlock()
	if deletes != 0 {
		t.Fatalf("rollback issued %d DELETE(s) after a run that created nothing", deletes)
	}
}

// newRBPatchFailHarness is newSiteRollbackHarness with every PATCH refused.
//
// The tagging PATCH is the one failure siteRollbackFake cannot express on its
// own: it answers PATCH out of f.subnets, which nextSubnet always populates, so
// the tag write always succeeds there. Wrapping rather than adding a knob keeps
// site_rollback_test.go byte-identical.
func newRBPatchFailHarness(t *testing.T) (*Engine, *siteRollbackFake) {
	t.Helper()
	f := &siteRollbackFake{
		hostStatus:      201,
		previewAddrs:    []string{"10.10.1.0", "10.10.2.0"},
		subnets:         map[string]M{},
		existingForward: map[string]string{},
		existingReverse: map[string]string{},
	}
	inner := f.handler()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(500)
			w.Write([]byte(`{"error":"tagging refused"}`))
			return
		}
		inner(w, r)
	}))
	t.Cleanup(srv.Close)
	return newTestEngine(srv), f
}

// T14. THE SUBNET THAT EXISTS BUT WAS NEVER RECORDED.
//
// createSubnet used to POST the create, PATCH the tags, and only THEN record the
// subnet. When the PATCH failed it returned an error whose own text says tagging
// is "needed for teardown" — so that subnet was simultaneously UNTAGGED (teardown
// cannot find it by tag) and UNRECORDED (rollback cannot find it by id). It sits
// in the customer's address space and nothing in this system can ever find it
// again.
//
// The assertion is the DELETE actually reaching the wire, not just the count: a
// report that says "attempted 1" while sending no DELETE would be a lie in the
// same direction as the bug.
func TestRBSubnetCreatedThenTaggingFailedIsStillRolledBack(t *testing.T) {
	e, f := newRBPatchFailHarness(t)

	var steps []string
	p := e.NewSiteProvisioner(siteRollbackConfig(false), collectSteps(&steps))

	out, err := p.Provision()
	if err == nil {
		t.Fatalf("Provision() error = nil, want the tagging failure (out %v)", out)
	}
	if !strings.Contains(err.Error(), "tagging failed") {
		t.Fatalf("Provision() error = %q, want the tagging failure — the run broke somewhere else and this "+
			"test is not exercising a created-but-untagged subnet", err.Error())
	}

	const created = "/api/ddi/v1/ipam/subnet/s-1"
	found := false
	for _, d := range f.deletes() {
		if d == created {
			found = true
		}
	}
	if !found {
		t.Fatalf("rollback DELETEs = %v, missing %s\n"+
			"That subnet was created upstream — the POST returned 201 — and only the tag write failed. It "+
			"is untagged, so teardown cannot find it by tag, and if rollback never recorded it, nothing can "+
			"find it by id either. It stays in the customer's address space forever.", f.deletes(), created)
	}

	rep := rbReport(t, out)
	if n := rbInt(t, rep, "attempted"); n < 1 {
		t.Fatalf("attempted = %d, want at least 1 — the created subnet must be counted, not just deleted. "+
			"report: %v, DELETEs: %v", n, rep, f.deletes())
	}
	if got := rbOutcome(t, rep); got != "complete" {
		t.Fatalf("outcome = %q, want \"complete\" — the one DELETE issued was accepted. report: %v", got, rep)
	}
}
