package audit

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func fullVerifies(l *Log) int {
	l.memoMu.Lock()
	defer l.memoMu.Unlock()
	return l.fullVerifies
}

// TestVerifyUnchangedLogIsNotWalkedAgain: the Audit page polls Verify every 30
// seconds. With nothing appended in between, the second call must answer from
// the remembered verdict instead of re-walking every entry; an append must
// bring the full walk back. Before the memo every call was a full walk.
func TestVerifyUnchangedLogIsNotWalkedAgain(t *testing.T) {
	l := newTestLog(t, filepath.Join(t.TempDir(), "audit_log.jsonl"))
	appendN(t, l, 5)

	for i := range 3 {
		if state, detail := Classify(l.Verify()); state != Intact {
			t.Fatalf("call %d: %s (%s), want intact", i, state, detail)
		}
	}
	if n := fullVerifies(l); n != 1 {
		t.Fatalf("3 verifies of an unchanged log made %d full walks, want 1", n)
	}

	appendN(t, l, 1)
	if state, _ := Classify(l.Verify()); state != Intact {
		t.Fatalf("after an append: %s, want intact", state)
	}
	if n := fullVerifies(l); n != 2 {
		t.Fatalf("an append did not bring back the full walk (walks=%d, want 2)", n)
	}
}

// TestVerifyMemoStillCatchesDisguisedTampering is the security half: once a
// verdict is remembered, an edit that keeps the file the same length and puts
// its modification time back must still be reported as tampered. A memo keyed
// on size or mtime would wave this through.
func TestVerifyMemoStillCatchesDisguisedTampering(t *testing.T) {
	p := filepath.Join(t.TempDir(), "audit_log.jsonl")
	l := newTestLog(t, p)
	appendN(t, l, 3)
	if state, _ := Classify(l.Verify()); state != Intact {
		t.Fatalf("baseline: %s, want intact", state)
	}

	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	// Same length: swap one character inside the first entry's actor field.
	edited := bytes.Replace(raw, []byte(`loopback`), []byte(`loopbacK`), 1)
	if bytes.Equal(edited, raw) || len(edited) != len(raw) {
		t.Fatal("the test edit did not apply as a same-length change")
	}
	if err := os.WriteFile(p, edited, 0o600); err != nil {
		t.Fatal(err)
	}
	mt := st.ModTime()
	if err := os.Chtimes(p, mt, mt); err != nil {
		t.Fatal(err)
	}
	if st2, _ := os.Stat(p); st2.Size() != st.Size() || !st2.ModTime().Equal(mt) {
		t.Fatalf("could not disguise the edit (size %d->%d, mtime %v->%v)", st.Size(), st2.Size(), mt, st2.ModTime())
	}

	if state, detail := Classify(l.Verify()); state != Tampered {
		t.Fatalf("a same-size, mtime-restored edit read as %s (%s), want tampered", state, detail)
	}
}

// TestVerifyMemoStillCatchesHeadTampering: the sealed head is part of the
// fingerprint too, so a rewritten head after a remembered verdict is caught.
func TestVerifyMemoStillCatchesHeadTampering(t *testing.T) {
	l := newTestLog(t, filepath.Join(t.TempDir(), "audit_log.jsonl"))
	appendN(t, l, 3)
	if state, _ := Classify(l.Verify()); state != Intact {
		t.Fatalf("baseline: %s, want intact", state)
	}
	hb, err := os.ReadFile(l.headFile())
	if err != nil {
		t.Fatal(err)
	}
	edited := bytes.Replace(hb, []byte(`"count":3`), []byte(`"count":2`), 1)
	if bytes.Equal(edited, hb) {
		t.Fatalf("head did not contain count 3: %s", hb)
	}
	if err := os.WriteFile(l.headFile(), edited, 0o600); err != nil {
		t.Fatal(err)
	}
	if state, detail := Classify(l.Verify()); state != Tampered {
		t.Fatalf("an altered head read as %s (%s), want tampered", state, detail)
	}
}
