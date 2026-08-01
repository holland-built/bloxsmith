// Package cache ports Bloxsmith's server-side TTL cache from server.py
// (_cache_key/_cache_get/_cache_set 193-210, cache_invalidate 211). One shared
// Cache backs /api/data, the hub fetchers, and the MCP wrappers, so the Go
// binary keeps data hot the same way the Python warm-loop does (5-min TTL,
// 256-entry cap, oldest-first eviction).
package cache

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

// TTL and Max mirror CACHE_TTL (300s) and CACHE_MAX (256) from server.py:190-191.
const (
	TTL = 300 * time.Second
	Max = 256
)

type entry struct {
	at    time.Time
	value any
}

// flight is one upstream fetch that is currently running. Late callers for the
// same key attach to it and block on wg instead of starting a second fetch.
// val/err are written by the leader before wg.Done(), so a waiter that returns
// from wg.Wait() reads them safely (WaitGroup establishes happens-before).
type flight struct {
	wg  sync.WaitGroup
	val any
	err error
}

// Cache is the process-wide TTL store. Construct one in main and share it.
type Cache struct {
	mu       sync.Mutex
	entries  map[string]entry
	inflight map[string]*flight // single-flight: one upstream fetch per key
	gen      uint64             // monotonic epoch; bumped by Rotate to fence in-flight writes
}

// New builds an empty cache.
func New() *Cache {
	return &Cache{entries: make(map[string]entry), inflight: make(map[string]*flight)}
}

// Gen returns the current cache generation (epoch). A Get-miss→fetch→Set path
// captures this BEFORE the upstream fetch and passes it back to SetGen so a
// Rotate() during the fetch drops the now-stale, wrong-tenant result.
func (c *Cache) Gen() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gen
}

// Rotate bumps the generation AND clears every entry in one atomic step. It is
// the tenant-switch primitive: any in-flight fetch that began under the old gen
// will have its SetGen dropped, and all previously cached rows (belonging to the
// prior tenant) are gone. Combines bumpGen()+Invalidate().
func (c *Cache) Rotate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen++
	c.entries = make(map[string]entry)
	// Abandon in-flight fetches too: they were started for the PRIOR tenant, so a
	// caller arriving after the switch must not attach to one and be handed the
	// old tenant's rows. Callers already attached still receive that fetch's
	// result (unchanged from the pre-single-flight behaviour, where an in-flight
	// request likewise returned its own already-started fetch), but its SetGen is
	// dropped by the generation fence so nothing old-tenant is cached.
	c.inflight = make(map[string]*flight)
}

// Key is _cache_key (server.py:193): "service|endpoint|<sorted params>|fetchAll".
// Params are rendered as Python renders str(sorted(params.items())) closely
// enough for a stable, collision-free key — exact byte-parity is irrelevant
// because keys never cross the wire.
func Key(service, endpoint string, params map[string]string, fetchAll bool) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := "["
	for i, k := range keys {
		if i > 0 {
			pairs += ", "
		}
		pairs += fmt.Sprintf("('%s', '%s')", k, params[k])
	}
	pairs += "]"
	return fmt.Sprintf("%s|%s|%s|%v", service, endpoint, pairs, fetchAll)
}

// Get is _cache_get (server.py:196): returns the value if present and younger
// than TTL, else (nil, false).
func (c *Cache) Get(key string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || time.Since(e.at) >= TTL {
		return nil, false
	}
	return e.value, true
}

// Set is _cache_set (server.py:201): stores value, evicting the oldest entries
// first when at the cap and the key is new. It stamps the write with the current
// generation (never stale by construction).
func (c *Cache) Set(key string, value any) {
	c.mu.Lock()
	gen := c.gen
	c.mu.Unlock()
	c.SetGen(key, value, gen)
}

// SetGen is Set fenced by a generation token: if gen no longer matches the
// current cache generation, the write is DROPPED (a Rotate happened after the
// caller captured gen — the value belongs to a prior tenant). Otherwise it
// behaves exactly like Set (oldest-first eviction at the cap).
func (c *Cache) SetGen(key string, value any, gen uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if gen != c.gen {
		return // stale in-flight write from before a Rotate — drop it
	}
	if _, exists := c.entries[key]; !exists && len(c.entries) >= Max {
		type kt struct {
			k  string
			at time.Time
		}
		all := make([]kt, 0, len(c.entries))
		for k, e := range c.entries {
			all = append(all, kt{k, e.at})
		}
		sort.Slice(all, func(i, j int) bool { return all[i].at.Before(all[j].at) })
		for i := 0; i <= len(c.entries)-Max; i++ {
			delete(c.entries, all[i].k)
		}
	}
	c.entries[key] = entry{at: time.Now(), value: value}
}

// Invalidate is cache_invalidate (server.py:211): drop everything (used on an
// account switch so cached rows keyed to the old tenant are cleared).
func (c *Cache) Invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = make(map[string]entry)
	// Detach in-flight fetches as well, so /api/cache-bust keeps its meaning: a
	// caller arriving after the bust starts a genuinely fresh fetch instead of
	// attaching to one that began before it.
	c.inflight = make(map[string]*flight)
}

// Do is Get-else-fetch with single-flight. It returns a fresh cached value if
// there is one; otherwise exactly ONE caller per key runs fetch and every other
// caller that arrives while that fetch is in flight waits for it and shares the
// result. Without this, a cold cache plus N concurrent callers (two browser
// tabs, a poll landing on top of a first load) means N full upstream fetches —
// measured cold /api/data cost is 17-26s, so the duplicates make the cold
// window worse for everyone.
//
// Failure is NOT shared as success and is NOT cached: on a non-nil error the
// value is left out of the cache and every waiter gets the same error, so the
// next caller retries. Callers must keep rendering a failed read as "error",
// never as "empty".
//
// The write is fenced by the generation captured before the fetch (see SetGen),
// so a tenant switch mid-fetch still drops the result.
func (c *Cache) Do(key string, fetch func() (any, error)) (any, error) {
	c.mu.Lock()
	if e, ok := c.entries[key]; ok && time.Since(e.at) < TTL {
		v := e.value
		c.mu.Unlock()
		return v, nil
	}
	if f, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		f.wg.Wait()
		return f.val, f.err
	}
	f := &flight{}
	f.wg.Add(1)
	c.inflight[key] = f
	gen := c.gen
	c.mu.Unlock()

	// A panicking fetcher must not strand the waiters on wg.Wait() forever. Wake
	// them with an error, then re-panic so the leader's own request still hits the
	// handler's existing recover-to-500 guard (server/data.go recover500) — this
	// changes nothing about how a panic is reported, only who is left hanging.
	defer func() {
		if r := recover(); r != nil {
			f.val, f.err = nil, fmt.Errorf("cache: fetch for %q panicked: %v", key, r)
			c.land(key, f)
			panic(r)
		}
	}()

	f.val, f.err = fetch()
	if f.err == nil {
		c.SetGen(key, f.val, gen)
	}
	c.land(key, f)
	return f.val, f.err
}

// land removes a finished flight and releases its waiters. The identity check
// matters: Rotate/Invalidate may have already replaced the map, and this flight
// must not delete a newer one that took its place.
func (c *Cache) land(key string, f *flight) {
	c.mu.Lock()
	if c.inflight[key] == f {
		delete(c.inflight, key)
	}
	c.mu.Unlock()
	f.wg.Done()
}
