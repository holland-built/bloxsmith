package cache

import (
	"sync"
	"testing"
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
