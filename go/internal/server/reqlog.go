package server

// reqlog is DIAGNOSTIC INSTRUMENTATION, not product behaviour.
//
// It exists to answer one open question about the drilldown flake (see
// tests/drilldown.spec.ts): when that test's second /api/data fetch is in
// flight, did the request arrive at all, how long did it take, what status did
// it return, and was it cancelled by the client or killed by the process
// exiting? Three diagnoses have been offered for that test and none was ever
// backed by a captured server-side record of the request in question.
//
// Design constraints that drove this shape:
//   - OFF BY DEFAULT. The middleware is not installed unless BLOXSMITH_REQLOG
//     names a file. Unset (production, CI, normal dev) => zero added work.
//   - SURVIVES A RESTART. The event under investigation is a server restart, so
//     the log cannot live in the stdout of the process that dies. It appends to
//     a file (O_APPEND) and every process that opens the same path adds to it.
//   - START **AND** END RECORDS. A single duration line is emitted only by a
//     request that finished; a request killed mid-flight would leave no trace at
//     all, which is precisely the case being investigated. A start record with
//     no matching end record is itself the evidence.
//   - PID + PROCESS START TIME on every record, so records can be attributed to
//     a specific server process across a restart.

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// reqLogEnv names the file to append diagnostic request records to. Unset =
// instrumentation disabled entirely.
const reqLogEnv = "BLOXSMITH_REQLOG"

type reqLog struct {
	mu   sync.Mutex
	f    *os.File
	pid  int
	boot string // this process's start time, RFC3339Nano
	seq  atomic.Uint64
}

// newReqLog opens the append-only diagnostic log, or returns nil if the
// instrumentation is not enabled (or the file cannot be opened — in which case
// it says so on stderr rather than silently degrading to "no records", since
// "the log failed to open" and "the log recorded nothing" must not look alike).
func newReqLog() *reqLog {
	path := strings.TrimSpace(os.Getenv(reqLogEnv))
	if path == "" {
		return nil
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		os.Stderr.WriteString("[reqlog] DISABLED: cannot open " + path + ": " + err.Error() + "\n")
		return nil
	}
	rl := &reqLog{f: f, pid: os.Getpid(), boot: time.Now().UTC().Format(time.RFC3339Nano)}
	rl.write(map[string]any{"ev": "process-start"})
	return rl
}

func (rl *reqLog) write(rec map[string]any) {
	rec["pid"] = rl.pid
	rec["proc_start"] = rl.boot
	rec["t"] = time.Now().UTC().Format(time.RFC3339Nano)
	b, err := json.Marshal(rec)
	if err != nil {
		return
	}
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.f.Write(append(b, '\n'))
	rl.f.Sync() // a restart must not lose buffered records
}

// statusRecorder captures the status code the handler actually wrote (and
// whether it wrote anything at all).
type statusRecorder struct {
	http.ResponseWriter
	status  int
	wrote   bool
	written int64
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.wrote {
		s.status, s.wrote = code, true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if !s.wrote {
		s.status, s.wrote = http.StatusOK, true
	}
	n, err := s.ResponseWriter.Write(b)
	s.written += int64(n)
	return n, err
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// wrap installs the middleware. Returns next unchanged when instrumentation is
// disabled, so the non-diagnostic path is byte-for-byte the previous behaviour.
func (rl *reqLog) wrap(next http.Handler) http.Handler {
	if rl == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		id := rl.seq.Add(1)
		start := time.Now()
		rl.write(map[string]any{
			"ev": "req-start", "id": id,
			"route": r.URL.Path, "query": r.URL.RawQuery, "method": r.Method,
		})
		rec := &statusRecorder{ResponseWriter: w, status: 0}
		// A panic must still produce an end record; the handler chain's own
		// recover500 runs closer in, but a panic outside it would otherwise
		// erase the evidence.
		defer func() {
			p := recover()
			outcome := "ok"
			switch {
			case p != nil:
				outcome = "panic"
			case r.Context().Err() != nil:
				outcome = "client-cancelled"
			case !rec.wrote:
				outcome = "no-response-written"
			}
			rl.write(map[string]any{
				"ev": "req-end", "id": id, "route": r.URL.Path,
				"dur_ms": time.Since(start).Milliseconds(),
				"status": rec.status, "bytes": rec.written, "outcome": outcome,
			})
			if p != nil {
				panic(p)
			}
		}()
		next.ServeHTTP(rec, r)
	})
}
