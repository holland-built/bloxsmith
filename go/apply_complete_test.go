package main

import (
	"strings"
	"testing"
	"time"
)

// WHAT HAPPENS AFTER THE BINARY IS SWAPPED (#99).
//
// The hand-off used to be unconditional. On the `bloxsmith update` CLI path it
// did nothing whatsoever while announcing that it had: phase went to
// "restarting", the command printed "— restarting", and main.go's os.Exit tore
// the process down long before the goroutine's 750ms sleep elapsed. An operator
// running Bloxsmith as a service read "restarting" and went on serving the old
// binary.
//
// completeApply takes the mode as a parameter and the hand-off as a func, so
// both branches run here with no release download, no binary swap and no
// successor process.

func TestCompleteApplyWithNoServerNeverHandsOffAndFinishes(t *testing.T) {
	prev := progress
	progress = &updateProgress{Phase: "applying", running: true}
	t.Cleanup(func() { progress = prev })

	calls := 0
	scheduled := completeApply(false, func() { calls++ })

	if scheduled {
		t.Fatal("completeApply reported a hand-off on a process with no server to hand over from")
	}
	// Synchronous, not after a deadline: the false branch must not start a
	// goroutine at all, so there is nothing that could run later.
	if calls != 0 {
		t.Fatalf("the hand-off was called %d time(s) with no server running", calls)
	}

	snap := progress.snapshot()
	if phase, _ := snap["phase"].(string); phase != "done" {
		t.Fatalf("phase = %q, want %q", phase, "done")
	}
	if phase, _ := snap["phase"].(string); phase == "restarting" {
		t.Fatal("the CLI path published 'restarting' — the claim #99 is about")
	}
	if pct, _ := snap["pct"].(int); pct != 100 {
		t.Fatalf("pct = %d, want 100", pct)
	}
}

// The server path is unchanged, and that is the half worth protecting: the
// in-app Update now button genuinely does hand the port over.
func TestCompleteApplyWithAServerSchedulesTheHandOff(t *testing.T) {
	prev := progress
	progress = &updateProgress{Phase: "applying", running: true}
	t.Cleanup(func() { progress = prev })

	ran := make(chan struct{})
	scheduled := completeApply(true, func() { close(ran) })

	if !scheduled {
		t.Fatal("completeApply did not schedule a hand-off for a running server")
	}
	// The phase the frontend's stepped modal shows while the successor starts.
	// It must be published by completeApply itself, not by the hand-off, or a
	// slow spawn would leave the modal on 'applying'.
	snap := progress.snapshot()
	if phase, _ := snap["phase"].(string); phase != "restarting" {
		t.Fatalf("phase = %q, want %q", phase, "restarting")
	}
	if pct, _ := snap["pct"].(int); pct != 95 {
		t.Fatalf("pct = %d, want 95", pct)
	}

	// Observed by the hand-off itself, not by sleeping and hoping.
	select {
	case <-ran:
	case <-time.After(5 * time.Second):
		t.Fatal("the hand-off was never called for a running server")
	}
}

// The two help surfaces an operator reads before running it. Both promised a
// restart for several releases; neither may go back to it.
func TestUpdateHelpDoesNotPromiseARestart(t *testing.T) {
	for _, c := range []struct {
		name string
		fn   func()
	}{
		{"bloxsmith update --help", updateUsage},
		{"bloxsmith --help", printUsage},
	} {
		t.Run(c.name, func(t *testing.T) {
			out := strings.ToLower(captureStdout(t, c.fn))
			if !strings.Contains(out, "update") {
				t.Fatalf("nothing about `update` in this help text:\n%s", out)
			}
			// The WHOLE screen, not the first line: the wording that shipped put
			// "swaps this binary in place and restarts" on the third line of
			// `update --help`, so a check anchored to one line would have read
			// straight past the claim it exists to catch.
			//
			// The phrases, not the bare word: "restart it yourself" and
			// `bloxsmith service restart` are the correction, and both contain it.
			for _, bad := range []string{"then restart", "and restarts", "and restart.", "then re-exec"} {
				if strings.Contains(out, bad) {
					t.Fatalf("help still promises a restart the CLI does not perform (%q):\n%s", bad, out)
				}
			}
			if !strings.Contains(out, "yourself") {
				t.Fatalf("help does not tell the operator to restart it themselves:\n%s", out)
			}
		})
	}
}
