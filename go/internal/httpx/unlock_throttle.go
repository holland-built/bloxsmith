package httpx

// THROTTLE FOR POST /api/vault/unlock.
//
// THE DEFECT. The unlock route called Vault.UnlockR once per request with no
// attempt counter, no delay and no lockout, and nothing in front of it: the
// dashboard has no login of its own, and the documented LAN deployment
// (BIND=0.0.0.0) publishes that route to the network. Two separate things came
// out of that, and they need two separate mechanisms because either fix alone
// leaves the other open:
//
//  1. PASSPHRASE GUESSING AT NETWORK SPEED. Nothing counted a wrong passphrase,
//     so an attacker's guess rate was bounded only by how fast the server could
//     derive keys. scrypt at N=2^17 (kdfByVersion, internal/vault/vault.go) is
//     the reason that rate is low, but "low" is not "limited" — an unattended
//     server will happily answer wrong guesses for a week.
//
//  2. AN UNBOUNDED QUEUE ON AN EXPENSIVE OPERATION. The audit that prompted
//     this predicted memory exhaustion — ten concurrent POSTs at ~128 MiB per
//     derive being ~1.3 GB. THAT DOES NOT REPRODUCE, and this file does not
//     repeat it. Measured against the build immediately before this change
//     (darwin/arm64, 15 concurrent unlock POSTs): the derives already
//     serialised — completion times stepped in ~150ms increments and peak RSS
//     rose from 146 MB to 280 MB, one derive's worth, not fifteen. The reason
//     is vault.Unlock holding v.mu across deriveKey.
//
//     What IS uncapped is the queue behind that mutex. Every waiting request
//     holds a connection, a goroutine and a parsed body, with no timeout and
//     no limit on how many may wait: at ~150ms a derive, the hundredth caller
//     waits fifteen seconds and the thousandth waits two and a half minutes,
//     all still connected, and nothing ever tells any of them to go away.
//
//     And the memory bound that does exist is ACCIDENTAL. v.mu is there to
//     protect the vault's fields, not to ration memory; deriving outside the
//     lock is an obvious and legitimate optimisation that would silently
//     restore the multiplication the audit described. The semaphore makes the
//     cap explicit and load-bearing, and gives the queue a ceiling: three
//     seconds, then 503.
//
// WHY HERE AND NOT IN internal/vault. This is request shaping — it counts
// clients, spends wall-clock time and writes an HTTP status — and it belongs
// beside Guard and the write gate. The vault's job is the cryptography. Putting
// a per-IP counter inside it would also throttle the two callers that are NOT
// requests: boot-time AutoUnlock (main.go buildServer) and the `bloxsmith
// vault-passphrase` CLI (passcli.go) both call Vault.Unlock directly and never
// touch this file. Nothing here can slow, block or 429 either of them, and
// internal/server's TestUnlockRoute_ThrottleDoesNotReachDirectVaultCallers
// pins that: it locks out an HTTP client and then auto-unlocks the same vault.
//
// WHO A "CLIENT" IS. The counter keys on the peer address, and behind a reverse
// proxy every request has the SAME peer — the proxy — so the map collapses into
// one bucket and one attacker's guesses lock out every legitimate user. That is
// opt-in to fix, by naming the proxy in TRUSTED_PROXIES; unset (the default) the
// peer address is used exactly as before. The whole argument, including why
// X-Forwarded-For is walked from the right and why the loopback check and the
// audit actor do NOT get the same treatment, is in trusted_proxies.go.
//
// PROCESS-LOCAL, AND A RESTART CLEARS IT. Both mechanisms live in memory, so an
// attacker who can restart the server resets every counter. That is accepted
// rather than overlooked: an attacker who can restart the process has already
// won, and the durable defence against guessing is scrypt's cost, which no
// restart reduces. Persisting a lockout to disk would add a file the vault's
// own threat model would then have to cover, for a client identifier (an IP)
// that is not stable enough to be worth persisting.

import (
	"context"
	"math"
	"net/http"
	"sync"
	"time"
)

// UnlockVerdict is what Do decided to do with a request.
type UnlockVerdict int

const (
	// UnlockRan means derive was called; its own result is the answer.
	UnlockRan UnlockVerdict = iota
	// UnlockBlocked means this client is inside a failure lockout. No derive
	// was performed, so the request costs nothing but the round trip.
	UnlockBlocked
	// UnlockBusy means another unlock held the single derive slot for longer
	// than the acquire timeout.
	UnlockBusy
)

const (
	// unlockBaseDelay and unlockMaxDelay are the backoff curve: the nth
	// consecutive failure from one client locks it out for
	// min(30s, 1s * 2^(n-1)) — 1, 2, 4, 8, 16, then 30 forever.
	unlockBaseDelay = time.Second
	unlockMaxDelay  = 30 * time.Second

	// unlockAcquireTimeout is how long a request waits for the derive slot
	// before being told to come back. Longer than one derive (~160ms measured
	// on this repo's v2 parameters) so an honest queue of a few clears, short
	// enough that a hung derive does not pile connections up behind it.
	unlockAcquireTimeout = 3 * time.Second

	// unlockForget is how long a client's failure count survives its last
	// failure. Idling this out is a deliberate reset: a client at the 30s
	// ceiling who waits 15 minutes to drop back to a 1s delay has traded 15
	// minutes for one fast guess, which is a worse deal than simply continuing
	// to guess at 30s intervals. It also means an operator who fat-fingered a
	// passphrase before lunch is not still locked out after it.
	unlockForget = 15 * time.Minute

	// unlockMaxTracked bounds the failure map. See evictLocked.
	unlockMaxTracked = 4096
)

// unlockFailure is one client's consecutive-failure state.
type unlockFailure struct {
	n    int       // consecutive failures, reset to zero (deleted) on success
	last time.Time // when the most recent one happened
}

// UnlockThrottle is the two mechanisms described at the top of this file. The
// zero value is not usable; call NewUnlockThrottle.
type UnlockThrottle struct {
	// sem is the global derive slot, capacity 1: however many requests
	// arrive, at most one scrypt derive is in flight, so the worst case is
	// ~128 MiB and not 128 MiB times the connection count. Today vault.Unlock's
	// own mutex happens to give the same guarantee (see point 2 at the top of
	// this file); this states it as a rule instead of inheriting it from an
	// implementation detail of another package, and unlike that mutex it
	// bounds the WAIT as well as the concurrency.
	//
	// Capacity 1 rather than "a few" because a legitimate unlock happens once
	// per server lifetime — there is no throughput to protect here.
	sem chan struct{}

	// Proxies is the TRUSTED_PROXIES set used to resolve which client a request
	// belongs to. nil — the value NewUnlockThrottle leaves — trusts nothing and
	// keys on the peer address, which is the behaviour this throttle shipped
	// with. main.go sets it from config; see trusted_proxies.go.
	Proxies *TrustedProxies

	mu    sync.Mutex
	fails map[string]unlockFailure

	// The four fields below are settable rather than referring to the
	// constants directly so the tests can drive the eviction and expiry paths
	// without inserting 4096 entries or sleeping 15 minutes. Nothing outside
	// this package can reach them; production always gets the constants.
	acquire    time.Duration
	forget     time.Duration
	maxTracked int
	now        func() time.Time
}

// NewUnlockThrottle builds a throttle with the production settings.
func NewUnlockThrottle() *UnlockThrottle {
	return &UnlockThrottle{
		sem:        make(chan struct{}, 1),
		fails:      map[string]unlockFailure{},
		acquire:    unlockAcquireTimeout,
		forget:     unlockForget,
		maxTracked: unlockMaxTracked,
		now:        time.Now,
	}
}

// Do runs one unlock attempt under both mechanisms and reports what happened.
// derive must perform the actual key derivation and return whether it
// succeeded; it is called at most once, and only while this request holds the
// single derive slot.
//
// THE ORDER OF THE TWO CHECKS IS THE POINT. The per-client lockout is consulted
// BEFORE the semaphore, so a blocked client never queues for the slot and never
// reaches derive. If it were the other way round, an attacker in permanent
// lockout would still occupy the one derive slot for up to the acquire timeout
// on every request and could starve the operator's real unlock — the counter
// would be limiting guesses while handing over a queueing DoS instead.
//
// Do is a single entry point rather than exported Check/Acquire/Record calls
// for the same reason: a caller cannot get that ordering wrong, forget to
// release the slot, or forget to record the outcome.
//
// It takes the whole request, not the peer address, because deciding WHICH
// CLIENT this is now needs the request's headers as well as its peer — see
// TrustedProxies.ClientIP. Passing only the address would have left the caller
// to resolve that itself, which is the one place this decision must not be
// duplicated. The request's own context is what the wait honours: a caller that
// hung up should not hold a place in the queue.
func (t *UnlockThrottle) Do(r *http.Request, derive func() bool) (UnlockVerdict, time.Duration) {
	key := t.Proxies.ClientIP(r)
	ctx := r.Context()

	if wait := t.blockedFor(key); wait > 0 {
		return UnlockBlocked, wait
	}
	if !t.acquireSlot(ctx) {
		return UnlockBusy, 0
	}
	defer func() { <-t.sem }()

	t.record(key, derive())
	return UnlockRan, 0
}

// blockedFor reports how long this client must still wait, 0 when it may try.
func (t *UnlockThrottle) blockedFor(key string) time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()

	f, ok := t.fails[key]
	if !ok || f.n == 0 {
		return 0
	}
	now := t.now()
	if now.Sub(f.last) >= t.forget {
		// Idle long enough to be forgotten. Dropped here as well as in
		// evictLocked so a quiet server does not carry dead entries until it
		// happens to hit the cap.
		delete(t.fails, key)
		return 0
	}
	until := f.last.Add(unlockBackoff(f.n))
	if !now.Before(until) {
		return 0
	}
	return until.Sub(now)
}

// record folds one attempt's outcome into the client's counter. A success
// clears it outright — the client proved it knows the passphrase, so its
// history says nothing about the next request.
func (t *UnlockThrottle) record(key string, success bool) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if success {
		delete(t.fails, key)
		return
	}
	f, existed := t.fails[key]
	if !existed {
		t.evictLocked()
	}
	f.n++
	f.last = t.now()
	t.fails[key] = f
}

// evictLocked keeps the failure map bounded. Caller holds t.mu.
//
// WHY THIS EXISTS. The map is keyed by client address and every new failing
// address adds an entry, so an attacker rotating source addresses — trivial
// from a machine with an IPv6 /64 — could grow it without limit. That would
// have traded the memory exhaustion this file exists to stop for a slower one
// with the same ending.
//
// TWO STAGES, IN THIS ORDER. First drop everything already past unlockForget:
// those entries cannot affect any decision, so removing them is free. If the
// map is still full, evict the least recently failed entry.
//
// EVICTING THE OLDEST IS THE LESSER OF TWO EVILS, and it is worth being
// explicit about what it costs. It means ~4096 distinct failing addresses
// inside 15 minutes can push a genuinely-blocked client's entry out and reset
// its escalation. The alternative — refuse to track anything new once full —
// is worse, because then the attacker who filled the table is the one who ends
// up untracked and guessing at full speed. Eviction only ever loses ESCALATION
// MEMORY; it can never lift the derive-slot cap, so the memory-exhaustion
// defence holds regardless of what this map contains.
//
// The sweep is lazy (only on a new key, only at the cap) rather than run by a
// timer, because a background goroutine ticking forever over a map that is
// almost always empty is a worse trade than an O(n) scan on the rare insert
// that finds the table full. At the cap the map holds ~4096 short strings and
// a 24-byte struct each — well under a megabyte, against the 128 MiB a single
// unthrottled derive costs.
func (t *UnlockThrottle) evictLocked() {
	if len(t.fails) < t.maxTracked {
		return
	}
	now := t.now()
	for k, f := range t.fails {
		if now.Sub(f.last) >= t.forget {
			delete(t.fails, k)
		}
	}
	for len(t.fails) >= t.maxTracked {
		oldest, oldestAt := "", time.Time{}
		for k, f := range t.fails {
			if oldestAt.IsZero() || f.last.Before(oldestAt) {
				oldest, oldestAt = k, f.last
			}
		}
		delete(t.fails, oldest)
	}
}

// acquireSlot takes the single derive slot, or gives up after t.acquire.
// The request's own context is honoured too: a client that hung up should not
// hold a place in the queue for a derive nobody will read.
func (t *UnlockThrottle) acquireSlot(ctx context.Context) bool {
	if ctx == nil {
		ctx = context.Background()
	}
	timer := time.NewTimer(t.acquire)
	defer timer.Stop()
	select {
	case t.sem <- struct{}{}:
		return true
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	}
}

// unlockBackoff is min(unlockMaxDelay, unlockBaseDelay * 2^(n-1)) for the nth
// consecutive failure. The n > 6 arm is not redundant with the cap below it: it
// keeps the shift from overflowing on a long-running attacker's counter, which
// would otherwise wrap to a negative duration and let them straight through.
func unlockBackoff(n int) time.Duration {
	switch {
	case n <= 0:
		return 0
	case n > 6:
		return unlockMaxDelay
	}
	if d := unlockBaseDelay << (n - 1); d < unlockMaxDelay {
		return d
	}
	return unlockMaxDelay
}

// RetryAfterSeconds renders a wait as the whole seconds a Retry-After header
// takes. Rounded UP and floored at 1: rounding down would name an instant that
// is still inside the lockout, so an obedient client would retry and be refused
// again, and a bare "0" reads as "retry now" — which is the opposite of what
// this header is being sent to say.
func RetryAfterSeconds(d time.Duration) int {
	s := int(math.Ceil(d.Seconds()))
	if s < 1 {
		return 1
	}
	return s
}

// --- what this deliberately does NOT do --------------------------------------
//
// CLIENTS BEHIND ONE NAT STILL SHARE A BUCKET. Every request from an office
// behind one public address counts as the same client, so one person
// fat-fingering their passphrase can lock out everyone behind it. Accepted: NAT
// leaves no trace in the request for anyone to read, so there is nothing to key
// on, and the failure mode is a 30-second wait on a route used once per server
// lifetime.
//
// THE REVERSE-PROXY CASE IS NOT THE SAME PROBLEM, and it is no longer on this
// list — it was a denial-of-service lever, not an inconvenience, because the
// proxy is the ONLY peer the server ever sees and the whole map becomes one
// bucket. TRUSTED_PROXIES fixes it opt-in; trusted_proxies.go carries the
// argument, including why the header is still ignored by default and why it is
// walked from the right rather than the left.
//
// AND IT IS STILL NEVER "FIXED" BY READING X-Forwarded-For FROM AN UNNAMED
// SOURCE. Unless the operator has told this process which peer is a proxy, that
// header is written by whoever sent the request. Keying the counter on it blind
// would let an attacker put a fresh value on every guess and reset their own
// lockout at will — the throttle would still be running, still be reporting
// counts, and be worth exactly nothing.
