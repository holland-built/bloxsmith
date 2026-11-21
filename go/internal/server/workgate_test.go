package server

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"bloxsmith/internal/config"
	"bloxsmith/internal/demo"
	"bloxsmith/internal/runs"
)

func gateDeps(t *testing.T) *Deps {
	t.Helper()
	return &Deps{StateDir: t.TempDir(), Cfg: &config.Config{}}
}

func TestGateClosesOnlyWhenIdleAndRefusesNewWork(t *testing.T) {
	d := gateDeps(t)
	_, ok := d.workGate().Enter()
	if !ok {
		t.Fatal("an open gate refused work")
	}
	if why := d.CloseForUpdate(); why == "" {
		t.Fatal("the gate closed while a change was running")
	}
	if _, ok := d.workGate().Enter(); !ok {
		t.Fatal("a busy answer must leave the gate open")
	}
}

func TestGateStaysClosedUntilReopened(t *testing.T) {
	d := gateDeps(t)
	if why := d.CloseForUpdate(); why != "" {
		t.Fatalf("idle gate reported busy: %s", why)
	}
	if _, ok := d.workGate().Enter(); ok {
		t.Fatal("new work got in after the gate closed")
	}
	d.ReopenAfterUpdate()
	if _, ok := d.workGate().Enter(); !ok {
		t.Fatal("gate stayed closed after a failed update released it")
	}
}

// A provisioning stream is a GET that lasts minutes. It must count for its
// whole lifetime, and a dry-run preview must not count.
func TestStreamCountsForItsFullLifetime(t *testing.T) {
	d := gateDeps(t)
	entered, finish := make(chan struct{}), make(chan struct{})
	h := d.withWorkGate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-finish
	}))
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/provision/site/stream?dry=0", nil))
	}()
	<-entered
	if why := d.CloseForUpdate(); why == "" {
		t.Fatal("gate closed during a live provisioning stream")
	}
	close(finish)
	<-done
	if why := d.CloseForUpdate(); why != "" {
		t.Fatalf("gate still busy after the stream ended: %s", why)
	}
}

func TestTeardownStreamRefusedWhileClosed(t *testing.T) {
	d := gateDeps(t)
	if why := d.CloseForUpdate(); why != "" {
		t.Fatal(why)
	}
	reached := false
	h := d.withWorkGate(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/teardown/site/stream?dry=0", nil))
	if reached || rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("closed gate: reached=%v code=%d", reached, rr.Code)
	}
}

func TestReadsAndPreviewsPassAClosedGate(t *testing.T) {
	d := gateDeps(t)
	d.CloseForUpdate()
	for _, target := range []string{"/api/data", "/api/provision/site/stream?dry=1", "/api/update/status"} {
		reached := false
		h := d.withWorkGate(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", target, nil))
		if !reached {
			t.Errorf("%s was refused by a closed gate", target)
		}
	}
}

func TestBackgroundKitBuildCounts(t *testing.T) {
	d := gateDeps(t)
	started, finish, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	if !d.goCounted(func() { close(started); <-finish; close(done) }) {
		t.Fatal("open gate refused background work")
	}
	<-started
	if why := d.CloseForUpdate(); why == "" {
		t.Fatal("gate closed while the background build ran")
	}
	close(finish)
	<-done
	deadline := time.Now().Add(2 * time.Second)
	for d.CloseForUpdate() != "" {
		if time.Now().After(deadline) {
			t.Fatal("background build was never released")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestStartKitServerUsesTheCountedGoroutine(t *testing.T) {
	f, err := parser.ParseFile(token.NewFileSet(), "desk_site.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "startKitServer" {
			continue
		}
		counted := false
		ast.Inspect(fn, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.GoStmt:
				t.Error("startKitServer starts a goroutine the gate cannot count")
			case *ast.SelectorExpr:
				counted = counted || x.Sel.Name == "goCounted"
			}
			return true
		})
		if !counted {
			t.Error("startKitServer does not use goCounted")
		}
		return
	}
	t.Fatal("startKitServer not found")
}

func TestRunStoresMakeTheGateBusy(t *testing.T) {
	for _, status := range []string{runs.Building, runs.Removing} {
		d := gateDeps(t)
		l := d.ledger()
		// Added after Open, as a live run is.
		if err := l.Add(runs.Run{ID: "r-1", Status: status, Objects: []runs.Object{}}); err != nil {
			t.Fatal(err)
		}
		if why := d.CloseForUpdate(); why == "" {
			t.Errorf("desk run %q did not make the gate busy", status)
		}
		if _, ok := d.workGate().Enter(); !ok {
			t.Errorf("desk run %q: a busy answer left the gate closed", status)
		}
	}
	for _, status := range []string{"building", "removing"} {
		d := gateDeps(t)
		if err := d.demoStore().Save(&demo.Run{Change: "c-20260101-000000", Status: status}); err != nil {
			t.Fatal(err)
		}
		// A running build holds the lock; without it the record is a crash leftover.
		release, err := d.demoStore().Lock(time.Now)
		if err != nil {
			t.Fatal(err)
		}
		if why := d.CloseForUpdate(); why == "" {
			t.Errorf("demo run %q did not make the gate busy", status)
		}
		release()
	}
}

func TestUnreadableRunRecordIsBusy(t *testing.T) {
	d := gateDeps(t)
	if err := os.WriteFile(filepath.Join(d.StateDir, "desk_runs.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if why := d.CloseForUpdate(); why == "" {
		t.Error("an unreadable desk run file did not count as busy")
	}

	d = gateDeps(t)
	dir := filepath.Join(d.StateDir, "demo", "runs", "c-20260101-000000")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "run.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	why := d.CloseForUpdate()
	if why == "" || !strings.Contains(why, "read") {
		t.Errorf("an unreadable demo record did not count as busy: %q", why)
	}
}

func TestStoppedDemoRunNoLongerBlocksAnUpdate(t *testing.T) {
	for _, status := range []string{"building", "removing"} {
		state := t.TempDir()
		before := &Deps{StateDir: state, Cfg: &config.Config{}}
		if err := before.demoStore().Save(&demo.Run{Change: "c-20260101-000000", Status: status, VMID: 9001}); err != nil {
			t.Fatal(err)
		}
		after := &Deps{StateDir: state, Cfg: &config.Config{}}
		if err := after.demoStore().Recover(time.Now); err != nil {
			t.Fatal(err)
		}
		if why := after.WorkRunning(); why != "" {
			t.Errorf("%s: WorkRunning still busy: %s", status, why)
		}
		if why := after.CloseForUpdate(); why != "" {
			t.Errorf("%s: CloseForUpdate still busy: %s", status, why)
		}
	}
}

func TestDemoRunUnderALiveLockStaysBusy(t *testing.T) {
	d := gateDeps(t)
	if err := d.demoStore().Save(&demo.Run{Change: "c-20260101-000000", Status: "building"}); err != nil {
		t.Fatal(err)
	}
	release, err := d.demoStore().Lock(time.Now)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	_ = d.demoStore().Recover(time.Now)
	if why := d.WorkRunning(); why == "" {
		t.Fatal("a build holding the lock stopped counting as busy")
	}
}

func TestPlainFileInDemoRunsDoesNotBlockAnUpdate(t *testing.T) {
	d := gateDeps(t)
	dir := filepath.Join(d.StateDir, "demo", "runs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".DS_Store"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if why := d.WorkRunning(); why != "" {
		t.Fatalf(".DS_Store made the gate busy: %s", why)
	}
}

func TestUnreadableDemoRunStaysBusyAfterRecovery(t *testing.T) {
	d := gateDeps(t)
	dir := filepath.Join(d.StateDir, "demo", "runs", "c-20260101-000000")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "run.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = d.demoStore().Recover(time.Now)
	if why := d.WorkRunning(); why == "" {
		t.Fatal("an unreadable real run stopped counting as busy")
	}
}

// crashedDemo leaves what a killed older server leaves: a record and its lock.
func crashedDemo(t *testing.T, d *Deps, status string) {
	t.Helper()
	if err := d.demoStore().Save(&demo.Run{Change: "c-20260101-000000", Status: status, VMID: 9001}); err != nil {
		t.Fatal(err)
	}
	// An older server's lock: a timestamp and no OS lock, so only age clears it.
	stamp := time.Now().UTC().Format(time.RFC3339)
	if err := os.WriteFile(filepath.Join(d.StateDir, "demo", "build.lock"), []byte(stamp), 0o600); err != nil {
		t.Fatal(err)
	}
}

func ageDemoLock(t *testing.T, d *Deps) {
	t.Helper()
	old := time.Now().Add(-3 * time.Hour)
	if err := os.Chtimes(filepath.Join(d.StateDir, "demo", "build.lock"), old, old); err != nil {
		t.Fatal(err)
	}
}

func TestCrashThenRestartClearsOnceTheLockExpires(t *testing.T) {
	for status, want := range map[string]string{"building": "failed", "removing": "remove-failed"} {
		state := t.TempDir()
		crashedDemo(t, &Deps{StateDir: state, Cfg: &config.Config{}}, status)

		restarted := &Deps{StateDir: state, Cfg: &config.Config{}}
		if err := restarted.demoStore().Recover(time.Now); err == nil {
			t.Fatalf("%s: startup recovery ignored an older server's recent lock", status)
		}
		if why := restarted.WorkRunning(); why == "" {
			t.Fatalf("%s: not busy while the lock is recent", status)
		}
		if r, _ := restarted.demoStore().Load("c-20260101-000000"); r == nil || r.Status != status {
			t.Fatalf("%s: record changed under a live lock: %+v", status, r)
		}

		ageDemoLock(t, restarted)
		if why := restarted.WorkRunning(); why != "" {
			t.Fatalf("%s: still busy after the lock expired: %s", status, why)
		}
		r, err := restarted.demoStore().Load("c-20260101-000000")
		if err != nil || r.Status != want || r.VMID != 9001 {
			t.Fatalf("%s: recovered record %+v, %v", status, r, err)
		}
		if why := restarted.CloseForUpdate(); why != "" {
			t.Fatalf("%s: CloseForUpdate still busy: %s", status, why)
		}
	}
}

func TestRetryLeavesAloneABuildThisProcessIsRunning(t *testing.T) {
	d := gateDeps(t)
	crashedDemo(t, d, "building")
	ageDemoLock(t, d)
	release, ok := d.workGate().Enter()
	if !ok {
		t.Fatal("open gate refused work")
	}
	defer release()
	if why := d.WorkRunning(); why == "" {
		t.Fatal("not busy during counted work")
	}
	if why := d.CloseForUpdate(); why == "" {
		t.Fatal("gate closed during counted work")
	}
	if r, _ := d.demoStore().Load("c-20260101-000000"); r == nil || r.Status != "building" {
		t.Fatalf("a running build was marked stopped: %+v", r)
	}
}

func TestEmptyDemoRunFolderNoLongerBlocksAnUpdate(t *testing.T) {
	d := gateDeps(t)
	dir := filepath.Join(d.StateDir, "demo", "runs", "c-20260101-000000")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if why := d.WorkRunning(); why != "" {
		t.Fatalf("an empty run folder blocked the update: %s", why)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the empty run folder was not removed: %v", err)
	}
}

func TestNonEmptyUnreadableDemoRunStillBlocksAnUpdate(t *testing.T) {
	d := gateDeps(t)
	dir := filepath.Join(d.StateDir, "demo", "runs", "c-20260101-000000", "ip")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if why := d.WorkRunning(); why == "" {
		t.Fatal("a non-empty run folder with no record stopped counting as busy")
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("a non-empty run folder was changed: %v", err)
	}
}

func TestDemoRunFolderWithOnlyATempRecordNoLongerBlocksAnUpdate(t *testing.T) {
	d := gateDeps(t)
	dir := filepath.Join(d.StateDir, "demo", "runs", "c-20260101-000000")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "run.json.tmp"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if why := d.WorkRunning(); why != "" {
		t.Fatalf("a folder with only run.json.tmp blocked the update: %s", why)
	}
}
