package httpx

import (
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// These four guard one property: the per-client lockout must apply to requests
// that arrive TOGETHER, not only to requests that arrive one after another.
//
// Before the post-acquire check existed, Do read the failure counter before the
// derive and wrote it after, so a burst all read n == 0 and all passed. The
// capacity-1 semaphore then handed each of them a guess in turn. Measured on
// that code: 50 concurrent wrong guesses from one address gave 50 derives and 0
// blocks, and with a 160ms derive the bound was the 3s acquire timeout — 19
// guesses — rather than the 1, 2, 4, 8, 16, 30s curve. See issue #52.

// burstThrottle is a throttle with a long acquire timeout, so a queued caller
// waits for the slot rather than timing out and masking the thing under test.
func burstThrottle() *UnlockThrottle {
	t := NewUnlockThrottle()
	t.acquire = 10 * time.Second
	return t
}

// doFrom runs one attempt from addr with the given derive.
func doFrom(th *UnlockThrottle, addr string, derive func() bool) (UnlockVerdict, time.Duration) {
	r := httptest.NewRequest("POST", "/api/vault/unlock", nil)
	r.RemoteAddr = addr + ":40000"
	return th.Do(r, derive)
}

// TestUnlockBurstIsRefusedDeterministically pins the exact interleaving, with no
// reliance on the scheduler: caller B is proven to have passed the pre-check
// while caller A still holds the slot and has not yet recorded its failure.
//
// The seam fires between the pre-check and acquireSlot — the only point where a
// caller has passed the first check and has not yet blocked on the slot. Firing
// it after acquireSlot instead would deadlock: B could not signal until A had
// already released.
func TestUnlockBurstIsRefusedDeterministically(t *testing.T) {
	th := burstThrottle()
	var derives atomic.Int64

	releaseA := make(chan struct{})
	bPastPreCheck := make(chan struct{})
	aInDerive := make(chan struct{})

	var aVerdict, bVerdict UnlockVerdict
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		aVerdict, _ = doFrom(th, "203.0.113.9", func() bool {
			derives.Add(1)
			close(aInDerive)
			<-releaseA // A holds the slot, and has recorded nothing yet
			return false
		})
	}()
	<-aInDerive

	th.afterPreCheck = func() {
		th.afterPreCheck = nil // A is already past it; this is B's one signal
		close(bPastPreCheck)
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		bVerdict, _ = doFrom(th, "203.0.113.9", func() bool {
			derives.Add(1)
			return false
		})
	}()

	<-bPastPreCheck // B passed the lockout check while A's failure was unrecorded
	close(releaseA)
	wg.Wait()

	if aVerdict != UnlockRan {
		t.Fatalf("caller A verdict = %v, want UnlockRan", aVerdict)
	}
	if bVerdict != UnlockBlocked {
		t.Fatalf("caller B verdict = %v, want UnlockBlocked — it passed the pre-check "+
			"before A recorded, so only the post-acquire check can refuse it", bVerdict)
	}
	if n := derives.Load(); n != 1 {
		t.Fatalf("derive ran %d times for one client in one burst, want 1", n)
	}
}

// TestUnlockBurstDoesNotBlockOtherClients is the other half: the fix must refuse
// a SECOND GUESS FROM ONE CLIENT, not a first guess from everyone. B queues
// behind A's slot exactly as above, but from a different address, and must get
// its derive.
//
// Without this, turning the per-client lockout into an accidental global one
// would pass every other test in this file.
func TestUnlockBurstDoesNotBlockOtherClients(t *testing.T) {
	th := burstThrottle()
	var derives atomic.Int64

	releaseA := make(chan struct{})
	bPastPreCheck := make(chan struct{})
	aInDerive := make(chan struct{})

	var bVerdict UnlockVerdict
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		doFrom(th, "203.0.113.9", func() bool {
			derives.Add(1)
			close(aInDerive)
			<-releaseA
			return false
		})
	}()
	<-aInDerive

	th.afterPreCheck = func() {
		th.afterPreCheck = nil
		close(bPastPreCheck)
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		bVerdict, _ = doFrom(th, "198.51.100.4", func() bool { // a DIFFERENT client
			derives.Add(1)
			return false
		})
	}()

	<-bPastPreCheck
	close(releaseA)
	wg.Wait()

	if bVerdict != UnlockRan {
		t.Fatalf("a different client's first guess got %v, want UnlockRan — the lockout is "+
			"per-client and must not have become global", bVerdict)
	}
	if n := derives.Load(); n != 2 {
		t.Fatalf("derive ran %d times for two distinct clients, want 2", n)
	}
}

// TestUnlockPanickingDeriveStillCounts: a derive that panics must still count as
// a failed attempt. Otherwise anything that can crash the derive path is an
// unlimited free-guess oracle — the attempt was made, so it is charged for.
//
// Do is called through a helper that recovers, because a recover in this test's
// own defer would resume after the defer rather than after the panicking call,
// and the assertions below would never run.
func TestUnlockPanickingDeriveStillCounts(t *testing.T) {
	th := burstThrottle()

	panicked := func() (p bool) {
		defer func() { p = recover() != nil }()
		doFrom(th, "203.0.113.9", func() bool { panic("derive exploded") })
		return false
	}()
	if !panicked {
		t.Fatal("the panic did not propagate out of Do — the caller's own recover-to-500 guard never runs")
	}

	v, wait := doFrom(th, "203.0.113.9", func() bool {
		t.Fatal("derive ran again; the panicking attempt was never counted as a failure")
		return false
	})
	if v != UnlockBlocked || wait <= 0 {
		t.Fatalf("after a panicking derive: verdict %v, wait %v — want UnlockBlocked with a wait", v, wait)
	}
}

// TestUnlockBurstUnderRealConcurrency is the whole-path guard: no seam, no
// choreography, just 50 requests released together. It is kept alongside the
// deterministic test rather than instead of it — this one proves the fix holds
// when nothing is arranged, and the deterministic one proves it for the reason
// intended rather than because the scheduler was kind.
func TestUnlockBurstUnderRealConcurrency(t *testing.T) {
	th := NewUnlockThrottle()
	var derives, ran, blocked, busy atomic.Int64

	const n = 50
	var start, done sync.WaitGroup
	start.Add(1)
	for i := 0; i < n; i++ {
		done.Add(1)
		go func() {
			defer done.Done()
			start.Wait()
			v, _ := doFrom(th, "203.0.113.9", func() bool {
				derives.Add(1)
				time.Sleep(2 * time.Millisecond) // a derive is not free
				return false
			})
			switch v {
			case UnlockRan:
				ran.Add(1)
			case UnlockBlocked:
				blocked.Add(1)
			case UnlockBusy:
				busy.Add(1)
			}
		}()
	}
	start.Done()
	done.Wait()

	t.Logf("%d concurrent wrong guesses: %d ran, %d blocked, %d busy; derive called %d times",
		n, ran.Load(), blocked.Load(), busy.Load(), derives.Load())
	if got := derives.Load(); got != 1 {
		t.Fatalf("one client got %d passphrase guesses out of a single burst, want 1 — "+
			"the first failure locks it out for %v", got, unlockBaseDelay)
	}
}
