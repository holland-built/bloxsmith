package httpx

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// What these tests are actually defending, restated so a future reader does not
// have to infer it from assertions: POST /api/vault/unlock needs no credential
// to reach and costs a 128 MiB scrypt derive per call. The two properties that
// matter are that a refused client spends NO derive, and that no number of
// concurrent callers can make more than one derive run at a time. Everything
// below is one of those two, or the bookkeeping that keeps them true.

// fakeClock drives the backoff and expiry paths without sleeping. Every test
// using it is single-goroutine on purpose — the concurrency tests below run on
// the real clock instead, because a clock that is only safe under a mutex the
// test does not hold is a race the detector would (rightly) report.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newFakeClock() *fakeClock { return &fakeClock{t: time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)} }

// testThrottle is a production throttle on a test-controlled clock.
func testThrottle(clk *fakeClock) *UnlockThrottle {
	th := NewUnlockThrottle()
	th.now = clk.now
	return th
}

const testClient = "192.0.2.10:51000"

// peerReq is an unlock POST from one peer, in the shape net/http hands to a
// handler: RemoteAddr always carries a port. Tests that also exercise the
// forwarded chain use fwdReq below.
func peerReq(remoteAddr string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/vault/unlock", nil)
	r.RemoteAddr = remoteAddr
	return r
}

// fwdReq is peerReq plus an X-Forwarded-For, one header value per argument, so a
// test can build a multi-line chain the way an attacker's header plus a proxy's
// appended one actually arrives.
func fwdReq(remoteAddr string, xff ...string) *http.Request {
	r := peerReq(remoteAddr)
	for _, v := range xff {
		r.Header.Add("X-Forwarded-For", v)
	}
	return r
}

func failingDerive() bool { return false }
func passingDerive() bool { return true }

// --- the lockout curve -------------------------------------------------------

// The nth consecutive failure locks the client out for min(30s, 1s*2^(n-1)).
// Asserted at every step rather than at the ends, because an off-by-one in the
// exponent is invisible from the endpoints alone: 2^n and 2^(n-1) both start
// low and both saturate at 30s.
func TestUnlockThrottle_LockoutEscalatesAndCaps(t *testing.T) {
	clk := newFakeClock()
	th := testThrottle(clk)

	want := []time.Duration{
		1 * time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second,
		16 * time.Second, 30 * time.Second, 30 * time.Second, 30 * time.Second,
	}
	for i, w := range want {
		if v, _ := th.Do(peerReq(testClient), failingDerive); v != UnlockRan {
			t.Fatalf("failure %d: verdict = %v, want UnlockRan — the attempt was refused before it "+
				"was even allowed to be wrong", i+1, v)
		}
		v, wait := th.Do(peerReq(testClient), func() bool {
			t.Errorf("failure %d: a locked-out client reached the derive — the whole point of "+
				"checking the counter first is that this costs 128 MiB", i+1)
			return false
		})
		if v != UnlockBlocked {
			t.Fatalf("after %d consecutive failures: verdict = %v, want UnlockBlocked", i+1, v)
		}
		if wait != w {
			t.Fatalf("after %d consecutive failures: wait = %v, want %v", i+1, wait, w)
		}
		// Sit out the lockout exactly, so the next iteration measures the next
		// step of the curve and not the remainder of this one.
		clk.advance(w)
	}
}

// A blocked client must be told how long to wait, and the whole point of the
// counter is that being told costs the server nothing. This is the "spends no
// scrypt" assertion in its own test rather than only as a side condition above.
func TestUnlockThrottle_BlockedRequestRunsNoDerive(t *testing.T) {
	clk := newFakeClock()
	th := testThrottle(clk)

	derives := 0
	count := func() bool { derives++; return false }

	if v, _ := th.Do(peerReq(testClient), count); v != UnlockRan {
		t.Fatalf("first attempt was not allowed to run")
	}
	for i := 0; i < 20; i++ {
		if v, _ := th.Do(peerReq(testClient), count); v != UnlockBlocked {
			t.Fatalf("attempt %d: verdict = %v, want UnlockBlocked", i+2, v)
		}
	}
	if derives != 1 {
		t.Fatalf("derive ran %d times across 21 attempts, want 1 — 20 refusals cost %d x 128 MiB "+
			"of scrypt, which is the memory-exhaustion hole this exists to close", derives, derives-1)
	}
}

// Getting the passphrase right clears the history. Without this an operator who
// mistyped twice and then succeeded would still be serving out a lockout on
// their next legitimate unlock, and a lock/unlock cycle would escalate for no
// reason.
func TestUnlockThrottle_SuccessClearsTheCounter(t *testing.T) {
	clk := newFakeClock()
	th := testThrottle(clk)

	for i := 0; i < 3; i++ {
		th.Do(peerReq(testClient), failingDerive)
		clk.advance(unlockMaxDelay) // wait out each lockout
	}
	if v, _ := th.Do(peerReq(testClient), passingDerive); v != UnlockRan {
		t.Fatalf("the correct passphrase was refused: %v", v)
	}
	if n := len(th.fails); n != 0 {
		t.Fatalf("failure map still holds %d entries after a success, want 0", n)
	}

	// And the next wrong guess starts the curve over at 1s, not at 8s.
	th.Do(peerReq(testClient), failingDerive)
	if _, wait := th.Do(peerReq(testClient), failingDerive); wait != time.Second {
		t.Fatalf("first failure after a success locked out for %v, want 1s — the counter was not "+
			"reset, only its entry", wait)
	}
}

// One client's failures must not lock out another. A shared counter would mean
// anybody on the network could deny the operator their own vault.
func TestUnlockThrottle_ClientsAreIndependent(t *testing.T) {
	clk := newFakeClock()
	th := testThrottle(clk)

	const attacker = "198.51.100.7:40000"
	const operator = "192.0.2.44:40000"

	for i := 0; i < 6; i++ {
		th.Do(peerReq(attacker), failingDerive)
		clk.advance(unlockMaxDelay)
	}
	// The attacker is now at the ceiling.
	th.Do(peerReq(attacker), failingDerive)
	if v, _ := th.Do(peerReq(attacker), failingDerive); v != UnlockBlocked {
		t.Fatalf("attacker verdict = %v, want UnlockBlocked", v)
	}
	if v, _ := th.Do(peerReq(operator), passingDerive); v != UnlockRan {
		t.Fatalf("operator verdict = %v, want UnlockRan — one client's failures locked out another", v)
	}
}

// The peer address is the key, so the same client on a different ephemeral port
// is still the same client. Trivially true given hostOf, and asserted because
// keying on the full RemoteAddr would silently make the counter useless: every
// TCP connection gets a new source port.
func TestUnlockThrottle_KeyIgnoresThePort(t *testing.T) {
	clk := newFakeClock()
	th := testThrottle(clk)

	th.Do(peerReq("203.0.113.9:1111"), failingDerive)
	v, _ := th.Do(peerReq("203.0.113.9:2222"), func() bool {
		t.Error("a new source port from the same host was treated as a new client")
		return false
	})
	if v != UnlockBlocked {
		t.Fatalf("verdict = %v, want UnlockBlocked — one guess per connection would be unlimited guesses", v)
	}
}

// A client that has been quiet for longer than unlockForget is forgotten
// outright: no entry, and the curve restarts.
func TestUnlockThrottle_ForgetsIdleClients(t *testing.T) {
	clk := newFakeClock()
	th := testThrottle(clk)

	th.Do(peerReq(testClient), failingDerive)
	clk.advance(unlockForget + time.Second)

	if v, _ := th.Do(peerReq(testClient), failingDerive); v != UnlockRan {
		t.Fatalf("verdict = %v, want UnlockRan after idling past the forget window", v)
	}
	if _, wait := th.Do(peerReq(testClient), failingDerive); wait != time.Second {
		t.Fatalf("lockout after the forget window = %v, want 1s — the old count survived", wait)
	}
}

// --- the map bound -----------------------------------------------------------

// An attacker rotating source addresses must not be able to grow the failure
// map without limit; that would trade one memory-exhaustion bug for another.
// maxTracked is lowered here so the eviction path is exercised in milliseconds
// instead of with 4096 real entries.
func TestUnlockThrottle_FailureMapIsBounded(t *testing.T) {
	clk := newFakeClock()
	th := testThrottle(clk)
	th.maxTracked = 64

	const rotations = 1000
	for i := 0; i < rotations; i++ {
		clk.advance(time.Millisecond)
		addr := fmt.Sprintf("198.51.100.%d:%d", i%256, 40000+i)
		if v, _ := th.Do(peerReq(addr), failingDerive); v != UnlockRan {
			t.Fatalf("rotation %d: verdict = %v, want UnlockRan", i, v)
		}
	}
	if n := len(th.fails); n > th.maxTracked {
		t.Fatalf("failure map holds %d entries after %d rotating addresses, cap is %d — "+
			"the map itself is now the memory-exhaustion vector", n, rotations, th.maxTracked)
	}
	// Eviction is least-recently-failed, so the newest attacker must still be
	// tracked. If eviction dropped the newest instead, the table would be full
	// of history and blind to whoever is attacking right now.
	newest := fmt.Sprintf("198.51.100.%d", (rotations-1)%256)
	if _, ok := th.fails[newest]; !ok {
		t.Fatalf("the most recent failing client %q is not tracked — eviction is dropping the wrong end", newest)
	}
}

// The cheap half of eviction: entries already past the forget window are
// dropped before anything still live is considered.
func TestUnlockThrottle_ExpiredEntriesEvictedBeforeLiveOnes(t *testing.T) {
	clk := newFakeClock()
	th := testThrottle(clk)
	th.maxTracked = 8

	for i := 0; i < 8; i++ {
		th.Do(peerReq(fmt.Sprintf("198.51.100.%d:1", i)), failingDerive)
	}
	clk.advance(unlockForget + time.Second) // every entry above is now stale

	const live = "192.0.2.99:1"
	th.Do(peerReq(live), failingDerive)

	if n := len(th.fails); n != 1 {
		t.Fatalf("map holds %d entries, want 1 — the stale sweep did not run, so live entries are "+
			"being evicted to make room for nothing", n)
	}
	if _, ok := th.fails["192.0.2.99"]; !ok {
		t.Fatalf("the only live client was the one evicted")
	}
}

// --- the derive slot ---------------------------------------------------------

// Many callers, one derive at a time — asserted on the throttle itself rather
// than inferred from vault.Unlock's mutex, which gives the same answer today
// for reasons that have nothing to do with rationing memory and could change
// without anyone noticing this depended on them.
func TestUnlockThrottle_DerivesAreSerialised(t *testing.T) {
	th := NewUnlockThrottle() // real clock: nothing here depends on time travel

	const callers = 16
	var mu sync.Mutex
	inFlight, peak, ran := 0, 0, 0

	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// Distinct clients, all succeeding, so neither the lockout nor the
			// counter can be what serialises them — only the slot can.
			addr := fmt.Sprintf("192.0.2.%d:5000", i+1)
			v, _ := th.Do(peerReq(addr), func() bool {
				mu.Lock()
				inFlight++
				if inFlight > peak {
					peak = inFlight
				}
				mu.Unlock()

				time.Sleep(2 * time.Millisecond) // stand in for the derive

				mu.Lock()
				inFlight--
				ran++
				mu.Unlock()
				return true
			})
			if v != UnlockRan {
				t.Errorf("caller %d: verdict = %v, want UnlockRan — %d serialised 2ms derives are "+
					"nowhere near the %v acquire timeout", i, v, callers, unlockAcquireTimeout)
			}
		}(i)
	}
	wg.Wait()

	if peak != 1 {
		t.Fatalf("peak concurrent derives = %d, want 1 — %d concurrent unlock requests would hold "+
			"%d x 128 MiB of scrypt buffers at once", peak, callers, peak)
	}
	if ran != callers {
		t.Fatalf("%d of %d callers ran; they must queue, not be dropped", ran, callers)
	}
}

// Queueing has a limit: a caller that cannot get the slot within the acquire
// timeout is told to come back rather than held open indefinitely.
func TestUnlockThrottle_BusyWhenTheSlotIsHeld(t *testing.T) {
	th := NewUnlockThrottle()
	th.acquire = 20 * time.Millisecond

	holding := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		th.Do(peerReq("192.0.2.1:1"), func() bool {
			close(holding)
			<-release
			return true
		})
	}()
	<-holding

	v, wait := th.Do(peerReq("192.0.2.2:1"), func() bool {
		t.Error("a second derive started while the slot was held")
		return false
	})
	if v != UnlockBusy {
		t.Fatalf("verdict = %v, want UnlockBusy", v)
	}
	if wait != 0 {
		t.Fatalf("busy wait = %v, want 0 — busy is not a lockout and must not be reported as one", wait)
	}

	close(release)
	<-done
}

// A client that hung up must not keep queueing for a derive nobody will read.
func TestUnlockThrottle_CancelledContextDoesNotQueue(t *testing.T) {
	th := NewUnlockThrottle()

	holding := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		th.Do(peerReq("192.0.2.1:1"), func() bool {
			close(holding)
			<-release
			return true
		})
	}()
	<-holding

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	v, _ := th.Do(peerReq("192.0.2.2:1").WithContext(ctx), func() bool {
		t.Error("a cancelled request still ran a derive")
		return false
	})
	if v != UnlockBusy {
		t.Fatalf("verdict = %v, want UnlockBusy", v)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("a cancelled request waited %v — it should give up at once, not serve out the "+
			"%v acquire timeout", elapsed, unlockAcquireTimeout)
	}

	close(release)
	<-done
}

// A panicking derive must still hand the slot back. A leaked slot would mean
// every later unlock 503s until the process restarts — the operator locked out
// of their own vault by the control meant to protect it.
func TestUnlockThrottle_PanicReleasesTheSlot(t *testing.T) {
	th := NewUnlockThrottle()
	th.acquire = 50 * time.Millisecond

	func() {
		defer func() { _ = recover() }()
		th.Do(peerReq("192.0.2.1:1"), func() bool { panic("derive exploded") })
	}()

	if v, _ := th.Do(peerReq("192.0.2.2:1"), passingDerive); v != UnlockRan {
		t.Fatalf("verdict = %v, want UnlockRan — the slot was never released after a panic", v)
	}
}

// --- Retry-After rendering ---------------------------------------------------

// Retry-After is whole seconds. Rounding down would name an instant still
// inside the lockout, so an obedient client retries and is refused again; 0
// reads as "retry now", which is the opposite of the message.
func TestRetryAfterSeconds(t *testing.T) {
	cases := []struct {
		in   time.Duration
		want int
	}{
		{0, 1},
		{-time.Second, 1},
		{time.Millisecond, 1},
		{time.Second, 1},
		{1200 * time.Millisecond, 2},
		{29500 * time.Millisecond, 30},
		{30 * time.Second, 30},
	}
	for _, c := range cases {
		if got := RetryAfterSeconds(c.in); got != c.want {
			t.Errorf("RetryAfterSeconds(%v) = %d, want %d", c.in, got, c.want)
		}
	}
}

// --- who a client is, behind a proxy ------------------------------------------
//
// These four are the throttle-level half of TRUSTED_PROXIES; the resolution
// rules themselves are pinned in trusted_proxies_test.go. What is asserted here
// is the consequence that matters: which requests land in the SAME bucket.

// The safe default, and the regression guard on it. With nothing configured an
// X-Forwarded-For must not influence the key at all — if it did, an attacker
// would put a fresh value on every guess and never be locked out, and the
// counter would keep running and keep meaning nothing.
func TestUnlockThrottle_IgnoresForwardedForByDefault(t *testing.T) {
	clk := newFakeClock()
	th := testThrottle(clk) // Proxies is nil, as NewUnlockThrottle leaves it

	th.Do(fwdReq(testClient, "203.0.113.1"), failingDerive)
	v, _ := th.Do(fwdReq(testClient, "203.0.113.2"), func() bool {
		t.Error("a new X-Forwarded-For value bought a fresh bucket with no proxy configured")
		return false
	})
	if v != UnlockBlocked {
		t.Fatalf("verdict = %v, want UnlockBlocked — one header edit per guess is unlimited guesses", v)
	}
}

// THE WHOLE POINT OF THE SETTING. Two real clients arriving through one trusted
// proxy have to be counted separately. Without this the proxy is the only peer
// the server sees, every request shares one bucket, and six wrong guesses from
// anyone reachable through that proxy lock out every legitimate operator — a
// denial of service handed to the attacker by the control meant to stop them.
func TestUnlockThrottle_ClientsBehindOneTrustedProxyAreIndependent(t *testing.T) {
	clk := newFakeClock()
	th := testThrottle(clk)
	th.Proxies, _ = ParseTrustedProxies([]string{"10.0.0.7"})

	const proxy = "10.0.0.7:44321"
	const attacker = "203.0.113.9"
	const operator = "198.51.100.4"

	// Drive the attacker to the ceiling, waiting out each lockout so the
	// escalation is real and not just the first 1s step.
	for i := 0; i < 6; i++ {
		th.Do(fwdReq(proxy, attacker), failingDerive)
		clk.advance(unlockMaxDelay)
	}
	th.Do(fwdReq(proxy, attacker), failingDerive)
	if v, _ := th.Do(fwdReq(proxy, attacker), failingDerive); v != UnlockBlocked {
		t.Fatalf("attacker verdict = %v, want UnlockBlocked — the throttle stopped working once a proxy was trusted", v)
	}
	if v, _ := th.Do(fwdReq(proxy, operator), passingDerive); v != UnlockRan {
		t.Fatalf("operator verdict = %v, want UnlockRan — both clients are still sharing the proxy's single bucket, which is the defect TRUSTED_PROXIES exists to fix", v)
	}
}

// A peer that is NOT a configured proxy gets its header ignored, no exceptions.
// Otherwise anyone who can reach the app port directly — a LAN peer, another
// container on the same bridge network — walks around the whole scheme by
// writing their own X-Forwarded-For.
func TestUnlockThrottle_UntrustedPeerCannotUseForwardedFor(t *testing.T) {
	clk := newFakeClock()
	th := testThrottle(clk)
	th.Proxies, _ = ParseTrustedProxies([]string{"10.0.0.7"})

	const direct = "203.0.113.50:9000" // not the proxy

	th.Do(fwdReq(direct, "198.51.100.1"), failingDerive)
	v, _ := th.Do(fwdReq(direct, "198.51.100.2"), func() bool {
		t.Error("an untrusted peer changed buckets by editing X-Forwarded-For")
		return false
	})
	if v != UnlockBlocked {
		t.Fatalf("verdict = %v, want UnlockBlocked — the header is only readable from a peer the operator named", v)
	}
}

// The spoofing attempt this design is shaped around. The attacker prepends
// their own entries, including ones that look like trusted proxies, hoping the
// server reads the LEFT end of the chain. Walking from the right, everything
// they wrote sits to the left of the address our own proxy appended and is
// never reached — so every guess lands in the same bucket no matter what the
// header says.
func TestUnlockThrottle_SpoofedChainCannotEscapeItsBucket(t *testing.T) {
	clk := newFakeClock()
	th := testThrottle(clk)
	th.Proxies, _ = ParseTrustedProxies([]string{"10.0.0.0/24"})

	const proxy = "10.0.0.7:44321"
	const attacker = "203.0.113.9"

	spoofs := []string{
		"1.2.3.4",                    // a plain lie
		"10.0.0.9, 10.0.0.8",         // fake trusted hops, hoping the walk continues past them
		"127.0.0.1",                  // the loopback trick
		"9.9.9.9, 10.0.0.5, 1.1.1.1", // a whole fabricated chain
		"not-an-address",             // garbage, hoping a parse failure opens something
	}
	// First failure establishes the bucket; the client is locked out from here.
	th.Do(fwdReq(proxy, attacker), failingDerive)
	for _, s := range spoofs {
		// The proxy appends the address it actually saw, to the RIGHT of
		// whatever the attacker sent. That is the only entry we believe.
		v, _ := th.Do(fwdReq(proxy, s+", "+attacker), func() bool {
			t.Errorf("X-Forwarded-For %q escaped the lockout and ran a derive", s)
			return false
		})
		if v != UnlockBlocked {
			t.Fatalf("X-Forwarded-For %q: verdict = %v, want UnlockBlocked — the attacker picked their own bucket and the throttle counts nothing", s, v)
		}
	}
}
