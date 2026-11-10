// Package cache ports Bloxsmith's server-side TTL cache from server.py
// (_cache_key/_cache_get/_cache_set 193-210, cache_invalidate 211). One shared
// Cache backs /api/data, the hub fetchers, and the MCP wrappers, so the Go
// binary keeps data hot the same way the Python warm-loop does (5-min TTL,
// 256-entry cap, oldest-first eviction).
package cache

import (
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"
)

// TTL and Max mirror CACHE_TTL (300s) and CACHE_MAX (256) from server.py:190-191.
const (
	TTL = 300 * time.Second
	Max = 256
)

// StaleFor is how long past its TTL an entry may still be handed out by Do
// while a background refresh replaces it (stale-while-revalidate). Past
// TTL+StaleFor the entry is too old to show and the caller waits for a fresh
// fetch, exactly as before stale serving existed. So an entry Do returns is
// never older than TTL+StaleFor (10 minutes with the defaults).
const StaleFor = TTL

type entry struct {
	at    time.Time
	ttl   time.Duration // 0 means TTL; set by DoTTL for short-lived entries
	value any
}

// life is how long the entry counts as fresh.
func (e entry) life() time.Duration {
	if e.ttl > 0 {
		return e.ttl
	}
	return TTL
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
	if !ok || time.Since(e.at) >= e.life() {
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
	c.store(key, value, 0)
}

// store writes one entry, evicting the oldest entries first when at the cap
// and the key is new. The caller holds c.mu and has already checked the
// generation.
func (c *Cache) store(key string, value any, ttl time.Duration) {
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
	c.entries[key] = entry{at: time.Now(), ttl: ttl, value: value}
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

// InvalidatePrefix drops every entry whose key starts with prefix, and detaches
// the in-flight fetches for those keys so their results are not cached when
// they land (they may have read the tenant before the change that caused this
// call). Other keys, the generation, and anything keyed to it (the 403
// entitlement memory in package dashboard) are untouched. Used after a tenant
// write to drop the short-lived tile reads, which would otherwise show the
// pre-write state for up to their TTL.
func (c *Cache) InvalidatePrefix(prefix string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.entries {
		if strings.HasPrefix(k, prefix) {
			delete(c.entries, k)
		}
	}
	for k := range c.inflight {
		if strings.HasPrefix(k, prefix) {
			delete(c.inflight, k)
		}
	}
}

// Do is Get-else-fetch with single-flight and stale-while-revalidate. It
// returns a fresh cached value if there is one. If the entry is past its TTL
// but within StaleFor of it, Do returns the old value at once and starts ONE
// background refresh for the key (a second caller in that window gets the old
// value too and starts nothing). Otherwise exactly ONE caller per key runs
// fetch and every other caller that arrives while that fetch is in flight
// waits for it and shares the result. Without single-flight, a cold cache plus
// N concurrent callers (two browser tabs, a poll landing on top of a first
// load) means N full upstream fetches — measured cold /api/data cost is
// 17-26s, so the duplicates make the cold window worse for everyone.
//
// Because the refresh can run after the caller has returned, fetch must not
// depend on the calling request's context. A caller whose fetch does, or which
// must never be handed an old value, uses DoFresh.
//
// Failure is NOT shared as success and is NOT cached: on a non-nil error the
// value is left out of the cache and every waiter gets the same error, so the
// next caller retries. A failed background refresh leaves the old entry in
// place, so it keeps being served until it is StaleFor past its TTL. Callers
// must keep rendering a failed read as "error", never as "empty".
//
// The write is fenced by the generation captured before the fetch (see SetGen),
// so a tenant switch mid-fetch still drops the result.
func (c *Cache) Do(key string, fetch func() (any, error)) (any, error) {
	return c.do(key, TTL, true, fetch)
}

// DoFresh is Do without stale serving: an entry past its TTL is a miss and the
// caller waits for the fetch. For fetches bound to a request context, and for
// callers that must never be handed an old value.
func (c *Cache) DoFresh(key string, fetch func() (any, error)) (any, error) {
	return c.do(key, TTL, false, fetch)
}

// DoTTL is DoFresh with its own TTL for this key instead of the shared one.
func (c *Cache) DoTTL(key string, ttl time.Duration, fetch func() (any, error)) (any, error) {
	return c.do(key, ttl, false, fetch)
}

func (c *Cache) do(key string, ttl time.Duration, stale bool, fetch func() (any, error)) (any, error) {
	c.mu.Lock()
	e, have := c.entries[key]
	age := time.Since(e.at)
	if have && age < ttl {
		c.mu.Unlock()
		return e.value, nil
	}
	serveStale := stale && have && age < ttl+StaleFor
	if f, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		if serveStale {
			return e.value, nil // a refresh is already running; do not wait for it
		}
		f.wg.Wait()
		return f.val, f.err
	}
	f := &flight{}
	f.wg.Add(1)
	c.inflight[key] = f
	gen := c.gen
	c.mu.Unlock()

	if serveStale {
		go c.refresh(key, ttl, gen, f, fetch)
		return e.value, nil
	}

	// A panicking fetcher must not strand the waiters on wg.Wait() forever. Wake
	// them with an error, then re-panic so the leader's own request still hits the
	// handler's existing recover-to-500 guard (server/data.go recover500) — this
	// changes nothing about how a panic is reported, only who is left hanging.
	defer func() {
		if r := recover(); r != nil {
			f.val, f.err = nil, fmt.Errorf("cache: fetch for %q panicked: %v", key, r)
			c.land(key, ttl, gen, f)
			panic(r)
		}
	}()

	f.val, f.err = fetch()
	c.land(key, ttl, gen, f)
	return f.val, f.err
}

// refresh is the background half of stale-while-revalidate. It runs in its own
// goroutine, where no handler's recover can see it, so a panic is logged and
// swallowed instead of taking the process down; the stale entry stays.
func (c *Cache) refresh(key string, ttl time.Duration, gen uint64, f *flight, fetch func() (any, error)) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[cache] background refresh of %q panicked: %v", key, r)
			f.val, f.err = nil, fmt.Errorf("cache: refresh for %q panicked: %v", key, r)
			c.land(key, ttl, gen, f)
		}
	}()
	f.val, f.err = fetch()
	c.land(key, ttl, gen, f)
}

// land caches a finished flight's value (if it succeeded) and releases its
// waiters. The value is cached only while this flight is still the registered
// one for its key and the generation has not moved: Rotate, Invalidate and
// InvalidatePrefix all detach in-flight fetches, and a result that started
// before any of them must not be cached after it. The identity check also stops
// this flight from deleting a newer one that took its place.
func (c *Cache) land(key string, ttl time.Duration, gen uint64, f *flight) {
	c.mu.Lock()
	if c.inflight[key] == f {
		if f.err == nil && gen == c.gen {
			c.store(key, f.val, ttl)
		}
		delete(c.inflight, key)
	}
	c.mu.Unlock()
	f.wg.Done()
}

// Once runs fn with single-flight but caches nothing: concurrent callers for
// the same key share one run of fn and its result, and the next caller after
// it finishes runs fn again. It is for fetchers that keep their own Get/SetGen
// caching (and their own rules about what is cached); wrapping them in Once
// stops N concurrent cold callers from making N upstream fetches. Keys share
// the in-flight table with Do, so use a prefix no Do key uses.
//
// A panic in fn wakes the waiters with nil and is re-raised in the caller that
// ran fn, as in Do. Rotate and Invalidate detach a running fn, so a caller
// arriving after a tenant switch starts its own run.
func (c *Cache) Once(key string, fn func() any) any {
	if c == nil {
		return fn()
	}
	c.mu.Lock()
	if f, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		f.wg.Wait()
		return f.val
	}
	f := &flight{}
	f.wg.Add(1)
	c.inflight[key] = f
	c.mu.Unlock()
	defer func() {
		if r := recover(); r != nil {
			f.val = nil
			c.release(key, f)
			panic(r)
		}
	}()
	f.val = fn()
	c.release(key, f)
	return f.val
}

// release ends a Once flight without caching anything.
func (c *Cache) release(key string, f *flight) {
	c.mu.Lock()
	if c.inflight[key] == f {
		delete(c.inflight, key)
	}
	c.mu.Unlock()
	f.wg.Done()
}
