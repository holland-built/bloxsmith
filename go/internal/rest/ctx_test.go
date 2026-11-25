package rest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// A read given a context stops when the context ends, and is not asked a
// second time: the Visibility Assessment runs under the AI loop's deadline,
// and a 35-second read plus a retry would outlast it.
func TestCtxReadsStopAtDeadlineAndDoNotRetry(t *testing.T) {
	recordSleeps(t)
	var calls int32
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)
	c := New(srv.URL, NewAuth("key", nil))

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, status, err := c.GetExCtx(ctx, "/x", nil)
	if err == nil || status != 0 {
		t.Fatalf("GetExCtx: status=%d err=%v, want a failed read", status, err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("GetExCtx took %v, want it to stop at the 100ms deadline", time.Since(start))
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("GetExCtx sent %d requests, want 1 (no retry after the deadline)", n)
	}

	atomic.StoreInt32(&calls, 0)
	ctx2, cancel2 := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel2()
	if _, _, err := c.GetPageStrictCtx(ctx2, "/x", nil); err == nil {
		t.Fatal("GetPageStrictCtx: want an error after the deadline")
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("GetPageStrictCtx sent %d requests, want 1", n)
	}
}
