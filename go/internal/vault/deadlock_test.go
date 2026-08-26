package vault

// THE TENANT-SWITCH DEADLOCK, 2026-08-26.
//
// The installed server stopped answering after a tenant switch. It held its
// listener open, so TCP connects succeeded and every request then hung: curl to
// `/` and to `/api/vault/status` both timed out at 8s with no status line, the
// process sat at 0.0% CPU in state S, and the log went silent for four hours on
// a poll that runs every five and a half minutes. The last two lines of it are
// what named the trigger:
//
//	09:55:56  subnets=6628 ... totals[subnets=72295 ...]      <- old tenant
//	09:58:16  subnets=487(union, page=487 atRisk=1, ok) ...   <- NEW tenant
//
// So the switch itself SUCCEEDED and one poll completed on the new tenant.
// Whatever wedged came after, which is why "it crashed on changing tenants" and
// "the switch works" were both true reports of the same fault.
//
// SIGQUIT gave 125 goroutines: 91 parked on sync.RWMutex.RLock, one on
// RWMutex.Lock, two on Mutex.Lock. The one and the two are the whole bug.
//
//	goroutine 34901 [sync.RWMutex.Lock, 6 minutes]:
//	  rest.(*Auth).SetOverride       <- wants a.mu
//	  main.buildServer.func1
//	  vault.(*Vault).rotateAuth
//	  vault.(*Vault).SetActive       <- HOLDS v.mu
//
//	goroutine 34795 [sync.Mutex.Lock, 6 minutes]:
//	  vault.(*Vault).ActiveKey       <- wants v.mu
//	  rest.(*Auth).Value             <- HOLDS a.mu
//	  rest.(*Client).Pin
//	  server.(*Deps).withPinnedTenant
//
// A holds v.mu and wants a.mu; B holds a.mu and wants v.mu. The other 91 are
// ordinary requests queued behind the stalled writer, because Go's RWMutex stops
// admitting readers once a writer is waiting — and withPinnedTenant is global
// middleware, so "every request" includes static files. That is how a two-lock
// cycle presents as a whole-server hang rather than one broken endpoint.
//
// A third domain was in the graph too, found by review rather than by the dump:
// account.Manager holds m.mu across an outbound HTTPS call in cspJSON, which
// reads auth.IdentityValue, which resolved through ActiveKey. So there were two
// cycles, v->a->v and v->m->a->v, and only cutting the edges OUT OF the vault
// kills both. That is what the fix does; Auth releasing its lock before calling
// the resolver is the belt to that braces.
//
// WHAT THIS FILE ASSERTS. Not "no deadlock happened", which any passing test can
// claim by never provoking one. It reconstructs the exact interleaving with
// channels, so the test is a race that the OLD code loses every time.

import (
	"sync"
	"testing"
	"time"

	"bloxsmith/internal/rest"
)

// How long a correct implementation is allowed. Generous on purpose: the point
// is to distinguish "completed" from "never completes", not to time anything.
const deadlockBudget = 10 * time.Second

// wire builds the vault and auth the way main.go does at :456 and :471 — the
// resolver is the vault's own ActiveKey, and the reset callback pokes the auth
// slot. Reproducing the WIRING is what makes this a test of the real cycle
// rather than of two mutexes invented here.
//
// gate, if non-nil, is called inside the resolver before it touches the vault.
// That is the seam the test drives the interleaving through.
// beforeOverride, if non-nil, is called by the reset callback immediately before
// it touches the auth slot. That is the instant the switch is committed to
// wanting a.mu, and waiting for it is what lets the test drop its sleep.
func wire(t *testing.T, gate func(), beforeOverride func()) (*Vault, *rest.Auth) {
	t.Helper()
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "One", Key: "key-one"},
		Tenant{ID: "t2", Label: "Two", Key: "key-two"},
	)
	auth := rest.NewAuth("", func() string {
		if gate != nil {
			gate()
		}
		return v.ActiveKey()
	})
	v.SetAuthReset(func() {
		if beforeOverride != nil {
			beforeOverride()
		}
		auth.SetOverride("")
	})
	return v, auth
}

func TestTenantSwitchDoesNotDeadlockAgainstAuthResolver(t *testing.T) {
	inResolver := make(chan struct{})
	release := make(chan struct{})
	atOverride := make(chan struct{})
	var once, onceReset sync.Once

	v, auth := wire(t, func() {
		// Only the first resolution is gated. SetActive's own path can resolve
		// the key again on its way through, and a gate that fired twice would
		// block the goroutine it is supposed to be racing.
		once.Do(func() {
			close(inResolver)
			<-release
		})
	}, func() {
		onceReset.Do(func() { close(atOverride) })
	})

	readerDone := make(chan string, 1)
	go func() { readerDone <- auth.Value() }()

	// The reader is now inside the resolver. Under the OLD code it is holding
	// a.mu at this point; under the fixed code it holds nothing. Either way the
	// switch is about to run against it.
	select {
	case <-inResolver:
	case <-time.After(deadlockBudget):
		t.Fatal("the auth resolver was never entered — the test never reached the interleaving it exists to test")
	}

	switchDone := make(chan map[string]any, 1)
	go func() { switchDone <- v.SetActive("t2") }()

	// Wait for the switch to reach the instant before it takes the auth lock.
	// This used to be a 250ms sleep, which Codex flagged as able to pass
	// VACUOUSLY: on a loaded runner an old-code SetActive that had not yet
	// reached its callback would be released early, miss the interleaving, and
	// report a green run over the very deadlock this file exists to hold shut.
	// A signal from inside the callback cannot be early or late by construction.
	//
	// Under the old code this signal arrives while v.mu is still held and the
	// next statement blocks forever on a.mu; under the fixed code it arrives
	// with v.mu already released. The test does not need to know which — it only
	// needs the switch to be past the vault mutation before the reader is let go.
	select {
	case <-atOverride:
	case <-time.After(deadlockBudget):
		t.Fatal("the tenant switch never reached its auth-reset callback, so the interleaving under test never happened")
	}

	// Now let the resolver proceed into the vault. Old code: SetActive holds
	// v.mu and waits on a.mu, this reader holds a.mu and now wants v.mu, and
	// neither ever moves. Fixed code: SetActive released v.mu before the
	// callback, so both finish.
	close(release)

	for i := 0; i < 2; i++ {
		select {
		case k := <-readerDone:
			// Asserted, not ignored: a resolver that returned "" would mean the
			// reader never really reached the vault, and the deadlock it is here
			// to provoke would have been dodged rather than fixed.
			if k != "key-one" && k != "key-two" {
				t.Fatalf("resolver returned %q, so it never read a real tenant key and this test proved nothing", k)
			}
		case res := <-switchDone:
			if res["ok"] != true {
				t.Fatalf("SetActive failed: %v", res)
			}
		case <-time.After(deadlockBudget):
			t.Fatalf("DEADLOCK: neither the tenant switch nor the auth resolver completed within %s. "+
				"This is the 2026-08-26 hang: SetActive holds the vault mutex and waits on the auth "+
				"lock while a resolver holds the auth lock and waits on the vault mutex", deadlockBudget)
		}
	}

	if got := v.ActiveKey(); got != "key-two" {
		t.Fatalf("after the switch the active key is %q, want key-two", got)
	}
}

// The lock-boundary invariant on its own, because the cycle test above passes as
// soon as EITHER edge is cut and so cannot say which one. Codex's finding 6 on
// this change, and it was right: a test that proves "no cycle" is not a test
// that proves "the vault never calls out under its lock", and it is the second
// property that stops the next callback added to rotateAuth from reopening this.
func TestRotateAuthRunsWithTheVaultMutexReleased(t *testing.T) {
	v := newUnlockedVault(t,
		Tenant{ID: "t1", Label: "One", Key: "key-one"},
		Tenant{ID: "t2", Label: "Two", Key: "key-two"},
	)

	// The callback tries to take v.mu the only way an outsider can: through a
	// public accessor. If the mutation still held the lock this would block, so
	// the timeout below is the assertion.
	reached := make(chan string, 1)
	v.SetAuthReset(func() {
		done := make(chan string, 1)
		go func() { done <- v.ActiveKey() }()
		select {
		case k := <-done:
			reached <- k
		case <-time.After(2 * time.Second):
			reached <- "" // blocked: the lock was still held
		}
	})

	res := v.SetActive("t2")
	if res["ok"] != true {
		t.Fatalf("SetActive failed: %v", res)
	}
	select {
	case k := <-reached:
		if k == "" {
			t.Fatal("rotateAuth ran while the vault mutex was still held: a callback that reads the vault through ActiveKey blocked. " +
				"Anything the callback touches that resolves back through this vault will deadlock, which is the 2026-08-26 outage")
		}
		if k != "key-two" {
			t.Fatalf("the callback saw active key %q, want key-two — rotateAuth must run AFTER the mutation is committed", k)
		}
	case <-time.After(deadlockBudget):
		t.Fatal("the auth reset callback never ran at all")
	}
}

// The same boundary for the auth side. Kept separate from the vault's for the
// same reason: one test per invariant, so a failure names which one broke.
func TestAuthResolvesWithItsOwnLockReleased(t *testing.T) {
	var auth *rest.Auth
	reached := make(chan bool, 1)

	// The resolver reaches back into the auth for a WRITE. Under the old code
	// Value held a.mu (a read lock) across this call, so the write blocked;
	// nothing about a.mu is reentrant.
	auth = rest.NewAuth("fallback-key", func() string {
		done := make(chan struct{})
		go func() { auth.SetOverride(""); close(done) }()
		select {
		case <-done:
			reached <- true
		case <-time.After(2 * time.Second):
			reached <- false
		}
		return "resolved-key"
	})

	// IdentityValue, not Value: the fallback is non-empty here, and Value would
	// return the fallback without ever calling the resolver. IdentityValue with
	// a fallback set does the same, so the fallback is cleared first.
	auth.SetFallback("")
	go func() { _ = auth.IdentityValue() }()

	select {
	case ok := <-reached:
		if !ok {
			t.Fatal("rest.Auth held its own lock across the active() resolver: a call back into the Auth blocked. " +
				"That is the edge that let a tenant switch and an inbound request deadlock on 2026-08-26")
		}
	case <-time.After(deadlockBudget):
		t.Fatal("the auth resolver never ran")
	}
}
