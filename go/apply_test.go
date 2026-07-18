package main

import (
	"context"
	"path/filepath"
	"testing"
)

// TestHandleRestartLaunchFailureKeepsServing pins the self-update restart fix:
// when the successor binary CANNOT be launched, handleRestart must NOT signal
// exit and must NOT release the listen socket — the old process keeps serving —
// and it must report phase=error so the frontend sees the failure instead of a
// stale "done".
func TestHandleRestartLaunchFailureKeepsServing(t *testing.T) {
	// Point shutdownServer at a canary; a launch failure must never call it,
	// because releasing the port before the child is up is exactly the bug.
	shutdownCalled := false
	shutdownServer = func(_ context.Context) error { shutdownCalled = true; return nil }
	t.Cleanup(func() { shutdownServer = nil })

	// Reset progress to a clean in-flight state.
	progress = &updateProgress{Phase: "restarting", running: true}

	badExe := filepath.Join(t.TempDir(), "does-not-exist-bloxsmith")
	if exit := handleRestart(badExe); exit {
		t.Fatal("handleRestart returned exit=true on a launch failure; the parent would have exited and taken the service down")
	}
	if shutdownCalled {
		t.Fatal("handleRestart released the listen socket despite the child failing to start")
	}
	if snap := progress.snapshot(); snap["phase"] != "error" {
		t.Fatalf("phase = %v, want error", snap["phase"])
	}
}
