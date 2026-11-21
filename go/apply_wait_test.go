package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"bloxsmith/internal/server"
)

func waitTestSetup(t *testing.T) {
	t.Helper()
	prevProgress, prevStart := progress, startTime
	t.Cleanup(func() { progress, startTime = prevProgress, prevStart })
	progress = &updateProgress{Phase: "idle"}
	startTime = time.Now().Add(-2 * applyCooldown)
}

func waitForPhase(t *testing.T, want string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snap := progress.snapshot()
		if snap["phase"] == want {
			return snap
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("phase = %v, want %q", progress.snapshot()["phase"], want)
	return nil
}

// A job that starts during the download must stop the update at the swap.
func TestUpdateNowStopsAtTheSwapIfWorkStartedDuringDownload(t *testing.T) {
	waitTestSetup(t)
	gate := &server.WorkGate{}
	deps := &server.Deps{Work: gate}
	var release func()
	swapped := false
	rr := httptest.NewRecorder()
	applyUpdateNow(rr, deps, func(h applyHooks) error {
		release, _ = gate.Enter()
		if err := h.beforeSwap("v99.0.0"); err != nil {
			return err
		}
		swapped = true
		return nil
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d", rr.Code)
	}
	snap := waitForPhase(t, "waiting")
	defer release()
	if swapped {
		t.Fatal("the swap ran while a job was running")
	}
	if snap["running"] != false || !strings.Contains(snap["error"].(string), "work is running") {
		t.Fatalf("status = %v", snap)
	}
	// The job that is running must be able to finish, and new work can start.
	next, ok := gate.Enter()
	if !ok {
		t.Fatal("the gate stayed closed after the update stood down")
	}
	next()
}

// Once the gate is closed for the swap, no job can start before the restart.
func TestUpdateNowHoldsTheGateThroughTheRestart(t *testing.T) {
	waitTestSetup(t)
	gate := &server.WorkGate{}
	var startedDuringSwap bool
	var wg sync.WaitGroup
	wg.Add(1)
	applyUpdateNow(httptest.NewRecorder(), &server.Deps{Work: gate}, func(h applyHooks) error {
		defer wg.Done()
		if err := h.beforeSwap("v99.0.0"); err != nil {
			return err
		}
		_, startedDuringSwap = gate.Enter()
		return nil
	})
	wg.Wait()
	if startedDuringSwap {
		t.Fatal("a job started after the check and before the restart")
	}
	time.Sleep(20 * time.Millisecond)
	if _, ok := gate.Enter(); ok {
		t.Fatal("the gate reopened on a successful update, before the restart")
	}
}

func TestUpdateNowReopensTheGateWhenTheInstallFails(t *testing.T) {
	waitTestSetup(t)
	gate := &server.WorkGate{}
	applyUpdateNow(httptest.NewRecorder(), &server.Deps{Work: gate}, func(h applyHooks) error {
		if err := h.beforeSwap("v99.0.0"); err != nil {
			return err
		}
		return errors.New("disk full")
	})
	waitForPhase(t, "error")
	if _, ok := gate.Enter(); !ok {
		t.Fatal("a failed install left the gate closed, so no work could start")
	}
}

func TestUpdateNowReopensTheGateWhenTheNewVersionCannotStart(t *testing.T) {
	waitTestSetup(t)
	gate := &server.WorkGate{}
	done := make(chan struct{})
	applyUpdateNow(httptest.NewRecorder(), &server.Deps{Work: gate}, func(h applyHooks) error {
		defer close(done)
		if err := h.beforeSwap("v99.0.0"); err != nil {
			return err
		}
		h.handoffFailed(errors.New("could not start"))
		return nil
	})
	<-done
	if _, ok := gate.Enter(); !ok {
		t.Fatal("a failed restart left the gate closed")
	}
}

type unknownGate struct{ server.UpdateGate }

func (unknownGate) WorkRunning() string { return "a job record could not be read" }

// Not knowing counts as busy, and the words say it was not known.
func TestUpdateNowTreatsAnUnknownStateAsBusy(t *testing.T) {
	for name, gate := range map[string]server.UpdateGate{"unreadable record": unknownGate{}, "no gate": nil} {
		t.Run(name, func(t *testing.T) {
			waitTestSetup(t)
			rr := httptest.NewRecorder()
			applyUpdateNow(rr, gate, func(applyHooks) error {
				t.Error("the update ran without knowing whether work was running")
				return nil
			})
			var body struct {
				Busy  bool   `json:"busy"`
				Error string `json:"error"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if rr.Code != http.StatusConflict || !body.Busy || !strings.Contains(body.Error, "could not confirm") {
				t.Fatalf("status %d, body %s", rr.Code, rr.Body)
			}
		})
	}
}
