package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/provision"
)

// --- rollback report survival, at the HTTP/SSE boundary ----------------------
//
// Provision now returns M{"rollback": {outcome, attempted, deleted, residual}}
// alongside its error. These tests pin that the report actually REACHES the two
// places an operator can read it — the SSE/HTTP error payload and the signed
// audit log — because until now it was built and then dropped on the floor, and
// the failure mode of dropping it again is completely silent.
//
// The audit assertions read the temp audit_log.jsonl from disk on purpose. A
// wrong detail type (a []map[string]any residual, say) makes canonicalJSON
// reject the entry, and auditAppend only LOGS that: the HTTP response still
// succeeds while nothing is recorded. Asserting on the call site alone would
// stay green through exactly that.

// newResidualDeps wires a Deps with the repo's real bundled templates, a
// tokenless Guard (loopback -> admin, satisfying the "operator" gate) and a real
// audit.Log on a scratch file, whose path it returns for on-disk assertions.
func newResidualDeps(t *testing.T, upstream http.HandlerFunc) (*Deps, string) {
	t.Helper()
	d, closeSrv := newTestDeps(t, upstream)
	t.Cleanup(closeSrv)
	d.Guard = &httpx.Guard{Port: "8080"}
	d.Provision = provision.New(d.Rest, "../../templates")
	if state, _ := d.Provision.TemplatesDirState(); state != provision.DirPresent {
		t.Fatalf("templates not found at ../../templates — check the relative path from go/internal/server")
	}
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	// Trust root in its own directory, as in production — the key must never sit
	// beside the log it signs.
	d.Audit = audit.New(logPath, "app-v-test", "test-instance", audit.Options{TrustDir: t.TempDir()})
	return d, logPath
}

func siteStreamRequest(qs string) *http.Request {
	r := httptest.NewRequest("GET", "/api/provision/site/stream?"+qs, nil)
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	return r
}

// auditEntries reads the audit log FROM DISK and returns the entries for one
// event name (or every entry when event == ""). A log file that was never
// created means zero entries, which is a legitimate assertion (T9).
func auditEntries(t *testing.T, path, event string) []map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatalf("read audit log %s: %v", path, err)
	}
	var out []map[string]any
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var e map[string]any
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			t.Fatalf("audit log line %q is not JSON: %v", line, err)
		}
		if event == "" || e["event"] == event {
			out = append(out, e)
		}
	}
	return out
}

func residualAuditDetail(t *testing.T, entry map[string]any) map[string]any {
	t.Helper()
	det, ok := entry["detail"].(map[string]any)
	if !ok {
		t.Fatalf("audit entry has no detail object: %v", entry)
	}
	return det
}

// reportOf pulls the rollback report out of a frame / body / audit detail,
// failing loudly when the key is missing — the whole point of the change.
func reportOf(t *testing.T, m map[string]any, where string) map[string]any {
	t.Helper()
	rb, ok := m["rollback"]
	if !ok {
		t.Fatalf("%s carries no \"rollback\" key: %v", where, m)
	}
	rep, ok := rb.(map[string]any)
	if !ok {
		t.Fatalf("%s rollback is %T, want an object: %v", where, rb, rb)
	}
	return rep
}

func residualOf(t *testing.T, report map[string]any, where string) []any {
	t.Helper()
	res, ok := report["residual"].([]any)
	if !ok {
		t.Fatalf("%s report has no residual list: %v", where, report)
	}
	return res
}

// errorFrame returns the single error-bearing frame of a stream body.
func errorFrame(t *testing.T, frames []map[string]any) map[string]any {
	t.Helper()
	for _, f := range frames {
		if _, ok := f["error"]; ok {
			return f
		}
	}
	t.Fatalf("no error frame among %d frames", len(frames))
	return nil
}

// siteUpstream answers every read and write the REAL (non-dry) site path makes:
// subnets, DHCP ranges and the forward/reverse zones are all created cleanly,
// then the host create is refused with a 500 — the diagnosis' own repro. When
// refuseSubnetDeletes is set, the compensating DELETEs for the subnets are
// refused too, so rollback finishes incomplete with one residual entry per
// subnet; otherwise every DELETE succeeds and rollback completes.
func siteUpstream(refuseSubnetDeletes bool) http.HandlerFunc {
	var mu sync.Mutex
	subnets, ranges, zones := 0, 0, 0
	next := func(n *int) int {
		mu.Lock()
		defer mu.Unlock()
		*n++
		return *n
	}
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "DELETE":
			if refuseSubnetDeletes && strings.Contains(path, "/ipam/subnet/") {
				w.WriteHeader(500)
				io.WriteString(w, `{"error":"delete refused"}`)
				return
			}
			io.WriteString(w, `{"result":{}}`)
		case strings.HasSuffix(path, "/nextavailablesubnet"):
			i := next(&subnets)
			fmt.Fprintf(w, `{"results":[{"id":"ipam/subnet/sn-%d","address":"10.1.%d.0","cidr":25}]}`, i, i)
		case r.Method == "PATCH" && strings.Contains(path, "/ipam/subnet/"):
			id := strings.TrimPrefix(path, "/api/ddi/v1/")
			fmt.Fprintf(w, `{"result":{"id":"%s","address":"10.1.%s.0","cidr":25}}`,
				id, strings.TrimPrefix(id, "ipam/subnet/sn-"))
		case strings.HasSuffix(path, "/ipam/host"):
			w.WriteHeader(500)
			io.WriteString(w, `{"error":"host create refused"}`)
		case strings.HasSuffix(path, "/ipam/range"):
			fmt.Fprintf(w, `{"result":{"id":"ipam/range/rg-%d"}}`, next(&ranges))
		case strings.HasSuffix(path, "/dns/auth_zone"):
			if r.Method == "POST" {
				fmt.Fprintf(w, `{"result":{"id":"dns/auth_zone/z-%d"}}`, next(&zones))
				return
			}
			io.WriteString(w, `{"results":[]}`) // no existing zone -> this run creates (and owns) it
		case strings.HasSuffix(path, "/ipam/ip_space"):
			io.WriteString(w, `{"results":[{"id":"ipam/ip_space/sp-1"}]}`)
		case strings.HasSuffix(path, "/ipam/subnet"):
			io.WriteString(w, `{"results":[]}`) // findExistingSite: site not provisioned yet
		case strings.HasSuffix(path, "/ipam/address_block"):
			io.WriteString(w, `{"results":[{"id":"ipam/address_block/blk-1","address":"10.1.0.0","cidr":16}]}`)
		case strings.HasSuffix(path, "/dns/view"):
			io.WriteString(w, `{"results":[{"id":"dns/view/v-1"}]}`)
		default:
			w.WriteHeader(500)
			fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, path)
		}
	}
}

const labTemplate = "amer/lab/site-amer-lab.yaml"

// runSiteStreamFailure drives provisionSiteStream to the host-create failure and
// returns its frames plus the audit log path.
func runSiteStreamFailure(t *testing.T, refuseSubnetDeletes bool) ([]map[string]any, string) {
	t.Helper()
	d, logPath := newResidualDeps(t, siteUpstream(refuseSubnetDeletes))
	rr := httptest.NewRecorder()
	d.provisionSiteStream(rr, siteStreamRequest("template="+labTemplate+"&dry=0"))
	return parseSSEFrames(t, rr.Body.String()), logPath
}

// T7 — the operator-facing half: the error frame names the objects still live.
func TestProvisionSiteStream_ErrorFrameCarriesResidual(t *testing.T) {
	frames, _ := runSiteStreamFailure(t, true)
	frame := errorFrame(t, frames)

	report := reportOf(t, frame, "site stream error frame")
	if report["outcome"] != "incomplete" {
		t.Fatalf("outcome = %v, want \"incomplete\" (two subnet DELETEs were refused); report=%v", report["outcome"], report)
	}
	res := residualOf(t, report, "site stream error frame")
	if len(res) != 2 {
		t.Fatalf("residual has %d entries, want 2 (both subnets); report=%v", len(res), report)
	}
	for _, e := range res {
		entry, ok := e.(map[string]any)
		if !ok {
			t.Fatalf("residual entry is %T, want an object: %v", e, e)
		}
		if entry["kind"] != "subnet" {
			t.Fatalf("residual kind = %v, want \"subnet\": %v", entry["kind"], entry)
		}
		if id, _ := entry["id"].(string); !strings.HasPrefix(id, "ipam/subnet/sn-") {
			t.Fatalf("residual id = %v, want the live subnet id: %v", entry["id"], entry)
		}
		if entry["status"] != float64(500) {
			t.Fatalf("residual status = %v, want 500: %v", entry["status"], entry)
		}
	}
	if report["deleted"] == report["attempted"] {
		t.Fatalf("deleted == attempted (%v) but two deletes were refused; report=%v", report["deleted"], report)
	}
}

// T8 — the permanent half: the same report is in the signed log, on disk.
func TestProvisionSiteStream_ErrorAuditEntryCarriesResidual(t *testing.T) {
	_, logPath := runSiteStreamFailure(t, true)

	entries := auditEntries(t, logPath, "provision-site-error")
	if len(entries) != 1 {
		t.Fatalf("provision-site-error entries on disk = %d, want 1 (an entry rejected by canonicalJSON is only logged, never written)", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["template"] != labTemplate {
		t.Fatalf("audit detail template = %v, want %q", detail["template"], labTemplate)
	}
	report := reportOf(t, detail, "provision-site-error audit detail")
	if report["outcome"] != "incomplete" {
		t.Fatalf("audit outcome = %v, want \"incomplete\"; report=%v", report["outcome"], report)
	}
	if res := residualOf(t, report, "provision-site-error audit detail"); len(res) != 2 {
		t.Fatalf("audit residual has %d entries, want 2 (same report as the frame); report=%v", len(res), report)
	}
}

// T9 — a dry run creates nothing, so rollback deliberately does not run and
// nothing is audited. The outcome word says so instead of a missing key.
func TestProvisionSiteStream_DryRunFailureNoAuditNoResidualKey(t *testing.T) {
	d, logPath := newResidualDeps(t, allFailedUpstream)
	rr := httptest.NewRecorder()
	d.provisionSiteStream(rr, siteStreamRequest("template="+labTemplate+"&dry=1"))

	frame := errorFrame(t, parseSSEFrames(t, rr.Body.String()))
	report := reportOf(t, frame, "dry-run error frame")
	if report["outcome"] != "skipped_dry_run" {
		t.Fatalf("outcome = %v, want \"skipped_dry_run\"; report=%v", report["outcome"], report)
	}
	if report["attempted"] != float64(0) {
		t.Fatalf("attempted = %v, want 0 (a preview issues no DELETEs)", report["attempted"])
	}
	if got := auditEntries(t, logPath, ""); len(got) != 0 {
		t.Fatalf("audit entries = %d, want 0 (a dry run must never audit); entries=%v", len(got), got)
	}
}

// T12 — the test for the presence-vs-length trap. Every rollback DELETE
// succeeds, so the residual list is EMPTY while the report is still meaningful
// ("rollback ran and deleted all N objects"). An implementer who guards the copy
// with `if len(residual) > 0` collapses that into silence, in the SSE frame and
// in a log that can never be amended.
func TestProvisionSiteStream_CleanRollbackKeepsEmptyResidualInFrameAndAudit(t *testing.T) {
	frames, logPath := runSiteStreamFailure(t, false)

	frame := errorFrame(t, frames)
	report := reportOf(t, frame, "site stream error frame (clean rollback)")
	if report["outcome"] != "complete" {
		t.Fatalf("frame outcome = %v, want \"complete\" (every DELETE returned 2xx); report=%v", report["outcome"], report)
	}
	att, del := report["attempted"], report["deleted"]
	if att != del {
		t.Fatalf("frame attempted %v != deleted %v on a clean rollback; report=%v", att, del, report)
	}
	if att == float64(0) {
		t.Fatalf("frame attempted = 0, want > 0 (subnets, a range and a zone were created); report=%v", report)
	}
	if res := residualOf(t, report, "site stream error frame (clean rollback)"); len(res) != 0 {
		t.Fatalf("frame residual = %v, want empty on a clean rollback", res)
	}

	entries := auditEntries(t, logPath, "provision-site-error")
	if len(entries) != 1 {
		t.Fatalf("provision-site-error entries on disk = %d, want 1", len(entries))
	}
	auditReport := reportOf(t, residualAuditDetail(t, entries[0]), "provision-site-error audit detail (clean rollback)")
	if auditReport["outcome"] != "complete" {
		t.Fatalf("audit outcome = %v, want \"complete\"; report=%v", auditReport["outcome"], auditReport)
	}
	if auditReport["attempted"] != att || auditReport["deleted"] != del {
		t.Fatalf("audit counts (%v/%v) differ from the frame's (%v/%v)",
			auditReport["attempted"], auditReport["deleted"], att, del)
	}
	if res := residualOf(t, auditReport, "provision-site-error audit detail (clean rollback)"); len(res) != 0 {
		t.Fatalf("audit residual = %v, want empty on a clean rollback", res)
	}
}

// --- seed-demo, per template -------------------------------------------------

// runSeedDemoFailure drives the seed stream non-dry against siteUpstream: the
// block pool step finds every block already present (so it succeeds), and both
// amer site templates fail at their host create with refused subnet deletes.
func runSeedDemoFailure(t *testing.T) ([]map[string]any, string) {
	t.Helper()
	d, logPath := newResidualDeps(t, siteUpstream(true))
	rr := httptest.NewRecorder()
	d.provisionSeedDemoStream(rr, seedStreamRequest("regions=amer&dry=0"))
	return parseSSEFrames(t, rr.Body.String()), logPath
}

func templateErrorFrame(t *testing.T, frames []map[string]any, template string) map[string]any {
	t.Helper()
	for _, f := range frames {
		if f["template"] == template {
			if _, ok := f["error"]; ok {
				return f
			}
		}
	}
	t.Fatalf("no error frame for template %q among %d frames", template, len(frames))
	return nil
}

// T10a — the per-template error frame carries the report, not just a message.
func TestProvisionSeedDemoStream_FailureFrameCarriesResidual(t *testing.T) {
	frames, _ := runSeedDemoFailure(t)
	frame := templateErrorFrame(t, frames, labTemplate)

	report := reportOf(t, frame, "seed-demo per-template error frame")
	if report["outcome"] != "incomplete" {
		t.Fatalf("outcome = %v, want \"incomplete\"; report=%v", report["outcome"], report)
	}
	if res := residualOf(t, report, "seed-demo per-template error frame"); len(res) != 2 {
		t.Fatalf("residual has %d entries, want 2 (both of amer-lab's subnets); report=%v", len(res), report)
	}
}

// T10b — and the entry that did not exist at all before this change: a
// per-template provision-site-error, on disk, additive to the aggregate
// provision-seed-demo counts entry.
func TestProvisionSeedDemoStream_FailureWritesPerTemplateAuditEntry(t *testing.T) {
	_, logPath := runSeedDemoFailure(t)

	entries := auditEntries(t, logPath, "provision-site-error")
	var forLab map[string]any
	for _, e := range entries {
		if residualAuditDetail(t, e)["template"] == labTemplate {
			forLab = e
		}
	}
	if forLab == nil {
		t.Fatalf("no provision-site-error entry on disk for %q (found %d entries in total)", labTemplate, len(entries))
	}
	report := reportOf(t, residualAuditDetail(t, forLab), "seed-demo per-template audit detail")
	if report["outcome"] != "incomplete" {
		t.Fatalf("audit outcome = %v, want \"incomplete\"; report=%v", report["outcome"], report)
	}
	if res := residualOf(t, report, "seed-demo per-template audit detail"); len(res) != 2 {
		t.Fatalf("audit residual has %d entries, want 2; report=%v", len(res), report)
	}
	// The aggregate provision-seed-demo entry is deliberately NOT asserted here.
	// Writing this test surfaced a separate, pre-existing defect: that entry
	// passes "regions" as a []string, which canonicalJSON's closed type switch
	// rejects, so auditAppend logs `unsupported type []string` and the entry has
	// never actually reached disk. It is the same silent-drop class §10.1 warns
	// about, it predates this change (both the seed and teardown aggregates carry
	// it), and fixing it belongs to its own pass with its own test — asserting
	// either 0 or 1 here would freeze a wrong answer into this file.
	//
	// What matters for THIS test is unaffected: the per-template entry above is
	// additive, and it is the only record that names the stranded objects.
}

// --- POST /api/provision/block ----------------------------------------------

// blockUpstream lets the first address-block create succeed, refuses the second
// (so the atomic run rolls back), and refuses the compensating DELETE — one
// block left live upstream, which is exactly what the 400 and the audit entry
// have to name.
func blockUpstream() http.HandlerFunc {
	var mu sync.Mutex
	created := 0
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "DELETE":
			w.WriteHeader(500)
			io.WriteString(w, `{"error":"delete refused"}`)
		case strings.HasSuffix(path, "/ipam/ip_space"):
			io.WriteString(w, `{"results":[{"id":"ipam/ip_space/sp-1"}]}`)
		case r.Method == "GET" && strings.HasSuffix(path, "/ipam/address_block"):
			io.WriteString(w, `{"results":[]}`) // exists(): nothing there yet
		case r.Method == "POST" && strings.HasSuffix(path, "/ipam/address_block"):
			mu.Lock()
			created++
			i := created
			mu.Unlock()
			if i == 1 {
				io.WriteString(w, `{"result":{"id":"ipam/address_block/b-1"}}`)
				return
			}
			w.WriteHeader(500)
			io.WriteString(w, `{"error":"create refused"}`)
		default:
			w.WriteHeader(500)
			fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, path)
		}
	}
}

// T11 — the block route's 400 body AND its new provision-block-error entry both
// name the block rollback could not delete.
func TestProvisionBlock_ErrorBodyAndAuditCarryResidual(t *testing.T) {
	const blocksTemplate = "blocks/regional_address_blocks.yaml"
	d, logPath := newResidualDeps(t, blockUpstream())

	r := httptest.NewRequest("POST", "/api/provision/block", nil)
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	rr := httptest.NewRecorder()
	d.provisionBlock(rr, r, map[string]any{"template": blocksTemplate, "dry": "0"})

	if rr.Code != 400 {
		t.Fatalf("status = %d, want 400 (a ProvisionError is still a 400, exactly as provErr does); body=%s", rr.Code, rr.Body.String())
	}
	body := decodeBody(t, rr)
	if _, ok := body["error"]; !ok {
		t.Fatalf("400 body lost its error message: %v", body)
	}
	report := reportOf(t, body, "/api/provision/block 400 body")
	if report["outcome"] != "incomplete" {
		t.Fatalf("outcome = %v, want \"incomplete\" (the compensating DELETE was refused); report=%v", report["outcome"], report)
	}
	res := residualOf(t, report, "/api/provision/block 400 body")
	if len(res) != 1 {
		t.Fatalf("residual has %d entries, want 1 (the one created block); report=%v", len(res), report)
	}
	entry, _ := res[0].(map[string]any)
	if entry["kind"] != "address_block" || entry["id"] != "ipam/address_block/b-1" || entry["status"] != float64(500) {
		t.Fatalf("residual entry = %v, want the live block ipam/address_block/b-1 with status 500", entry)
	}

	entries := auditEntries(t, logPath, "provision-block-error")
	if len(entries) != 1 {
		t.Fatalf("provision-block-error entries on disk = %d, want 1", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["template"] != blocksTemplate {
		t.Fatalf("audit detail template = %v, want %q", detail["template"], blocksTemplate)
	}
	auditReport := reportOf(t, detail, "provision-block-error audit detail")
	if auditReport["outcome"] != "incomplete" {
		t.Fatalf("audit outcome = %v, want \"incomplete\"; report=%v", auditReport["outcome"], auditReport)
	}
	if r2 := residualOf(t, auditReport, "provision-block-error audit detail"); len(r2) != 1 {
		t.Fatalf("audit residual has %d entries, want 1 (same report as the body); report=%v", len(r2), auditReport)
	}
}
