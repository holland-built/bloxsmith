package audit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// expected mirrors testdata/expected.json, produced by the Python source-of-truth
// generator (server.py's exact _audit_entry_hash + json.dumps defaults).
type expected struct {
	SampleCanonical string `json:"sample_canonical"`
	SampleHash      string `json:"sample_hash"`
	Entry0Hash      string `json:"entry0_hash"`
	Entry1Hash      string `json:"entry1_hash"`
	Entry2Hash      string `json:"entry2_hash"`
}

func loadExpected(t *testing.T) expected {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "expected.json"))
	if err != nil {
		t.Fatalf("read expected.json: %v", err)
	}
	var e expected
	if err := json.Unmarshal(b, &e); err != nil {
		t.Fatalf("parse expected.json: %v", err)
	}
	return e
}

// sampleValue is the SAME dict the Python generator serialized for
// expected.sample_canonical. If the Go canonical encoder disagrees by even one
// space in a separator (", " / ": ") or one escape (ü / surrogate pair),
// the bytes and thus the hash diverge — this test exists to catch exactly that.
func sampleValue() map[string]any {
	return map[string]any{
		"ts":    json.Number("1752624000.123456"),
		"event": "write-authorized",
		"actor": "Zürich ☃ 😀",
		"detail": map[string]any{
			"method":       "POST",
			"path":         "/api/edit/host",
			"image_digest": "app-v1.2.3",
			"instance_id":  "ab12cd34",
			"minutes":      5,
		},
		"prev_hash": zeroHash,
	}
}

// TestCanonicalJSONByteParity is the mandatory parity gate: Go's canonical JSON
// must equal Python's json.dumps(sort_keys=True) byte-for-byte.
func TestCanonicalJSONByteParity(t *testing.T) {
	exp := loadExpected(t)
	got, err := canonicalJSON(sampleValue())
	if err != nil {
		t.Fatalf("canonicalJSON: %v", err)
	}
	if string(got) != exp.SampleCanonical {
		t.Fatalf("canonical JSON mismatch:\n Go    : %s\n Python: %s", got, exp.SampleCanonical)
	}
}

// TestVerifyPythonWrittenChain proves Go verifies a chain written by Python's
// exact hashing algorithm, and recomputes each entry's hash identically.
func TestVerifyPythonWrittenChain(t *testing.T) {
	exp := loadExpected(t)
	l := New(filepath.Join("testdata", "audit_log.jsonl"), "app-v1.2.3", "ab12cd34")

	entries, skipped, err := l.Read()
	if err != nil {
		t.Fatalf("Read() error: %v", err)
	}
	if skipped != 0 {
		t.Fatalf("want 0 skipped, got %d", skipped)
	}
	if len(entries) != 3 {
		t.Fatalf("want 3 entries, got %d", len(entries))
	}
	wantHashes := []string{exp.Entry0Hash, exp.Entry1Hash, exp.Entry2Hash}
	for i, e := range entries {
		got, err := l.entryHash(e)
		if err != nil {
			t.Fatalf("entry %d hash: %v", i, err)
		}
		if got != wantHashes[i] {
			t.Fatalf("entry %d hash mismatch: Go %s vs Python %s", i, got, wantHashes[i])
		}
		if stored, _ := e["hash"].(string); got != stored {
			t.Fatalf("entry %d: Go hash %s != stored hash %s", i, got, stored)
		}
	}

	res := l.Verify()
	if v, _ := res["valid"].(bool); !v {
		t.Fatalf("Verify() on Python chain = %v, want valid", res)
	}
}

// TestVerifyDetectsTampering: flipping one byte in a payload field must break
// the chain — the whole point of hashing over canonical JSON.
func TestVerifyDetectsTampering(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "audit_log.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	// Change the snooze category "dns_down" -> "dns_up" without recomputing hash.
	tampered := []byte{}
	for _, b := range src {
		tampered = append(tampered, b)
	}
	tampered = []byte(replaceFirst(string(tampered), "dns_down", "dns_upXX"))
	dir := t.TempDir()
	p := filepath.Join(dir, "audit_log.jsonl")
	if err := os.WriteFile(p, tampered, 0o600); err != nil {
		t.Fatal(err)
	}
	l := New(p, "app-v1.2.3", "ab12cd34")
	res := l.Verify()
	if v, _ := res["valid"].(bool); v {
		t.Fatal("Verify() accepted a tampered chain")
	}
	if idx, _ := res["broken_index"].(int); idx != 1 {
		t.Fatalf("broken_index = %v, want 1", res["broken_index"])
	}
}

func replaceFirst(s, old, new string) string {
	for i := 0; i+len(old) <= len(s); i++ {
		if s[i:i+len(old)] == old {
			return s[:i] + new + s[i+len(old):]
		}
	}
	return s
}

// TestGoWrittenChainVerifies: the writer + pyFloat path is internally
// consistent (Append then Verify green), and links entries correctly.
func TestGoWrittenChainVerifies(t *testing.T) {
	dir := t.TempDir()
	l := New(filepath.Join(dir, "audit_log.jsonl"), "app-v9.9.9", "deadbeef")
	ts := 1752624000.5
	l.now = func() float64 { ts += 20; return ts } // fractional -> real float repr

	if _, err := l.Append("write-authorized", "loopback",
		map[string]any{"method": "POST", "path": "/api/edit/host"}); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Append("snooze", "loopback",
		map[string]any{"category": "dns_down", "minutes": 5}); err != nil {
		t.Fatal(err)
	}
	res := l.Verify()
	if v, _ := res["valid"].(bool); !v {
		t.Fatalf("Go-written chain failed self-verify: %v", res)
	}
	entries, skipped, err := l.Read()
	if err != nil {
		t.Fatalf("Read() error: %v", err)
	}
	if skipped != 0 {
		t.Fatalf("want 0 skipped, got %d", skipped)
	}
	if n := len(entries); n != 2 {
		t.Fatalf("want 2 entries, got %d", n)
	}
}

// TestVerifyEmptyLogIsValid: a missing/never-written log file is a genuinely
// empty chain, not a read failure — it must still verify as intact.
func TestVerifyEmptyLogIsValid(t *testing.T) {
	dir := t.TempDir()
	l := New(filepath.Join(dir, "audit_log.jsonl"), "app-v1.2.3", "ab12cd34")

	res := l.Verify()
	if v, _ := res["valid"].(bool); !v {
		t.Fatalf("Verify() on empty log = %v, want valid", res)
	}
	if res["broken_index"] != nil {
		t.Fatalf("broken_index = %v, want nil", res["broken_index"])
	}
	if _, ok := res["verify_error"]; ok {
		t.Fatalf("verify_error present on a valid empty log: %v", res)
	}
}

// TestVerifyUnreadableFileCannotVerify: when the log cannot even be opened
// (here: the path is a directory, so os.Open succeeds but reading from it
// fails), Verify() must report "could not verify" — never "valid": true, and
// never conflated with a broken/tampered chain (broken_index must stay nil).
func TestVerifyUnreadableFileCannotVerify(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	if err := os.Mkdir(logPath, 0o755); err != nil {
		t.Fatal(err)
	}
	l := New(logPath, "app-v1.2.3", "ab12cd34")

	res := l.Verify()
	if v, _ := res["valid"].(bool); v {
		t.Fatalf("Verify() on an unreadable log = %v, want valid:false", res)
	}
	if res["broken_index"] != nil {
		t.Fatalf("broken_index = %v, want nil (unreadable is not the same as broken)", res["broken_index"])
	}
	msg, _ := res["verify_error"].(string)
	if msg == "" {
		t.Fatalf("verify_error missing/empty for an unreadable log: %v", res)
	}
}

// TestVerifyDroppedLineCannotVerify: a line that fails to decode mid-file
// must NOT be silently skipped into a short-but-"valid" chain — Verify() must
// report could-not-verify with the skipped count, distinct from both valid
// and broken.
func TestVerifyDroppedLineCannotVerify(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	l := New(logPath, "app-v9.9.9", "deadbeef")
	ts := 1752624000.5
	l.now = func() float64 { ts += 20; return ts }

	if _, err := l.Append("write-authorized", "loopback",
		map[string]any{"method": "POST", "path": "/api/edit/host"}); err != nil {
		t.Fatal(err)
	}

	// Corrupt the log by appending a malformed line by hand, mid-file.
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("{not valid json\n"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	res := l.Verify()
	if v, _ := res["valid"].(bool); v {
		t.Fatalf("Verify() with a dropped line = %v, want valid:false", res)
	}
	if res["broken_index"] != nil {
		t.Fatalf("broken_index = %v, want nil (a dropped line is not the same as tampering)", res["broken_index"])
	}
	msg, _ := res["verify_error"].(string)
	if msg == "" {
		t.Fatalf("verify_error missing/empty for a chain with a dropped line: %v", res)
	}
}

// TestVerifyUnverifiableIsDistinctFromValid is the explicit regression guard
// for the actual defect: "could not verify" must never be reportable as
// indistinguishable from "valid". A caller that only checks res["valid"]
// would otherwise treat an unreadable/incomplete chain as proof of
// integrity — the worst possible failure mode for a tamper-evident log.
func TestVerifyUnverifiableIsDistinctFromValid(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	if err := os.Mkdir(logPath, 0o755); err != nil {
		t.Fatal(err)
	}
	l := New(logPath, "app-v1.2.3", "ab12cd34")

	unverifiable := l.Verify()
	valid, _ := unverifiable["valid"].(bool)
	_, hasReason := unverifiable["verify_error"]
	if valid {
		t.Fatal("unverifiable chain reported valid:true — this is the exact defect being fixed")
	}
	if !hasReason {
		t.Fatal("unverifiable chain has no verify_error to distinguish it from a clean valid:false/broken result")
	}

	emptyLog := New(filepath.Join(dir, "other_audit_log.jsonl"), "app-v1.2.3", "ab12cd34")
	valid2 := emptyLog.Verify()
	v2, _ := valid2["valid"].(bool)
	if !v2 {
		t.Fatalf("genuinely empty log incorrectly reported unverifiable/invalid: %v", valid2)
	}
}
