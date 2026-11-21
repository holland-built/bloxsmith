package main

import (
	"errors"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"bloxsmith/internal/server"
)

// A failed restart must reopen the work gate BEFORE it releases the update
// guard. In the other order a second update can start and close the gate, and
// the first run's late reopen then lets work start during that install.

type reopenSpyGate struct {
	server.UpdateGate
	onReopen func()
}

func (g reopenSpyGate) ReopenAfterUpdate() {
	g.onReopen()
	g.UpdateGate.ReopenAfterUpdate()
}

// guardCheck reports a failure if a second update could start right now.
func guardCheck(t *testing.T) func() {
	return func() {
		if progress.begin() {
			t.Error("the update guard was released before the gate reopened, so a second update could start")
		}
	}
}

func failRestart(t *testing.T, h applyHooks) {
	t.Helper()
	bad := filepath.Join(t.TempDir(), "does-not-exist-bloxsmith")
	if handleRestart(bad, h.failHandoff) {
		t.Fatal("a failed launch asked the process to exit")
	}
	snap := progress.snapshot()
	if snap["phase"] != "error" || snap["running"] != false {
		t.Fatalf("after the failed restart: %v", snap)
	}
}

func TestUpdateNowFailedRestartReopensGateBeforeReleasingGuard(t *testing.T) {
	waitTestSetup(t)
	gate := reopenSpyGate{UpdateGate: &server.Deps{Work: &server.WorkGate{}}, onReopen: guardCheck(t)}
	captured := make(chan applyHooks, 1)
	applyUpdateNow(httptest.NewRecorder(), gate, func(h applyHooks) error {
		if err := h.beforeSwap("v99.0.0"); err != nil {
			return err
		}
		captured <- h
		return nil
	})
	select {
	case h := <-captured:
		failRestart(t, h)
	case <-time.After(2 * time.Second):
		t.Fatal("the update never reached the swap")
	}
}

func TestOvernightFailedRestartReopensGateBeforeReleasingGuard(t *testing.T) {
	waitTestSetup(t)
	progress.begin()
	r := newRig(t)
	r.enable(t)
	r.u.reopenGate = guardCheck(t)
	var hooks applyHooks
	r.applyFn = func(h applyHooks) error {
		hooks = h
		_ = h.allow(auTag)
		return h.beforeSwap(auTag)
	}
	r.u.tick()
	failRestart(t, hooks)
}

// A hook that panics must not leave the guard held forever.
func TestFailedRestartReleasesGuardEvenIfTheHookPanics(t *testing.T) {
	waitTestSetup(t)
	progress.begin()
	applyHooks{handoffFailed: func(error) { panic("boom") }}.failHandoff(errors.New("could not start"))
	if snap := progress.snapshot(); snap["phase"] != "error" || snap["running"] != false {
		t.Fatalf("after the panic: %v", snap)
	}
}
