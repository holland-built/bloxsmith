package cache

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestSetGenDroppedWhenRotatedMidFetch models a /api/data-style fetch: the
// handler captures the generation BEFORE the upstream fetch, a tenant switch
// Rotate()s the cache while the fetch is in flight, and the fetch's SetGen must
// then be DROPPED so no prior-tenant rows land under the new tenant.
func TestSetGenDroppedWhenRotatedMidFetch(t *testing.T) {
	c := New()
	const key = "svc|ep|[]|false"

	fetchStarted := make(chan struct{})
	rotateDone := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		g := c.Gen() // captured before the (simulated) upstream fetch
		close(fetchStarted)
		<-rotateDone // upstream fetch is "in flight" until the switch lands
		c.SetGen(key, "old-tenant-rows", g)
	}()

	<-fetchStarted
	c.Rotate() // tenant switch mid-fetch
	close(rotateDone)
	wg.Wait()

	if v, ok := c.Get(key); ok {
		t.Fatalf("stale in-flight write survived Rotate: got %v", v)
	}

	// A fresh fetch under the new generation caches normally.
	g2 := c.Gen()
	c.SetGen(key, "new-tenant-rows", g2)
	if v, ok := c.Get(key); !ok || v != "new-tenant-rows" {
		t.Fatalf("post-rotate write dropped: v=%v ok=%v", v, ok)
	}
}

// TestSetUsesCurrentGen proves plain Set still works (stamped with the current
// generation) and that Rotate both bumps the generation and clears entries.
func TestSetUsesCurrentGen(t *testing.T) {
	c := New()
	g0 := c.Gen()
	c.Set("k", "v")
	if v, ok := c.Get("k"); !ok || v != "v" {
		t.Fatalf("Set should persist under current gen: v=%v ok=%v", v, ok)
	}
	c.Rotate()
	if c.Gen() == g0 {
		t.Fatal("Rotate did not bump the generation")
	}
	if _, ok := c.Get("k"); ok {
		t.Fatal("Rotate did not clear entries")
	}
}

// TestDoColdConcurrentCallersFetchOnce is the cold-start case that motivated
// single-flight: N callers ask for the same key while the cache is empty and the
// upstream fetch is slow. Exactly ONE upstream fetch must happen. Remove the
// inflight bookkeeping from Do and every caller runs its own fetch instead.
func TestDoColdConcurrentCallersFetchOnce(t *testing.T) {
	c := New()
	const key = "svc|ep|[]|false"
	const n = 8 // >= 3 so a single-flight-less Do cannot pass by luck

	var fetches atomic.Int64
	release := make(chan struct{})
	entered := make(chan struct{}, n)
	fetch := func() (any, error) {
		fetches.Add(1)
		<-release // hold the fetch open so every caller arrives while it is running
		return "rows", nil
	}

	got := make([]any, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			entered <- struct{}{}
			v, err := c.Do(key, fetch)
			if err != nil {
				t.Errorf("caller %d: unexpected error: %v", i, err)
			}
			got[i] = v
		}()
	}
	for range n {
		<-entered // all n goroutines have reached their Do call
	}
	time.Sleep(50 * time.Millisecond) // let them get inside Do before releasing
	close(release)
	wg.Wait()

	if f := fetches.Load(); f != 1 {
		t.Fatalf("cold single-flight: want exactly 1 upstream fetch for %d callers, got %d", n, f)
	}
	for i, v := range got {
		if v != "rows" {
			t.Fatalf("caller %d got %v, want the shared fetch result", i, v)
		}
	}
	if v, ok := c.Get(key); !ok || v != "rows" {
		t.Fatalf("successful fetch was not cached: v=%v ok=%v", v, ok)
	}
}

// TestDoFailureIsNotSharedAsSuccess: one caller's failure must reach every
// waiter as a failure, must not be cached, and must not stop the next caller
// from retrying and succeeding. A failed read and an empty read are different
// things and must stay distinguishable.
func TestDoFailureIsNotSharedAsSuccess(t *testing.T) {
	c := New()
	const key = "svc|ep|[]|false"
	const n = 4
	boom := errors.New("upstream refused")

	var fetches atomic.Int64
	release := make(chan struct{})
	entered := make(chan struct{}, n)
	failing := func() (any, error) {
		fetches.Add(1)
		<-release
		return nil, boom
	}

	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			entered <- struct{}{}
			v, err := c.Do(key, failing)
			if !errors.Is(err, boom) {
				t.Errorf("caller %d: want the shared error, got err=%v v=%v", i, err, v)
			}
			if v != nil {
				t.Errorf("caller %d: failure handed back a value: %v", i, v)
			}
		}()
	}
	for range n {
		<-entered
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	if f := fetches.Load(); f != 1 {
		t.Fatalf("want 1 upstream fetch for %d failing callers, got %d", n, f)
	}
	if v, ok := c.Get(key); ok {
		t.Fatalf("a failed fetch was cached as a success: %v", v)
	}
	// The flight is gone, so the next caller retries rather than inheriting the error.
	v, err := c.Do(key, func() (any, error) { return "rows", nil })
	if err != nil || v != "rows" {
		t.Fatalf("retry after failure: v=%v err=%v", v, err)
	}
}

// TestDoPanicWakesWaitersAndDoesNotDeadlock: if the fetcher panics, waiters must
// be released with an error (not left blocked forever), nothing may be cached,
// and the panic must still propagate out of the leader's Do so the HTTP layer's
// existing recover-to-500 keeps working.
func TestDoPanicWakesWaitersAndDoesNotDeadlock(t *testing.T) {
	c := New()
	const key = "svc|ep|[]|false"

	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	panicky := func() (any, error) {
		close(entered)
		<-release
		panic("fetcher exploded")
	}

	leaderPanicked := make(chan any, 1)
	go func() {
		defer func() { leaderPanicked <- recover() }()
		_, _ = c.Do(key, panicky)
	}()
	<-entered

	const waiters = 3
	waiterErrs := make(chan error, waiters)
	for range waiters {
		go func() {
			_, err := c.Do(key, panicky)
			waiterErrs <- err
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)

	select {
	case r := <-leaderPanicked:
		if r == nil {
			t.Fatal("fetcher panic was swallowed; the handler's recover-to-500 would never fire")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("leader never returned after the fetcher panicked")
	}
	for i := range waiters {
		select {
		case err := <-waiterErrs:
			if err == nil {
				t.Fatalf("waiter %d got a success from a panicking fetch", i)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("waiter %d deadlocked on a panicking fetch", i)
		}
	}
	if v, ok := c.Get(key); ok {
		t.Fatalf("a panicking fetch cached a value: %v", v)
	}
}

// TestDoServesFreshCacheWithoutFetching: a warm key must not reach upstream at all.
func TestDoServesFreshCacheWithoutFetching(t *testing.T) {
	c := New()
	c.Set("k", "warm")
	v, err := c.Do("k", func() (any, error) {
		t.Fatal("Do fetched despite a fresh cache entry")
		return nil, nil
	})
	if err != nil || v != "warm" {
		t.Fatalf("v=%v err=%v", v, err)
	}
}

// TestDoRotateMidFlightDropsTheWrite: a tenant switch while Do's fetch is in
// flight must not leave prior-tenant rows in the cache.
func TestDoRotateMidFlightDropsTheWrite(t *testing.T) {
	c := New()
	const key = "svc|ep|[]|false"
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = c.Do(key, func() (any, error) {
			close(entered)
			<-release
			return "old-tenant-rows", nil
		})
	}()
	<-entered
	c.Rotate()
	close(release)
	<-done
	if v, ok := c.Get(key); ok {
		t.Fatalf("prior-tenant rows survived a mid-flight Rotate: %v", v)
	}
}
