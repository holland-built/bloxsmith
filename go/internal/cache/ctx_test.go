package cache

import (
	"context"
	"errors"
	"testing"
	"time"
)

// A caller joining another caller's fetch stops waiting when its own context
// ends, so a slow shared read can't hold it past its deadline.
func TestDoFreshCtx_WaiterStopsAtDeadline(t *testing.T) {
	c := New()
	release := make(chan struct{})
	started := make(chan struct{})
	go func() {
		_, _ = c.DoFresh("k", func() (any, error) {
			close(started)
			<-release
			return "v", nil
		})
	}()
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	begin := time.Now()
	_, err := c.DoFreshCtx(ctx, "k", func() (any, error) { t.Error("a waiter must not fetch"); return nil, nil })
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the deadline", err)
	}
	if d := time.Since(begin); d > time.Second {
		t.Fatalf("waited %v past a 50ms deadline", d)
	}
	close(release)
	// The leader still lands its value for later callers.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if v, ok := c.Get("k"); ok && v == "v" {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the leader's value was not cached")
}
