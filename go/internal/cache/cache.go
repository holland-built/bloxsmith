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

// Cache is the process-wide TTL store. Construct one in main and share it.
type Cache struct {
	mu      sync.Mutex
	entries map[string]entry
}

// New builds an empty cache.
func New() *Cache { return &Cache{entries: make(map[string]entry)} }

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
// first when at the cap and the key is new.
func (c *Cache) Set(key string, value any) {
	c.mu.Lock()
	defer c.mu.Unlock()
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
}
