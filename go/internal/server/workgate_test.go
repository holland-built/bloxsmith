package server

import (
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
		if why := d.CloseForUpdate(); why == "" {
			t.Errorf("demo run %q did not make the gate busy", status)
		}
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
