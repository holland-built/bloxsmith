package audit

import (
	"path/filepath"
	"sync"
	"testing"
)

// The defect these two guard, in one sentence: Verify() used to read the
// entries first and the sealed head last, so an Append landing in between was
// seen as entries=N against a head recording N+1 — and reported as "N were
// removed from the end", the TAMPERED verdict, on a chain nobody had touched.
//
// Both tests assert Classify(...) == Intact rather than just a nil
// broken_index. A regression that traded the false accusation for a false
// could-not-verify would still be a wrong verdict about a healthy log, and
// checking only broken_index would wave it through.

// twoLogsOverOneChain returns two independent *Log values bound to the SAME log
// file and the SAME trust directory — so they resolve the same audit.key and
// the same sealed head, while sharing no mutex.
//
// That is the shape that matters: the fix is a read ORDER, not a lock, and only
// a second Log can prove it. `bloxsmith audit verify` and cmd/auditfixture open
// a running server's log exactly like this, from another process, where no
// in-process mutex reaches.
func twoLogsOverOneChain(t *testing.T) (verifier, writer *Log) {
	t.Helper()
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	trust := t.TempDir()
	verifier = New(logPath, "app-v9.9.9", "deadbeef", Options{TrustDir: trust})
	writer = New(logPath, "app-v9.9.9", "deadbeef", Options{TrustDir: trust})
	if verifier.KeyID() != writer.KeyID() {
		t.Fatalf("the two logs did not resolve the same key: %s vs %s", verifier.KeyID(), writer.KeyID())
	}
	return verifier, writer
}

// TestVerifyReadsHeadBeforeEntries drives the interleaving deterministically:
// the hook fires inside Verify, between its two reads, and appends one entry
// through the OTHER Log. Every run exercises the exact window, so this cannot
// pass by being scheduled kindly.
func TestVerifyReadsHeadBeforeEntries(t *testing.T) {
	verifier, writer := twoLogsOverOneChain(t)
	appendN(t, writer, 3)

	fired := 0
	readSkewHook = func() {
		fired++
		if _, err := writer.Append("write-authorized", "loopback", map[string]any{"during": "verify"}); err != nil {
			t.Errorf("append during verify: %v", err)
		}
	}
	t.Cleanup(func() { readSkewHook = nil })

	res := verifier.Verify()
	if fired != 1 {
		t.Fatalf("the seam fired %d times, want 1 — the test proved nothing", fired)
	}
	if state, detail := Classify(res); state != Intact {
		t.Fatalf("Verify() = %s (%s) for a healthy chain appended to mid-verify; want intact\nverdict: %v",
			state, detail, res)
	}
}

// TestVerifyDuringConcurrentAppends is the realistic case the operator hits:
// GET /api/audit/log while a provision run is writing entries. Kept alongside
// the deterministic test because a seam-driven test proves the ordering and
// this one proves the whole path, including the read lock that stops a verifier
// seeing a half-flushed final line.
func TestVerifyDuringConcurrentAppends(t *testing.T) {
	l := newTestLog(t, filepath.Join(t.TempDir(), "audit_log.jsonl"))
	appendN(t, l, 1)
	if err := l.Adopt(); err != nil {
		t.Fatalf("Adopt: %v", err)
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})
	var mu sync.Mutex
	var bad map[string]any
	var badState Verdict

	wg.Add(1)
	go func() {
		defer wg.Done()
		defer close(stop)
		for i := 0; i < 400; i++ {
			if _, err := l.Append("write-authorized", "loopback", map[string]any{"i": i}); err != nil {
				t.Errorf("Append %d: %v", i, err)
				return
			}
		}
	}()

	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				res := l.Verify()
				if state, _ := Classify(res); state != Intact {
					mu.Lock()
					if bad == nil {
						bad, badState = res, state
					}
					mu.Unlock()
					return
				}
			}
		}()
	}
	wg.Wait()
	if bad != nil {
		t.Fatalf("Verify() said %s about a healthy chain while it was being appended to: %v", badState, bad)
	}
}
