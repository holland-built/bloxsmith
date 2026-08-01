package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func readRecs(t *testing.T, path string) []map[string]any {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open reqlog: %v", err)
	}
	defer f.Close()
	var out []map[string]any
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatalf("bad JSON line %q: %v", sc.Text(), err)
		}
		out = append(out, m)
	}
	return out
}

// Disabled by default: no env var, no middleware, no file.
func TestReqLogDisabledByDefault(t *testing.T) {
	t.Setenv(reqLogEnv, "")
	if rl := newReqLog(); rl != nil {
		t.Fatal("reqlog must be nil when BLOXSMITH_REQLOG is unset")
	}
	var rl *reqLog
	base := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
	if got := rl.wrap(base); got == nil {
		t.Fatal("wrap on a nil reqLog must return the handler, not nil")
	}
}

// A completed /api/ request produces a start record and an end record carrying
// status, duration and an "ok" outcome — plus pid/proc_start on both, which is
// what lets records be attributed to a process across a restart.
func TestReqLogRecordsStartAndEnd(t *testing.T) {
	path := filepath.Join(t.TempDir(), "req.jsonl")
	t.Setenv(reqLogEnv, path)
	rl := newReqLog()
	if rl == nil {
		t.Fatal("reqlog should be enabled")
	}
	h := rl.wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(201)
		w.Write([]byte("hi"))
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/data?x=1", nil))

	recs := readRecs(t, path)
	// process-start, req-start, req-end
	if len(recs) != 3 {
		t.Fatalf("want 3 records, got %d: %v", len(recs), recs)
	}
	if recs[0]["ev"] != "process-start" {
		t.Fatalf("first record should be process-start, got %v", recs[0]["ev"])
	}
	start, end := recs[1], recs[2]
	if start["ev"] != "req-start" || start["route"] != "/api/data" || start["query"] != "x=1" {
		t.Fatalf("bad start record: %v", start)
	}
	if end["ev"] != "req-end" || end["status"].(float64) != 201 || end["outcome"] != "ok" {
		t.Fatalf("bad end record: %v", end)
	}
	if start["id"] != end["id"] {
		t.Fatalf("start/end ids differ: %v vs %v", start["id"], end["id"])
	}
	for _, r := range recs {
		if r["pid"] == nil || r["proc_start"] == nil || r["t"] == nil {
			t.Fatalf("record missing pid/proc_start/t: %v", r)
		}
	}
}

// The case the flake investigation actually needs: a client that goes away
// mid-request must be recorded as cancelled, not as a plain success.
func TestReqLogRecordsClientCancellation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "req.jsonl")
	t.Setenv(reqLogEnv, path)
	rl := newReqLog()

	ctx, cancel := context.WithCancel(context.Background())
	h := rl.wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cancel() // client disconnects while the handler is still working
		time.Sleep(5 * time.Millisecond)
	}))
	req := httptest.NewRequest("GET", "/api/data", nil).WithContext(ctx)
	h.ServeHTTP(httptest.NewRecorder(), req)

	recs := readRecs(t, path)
	end := recs[len(recs)-1]
	if end["ev"] != "req-end" || end["outcome"] != "client-cancelled" {
		t.Fatalf("want client-cancelled end record, got %v", end)
	}
}

// Non-/api/ traffic (static assets) is not logged — the log stays readable.
func TestReqLogSkipsNonAPI(t *testing.T) {
	path := filepath.Join(t.TempDir(), "req.jsonl")
	t.Setenv(reqLogEnv, path)
	rl := newReqLog()
	h := rl.wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/index.html", nil))

	recs := readRecs(t, path)
	if len(recs) != 1 || recs[0]["ev"] != "process-start" {
		t.Fatalf("static request should not be logged, got %v", recs)
	}
}

// A second process appending to the same path must add to the file, not
// truncate it — the whole point is that records survive a restart.
func TestReqLogAppendsAcrossOpens(t *testing.T) {
	path := filepath.Join(t.TempDir(), "req.jsonl")
	t.Setenv(reqLogEnv, path)
	first := newReqLog()
	first.wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})).
		ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/data", nil))
	before := len(readRecs(t, path))

	newReqLog() // simulates the restarted process opening the same log
	after := readRecs(t, path)
	if len(after) != before+1 {
		t.Fatalf("reopen truncated or lost records: before=%d after=%d", before, len(after))
	}
}
