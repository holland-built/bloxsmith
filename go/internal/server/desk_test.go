package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"bloxsmith/internal/runs"
)

// fakeTenant answers the calls the desk makes: nextavailableip reserves one
// address, GET says whether an address still exists, DELETE removes it (or is
// refused while refuseDelete is set).
type fakeTenant struct {
	mu           sync.Mutex
	exists       map[string]bool
	deletes      []string
	refuseDelete bool
	slowDelete   chan struct{} // when set, each DELETE waits for a value
}

func (f *fakeTenant) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	p := r.URL.Path
	switch {
	case r.Method == "GET" && strings.HasSuffix(p, "/nextavailableip"):
		io.WriteString(w, `{"results":[{"address":"10.7.0.9"}]}`)
	case r.Method == "POST" && strings.HasSuffix(p, "/nextavailableip"):
		f.exists["ipam/address/a-1111"] = true
		io.WriteString(w, `{"results":[{"id":"ipam/address/a-1111","address":"10.7.0.4"}]}`)
	case r.Method == "GET" && strings.Contains(p, "/ipam/address/"):
		if f.exists[strings.TrimPrefix(p, "/api/ddi/v1/")] {
			io.WriteString(w, `{"result":{}}`)
		} else {
			w.WriteHeader(404)
		}
	case r.Method == "DELETE":
		id := strings.TrimPrefix(p, "/api/ddi/v1/")
		f.deletes = append(f.deletes, id)
		if f.slowDelete != nil {
			f.mu.Unlock()
			<-f.slowDelete
			f.mu.Lock()
		}
		if f.refuseDelete {
			w.WriteHeader(500)
			io.WriteString(w, `{"error":"refused"}`)
			return
		}
		if !f.exists[id] {
			w.WriteHeader(404)
			return
		}
		delete(f.exists, id)
		w.WriteHeader(204)
	default:
		w.WriteHeader(500)
		io.WriteString(w, `{"error":"unexpected `+r.Method+` `+p+`"}`)
	}
}

func newDeskDeps(t *testing.T) (*Deps, *fakeTenant, string) {
	t.Helper()
	f := &fakeTenant{exists: map[string]bool{}}
	d, logPath := newDeleteDeps(t, f.handler)
	d.StateDir = t.TempDir()
	return d, f, logPath
}

func deskPost(t *testing.T, d *Deps, fn func(http.ResponseWriter, *http.Request, map[string]any), path, body string) (int, map[string]any) {
	t.Helper()
	r := httptest.NewRequest("POST", path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	d.body(fn)(rr, r)
	return rr.Code, decodeBody(t, rr)
}

func onlyRun(t *testing.T, d *Deps) runs.Run {
	t.Helper()
	rs, err := d.ledger().List()
	if err != nil || len(rs) != 1 {
		t.Fatalf("runs = %v (err %v), want exactly 1", rs, err)
	}
	return rs[0]
}

func TestDeskRun_PreviewRecordsNothing(t *testing.T) {
	d, _, _ := newDeskDeps(t)
	code, body := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"ip","input":{"subnet_id":"ipam/subnet/s-1"},"dry":true}`)
	if code != 200 || body["dry_run"] != true {
		t.Fatalf("preview = %d %v, want 200 dry_run", code, body)
	}
	if rs, _ := d.ledger().List(); len(rs) != 0 {
		t.Fatalf("a preview recorded %d runs, want 0", len(rs))
	}
}

func TestDeskRun_BuildRecordsTheExactID(t *testing.T) {
	d, _, logPath := newDeskDeps(t)
	code, body := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"ip","input":{"subnet_id":"ipam/subnet/s-1","name":"printer-02"},"dry":false}`)
	if code != 200 || body["ok"] != true {
		t.Fatalf("build = %d %v", code, body)
	}
	run := onlyRun(t, d)
	if run.Status != runs.Built || len(run.Objects) != 1 || run.Objects[0].ID != "ipam/address/a-1111" {
		t.Fatalf("run = %+v, want built with ipam/address/a-1111", run)
	}
	if run.Title != "IP address for printer-02: 10.7.0.4" {
		t.Fatalf("title = %q", run.Title)
	}
	if n := len(auditEntries(t, logPath, "desk-build")); n != 1 {
		t.Fatalf("desk-build audit entries = %d, want 1", n)
	}
}

func TestDeskRemove_DeletesOnlyTheRunsObjectsAndCanRetry(t *testing.T) {
	d, f, logPath := newDeskDeps(t)
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"ip","input":{"subnet_id":"ipam/subnet/s-1"},"dry":false}`)
	run := onlyRun(t, d)

	// Preview reports what is still there and deletes nothing.
	code, body := deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":true}`)
	would, _ := body["would_remove"].([]any)
	if code != 200 || len(would) != 1 || len(f.deletes) != 0 {
		t.Fatalf("remove preview = %d %v, deletes %v", code, body, f.deletes)
	}

	// Infoblox refuses: the run says so and keeps the object for a retry.
	f.refuseDelete = true
	code, _ = deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	if got := onlyRun(t, d); code != 502 || got.Status != runs.RemoveFailed || got.Objects[0].State != runs.Error {
		t.Fatalf("refused remove = %d %+v", code, got)
	}

	// Retry succeeds and deletes exactly the recorded ID.
	f.refuseDelete = false
	f.deletes = nil
	code, _ = deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	got := onlyRun(t, d)
	if code != 200 || got.Status != runs.Removed || got.Objects[0].State != runs.Deleted {
		t.Fatalf("retried remove = %d %+v", code, got)
	}
	if len(f.deletes) != 1 || f.deletes[0] != "ipam/address/a-1111" {
		t.Fatalf("deletes = %v, want only ipam/address/a-1111", f.deletes)
	}

	// A third Remove has nothing left to delete.
	f.deletes = nil
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	if len(f.deletes) != 0 {
		t.Fatalf("a finished run deleted again: %v", f.deletes)
	}
	if n := len(auditEntries(t, logPath, "desk-remove")); n != 3 {
		t.Fatalf("desk-remove audit entries = %d, want 3", n)
	}
}

// Two Removes at once: one deletes, the other is told the run is busy or finds
// nothing left. The address is never deleted twice.
func TestDeskRemove_TwoAtOnceDeleteOnce(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"ip","input":{"subnet_id":"ipam/subnet/s-1"},"dry":false}`)
	run := onlyRun(t, d)
	f.slowDelete = make(chan struct{})
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i], _ = deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
		}(i)
	}
	// Let any deletes through once both requests are under way.
	go func() {
		for i := 0; i < 2; i++ {
			f.slowDelete <- struct{}{}
		}
	}()
	wg.Wait()
	f.mu.Lock()
	n := len(f.deletes)
	f.mu.Unlock()
	if n != 1 {
		t.Fatalf("deletes = %d (codes %v), want exactly 1", n, codes)
	}
	if got := onlyRun(t, d); got.Status != runs.Removed {
		t.Fatalf("run = %+v, want removed", got)
	}
}

func TestDeskRemove_AlreadyGoneCountsAsDone(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"ip","input":{"subnet_id":"ipam/subnet/s-1"},"dry":false}`)
	run := onlyRun(t, d)
	delete(f.exists, "ipam/address/a-1111") // someone released it by hand
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	if got := onlyRun(t, d); got.Status != runs.Removed || got.Objects[0].State != runs.Gone {
		t.Fatalf("run = %+v, want removed with the object marked gone", got)
	}
}

func TestDeskRun_UnknownJobAndMissingNetworkAreRefused(t *testing.T) {
	d, _, _ := newDeskDeps(t)
	if code, _ := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"rm-rf","input":{},"dry":false}`); code != 400 {
		t.Fatalf("unknown job = %d, want 400", code)
	}
	if code, _ := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"ip","input":{},"dry":false}`); code != 400 {
		t.Fatalf("no network = %d, want 400", code)
	}
}

func TestDeskRun_NoStateDirBuildsNothing(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	d.StateDir = ""
	code, _ := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"ip","input":{"subnet_id":"ipam/subnet/s-1"},"dry":false}`)
	if code != 500 || len(f.exists) != 0 {
		t.Fatalf("with nowhere to record: %d, created %v; want 500 and nothing created", code, f.exists)
	}
}

// A run left "building" by a server that stopped part way shows as failed on
// the next start, not stuck forever.
func TestLedger_BuildingRunIsMarkedFailedOnRestart(t *testing.T) {
	dir := t.TempDir()
	rs := []runs.Run{{ID: "r-1", Status: runs.Building, Created: "2026-11-05T00:00:00Z"}}
	b, _ := json.Marshal(rs)
	if err := os.WriteFile(filepath.Join(dir, "desk_runs.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	got, _, _ := runs.Open(dir).Get("r-1")
	if got.Status != runs.Failed || got.Error == "" {
		t.Fatalf("run = %+v, want failed with a reason", got)
	}
}
