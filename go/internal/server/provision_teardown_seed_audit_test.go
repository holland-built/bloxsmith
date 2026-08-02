package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- the per-template teardown error record, read back off disk --------------
//
// teardownSeedDemoStream loops the region's site templates and calls
// Decommission() on each. That routine is FAIL-FORWARD: it deletes DNS zones,
// DHCP ranges, subnets and hosts with no rollback, so a mid-run failure leaves
// part of a real site destroyed. The handler tallied summary["failed"] and moved
// on to the next template, and the only entry it wrote was the aggregate
// teardown-seed-demo one carrying succeeded/failed/skipped COUNTS. "failed: 1"
// out of three templates does not say which region's estate is now half gone.
//
// These tests assert on the FILE for the same reason the aggregate ones do: a
// detail value canonicalJSON refuses is only log.Printf'd by auditAppend, so the
// stream still finishes and the request still succeeds with nothing recorded.
// Asserting the terminal frame, or a spy on the call site, stays green through
// exactly the bug being fixed.

// teardownOneSiteFailsUpstream answers a non-dry seed-demo teardown in which
// exactly ONE of the two amer site templates fails: amer-lab owns a subnet whose
// DELETE is refused (so its teardown aborts after the plan and export have
// already run), while amer-hq owns nothing and tears down cleanly. The regional
// address block is found and deleted. Terminal: 2 succeeded, 1 failed.
func teardownOneSiteFailsUpstream(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.Method == "DELETE":
		if strings.Contains(path, "ipam/subnet/sn-lab") {
			w.WriteHeader(500)
			io.WriteString(w, `{"error":"delete refused"}`)
			return
		}
		io.WriteString(w, `{"result":{}}`)
	case strings.HasSuffix(path, "/ipam/ip_space"):
		io.WriteString(w, `{"results":[{"id":"ipam/ip_space/sp-1","name":"default"}]}`)
	case strings.HasSuffix(path, "/dns/view"):
		io.WriteString(w, `{"results":[{"id":"dns/view/v-1","name":"default"}]}`)
	case strings.HasSuffix(path, "/ipam/address_block"):
		io.WriteString(w, `{"results":[{"id":"ipam/address_block/blk-1","address":"10.1.0.0","cidr":16}]}`)
	case strings.HasSuffix(path, "/ipam/subnet"):
		// findSubnets tags the query with Site=="<site>" — only amer-lab has one.
		if strings.Contains(r.URL.Query().Get("_tfilter"), "amer-lab") {
			io.WriteString(w, `{"results":[{"id":"ipam/subnet/sn-lab","address":"10.1.1.0","cidr":25,"name":"amer-lab-bench"}]}`)
			return
		}
		io.WriteString(w, `{"results":[]}`)
	case strings.HasSuffix(path, "/ipam/range"),
		strings.HasSuffix(path, "/ipam/host"),
		strings.HasSuffix(path, "/dns/auth_zone"):
		io.WriteString(w, `{"results":[]}`)
	default:
		w.WriteHeader(500)
		io.WriteString(w, `{"error":"unexpected upstream call"}`)
	}
}

// teardownDryPlanFailsUpstream fails amer-lab in the PLAN phase — the subnet
// read is refused — so the failure arm is reached on a DRY run too. A dry run
// issues no DELETEs, so a delete-refusal fake can never reach that arm and a
// dry-run assertion built on one would be vacuous.
func teardownDryPlanFailsUpstream(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/ipam/subnet") &&
		strings.Contains(r.URL.Query().Get("_tfilter"), "amer-lab") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(500)
		io.WriteString(w, `{"error":"subnet read refused"}`)
		return
	}
	teardownOneSiteFailsUpstream(w, r)
}

const teardownLabTemplate = "amer/lab/site-amer-lab.yaml"

// runTeardownSeedDemo drives the real teardown stream and returns the parsed
// frames plus the audit log path. StateDir is set because a real teardown
// refuses to delete anything it cannot first export (provision/export.go).
func runTeardownSeedDemo(t *testing.T, upstream http.HandlerFunc, qs string) ([]map[string]any, string) {
	t.Helper()
	d, logPath := newResidualDeps(t, upstream)
	d.StateDir = t.TempDir()
	rr := httptest.NewRecorder()
	d.teardownSeedDemoStream(rr, teardownSeedStreamRequest(qs))
	return parseSSEFrames(t, rr.Body.String()), logPath
}

// One template fails, one succeeds: the per-template record must exist ON DISK
// and NAME the template whose site is now partly gone. This is the entry the
// handler never wrote.
func TestTeardownSeedDemoStream_PartialFailureWritesPerTemplateAuditEntry(t *testing.T) {
	frames, logPath := runTeardownSeedDemo(t, teardownOneSiteFailsUpstream, "regions=amer&dry=0&confirm=DELETE")

	terminal := terminalFrameOf(t, frames)
	if terminal["failed"] != float64(1) || terminal["succeeded"] != float64(2) {
		t.Fatalf("terminal frame = %v, want 1 failed (amer-lab) / 2 succeeded (amer-hq + the block pool)", terminal)
	}

	entries := auditEntries(t, logPath, "teardown-site-error")
	if len(entries) != 1 {
		t.Fatalf("teardown-site-error entries on disk = %d, want 1 — a bulk teardown that destroyed part of "+
			"one site records only \"failed: 1\" without it, which cannot name the site", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["template"] != teardownLabTemplate {
		t.Fatalf("audit detail template = %v, want %q — the whole point of the entry is naming the "+
			"failing template", detail["template"], teardownLabTemplate)
	}
	msg, _ := detail["error"].(string)
	if strings.TrimSpace(msg) == "" {
		t.Fatalf("audit detail carries no error message: %v", detail)
	}
	if !strings.Contains(msg, "subnet") {
		t.Fatalf("audit detail error = %q, want the engine's own message (the refused subnet delete)", msg)
	}
}

// The aggregate entry is not replaced by the per-template one — it is still
// written, still once, still carrying the same counts the terminal frame did.
func TestTeardownSeedDemoStream_PartialFailureKeepsAggregateAuditEntry(t *testing.T) {
	_, logPath := runTeardownSeedDemo(t, teardownOneSiteFailsUpstream, "regions=amer&dry=0&confirm=DELETE")

	entries := auditEntries(t, logPath, "teardown-seed-demo")
	if len(entries) != 1 {
		t.Fatalf("teardown-seed-demo entries on disk = %d, want 1 (the per-template entry is additive, "+
			"never a replacement)", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if got := regionsOf(t, detail, "teardown-seed-demo audit detail"); len(got) != 1 || got[0] != "amer" {
		t.Fatalf("audit regions = %v, want [amer]", got)
	}
	if detail["failed"] != float64(1) || detail["succeeded"] != float64(2) {
		t.Fatalf("aggregate counts = failed %v / succeeded %v, want 1 / 2 (unchanged by this fix)",
			detail["failed"], detail["succeeded"])
	}
}

// An all-succeed run must write NO per-template error entry. This is what stops
// "audit unconditionally" from passing: an entry on every template would put a
// permanent, unamendable failure record against a teardown that worked.
func TestTeardownSeedDemoStream_AllSucceedWritesNoPerTemplateAuditEntry(t *testing.T) {
	frames, logPath := runTeardownSeedDemo(t, teardownSuccessUpstream, "regions=amer&dry=0&confirm=DELETE")

	terminal := terminalFrameOf(t, frames)
	if terminal["failed"] != float64(0) || terminal["succeeded"] != float64(3) {
		t.Fatalf("terminal frame = %v, want 3 succeeded / 0 failed", terminal)
	}
	if got := auditEntries(t, logPath, "teardown-site-error"); len(got) != 0 {
		t.Fatalf("teardown-site-error entries = %d, want 0 on a clean teardown; entries=%v", len(got), got)
	}
	if got := auditEntries(t, logPath, "teardown-seed-demo"); len(got) != 1 {
		t.Fatalf("teardown-seed-demo entries = %d, want 1 (the aggregate is still the record of a clean run)", len(got))
	}
}

// A dry run deletes nothing, so it must audit nothing — not the per-template
// entry, not the aggregate. The upstream fails amer-lab in the plan phase so the
// failure arm IS reached under dry (the terminal frame proves it), which is the
// only way this asserts on the !dry gate rather than on an unvisited branch.
func TestTeardownSeedDemoStream_DryRunWritesNoAuditEntryAtAll(t *testing.T) {
	frames, logPath := runTeardownSeedDemo(t, teardownDryPlanFailsUpstream, "regions=amer&dry=1")

	if terminal := terminalFrameOf(t, frames); terminal["failed"] != float64(1) {
		t.Fatalf("terminal frame = %v, want 1 failed — the dry run must actually REACH the failure arm, "+
			"otherwise this test proves nothing about the !dry gate", terminal)
	}
	if got := auditEntries(t, logPath, ""); len(got) != 0 {
		t.Fatalf("audit entries = %d, want 0 — a dry run destroys nothing and must never record a "+
			"teardown failure against the tenant; entries=%v", len(got), got)
	}
}
