package sse_test

import (
	"bytes"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"bloxsmith/internal/sse"
)

// callLog records the order Start touches the ResponseWriter, so tests can
// pin "cors runs before anything is written" without guessing at timing.
type callLog struct {
	calls []string
}

func (l *callLog) record(s string) { l.calls = append(l.calls, s) }

// flakyWriter is a full http.ResponseWriter + http.Flusher whose Write calls
// can be made to fail starting at a chosen call index, to deterministically
// simulate a client that has gone away mid-stream — no reliance on real
// socket timing.
type flakyWriter struct {
	header      http.Header
	buf         bytes.Buffer
	log         *callLog
	failAfter   int // -1 = never fail; N = the Nth Write call (0-based) and onward fail
	writeCalls  int
	wroteHeader bool
	status      int
	flushCount  int
}

func newFlakyWriter(log *callLog, failAfter int) *flakyWriter {
	return &flakyWriter{header: http.Header{}, log: log, failAfter: failAfter}
}

func (f *flakyWriter) Header() http.Header {
	if f.log != nil {
		f.log.record("Header")
	}
	return f.header
}

func (f *flakyWriter) WriteHeader(code int) {
	f.wroteHeader = true
	f.status = code
	if f.log != nil {
		f.log.record("WriteHeader")
	}
}

func (f *flakyWriter) Write(p []byte) (int, error) {
	idx := f.writeCalls
	f.writeCalls++
	if f.log != nil {
		f.log.record("Write")
	}
	if f.failAfter >= 0 && idx >= f.failAfter {
		return 0, errors.New("write: broken pipe")
	}
	return f.buf.Write(p)
}

func (f *flakyWriter) Flush() {
	f.flushCount++
	if f.log != nil {
		f.log.record("Flush")
	}
}

// noFlushWriter implements http.ResponseWriter but deliberately NOT
// http.Flusher, the exact condition sse.Start checks for before it will
// stream at all.
type noFlushWriter struct {
	header      http.Header
	buf         bytes.Buffer
	wroteHeader bool
}

func newNoFlushWriter() *noFlushWriter { return &noFlushWriter{header: http.Header{}} }

func (w *noFlushWriter) Header() http.Header         { return w.header }
func (w *noFlushWriter) WriteHeader(code int)        { w.wroteHeader = true }
func (w *noFlushWriter) Write(p []byte) (int, error) { return w.buf.Write(p) }

// --- 1. Wire format and headers ---------------------------------------

func TestStart_SetsExactHeaders(t *testing.T) {
	w := newFlakyWriter(nil, -1)
	corsCalled := false
	emit, ok := sse.Start(w, func() { corsCalled = true })
	if !ok {
		t.Fatalf("Start returned ok=false for a writer that implements http.Flusher")
	}
	if emit == nil {
		t.Fatalf("Start returned a nil Emit alongside ok=true")
	}
	if !corsCalled {
		t.Fatalf("cors was never called")
	}

	if got := w.header.Get("Content-Type"); got != "text/event-stream" {
		t.Errorf("Content-Type = %q, want %q", got, "text/event-stream")
	}
	if got := w.header.Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q, want %q", got, "no-cache")
	}
	if got := w.header.Get("X-Accel-Buffering"); got != "no" {
		t.Errorf("X-Accel-Buffering = %q, want %q", got, "no")
	}
	// Pin what's actually there, not what would be nice: sse.go never sets a
	// Connection header itself. If that changes, this test should be updated
	// deliberately, not silently pass either way.
	if got := w.header.Get("Connection"); got != "" {
		t.Errorf("Connection header = %q, but sse.Start does not set one — pin the new behavior deliberately", got)
	}

	if !w.wroteHeader || w.status != http.StatusOK {
		t.Errorf("WriteHeader(200) not observed: wrote=%v status=%d", w.wroteHeader, w.status)
	}
	if w.flushCount != 1 {
		t.Errorf("Start should flush the headers once before returning; flushCount=%d", w.flushCount)
	}
}

func TestStart_EmitWireFormatExactBytes(t *testing.T) {
	w := newFlakyWriter(nil, -1)
	emit, ok := sse.Start(w, nil)
	if !ok {
		t.Fatalf("Start returned ok=false")
	}
	w.buf.Reset() // isolate the emitted frame from Start's own header flush
	preFlush := w.flushCount

	emit(map[string]any{"step": "hello"})

	want := "data: {\"step\":\"hello\"}\n\n"
	if got := w.buf.String(); got != want {
		t.Errorf("frame = %q, want %q", got, want)
	}
	if w.flushCount != preFlush+1 {
		t.Errorf("emit must flush exactly once after writing; flushCount went from %d to %d", preFlush, w.flushCount)
	}
}

// --- 2. cors is called, and called before anything is written ----------

func TestStart_CorsCalledBeforeAnyWrite(t *testing.T) {
	log := &callLog{}
	w := newFlakyWriter(log, -1)
	_, ok := sse.Start(w, func() { log.record("cors") })
	if !ok {
		t.Fatalf("Start returned ok=false")
	}

	corsIdx, writeIdx, writeHeaderIdx := -1, -1, -1
	for i, c := range log.calls {
		switch c {
		case "cors":
			if corsIdx == -1 {
				corsIdx = i
			}
		case "Write":
			if writeIdx == -1 {
				writeIdx = i
			}
		case "WriteHeader":
			if writeHeaderIdx == -1 {
				writeHeaderIdx = i
			}
		}
	}
	if corsIdx == -1 {
		t.Fatalf("cors was never called; log=%v", log.calls)
	}
	if writeIdx != -1 && corsIdx > writeIdx {
		t.Errorf("cors ran after a body Write; log=%v", log.calls)
	}
	if writeHeaderIdx != -1 && corsIdx > writeHeaderIdx {
		t.Errorf("cors ran after WriteHeader; log=%v", log.calls)
	}
}

func TestStart_NilCorsDoesNotPanic(t *testing.T) {
	w := newFlakyWriter(nil, -1)
	if _, ok := sse.Start(w, nil); !ok {
		t.Fatalf("Start returned ok=false")
	}
}

// --- 3. The bool return: true/false branches ----------------------------

func TestStart_NotFlusher_ReturnsFalseAndWritesNothing(t *testing.T) {
	w := newNoFlushWriter()
	emit, ok := sse.Start(w, func() { t.Errorf("cors must not be called when streaming cannot proceed") })
	if ok {
		t.Fatalf("Start returned ok=true for a ResponseWriter that is not an http.Flusher")
	}
	if emit != nil {
		t.Errorf("Start returned a non-nil Emit alongside ok=false")
	}
	if w.wroteHeader {
		t.Errorf("Start must not call WriteHeader when it cannot stream")
	}
	if w.buf.Len() != 0 {
		t.Errorf("Start must not write any body when it cannot stream; wrote %q", w.buf.String())
	}
	if ct := w.header.Get("Content-Type"); ct != "" {
		t.Errorf("Start must not set headers when it cannot stream; Content-Type=%q", ct)
	}
}

func TestStart_IsFlusher_ReturnsTrue(t *testing.T) {
	w := newFlakyWriter(nil, -1)
	_, ok := sse.Start(w, nil)
	if !ok {
		t.Fatalf("Start returned ok=false for a writer that implements http.Flusher")
	}
}

// --- 4. Multiple emits produce multiple well-formed frames in order -----

func TestEmit_MultipleFramesInOrder(t *testing.T) {
	w := newFlakyWriter(nil, -1)
	emit, ok := sse.Start(w, nil)
	if !ok {
		t.Fatalf("Start returned ok=false")
	}
	w.buf.Reset()
	preFlush := w.flushCount

	emit(map[string]any{"step": "one"})
	emit(map[string]any{"step": "two"})
	emit(map[string]any{"done": true})

	want := "data: {\"step\":\"one\"}\n\n" +
		"data: {\"step\":\"two\"}\n\n" +
		"data: {\"done\":true}\n\n"
	if got := w.buf.String(); got != want {
		t.Errorf("frames = %q, want %q", got, want)
	}
	if w.flushCount != preFlush+3 {
		t.Errorf("expected one flush per emit; flushCount went from %d to %d", preFlush, w.flushCount)
	}
}

// --- 5. A payload that cannot be JSON-encoded ---------------------------

// TestEmit_UnencodableJSON_WritesVisiblePlaceholderFrame pins the fixed
// behavior: when the payload fails json.Marshal, Emit no longer swallows the
// frame. It writes a well-formed `data: {...}\n\n` frame built from plain
// strings (so building the placeholder itself cannot hit the same failure)
// that names the failure and carries the marshal error text, then keeps
// flushing normally. In a teardown stream, a step that genuinely happened
// must never vanish from what the operator sees — a visible "this step could
// not be encoded" beats a silently healthy-looking gap.
func TestEmit_UnencodableJSON_WritesVisiblePlaceholderFrame(t *testing.T) {
	t.Run("channel value", func(t *testing.T) {
		w := newFlakyWriter(nil, -1)
		emit, ok := sse.Start(w, nil)
		if !ok {
			t.Fatalf("Start returned ok=false")
		}
		w.buf.Reset()
		preFlush := w.flushCount

		emit(map[string]any{"step": "ok", "bad": make(chan int)})

		got := w.buf.String()
		if !strings.HasPrefix(got, "data: ") || !strings.HasSuffix(got, "\n\n") {
			t.Fatalf("expected a well-formed data frame, got %q", got)
		}
		if !strings.Contains(got, "emit_marshal_failed") {
			t.Errorf("frame does not name the failure: %q", got)
		}
		if !strings.Contains(got, "unsupported type: chan int") {
			t.Errorf("frame does not include the marshal error text: %q", got)
		}
		if w.flushCount != preFlush+1 {
			t.Errorf("the placeholder frame should still flush; flushCount went from %d to %d", preFlush, w.flushCount)
		}
	})

	t.Run("NaN float", func(t *testing.T) {
		w := newFlakyWriter(nil, -1)
		emit, ok := sse.Start(w, nil)
		if !ok {
			t.Fatalf("Start returned ok=false")
		}
		w.buf.Reset()
		preFlush := w.flushCount

		emit(map[string]any{"value": math.NaN()})

		got := w.buf.String()
		if !strings.HasPrefix(got, "data: ") || !strings.HasSuffix(got, "\n\n") {
			t.Fatalf("expected a well-formed data frame, got %q", got)
		}
		if !strings.Contains(got, "emit_marshal_failed") {
			t.Errorf("frame does not name the failure: %q", got)
		}
		if !strings.Contains(got, "unsupported value: NaN") {
			t.Errorf("frame does not include the marshal error text: %q", got)
		}
		if w.flushCount != preFlush+1 {
			t.Errorf("the placeholder frame should still flush; flushCount went from %d to %d", preFlush, w.flushCount)
		}
	})

	t.Run("stream continues working after a placeholder frame", func(t *testing.T) {
		w := newFlakyWriter(nil, -1)
		emit, ok := sse.Start(w, nil)
		if !ok {
			t.Fatalf("Start returned ok=false")
		}
		w.buf.Reset()

		emit(map[string]any{"bad": make(chan int)})
		emit(map[string]any{"step": "still alive"})

		got := w.buf.String()
		if !strings.Contains(got, "emit_marshal_failed") {
			t.Errorf("expected the placeholder frame to have been written first: %q", got)
		}
		want := "data: {\"step\":\"still alive\"}\n\n"
		if !strings.HasSuffix(got, want) {
			t.Errorf("expected the stream to keep working after the placeholder frame; got %q, want suffix %q", got, want)
		}
	})
}

// --- 6. A disconnected client -------------------------------------------

// TestEmit_WriteFailure_NoPanic pins the exact behavior the file's own
// comment describes ("nothing to recover mid-stream"): once the first Write
// of a frame fails, Emit returns immediately without panicking and without
// attempting the remaining writes or a flush.
func TestEmit_WriteFailure_NoPanic(t *testing.T) {
	w := newFlakyWriter(nil, 0) // every Write after Start fails
	emit, ok := sse.Start(w, nil)
	if !ok {
		t.Fatalf("Start returned ok=false")
	}
	preFlush := w.flushCount
	w.buf.Reset()

	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("Emit panicked on a write to a disconnected client: %v", r)
			}
		}()
		emit(map[string]any{"step": "into the void"})
	}()

	if w.buf.Len() != 0 {
		t.Errorf("no bytes should have been buffered when the very first write fails; got %q", w.buf.String())
	}
	if w.flushCount != preFlush {
		t.Errorf("Emit must not flush after a failed write; flushCount grew from %d to %d", preFlush, w.flushCount)
	}
}

// TestEmit_PartialWriteFailure_LeavesNoTrailingFrame pins the more subtle
// case: the "data: " prefix write succeeds but the JSON payload write then
// fails. Emit bails out immediately — it does not attempt to still write the
// blank-line terminator. Behaviorally this means a half-written "data: " can
// land on the wire before the connection fully dies; sse.go accepts that
// tradeoff rather than buffering a whole frame before writing any of it.
func TestEmit_PartialWriteFailure_LeavesNoTrailingFrame(t *testing.T) {
	w := newFlakyWriter(nil, 1) // 1st Write (the "data: " prefix) succeeds, 2nd+ fail
	emit, ok := sse.Start(w, nil)
	if !ok {
		t.Fatalf("Start returned ok=false")
	}
	preFlush := w.flushCount
	w.buf.Reset()
	w.writeCalls = 0 // re-baseline: only count writes emit itself makes

	emit(map[string]any{"step": "half sent"})

	if got := w.buf.String(); got != "data: " {
		t.Errorf("expected only the prefix to have landed before the failure, got %q", got)
	}
	if strings.Contains(w.buf.String(), "\n\n") {
		t.Errorf("the blank-line terminator must not appear after a mid-frame write failure; got %q", w.buf.String())
	}
	if w.flushCount != preFlush {
		t.Errorf("a failed write must not be followed by a flush; flushCount grew from %d to %d", preFlush, w.flushCount)
	}
}

// TestEmit_RealDisconnectedClient_NoPanic exercises the scenario end to end
// over a real connection rather than a synthetic writer: a client that has
// closed its side, then a server-side emit after that close. The important
// assertion is simply that the handler goroutine survives to send a response
// at all — a panic here would be the exact process-killing bug the sse
// package's callers were patched for at the handler level.
func TestEmit_RealDisconnectedClient_NoPanic(t *testing.T) {
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		emit, ok := sse.Start(w, nil)
		if !ok {
			t.Errorf("Start returned ok=false on a real http.Server response writer")
			return
		}
		emit(map[string]any{"step": "before close"})

		// Give the client time to close its side, then keep emitting. A real
		// TCP peer close is not perfectly deterministic about when the
		// server's Write starts failing, so this test only asserts the
		// no-panic property, not the byte-exact drop behavior (that's
		// covered deterministically by TestEmit_WriteFailure_NoPanic above).
		time.Sleep(150 * time.Millisecond)

		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("Emit panicked after the client disconnected: %v", r)
				}
			}()
			for i := 0; i < 5; i++ {
				emit(map[string]any{"step": "after close", "n": i})
			}
		}()
	}))
	defer srv.Close()

	req, err := http.NewRequest("GET", srv.URL, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	// Close the client side immediately, before the handler's post-sleep
	// emits, so the server is writing to a genuinely gone connection.
	resp.Body.Close()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("handler never returned — did Emit hang or the server panic outside recovery?")
	}
}

// --- 7. Concurrency ------------------------------------------------------
//
// Emit is NOT safe for concurrent use — it holds no lock, and every real
// caller (internal/server/provision.go's five stream handlers, backed by
// internal/provision's sequential step emitters) only ever calls Emit
// straight-line from the single request goroutine. There is no `go func`
// anywhere in internal/provision or internal/server/provision.go that
// invokes an Emit/emit closure. This test does not claim a concurrency
// guarantee sse.go doesn't provide; it only pins the single-goroutine usage
// that matches production and runs it under -race as a regression check
// against that usage ever changing without deliberately revisiting this
// package.
func TestEmit_SingleGoroutineUsage_RaceClean(t *testing.T) {
	w := newFlakyWriter(nil, -1)
	emit, ok := sse.Start(w, nil)
	if !ok {
		t.Fatalf("Start returned ok=false")
	}
	for i := 0; i < 50; i++ {
		emit(map[string]any{"step": i})
	}
}
