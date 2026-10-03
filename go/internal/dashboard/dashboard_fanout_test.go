package dashboard

import (
	"sync/atomic"
	"testing"
)

// fanOut runs tasks in goroutines the HTTP handler's recover cannot see, so a
// panic in one used to kill the process. It must survive, run the rest, and say
// how many tasks were lost.
func TestFanOut_APanickingTaskDoesNotKillTheProcessOrItsSiblings(t *testing.T) {
	var ran atomic.Int32
	panicked := fanOut(2,
		func() { ran.Add(1) },
		func() { panic("bad type assertion on a malformed upstream row") },
		func() { ran.Add(1) },
		func() { ran.Add(1) },
	)
	if panicked != 1 {
		t.Fatalf("panicked = %d, want 1", panicked)
	}
	if ran.Load() != 3 {
		t.Fatalf("siblings that ran = %d, want 3 — one bad task must not stop the others", ran.Load())
	}
}

func TestFanOut_NoPanicReportsZero(t *testing.T) {
	if n := fanOut(3, func() {}, func() {}); n != 0 {
		t.Fatalf("panicked = %d, want 0", n)
	}
}

// An empty status after a recovered panic means the feed failed, not that it is
// empty; a status a task did fill in is left alone.
func TestFailUnanswered_OnlyEmptyStatusesBecomeErrors(t *testing.T) {
	a, b, c := "", "ok", "empty"
	failUnanswered(&a, &b, &c)
	if a != "error" || b != "ok" || c != "empty" {
		t.Fatalf("got %q %q %q, want error ok empty", a, b, c)
	}
}
