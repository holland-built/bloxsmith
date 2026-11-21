package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/config"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/server"
)

// Update now, pressed through the real route while a job is counted as running.
// Nothing may be fetched, swapped or restarted.
func TestUpdateNowRouteRefusesWhileWorkIsRunning(t *testing.T) {
	prevProgress, prevStart, prevBase, prevSwap := progress, startTime, githubAPIBase, swapBinary
	t.Cleanup(func() {
		progress, startTime, githubAPIBase, swapBinary = prevProgress, prevStart, prevBase, prevSwap
	})
	progress = &updateProgress{Phase: "idle"}
	startTime = time.Now().Add(-2 * applyCooldown)

	var asked, swapped atomic.Int32
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		asked.Add(1)
		_, _ = w.Write([]byte(`{"tag_name":"v99.0.0","assets":[]}`))
	}))
	t.Cleanup(github.Close)
	githubAPIBase = github.URL
	swapBinary = func(io.Reader) error { swapped.Add(1); return nil }

	gate := &server.WorkGate{}
	release, ok := gate.Enter()
	if !ok {
		t.Fatal("the gate refused the running job")
	}
	defer release()

	handler := server.New(&server.Deps{
		Cfg:     &config.Config{Port: "8080"},
		Guard:   &httpx.Guard{Port: "8080", Token: "wait-test-token"},
		Version: "v1.0.0",
		Work:    gate,
		Static:  http.NotFoundHandler(),
		Audit: audit.New(filepath.Join(t.TempDir(), "audit_log.jsonl"), "app-v-test", "test-instance",
			audit.Options{TrustDir: t.TempDir()}),
		UpdateApply:    applyUpdateHandler,
		UpdateProgress: updateProgressHandler,
	})
	req := httptest.NewRequest(http.MethodPost, "/api/update/apply", nil)
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set("X-Auth-Token", "wait-test-token")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	// Long enough for the old background install to have reached GitHub.
	time.Sleep(200 * time.Millisecond)

	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body: %s", rr.Code, rr.Body)
	}
	var body struct {
		Busy  bool   `json:"busy"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.Busy || body.Error == "" {
		t.Fatalf("the refusal must say work is running: %s", rr.Body)
	}
	if n := asked.Load(); n != 0 {
		t.Fatalf("the update went ahead and asked GitHub %d time(s)", n)
	}
	if n := swapped.Load(); n != 0 {
		t.Fatalf("the binary was swapped %d time(s) under a running job", n)
	}
}
