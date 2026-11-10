package dashboard

import (
	"encoding/json"
	"errors"
	"time"
)

// TileCachePrefix starts the cache key of every short-lived read cached by
// CachedRead. A tenant write drops all of them at once with
// Cache.InvalidatePrefix(TileCachePrefix) (server/writelock.go).
const TileCachePrefix = "tile|"

// TileTTL is how long CachedRead keeps a read. The pages poll these routes
// every 30 seconds, so one fetch serves every open tab and every user on the
// same tenant for one poll, and a tab switch or remount inside that window
// costs no upstream call.
const TileTTL = 30 * time.Second

// CachedRead serves route's result from the shared cache for TileTTL, keyed by
// the tenant this request is pinned to and the route, so concurrent callers
// share one upstream fetch (single-flight) and a cached read is never handed
// to another tenant. A result that reports a failure ("status":"error" or
// "availability":"error") is returned but not cached, so the next poll asks
// again rather than showing the failure for the whole TTL. That also keeps the
// attack-surface tiles' one-hour 403 memory (entitlement.go) the thing that
// answers a refused feed: it answers locally, without an upstream call.
//
// route must already carry any query parameters the read depends on.
func (s *Service) CachedRead(route string, fn func() map[string]any) map[string]any {
	if s == nil || s.Cache == nil {
		return fn()
	}
	key := TileCachePrefix + s.Rest.TenantTag() + "|" + route
	v, _ := s.Cache.DoTTL(key, TileTTL, func() (any, error) {
		res := fn()
		if res["status"] == "error" || res["availability"] == "error" {
			return res, errReadFailed
		}
		return res, nil
	})
	if out, ok := v.(map[string]any); ok {
		return out
	}
	// Only a fetch that panicked leaves no value; the caller that ran it has
	// already re-panicked into its handler's recover. A waiter asks again.
	return fn()
}

// errReadFailed tells the cache "do not keep this" for a read whose body
// reports a failure; the body itself still goes back to the caller.
var errReadFailed = errors.New("read reported a failure")

// shared runs fn once for all concurrent callers asking for the same key on the
// same tenant, and hands each of them that one result. It caches nothing: fn
// keeps its own Get/SetGen caching and its own rules about what is cached. It
// closes the gap a Get-miss-then-fetch leaves open, where two cold callers
// (two tabs, two users) each went upstream.
func shared[T any](s *Service, key string, fn func() T) T {
	if s.Cache == nil {
		return fn()
	}
	v, ok := s.Cache.Once("once|"+s.Rest.TenantTag()+"|"+key, func() any { return fn() }).(T)
	if !ok {
		// Only a run that panicked hands back nothing; that run's caller has
		// re-panicked into its handler's recover. A waiter asks again.
		return fn()
	}
	return v
}

// picksKey renders chart picks as a single-flight key. JSON, so two different
// sets of picks can never render to the same string.
func picksKey(p any) string {
	b, _ := json.Marshal(p)
	return string(b)
}

// mustFanOut runs independent upstream reads at once, all of them admitted
// together. fanOut contains a task's panic (logging it); this re-raises one
// afterwards, so a read that used to run in line keeps its old outcome, the
// handler's recover-to-500, instead of quietly returning a zero value.
func mustFanOut(tasks ...func()) {
	if fanOut(len(tasks), tasks...) > 0 {
		panic(errTaskPanicked)
	}
}
