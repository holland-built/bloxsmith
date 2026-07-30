package audit

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The offline verifier's safety properties, tested at the package boundary
// because they are what make the tool trustworthy at all:
//
//   - it never creates a key, so verifying cannot mint the trust root it checks
//   - it cannot append or reseal, so verifying cannot change what it verifies
//
// Each of these was watched failing with its guard removed.

func newSignedLog(t *testing.T) (logPath, trustDir string) {
	t.Helper()
	dir := t.TempDir()
	trustDir = t.TempDir()
	logPath = filepath.Join(dir, "audit_log.jsonl")
	l := New(logPath, "app-vtest", "inst-1", Options{TrustDir: trustDir})
	if err := l.KeyError(); err != nil {
		t.Fatalf("test key: %v", err)
	}
	for i := 0; i < 5; i++ {
		if _, err := l.Append("test-event", "tester", map[string]any{"n": i}); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}
	if v, _ := Classify(l.Verify()); v != Intact {
		t.Fatalf("fixture is not intact to begin with: %v", l.Verify())
	}
	return logPath, trustDir
}

// TestOpenReadOnlyNeverCreatesAKey is the property that matters most. A verifier
// that generated a missing key would write a brand-new trust root, then have no
// way at all to tell an untouched chain from a forged one — and it would report
// its own fresh key as if it proved something.
func TestOpenReadOnlyNeverCreatesAKey(t *testing.T) {
	dir := t.TempDir()
	emptyTrust := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	if err := os.WriteFile(logPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}

	l, err := OpenReadOnly(logPath, Options{TrustDir: emptyTrust})
	if err == nil {
		t.Fatal("OpenReadOnly returned no error with no key available — it must refuse, not proceed")
	}
	if l != nil && l.key != nil {
		t.Fatal("OpenReadOnly established a key when none existed")
	}

	// And nothing was written into the trust directory.
	ents, rerr := os.ReadDir(emptyTrust)
	if rerr != nil {
		t.Fatal(rerr)
	}
	if len(ents) != 0 {
		names := []string{}
		for _, e := range ents {
			names = append(names, e.Name())
		}
		t.Fatalf("verifying created files in the trust directory: %v — a verifier must not be able to write a key", names)
	}

	// The same Options WITHOUT NoGenerate must create one, so this test is
	// proving the flag rather than an unrelated failure.
	if _, gerr := loadKey(Options{TrustDir: emptyTrust}); gerr != nil {
		t.Fatalf("control case failed: a normal loadKey should have generated a key, got %v", gerr)
	}
	if _, serr := os.Stat(filepath.Join(emptyTrust, keyFileName)); serr != nil {
		t.Fatalf("control case failed: no key file after a normal loadKey: %v", serr)
	}
}

// TestReadOnlyLogRefusesEveryWrite — a verifier that could reseal the head would
// let the act of verifying launder a truncated chain into a clean one.
func TestReadOnlyLogRefusesEveryWrite(t *testing.T) {
	logPath, trustDir := newSignedLog(t)

	l, err := OpenReadOnly(logPath, Options{TrustDir: trustDir})
	if err != nil {
		t.Fatalf("OpenReadOnly: %v", err)
	}

	if _, err := l.Append("sneaky", "attacker", nil); err == nil {
		t.Error("Append succeeded on a read-only log")
	}
	if err := l.Adopt(); err == nil {
		t.Error("Adopt succeeded on a read-only log — verifying could reseal a shortened chain as clean")
	}
	if err := l.writeHead(1, "deadbeef"); err == nil {
		t.Error("writeHead succeeded on a read-only log")
	}

	// The log and the seal are byte-identical afterwards.
	before, _ := os.ReadFile(logPath)
	head, _ := os.ReadFile(l.headFile())
	_ = l.Verify()
	after, _ := os.ReadFile(logPath)
	headAfter, _ := os.ReadFile(l.headFile())
	if string(before) != string(after) {
		t.Error("Verify() changed the log file")
	}
	if string(head) != string(headAfter) {
		t.Error("Verify() changed the sealed head")
	}
}

// TestVerifierCatchesTheThreeAttacks runs the attacks the keyed chain exists to
// stop, through the read-only path, and checks the VERDICT WORD each produces —
// not just "not intact". A truncation reported as could-not-verify would be a
// miss; a rotated key reported as tampered would be a fabricated accusation.
func TestVerifierCatchesTheThreeAttacks(t *testing.T) {
	t.Run("tail cut off", func(t *testing.T) {
		logPath, trustDir := newSignedLog(t)
		lines := readLines(t, logPath)
		writeLines(t, logPath, lines[:len(lines)-2])

		l, err := OpenReadOnly(logPath, Options{TrustDir: trustDir})
		if err != nil {
			t.Fatal(err)
		}
		v, detail := Classify(l.Verify())
		if v != Tampered {
			t.Fatalf("cutting 2 entries off the end must be tampered, got %q (%s)", v, detail)
		}
		if !contains(detail, "removed from the end") {
			t.Errorf("the reason should say what happened; got %q", detail)
		}
	})

	t.Run("entry edited", func(t *testing.T) {
		logPath, trustDir := newSignedLog(t)
		lines := readLines(t, logPath)
		// Corrupt entry 2's payload. Note the space after the colon: the on-disk
		// form is the canonical encoder's, `"n": 2`. The first version of this
		// test searched for `"n":2`, found nothing, edited nothing, and passed
		// with a verdict of "intact" — a test that proved only that an untouched
		// log verifies. Hence the assertion below that the fixture actually
		// changed; a mutation test that does not check its own mutation is
		// decoration.
		before := lines[2]
		lines[2] = replaceFirst(lines[2], `"n": 2`, `"n": 999`)
		if lines[2] == before {
			t.Fatalf("the fixture was not modified, so this test would assert nothing. line was: %s", before)
		}
		writeLines(t, logPath, lines)

		l, err := OpenReadOnly(logPath, Options{TrustDir: trustDir})
		if err != nil {
			t.Fatal(err)
		}
		v, detail := Classify(l.Verify())
		if v != Tampered {
			t.Fatalf("editing an entry must be tampered, got %q (%s)", v, detail)
		}
	})

	t.Run("wrong key is could-not-verify, NOT tampered", func(t *testing.T) {
		logPath, _ := newSignedLog(t)
		otherTrust := t.TempDir()
		// A different, valid key — a rotated or lost trust root, not an attack.
		if _, err := loadKey(Options{TrustDir: otherTrust}); err != nil {
			t.Fatal(err)
		}

		l, err := OpenReadOnly(logPath, Options{TrustDir: otherTrust})
		if err != nil {
			t.Fatalf("OpenReadOnly with a valid but different key should open: %v", err)
		}
		v, detail := Classify(l.Verify())
		if v == Tampered {
			t.Fatalf("a key this process does not hold must NEVER be reported as tampering — "+
				"that is an accusation against a log that may be perfectly intact. got %q (%s)", v, detail)
		}
		if v != CouldNotVerify {
			t.Fatalf("want could-not-verify for a foreign key, got %q (%s)", v, detail)
		}
	})
}

// TestClassifyHasExactlyThreeOutcomes guards the contract itself: the map that
// Verify() returns has four relevant keys and three legal combinations, and the
// order of the checks is what stops "could not check" being read as "forged".
func TestClassifyHasExactlyThreeOutcomes(t *testing.T) {
	cases := []struct {
		name string
		in   map[string]any
		want Verdict
	}{
		{"valid", map[string]any{"valid": true, "broken_index": nil}, Intact},
		{"broken", map[string]any{"valid": false, "broken_index": 7, "broken_reason": "bad"}, Tampered},
		{"cannot verify", map[string]any{"valid": false, "broken_index": nil, "verify_error": "no key"}, CouldNotVerify},
		// The trap: valid:false AND a verify_error. Reading `valid` first reports
		// tampering for a chain nothing was proven about.
		{"cannot verify wins over valid:false", map[string]any{"valid": false, "broken_index": 3, "verify_error": "no key"}, CouldNotVerify},
		{"nil result", nil, CouldNotVerify},
		{"neither proven nor faulted", map[string]any{"valid": false, "broken_index": nil}, CouldNotVerify},
	}
	seen := map[Verdict]bool{}
	for _, c := range cases {
		got, _ := Classify(c.in)
		if got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
		seen[got] = true
	}
	if len(seen) != 3 {
		t.Errorf("Classify produced %d distinct verdicts across these cases, want exactly 3: %v", len(seen), seen)
	}
	for _, v := range []Verdict{Intact, Tampered, CouldNotVerify} {
		if !seen[v] {
			t.Errorf("no case produced %q, so it is untested", v)
		}
	}
}

// readLines / writeLines / replaceFirst are shared with keyed_test.go and
// audit_test.go — same package, one copy each.

func contains(s, sub string) bool { return strings.Contains(s, sub) }
