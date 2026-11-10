package cache

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var errBoom = errors.New("upstream refused")

// age backdates an entry so a test can step past its TTL without sleeping.
func age(c *Cache, key string, by time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.entries[key]
	e.at = e.at.Add(-by)
	c.entries[key] = e
}

// waitFor polls cond for up to 2s; the background refresh lands asynchronously.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// TestDoServesStaleAndRefreshesOnceInBackground is the stale-while-revalidate
// contract: past the TTL, callers get the old value at once (they do not wait
// for the slow upstream), exactly one refresh runs no matter how many callers
// arrive meanwhile, and once it lands the new value is served. Old Do treated
// an expired entry as absent, so the first caller blocked on the fetch.
func TestDoServesStaleAndRefreshesOnceInBackground(t *testing.T) {
	c := New()
	const key = "dashboard_rest"
	c.Set(key, "old")
	age(c, key, TTL+time.Second)

	var fetches atomic.Int64
	release := make(chan struct{})
	fetch := func() (any, error) {
		fetches.Add(1)
		<-release
		return "new", nil
	}

	for i := range 5 {
		done := make(chan any, 1)
		go func() { v, _ := c.Do(key, fetch); done <- v }()
		select {
		case v := <-done:
			if v != "old" {
				t.Fatalf("caller %d got %v, want the stale value served at once", i, v)
			}
		case <-time.After(time.Second):
			t.Fatalf("caller %d waited for the upstream fetch instead of being served the stale value", i)
		}
	}
	close(release)
	waitFor(t, "the background refresh to land", func() bool {
		v, ok := c.Get(key)
		return ok && v == "new"
	})
	if n := fetches.Load(); n != 1 {
		t.Fatalf("want exactly 1 background refresh for 5 stale callers, got %d", n)
	}
}

// TestDoTooOldWaitsForFresh: past TTL+StaleFor the entry is not shown at all.
func TestDoTooOldWaitsForFresh(t *testing.T) {
	c := New()
	c.Set("k", "ancient")
	age(c, "k", TTL+StaleFor+time.Second)
	v, err := c.Do("k", func() (any, error) { return "fresh", nil })
	if err != nil || v != "fresh" {
		t.Fatalf("v=%v err=%v, want the caller to wait for a fresh fetch", v, err)
	}
}

// TestDoStaleRefreshFailureKeepsOldValue: a failed background refresh must not
// drop the entry (the next caller still gets the old value and retries).
func TestDoStaleRefreshFailureKeepsOldValue(t *testing.T) {
	c := New()
	c.Set("k", "old")
	age(c, "k", TTL+time.Second)
	var fetches atomic.Int64
	fail := func() (any, error) { fetches.Add(1); return nil, errBoom }
	if v, _ := c.Do("k", fail); v != "old" {
		t.Fatalf("got %v, want old", v)
	}
	waitFor(t, "the failed refresh to finish", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.inflight["k"] == nil && fetches.Load() == 1
	})
	if v, _ := c.Do("k", fail); v != "old" {
		t.Fatalf("after a failed refresh got %v, want the old value still served", v)
	}
}

// TestDoStaleRefreshPanicDoesNotCrash: the refresh runs in its own goroutine,
// where a panic would kill the process; it must be contained.
func TestDoStaleRefreshPanicDoesNotCrash(t *testing.T) {
	c := New()
	c.Set("k", "old")
	age(c, "k", TTL+time.Second)
	if v, _ := c.Do("k", func() (any, error) { panic("boom") }); v != "old" {
		t.Fatalf("got %v, want old", v)
	}
	waitFor(t, "the panicking refresh to release its flight", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.inflight["k"] == nil
	})
}

// TestDoStaleRefreshFencedByRotate: a refresh that started for the old tenant
// must not land after a switch, and the switch must also stop stale serving.
func TestDoStaleRefreshFencedByRotate(t *testing.T) {
	c := New()
	c.Set("k", "tenant-A")
	age(c, "k", TTL+time.Second)
	release := make(chan struct{})
	landed := make(chan struct{})
	_, _ = c.Do("k", func() (any, error) { <-release; defer close(landed); return "tenant-A-new", nil })
	c.Rotate()
	close(release)
	<-landed
	time.Sleep(20 * time.Millisecond)
	if v, ok := c.Get("k"); ok {
		t.Fatalf("a pre-switch refresh landed after Rotate: %v", v)
	}
}

// TestDoFreshNeverServesStale: the opt-out waits for the fetch.
func TestDoFreshNeverServesStale(t *testing.T) {
	c := New()
	c.Set("k", "old")
	age(c, "k", TTL+time.Second)
	v, _ := c.DoFresh("k", func() (any, error) { return "new", nil })
	if v != "new" {
		t.Fatalf("DoFresh returned %v, want new", v)
	}
}

// TestDoTTLExpiresOnItsOwnClock: a short-lived key is a miss after its own TTL
// even though the shared TTL has not passed, and is shared before it.
func TestDoTTLExpiresOnItsOwnClock(t *testing.T) {
	c := New()
	var fetches atomic.Int64
	fetch := func() (any, error) { return fetches.Add(1), nil }
	_, _ = c.DoTTL("tile|a", 30*time.Second, fetch)
	_, _ = c.DoTTL("tile|a", 30*time.Second, fetch)
	if n := fetches.Load(); n != 1 {
		t.Fatalf("within the TTL: %d fetches, want 1", n)
	}
	age(c, "tile|a", 31*time.Second)
	if _, ok := c.Get("tile|a"); ok {
		t.Fatal("Get served a 30s entry 31s after it was written")
	}
	_, _ = c.DoTTL("tile|a", 30*time.Second, fetch)
	if n := fetches.Load(); n != 2 {
		t.Fatalf("after the TTL: %d fetches, want 2", n)
	}
}

// TestInvalidatePrefixDropsOnlyThatPrefixAndFencesInFlight: a tenant write
// drops the tile entries, keeps the rest, and a tile read that was already in
// flight (it may have read the pre-write state) is not cached when it lands.
func TestInvalidatePrefixDropsOnlyThatPrefixAndFencesInFlight(t *testing.T) {
	c := New()
	c.Set("dashboard_rest", "agg")
	_, _ = c.DoTTL("tile|a", time.Minute, func() (any, error) { return "a", nil })
	gen := c.Gen()

	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = c.DoTTL("tile|b", time.Minute, func() (any, error) {
			close(entered)
			<-release
			return "pre-write", nil
		})
	}()
	<-entered
	c.InvalidatePrefix("tile|")
	close(release)
	<-done

	if _, ok := c.Get("tile|a"); ok {
		t.Fatal("tile|a survived InvalidatePrefix")
	}
	if v, ok := c.Get("tile|b"); ok {
		t.Fatalf("an in-flight pre-write read was cached after the invalidation: %v", v)
	}
	if v, ok := c.Get("dashboard_rest"); !ok || v != "agg" {
		t.Fatalf("an unrelated key was dropped: v=%v ok=%v", v, ok)
	}
	if c.Gen() != gen {
		t.Fatal("InvalidatePrefix moved the generation; that would reset the 403 entitlement memory")
	}
}

// TestOnceCollapsesConcurrentCallers: N concurrent callers share one run, and
// nothing is cached afterwards.
func TestOnceCollapsesConcurrentCallers(t *testing.T) {
	c := New()
	const n = 6
	var runs atomic.Int64
	release := make(chan struct{})
	entered := make(chan struct{}, n)
	var wg sync.WaitGroup
	got := make([]any, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			entered <- struct{}{}
			got[i] = c.Once("once|k", func() any { runs.Add(1); <-release; return "v" })
		}()
	}
	for range n {
		<-entered
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if r := runs.Load(); r != 1 {
		t.Fatalf("want 1 run for %d concurrent callers, got %d", n, r)
	}
	for i, v := range got {
		if v != "v" {
			t.Fatalf("caller %d got %v", i, v)
		}
	}
	c.Once("once|k", func() any { runs.Add(1); return "v" })
	if r := runs.Load(); r != 2 {
		t.Fatalf("Once cached its result: a later caller did not run fn (runs=%d)", r)
	}
}
