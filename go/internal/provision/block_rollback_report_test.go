package provision

import (
	"fmt"
	"strings"
	"testing"
)

// THE BLOCK FAILURE RETURN VALUE.
//
// Scope: what BlockProvisioner.Provision hands back when it FAILS, and what its
// rollback records about blocks it could not delete. Until now it handed back
// nil and its rollback recorded NOTHING — not even a list — so a block left live
// on a customer's tenant was named exactly once, in a stream line nobody keeps,
// and never again.
//
// Reuses blockRollbackFake / rollbackBlockConfig / newBlockRollbackHarness /
// collectSteps from block_test.go and rbInt / rbResidual / rbOutcome from
// rollback_report_test.go. NO TEST HERE TOUCHES A REAL TENANT.

// rbBlockReport is rbReport's block counterpart: it pulls the report out of a
// failure return and proves the failure return is nothing BUT the report.
//
// blocks_created is named explicitly because it is the dangerous one. It lists
// the ids rollback has just DELETEd, and the success HTTP path
// (server/provision.go's provisionBlock) renders that exact field as the run's
// created blocks — so leaking it on the failure path shows an operator a list of
// tombstones formatted identically to a list of live objects.
func rbBlockReport(t *testing.T, out M) M {
	t.Helper()
	if out == nil {
		t.Fatal("Provision() returned a nil map on the failure path — everything rollback learned died " +
			"inside the function and the caller has only err.Error() to show for blocks left live upstream")
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
	for _, k := range []string{"blocks_created", "failed", "name", "ip_space", "dry_run"} {
		if _, present := out[k]; present {
			t.Fatalf("failure map exported construction key %q (full map: %v)\n"+
				"blocks_created after a rollback is a list of DELETEd ids, and the success path renders "+
				"that same key as the blocks this run created. Returning it on failure presents tombstones "+
				"as live objects.", k, out)
		}
	}
	if len(out) != 1 {
		t.Fatalf("failure map has %d keys (%v), want exactly 1 (\"rollback\")", len(out), out)
	}
	return rep
}

// T4. A BLOCK UPSTREAM REFUSED TO DELETE MUST BE NAMED.
//
// Two blocks are created, the third fails on its cidr, and upstream then refuses
// the DELETE for b-2. That block is still live in the customer's address space
// and a retry will collide with it. Before this change rollback emitted one
// stream line about it and recorded nothing anywhere.
//
// The assertion is the CONCRETE entry — kind, id, status and the literal label —
// not a non-empty check. The site rollback shipped a label reading "10.0.5.0/24/"
// because it formatted a key its entries never carried; a presence-only
// assertion is exactly what let that through.
func TestRBBlockProvisionFailureReportsIncompleteWithNamedResidual(t *testing.T) {
	e, f := newBlockRollbackHarness(t, func(path string) int {
		if strings.HasSuffix(path, "/b-2") {
			return 500
		}
		return 200
	})

	var steps []string
	p := e.NewBlockProvisioner(rollbackBlockConfig(false), collectSteps(&steps))

	out, err := p.Provision(false)
	if err == nil {
		t.Fatalf("Provision() error = nil, want the bad-cidr failure (out %v)", out)
	}
	if !strings.Contains(err.Error(), "cidr is not an integer") {
		t.Fatalf("Provision() error = %q, want the bad-cidr failure — the fixture broke somewhere else "+
			"and this test is not exercising a rollback over created blocks", err.Error())
	}
	if n := f.postCount(); n != 2 {
		t.Fatalf("the fake received %d create(s), want 2 — nothing was created, so a residual entry here "+
			"would not be about a real block", n)
	}

	rep := rbBlockReport(t, out)
	if got := rbOutcome(t, rep); got != "incomplete" {
		t.Fatalf("outcome = %q, want \"incomplete\" — one block is still live upstream. report: %v", got, rep)
	}
	if got, want := rbInt(t, rep, "attempted"), 2; got != want {
		t.Fatalf("attempted = %d, want %d (both created blocks were tried). DELETEs: %v", got, want, f.deletes())
	}
	if got, want := rbInt(t, rep, "deleted"), 1; got != want {
		t.Fatalf("deleted = %d, want %d (only b-1 was accepted). DELETEs: %v", got, want, f.deletes())
	}

	res := rbResidual(t, rep)
	if len(res) != 1 {
		t.Fatalf("residual = %v (len %d), want exactly 1 entry — b-2's DELETE was refused with a 500 and "+
			"nothing else was. DELETEs: %v", res, len(res), f.deletes())
	}
	entry, ok := res[0].(M)
	if !ok {
		t.Fatalf("residual entry = %T (%v), want map[string]any", res[0], res[0])
	}
	if got, want := fmt.Sprintf("%v", entry["kind"]), "address_block"; got != want {
		t.Fatalf("residual kind = %q, want %q — an entry naming the wrong kind sends the operator to clean "+
			"up the wrong sort of object. entry: %v", got, want, entry)
	}
	if got, want := fmt.Sprintf("%v", entry["id"]), "ipam/address_block/b-2"; got != want {
		t.Fatalf("residual id = %q, want %q — this is the only handle anyone has on the block still live "+
			"upstream. entry: %v", got, want, entry)
	}
	if got, ok := entry["status"].(int); !ok || got != 500 {
		t.Fatalf("residual status = %#v, want int 500 — canonicalJSON has no case for other numeric types "+
			"and auditAppend drops the entry silently when encoding fails. entry: %v", entry["status"], entry)
	}
	// b-2 is the SECOND block in rollbackBlockConfig: 10.20.0.0/16.
	if got, want := fmt.Sprintf("%v", entry["label"]), "10.20.0.0/16"; got != want {
		t.Fatalf("residual label = %q, want %q — a label formatting a key the entry never carried renders "+
			"as a truncated address with a trailing slash and reads as a real one. entry: %v", got, want, entry)
	}
}

// T5. A BLOCK ROLLBACK THAT SUCCEEDED SAYS SO — and says how much it undid.
//
// Same failure, every DELETE accepted. An empty residual is byte-for-byte what a
// rollback with nothing to do produces; "complete" with attempted == deleted > 0
// is the difference, and the counts are what make it verifiable.
func TestRBBlockProvisionFailureCleanRollbackReportsComplete(t *testing.T) {
	e, f := newBlockRollbackHarness(t, nil)

	var steps []string
	p := e.NewBlockProvisioner(rollbackBlockConfig(false), collectSteps(&steps))

	out, err := p.Provision(false)
	if err == nil {
		t.Fatalf("Provision() error = nil, want the bad-cidr failure (out %v)", out)
	}

	rep := rbBlockReport(t, out)
	if got := rbOutcome(t, rep); got != "complete" {
		t.Fatalf("outcome = %q, want \"complete\" — every DELETE was accepted. report: %v", got, rep)
	}
	attempted, deleted := rbInt(t, rep, "attempted"), rbInt(t, rep, "deleted")
	if attempted == 0 {
		t.Fatalf("attempted = 0, but the run created two blocks before it failed — \"complete\" over zero "+
			"deletes would be vacuously true. DELETEs: %v", f.deletes())
	}
	if deleted != attempted {
		t.Fatalf("deleted = %d, attempted = %d, want equal", deleted, attempted)
	}
	if n := len(f.deletes()); n != attempted {
		t.Fatalf("attempted = %d but the fake recorded %d DELETE(s): %v — the count must be the DELETEs "+
			"actually issued, not the size of blocks_created", attempted, n, f.deletes())
	}
	if res := rbResidual(t, rep); len(res) != 0 {
		t.Fatalf("residual = %v, want empty", res)
	}
}

// T6. A BLOCK PREVIEW ROLLS BACK NOTHING — and that is a stated outcome.
//
// A dry run creates nothing, so rollback deliberately does not run. Returning
// nil said nothing at all, which is indistinguishable from any record written
// before this change existed. "skipped_dry_run" is permanently distinguishable
// from both a real rollback and a legacy entry.
func TestRBBlockProvisionDryRunFailureReportsSkipped(t *testing.T) {
	e, f := newBlockRollbackHarness(t, nil)

	var steps []string
	p := e.NewBlockProvisioner(rollbackBlockConfig(true), collectSteps(&steps))

	out, err := p.Provision(false)
	if err == nil {
		t.Fatalf("Provision() error = nil, want the bad-cidr failure (out %v)", out)
	}

	rep := rbBlockReport(t, out)
	if got := rbOutcome(t, rep); got != "skipped_dry_run" {
		t.Fatalf("outcome = %q, want \"skipped_dry_run\" — a preview created nothing, so rollback must not "+
			"run and must not claim it did. report: %v", got, rep)
	}
	if n := rbInt(t, rep, "attempted"); n != 0 {
		t.Fatalf("attempted = %d, want 0 on a dry run", n)
	}
	if n := rbInt(t, rep, "deleted"); n != 0 {
		t.Fatalf("deleted = %d, want 0 on a dry run", n)
	}
	if res := rbResidual(t, rep); len(res) != 0 {
		t.Fatalf("residual = %v, want empty on a dry run", res)
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
