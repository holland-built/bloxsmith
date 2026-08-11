package dashboard

// 403 entitlement backoff for the attack-surface feeds. An account without
// the Attack Surface licence gets "you are not authorized to use this
// feature" — a verdict about the account, not a transient fault — yet the
// UI's minute poll re-asked upstream and re-logged the refusal forever:
// 14,529 of the 21,103 lines in a real bloxsmith.err.log (2026-07-20 →
// 2026-08-11) were these three messages. Remember the 403 per endpoint,
// answer later polls locally, log once per window instead of once per poll.
//
// Only 403 backs off. A 429 here is Infoblox's 4 MiB gRPC cap or rate
// pressure (see CSPExposedHostnames), a 5xx/timeout is an outage — both can
// clear on the very next poll, so both keep retrying exactly as before.
//
// The memory is keyed to the shared cache's generation: an account switch
// calls cache.Rotate() (account.go:216), the generation moves, and the map
// resets — the next tenant may hold the licence, so a 403 must not outlive
// the account that earned it. TTL-only expiry would suppress a licensed
// tenant's feed for up to an hour after a switch.

import (
	"sync"
	"time"
)

// entitlementRetry is how long a 403 is believed before re-probing. Licences
// change on human timescales; an hour keeps the log quiet without making a
// newly-bought licence invisible for long.
const entitlementRetry = time.Hour

// entitlementReason is the operator-safe reason the three feeds return while
// a 403 is believed. It names the actual cause — the earlier generic
// "upstream ... failed" read as an outage, which a licence gap is not.
const entitlementReason = "account not entitled to Attack Surface (re-checked hourly)"

type entitlement struct {
	mu    sync.Mutex
	gen   uint64
	until map[string]time.Time // endpoint path → believe-the-403 deadline
}

// cacheGen reads the shared cache generation; 0 when a test built the
// Service without a cache.
func (s *Service) cacheGen() uint64 {
	if s.Cache == nil {
		return 0
	}
	return s.Cache.Gen()
}

// entitlementDenied reports whether path is inside a 403 backoff window for
// the current account. Nil-safe: a Service built as a bare literal (several
// tests do) has no backoff and always probes.
func (s *Service) entitlementDenied(path string) bool {
	e := s.ent
	if e == nil {
		return false
	}
	gen := s.cacheGen()
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.gen != gen {
		e.gen, e.until = gen, nil // account switched — forget the old tenant's 403s
		return false
	}
	deadline, ok := e.until[path]
	return ok && time.Now().Before(deadline)
}

// entitlementMark403 starts (or restarts) the backoff window for path and
// reports whether this call opened it — the opener logs, repeats stay silent.
func (s *Service) entitlementMark403(path string) bool {
	e := s.ent
	if e == nil {
		return true // no memory to consult — behave like the first time, log
	}
	gen := s.cacheGen()
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.gen != gen {
		e.gen, e.until = gen, nil
	}
	if e.until == nil {
		e.until = map[string]time.Time{}
	}
	_, already := e.until[path]
	e.until[path] = time.Now().Add(entitlementRetry)
	return !already
}
