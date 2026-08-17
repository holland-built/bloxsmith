package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"bloxsmith/internal/httpx"
	"bloxsmith/internal/provision"
)

// --- terminalFrame -----------------------------------------------------------
//
// terminalFrame is the fix for the "Seed complete." on a total failure bug:
// before this, the seed/teardown stream's final frame was a bare
// {"done":true,"summary":{...arrays...}} regardless of outcome, so an
// all-failed run and an all-succeeded run produced structurally
// indistinguishable terminal frames — the UI had nothing to branch on but
// "done", which it read as success. These tests pin the counts terminalFrame
// now adds, and that an all-failed frame is never byte-identical to an
// all-succeeded one.

func TestTerminalFrame_AllFailed_ReportsZeroSucceeded(t *testing.T) {
	summary := map[string]any{
		"succeeded": []any{},
		"failed":    []any{"blocks/regional_address_blocks.yaml", "amer/lab/site-amer-lab.yaml", "amer/production/site-amer-hq.yaml"},
		"skipped":   []any{},
	}
	frame := terminalFrame(summary)

	if frame["succeeded"] != 0 {
		t.Fatalf("succeeded = %v, want 0", frame["succeeded"])
	}
	if frame["failed"] != 3 {
		t.Fatalf("failed = %v, want 3", frame["failed"])
	}
	if frame["total"] != 3 {
		t.Fatalf("total = %v, want 3", frame["total"])
	}
	if frame["done"] != true {
		t.Fatalf("done = %v, want true (the stream contract still requires it)", frame["done"])
	}
}

func TestTerminalFrame_AllSucceeded_Unchanged(t *testing.T) {
	summary := map[string]any{
		"succeeded": []any{"blocks/regional_address_blocks.yaml", "amer/lab/site-amer-lab.yaml", "amer/production/site-amer-hq.yaml"},
		"failed":    []any{},
		"skipped":   []any{},
	}
	frame := terminalFrame(summary)

	if frame["succeeded"] != 3 {
		t.Fatalf("succeeded = %v, want 3", frame["succeeded"])
	}
	if frame["failed"] != 0 {
		t.Fatalf("failed = %v, want 0", frame["failed"])
	}
	if frame["total"] != 3 {
		t.Fatalf("total = %v, want 3", frame["total"])
	}
}

func TestTerminalFrame_Partial_BothCountsCorrect(t *testing.T) {
	summary := map[string]any{
		"succeeded": []any{"blocks/regional_address_blocks.yaml", "amer/lab/site-amer-lab.yaml"},
		"failed":    []any{"amer/production/site-amer-hq.yaml"},
		"skipped":   []any{},
	}
	frame := terminalFrame(summary)

	if frame["succeeded"] != 2 {
		t.Fatalf("succeeded = %v, want 2", frame["succeeded"])
	}
	if frame["failed"] != 1 {
		t.Fatalf("failed = %v, want 1", frame["failed"])
	}
	if frame["total"] != 3 {
		t.Fatalf("total = %v, want 3", frame["total"])
	}
}

func TestTerminalFrame_AllFailedNotByteIdenticalToAllSucceeded(t *testing.T) {
	failedSummary := map[string]any{
		"succeeded": []any{},
		"failed":    []any{"a", "b"},
		"skipped":   []any{},
	}
	succeededSummary := map[string]any{
		"succeeded": []any{"a", "b"},
		"failed":    []any{},
		"skipped":   []any{},
	}
	failedFrame, err := json.Marshal(terminalFrame(failedSummary))
	if err != nil {
		t.Fatal(err)
	}
	succeededFrame, err := json.Marshal(terminalFrame(succeededSummary))
	if err != nil {
		t.Fatal(err)
	}
	if string(failedFrame) == string(succeededFrame) {
		t.Fatalf("all-failed and all-succeeded terminal frames are byte-identical: %s", failedFrame)
	}
}

// --- provisionSeedDemoStream (HTTP-level, real templates + fake upstream) ----
//
// These exercise the actual handler end-to-end against the bundled templates
// under go/templates (regions=amer -> blocks/regional_address_blocks.yaml +
// amer/lab/site-amer-lab.yaml + amer/production/site-amer-hq.yaml — 3
// templates, matching the "0/3 done" example from the bug report), all run
// dry (dry=1) so no real upstream writes happen and Audit is never touched.

// newSeedStreamDeps wires a Deps whose Provision engine points at the repo's
// real bundled templates (go/templates, two levels up from this package) and
// whose Rest client points at the given fake upstream.
func newSeedStreamDeps(t *testing.T, upstream http.HandlerFunc) *Deps {
	t.Helper()
	d, closeSrv := newTestDeps(t, upstream)
	t.Cleanup(closeSrv)
	d.Guard = &httpx.Guard{Port: "8080"}
	d.Provision = provision.New(d.Rest, "../../templates")
	if state, _ := d.Provision.TemplatesDirState(); state != provision.DirPresent {
		t.Fatalf("templates not found at ../../templates — check the relative path from go/internal/server")
	}
	return d
}

func seedStreamRequest(qs string) *http.Request {
	r := httptest.NewRequest("GET", "/api/provision/seed-demo/stream?"+qs, nil)
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role (satisfies "operator" gate)
	return r
}

// parseSSEFrames splits a text/event-stream body into its `data: {...}` JSON
// frames, in order.
func parseSSEFrames(t *testing.T, body string) []map[string]any {
	t.Helper()
	var frames []map[string]any
	for _, chunk := range strings.Split(body, "\n\n") {
		chunk = strings.TrimSpace(chunk)
		if chunk == "" {
			continue
		}
		payload := strings.TrimPrefix(chunk, "data: ")
		var m map[string]any
		if err := json.Unmarshal([]byte(payload), &m); err != nil {
			t.Fatalf("could not parse SSE frame %q: %v", chunk, err)
		}
		frames = append(frames, m)
	}
	return frames
}

func terminalFrameOf(t *testing.T, frames []map[string]any) map[string]any {
	t.Helper()
	for _, f := range frames {
		if f["done"] == true {
			return f
		}
	}
	t.Fatalf("no terminal (done:true) frame found among %d frames", len(frames))
	return nil
}

// allFailedUpstream fails every request, so resolveIPSpace (the very first
// upstream read for both the block step and every site) errors out — every
// one of the 3 templates for regions=amer ends up in "failed".
func allFailedUpstream(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(500)
	w.Write([]byte(`{"error":"boom"}`))
}

func TestProvisionSeedDemoStream_AllFailed_TerminalFrameIsNotSuccess(t *testing.T) {
	d := newSeedStreamDeps(t, allFailedUpstream)
	r := seedStreamRequest("regions=amer&dry=1")
	rr := httptest.NewRecorder()
	d.provisionSeedDemoStream(rr, r)

	frames := parseSSEFrames(t, rr.Body.String())
	terminal := terminalFrameOf(t, frames)

	if terminal["succeeded"] != float64(0) {
		t.Fatalf("succeeded = %v, want 0 (every template failed)", terminal["succeeded"])
	}
	if got := terminal["failed"]; got != float64(3) {
		t.Fatalf("failed = %v, want 3 (blocks + amer-hq + amer-lab)", got)
	}
	if terminal["total"] != float64(3) {
		t.Fatalf("total = %v, want 3", terminal["total"])
	}

	// Every per-template frame must be an error, never a bare success signal.
	for _, f := range frames {
		if tpl, ok := f["template"]; ok && f["error"] == nil {
			t.Fatalf("template %v frame has no error but the run was all-failed: %v", tpl, f)
		}
	}
}

// allSucceededUpstream answers every read the dry-run path needs with a
// well-formed success shape, so all 3 templates (block pool + amer-hq +
// amer-lab) complete cleanly.
func allSucceededUpstream(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case strings.HasSuffix(path, "/ipam/ip_space"):
		w.Write([]byte(`{"results":[{"id":"ipsp1"}]}`))
	case strings.HasSuffix(path, "/nextavailablesubnet"):
		w.Write([]byte(`{"results":[{"address":"10.1.2.0"}]}`))
	case strings.HasSuffix(path, "/ipam/subnet"):
		w.Write([]byte(`{"results":[]}`)) // no existing site
	case strings.HasSuffix(path, "/ipam/address_block"):
		w.Write([]byte(`{"results":[{"id":"blk1","address":"10.1.0.0","cidr":16}]}`))
	case strings.HasSuffix(path, "/dns/view"):
		w.Write([]byte(`{"results":[{"id":"view1"}]}`))
	default:
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"unexpected upstream path ` + path + `"}`))
	}
}

func TestProvisionSeedDemoStream_AllSucceeded_Unchanged(t *testing.T) {
	d := newSeedStreamDeps(t, allSucceededUpstream)
	r := seedStreamRequest("regions=amer&dry=1")
	rr := httptest.NewRecorder()
	d.provisionSeedDemoStream(rr, r)

	frames := parseSSEFrames(t, rr.Body.String())
	terminal := terminalFrameOf(t, frames)

	if terminal["failed"] != float64(0) {
		t.Fatalf("failed = %v, want 0; body=%s", terminal["failed"], rr.Body.String())
	}
	if terminal["succeeded"] != float64(3) {
		t.Fatalf("succeeded = %v, want 3 (blocks + amer-hq + amer-lab); body=%s", terminal["succeeded"], rr.Body.String())
	}
	if terminal["total"] != float64(3) {
		t.Fatalf("total = %v, want 3", terminal["total"])
	}

	// Every per-template frame must carry a success signal (no error), which
	// is what lets the UI's progress rollup count them as "done" instead of
	// leaving done structurally at 0.
	sawTemplate := 0
	for _, f := range frames {
		if _, ok := f["template"]; ok {
			sawTemplate++
			if f["error"] != nil {
				t.Fatalf("template frame has an error but the run was all-succeeded: %v", f)
			}
		}
	}
	if sawTemplate != 3 {
		t.Fatalf("saw %d template-keyed frames, want 3 (one per template, success included)", sawTemplate)
	}
}

// partialUpstream succeeds for everything except the amer-hq site's
// findExistingSite check (identified by its _tfilter containing "amer-hq"),
// so amer-hq fails while the block pool and amer-lab succeed: 2 succeeded, 1
// failed, out of 3 total.
func partialUpstream(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if strings.HasSuffix(path, "/ipam/subnet") && strings.Contains(r.URL.Query().Get("_tfilter"), "amer-hq") {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
		return
	}
	allSucceededUpstream(w, r)
}

func TestProvisionSeedDemoStream_Partial_BothCountsCorrect(t *testing.T) {
	d := newSeedStreamDeps(t, partialUpstream)
	r := seedStreamRequest("regions=amer&dry=1")
	rr := httptest.NewRecorder()
	d.provisionSeedDemoStream(rr, r)

	frames := parseSSEFrames(t, rr.Body.String())
	terminal := terminalFrameOf(t, frames)

	if terminal["succeeded"] != float64(2) {
		t.Fatalf("succeeded = %v, want 2 (blocks + amer-lab); body=%s", terminal["succeeded"], rr.Body.String())
	}
	if terminal["failed"] != float64(1) {
		t.Fatalf("failed = %v, want 1 (amer-hq); body=%s", terminal["failed"], rr.Body.String())
	}
	if terminal["total"] != float64(3) {
		t.Fatalf("total = %v, want 3", terminal["total"])
	}
}
