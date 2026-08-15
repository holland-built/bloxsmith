package server

import (
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

// `?dry=` — the flag present with no value — used to mean a LIVE teardown.
//
// The safe default lives in truthy's `v == nil` branch, but queryM sets a key
// only when it is PRESENT, so an empty value missed that branch and fell into
// `case "0", "false", "no", "":`. A caller writing `?dry=${DRY}&confirm=DELETE`
// with DRY unset destroyed a customer's DNS zones, subnets, ranges and hosts
// while reading as though it had asked for nothing. See #59.
//
// This is asserted at the HANDLER, not on TruthyDry alone: the unit table says
// a function returns true, this says no DELETE was ISSUED.

// teardownCleanUpstream answers a teardown in which nothing fails, so a run that
// reaches the delete phase really would delete. It intercepts DELETE before
// teardownOneSiteFailsUpstream's subnet refusal, and reuses that fake for every
// read so the plan phase resolves a real estate to destroy.
func teardownCleanUpstream(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodDelete {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"result":{}}`)
		return
	}
	teardownOneSiteFailsUpstream(w, r)
}

func TestTeardownSeedDemoStream_EmptyDryIsStillAPreview(t *testing.T) {
	// Counted rather than t.Fatal'd from inside the handler: this runs on the
	// httptest server's goroutine, where FailNow does not stop the test it was
	// called for.
	var deletes atomic.Int64
	upstream := func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deletes.Add(1)
		}
		teardownCleanUpstream(w, r)
	}

	frames, _ := runTeardownSeedDemo(t, upstream, "regions=amer&dry=&confirm=DELETE")

	// The run must actually have RUN. Without this the delete count below is
	// vacuous — a request that 403s on the confirmation, cannot find a template,
	// or fails its export issues no DELETEs either, and would sail through.
	terminal := terminalFrameOf(t, frames)
	if terminal["failed"] != float64(0) {
		t.Fatalf("terminal frame reports %v failed: %v — the run did not complete, so "+
			"'no deletes' proves nothing", terminal["failed"], terminal)
	}
	if s, _ := terminal["succeeded"].(float64); s < 1 {
		t.Fatalf("terminal frame reports %v succeeded: %v — nothing was torn down even in preview",
			terminal["succeeded"], terminal)
	}
	// The damage, checked before the label: what matters is what reached the
	// customer's tenant, not what the frames called it.
	if n := deletes.Load(); n != 0 {
		t.Fatalf("`?dry=` issued %d DELETE(s) upstream. An empty value switches nothing off, "+
			"so it must leave the preview on", n)
	}
	dryMarked := false
	for _, f := range frames {
		if step, _ := f["step"].(string); strings.Contains(step, "[DRY-RUN] ") {
			dryMarked = true
			break
		}
	}
	if !dryMarked {
		t.Fatalf("no frame carried the [DRY-RUN] prefix — the run issued no deletes, but it did " +
			"not announce itself as a preview either")
	}
}
