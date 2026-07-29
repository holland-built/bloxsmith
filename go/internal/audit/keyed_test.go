package audit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newTestLog binds a Log to logPath with its trust root in a SEPARATE temp
// directory. That separation is the property under test — a test that put the
// key beside the log would not be testing what ships.
func newTestLog(t *testing.T, logPath string) *Log {
	t.Helper()
	return New(logPath, "app-v9.9.9", "deadbeef", Options{TrustDir: t.TempDir()})
}

// fixedClock gives Append a deterministic, fractional ts.
func fixedClock(l *Log) {
	ts := 1752624000.5
	l.now = func() float64 { ts += 20; return ts }
}

func appendN(t *testing.T, l *Log, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		if _, err := l.Append("write-authorized", "loopback",
			map[string]any{"method": "POST", "path": "/api/edit/host"}); err != nil {
			t.Fatalf("Append %d: %v", i, err)
		}
	}
}

func readLines(t *testing.T, p string) []string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimRight(string(b), "\n"), "\n")
}

func writeLines(t *testing.T, p string, lines []string) {
	t.Helper()
	body := ""
	for _, l := range lines {
		body += l + "\n"
	}
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// reforge is the attack from the security audit, written out: an attacker who
// can write audit_log.jsonl edits an entry and recomputes every following hash.
// It needs no secret — the old chain was a plain unkeyed SHA-256 — so this is
// about ten lines in any language. stripSignatures models the smarter variant
// that also deletes the seq/key_id/mac fields to make the chain look like a
// pre-keyed one, which is the downgrade the sealed head has to catch.
func reforge(t *testing.T, l *Log, logPath string, edit func([]map[string]any), stripSignatures bool) {
	t.Helper()
	entries, skipped, err := l.Read()
	if err != nil || skipped != 0 {
		t.Fatalf("Read before forging: err=%v skipped=%d", err, skipped)
	}
	edit(entries)
	prev := zeroHash
	lines := make([]string, 0, len(entries))
	for _, e := range entries {
		if stripSignatures {
			delete(e, "mac")
			delete(e, "key_id")
			delete(e, "seq")
		}
		e["prev_hash"] = prev
		delete(e, "hash")
		h, err := l.entryHash(e)
		if err != nil {
			t.Fatal(err)
		}
		e["hash"] = h
		prev = h
		b, err := canonicalJSON(e)
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, string(b))
	}
	writeLines(t, logPath, lines)
}

// --- the four things the old chain could not detect -------------------------

// TestForgedEntryIsDetected is the headline regression: rewriting an entry and
// recomputing every following hash used to leave Verify() returning valid:true,
// because the hash took no secret. The stale signature now gives it away.
func TestForgedEntryIsDetected(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	l := newTestLog(t, logPath)
	fixedClock(l)
	appendN(t, l, 4)

	if v, _ := l.Verify()["valid"].(bool); !v {
		t.Fatal("the freshly written chain did not verify — the test is broken before it starts")
	}

	reforge(t, l, logPath, func(entries []map[string]any) {
		d, _ := entries[1]["detail"].(map[string]any)
		d["path"] = "/api/edit/something-else"
	}, false)

	res := l.Verify()
	if v, _ := res["valid"].(bool); v {
		t.Fatalf("Verify() accepted a forged chain: %v — this is the exact defect being fixed", res)
	}
	if idx, _ := res["broken_index"].(int); idx != 1 {
		t.Fatalf("broken_index = %v, want 1", res["broken_index"])
	}
	if _, unverifiable := res["verify_error"]; unverifiable {
		t.Fatalf("a forgery was reported as could-not-verify rather than tampering: %v", res)
	}
}

// TestSignatureStrippingIsDetected covers the downgrade: the attacker deletes
// the signature fields as well, so the chain looks exactly like one written
// before the keyed rewrite and every plain hash checks out. Only the sealed
// head — which records how many entries there are and what the last one hashes
// to, under a key the attacker does not have — catches it.
func TestSignatureStrippingIsDetected(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	l := newTestLog(t, logPath)
	fixedClock(l)
	appendN(t, l, 4)

	reforge(t, l, logPath, func(entries []map[string]any) {
		d, _ := entries[2]["detail"].(map[string]any)
		d["path"] = "/api/edit/something-else"
	}, true)

	res := l.Verify()
	if v, _ := res["valid"].(bool); v {
		t.Fatalf("Verify() accepted a chain with its signatures stripped: %v", res)
	}
	if res["broken_index"] == nil {
		t.Fatalf("a signature-stripped forgery was reported as could-not-verify rather than tampering: %v", res)
	}
}

// TestTruncatedTailIsDetected: cutting entries off the end was undetectable by
// construction — Verify walked forward from a zero hash with no entry count, so
// any prefix of a valid chain was itself a valid chain. The sealed count fixes
// exactly that, and broken_index points at the first entry that should be there.
func TestTruncatedTailIsDetected(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	l := newTestLog(t, logPath)
	fixedClock(l)
	appendN(t, l, 5)

	lines := readLines(t, logPath)
	if len(lines) != 5 {
		t.Fatalf("want 5 lines, got %d", len(lines))
	}
	writeLines(t, logPath, lines[:3]) // the last two entries simply deleted

	res := l.Verify()
	if v, _ := res["valid"].(bool); v {
		t.Fatalf("Verify() accepted a truncated chain: %v", res)
	}
	if idx, _ := res["broken_index"].(int); idx != 3 {
		t.Fatalf("broken_index = %v, want 3 (the first entry that should be present and is not)", res["broken_index"])
	}
	if reason, _ := res["broken_reason"].(string); !strings.Contains(reason, "removed from the end") {
		t.Fatalf("broken_reason does not say what happened: %q", reason)
	}
}

// TestWholeChainDeletionIsDetected: deleting the log outright is the crudest
// truncation, and "the file is gone" must not read as "the log is empty, all
// clear" once a chain has been sealed.
func TestWholeChainDeletionIsDetected(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	l := newTestLog(t, logPath)
	fixedClock(l)
	appendN(t, l, 3)

	if err := os.Remove(logPath); err != nil {
		t.Fatal(err)
	}
	res := l.Verify()
	if v, _ := res["valid"].(bool); v {
		t.Fatalf("Verify() reported a deleted 3-entry chain as intact: %v", res)
	}
	if idx, _ := res["broken_index"].(int); idx != 0 {
		t.Fatalf("broken_index = %v, want 0", res["broken_index"])
	}
}

// --- key loss and rotation are NOT tampering --------------------------------

// TestRotatedKeyIsNotReportedAsTampering is the honesty guard. A wiped config
// directory, a container without persistent storage, or a deliberate key
// rotation all leave entries signed with a key this process does not hold. The
// chain may be perfectly intact; we simply cannot check it. Reporting that as
// "someone forged your audit log" would be an invented accusation — the exact
// class of defect this codebase spent the week removing.
func TestRotatedKeyIsNotReportedAsTampering(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	first := newTestLog(t, logPath)
	fixedClock(first)
	appendN(t, first, 3)

	second := newTestLog(t, logPath) // fresh trust dir => a different key
	if first.KeyID() == second.KeyID() {
		t.Fatal("the two test logs share a key; this test proves nothing")
	}

	res := second.Verify()
	if v, _ := res["valid"].(bool); v {
		t.Fatalf("a chain signed with an unavailable key was reported intact: %v", res)
	}
	if res["broken_index"] != nil {
		t.Fatalf("broken_index = %v, want nil — a key we do not hold is not evidence of tampering", res["broken_index"])
	}
	msg, _ := res["verify_error"].(string)
	if !strings.Contains(msg, first.KeyID()) || !strings.Contains(msg, second.KeyID()) {
		t.Fatalf("verify_error does not name both keys, so the operator cannot tell what happened: %q", msg)
	}
}

// TestNoKeyIsNeverReportedAsIntact: when the trust root cannot be established
// at all, entries are still recorded — losing the record of a real mutation is
// worse than losing the signature on it — but the verdict must say so.
func TestNoKeyIsNeverReportedAsIntact(t *testing.T) {
	dir := t.TempDir()
	// A regular file where the trust directory should be: MkdirAll fails, so no
	// key can be generated or read.
	blocked := filepath.Join(dir, "not-a-directory")
	if err := os.WriteFile(blocked, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(dir, "audit_log.jsonl")
	l := New(logPath, "app-v9.9.9", "deadbeef", Options{TrustDir: blocked})
	fixedClock(l)

	if l.KeyError() == nil {
		t.Fatal("expected a key error when the trust directory cannot be created")
	}
	if _, err := l.Append("write-authorized", "loopback", map[string]any{"method": "POST"}); err != nil {
		t.Fatalf("Append refused to record an event because it could not sign it: %v", err)
	}
	if n := len(readLines(t, logPath)); n != 1 {
		t.Fatalf("the event was not recorded: %d lines", n)
	}

	res := l.Verify()
	if v, _ := res["valid"].(bool); v {
		t.Fatalf("an unsigned chain was reported intact: %v", res)
	}
	if res["broken_index"] != nil {
		t.Fatalf("broken_index = %v, want nil — unsigned is not tampered", res["broken_index"])
	}
	if msg, _ := res["verify_error"].(string); msg == "" {
		t.Fatalf("no verify_error explaining the missing key: %v", res)
	}
}

// TestMissingHeadIsCouldNotVerify: the seal living outside the log's directory
// is what makes truncation detectable, so its absence means truncation cannot
// be ruled out. That is could-not-verify, not intact and not tampered.
func TestMissingHeadIsCouldNotVerify(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	l := newTestLog(t, logPath)
	fixedClock(l)
	appendN(t, l, 2)

	if err := os.Remove(l.headFile()); err != nil {
		t.Fatal(err)
	}
	res := l.Verify()
	if v, _ := res["valid"].(bool); v {
		t.Fatalf("a chain with no seal was reported intact: %v", res)
	}
	if res["broken_index"] != nil {
		t.Fatalf("broken_index = %v, want nil", res["broken_index"])
	}
}

// TestAlteredHeadIsDetected: rewriting the seal to match a truncated log needs
// the key, so a hand-edited head record fails its own MAC.
func TestAlteredHeadIsDetected(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	l := newTestLog(t, logPath)
	fixedClock(l)
	appendN(t, l, 4)

	h, err := l.readHead()
	if err != nil || h == nil {
		t.Fatalf("readHead: %v %v", h, err)
	}
	h.Count = 2 // the attacker's wish: pretend the chain was always this short
	b, _ := json.Marshal(h)
	if err := os.WriteFile(l.headFile(), b, 0o600); err != nil {
		t.Fatal(err)
	}

	res := l.Verify()
	if v, _ := res["valid"].(bool); v {
		t.Fatalf("an altered seal was accepted: %v", res)
	}
	if res["broken_index"] == nil {
		t.Fatalf("an altered seal was reported as could-not-verify rather than tampering: %v", res)
	}
}

// TestStaleHeadWithSignedEntriesStillVerifies pins the deliberate asymmetry in
// Verify: a seal SHORT of the log is the normal outcome of a failed reseal
// after a successful append, and reporting that as tampering would be a false
// accusation against the app's own crash. It is safe precisely because every
// entry past the seal must still carry a valid signature.
func TestStaleHeadWithSignedEntriesStillVerifies(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	l := newTestLog(t, logPath)
	fixedClock(l)
	appendN(t, l, 3)

	entries, _, err := l.Read()
	if err != nil {
		t.Fatal(err)
	}
	firstHash, _ := entries[0]["hash"].(string)
	if err := l.writeHead(1, firstHash); err != nil { // roll the seal back two entries
		t.Fatal(err)
	}

	res := l.Verify()
	if v, _ := res["valid"].(bool); !v {
		t.Fatalf("a stale seal over fully signed entries was reported as a problem: %v", res)
	}
}

// TestUnsignedEntryAppendedPastSealIsDetected is the other half of that
// asymmetry: the tolerance above must not become a hole to append forged
// entries through.
func TestUnsignedEntryAppendedPastSealIsDetected(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	l := newTestLog(t, logPath)
	fixedClock(l)
	appendN(t, l, 2)

	entries, _, err := l.Read()
	if err != nil {
		t.Fatal(err)
	}
	last, _ := entries[1]["hash"].(string)
	forged := map[string]any{
		"ts":        json.Number("1752624999.0"),
		"event":     "write-authorized",
		"actor":     "loopback",
		"detail":    map[string]any{"method": "DELETE", "path": "/api/teardown", "image_digest": "app-v9.9.9", "instance_id": "deadbeef"},
		"prev_hash": last,
	}
	h, err := l.entryHash(forged)
	if err != nil {
		t.Fatal(err)
	}
	forged["hash"] = h
	line, err := canonicalJSON(forged)
	if err != nil {
		t.Fatal(err)
	}
	writeLines(t, logPath, append(readLines(t, logPath), string(line)))

	res := l.Verify()
	if v, _ := res["valid"].(bool); v {
		t.Fatalf("an unsigned entry appended past the seal was accepted: %v", res)
	}
	if idx, _ := res["broken_index"].(int); idx != 2 {
		t.Fatalf("broken_index = %v, want 2", res["broken_index"])
	}
}

// --- migration --------------------------------------------------------------

// TestAdoptSealsLegacyChainThenDetectsTruncation walks the real upgrade path: a
// chain written before the keyed rewrite is unsealed (could-not-verify), gets
// adopted at startup, and truncation is caught from then on.
func TestAdoptSealsLegacyChainThenDetectsTruncation(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")

	// Write three entries the pre-keyed way: no trust dir, no key, no seal.
	legacy := New(logPath, "app-v9.9.9", "deadbeef", Options{})
	fixedClock(legacy)
	appendN(t, legacy, 3)
	for i, e := range mustRead(t, legacy) {
		if _, signed := e["mac"]; signed {
			t.Fatalf("entry %d is signed; the legacy fixture is not legacy", i)
		}
	}

	upgraded := newTestLog(t, logPath)
	if v, _ := upgraded.Verify()["valid"].(bool); v {
		t.Fatal("an unsealed legacy chain was reported intact before adoption")
	}
	if err := upgraded.Adopt(); err != nil {
		t.Fatalf("Adopt: %v", err)
	}
	if v, _ := upgraded.Verify()["valid"].(bool); !v {
		t.Fatalf("the adopted legacy chain does not verify: %v", upgraded.Verify())
	}

	writeLines(t, logPath, readLines(t, logPath)[:1])
	res := upgraded.Verify()
	if v, _ := res["valid"].(bool); v {
		t.Fatalf("truncating an adopted legacy chain went undetected: %v", res)
	}
	if idx, _ := res["broken_index"].(int); idx != 1 {
		t.Fatalf("broken_index = %v, want 1", res["broken_index"])
	}
}

// TestAdoptRefusesAlreadyBrokenChain: adoption must never launder a visibly
// tampered log into a sealed, "valid" one.
func TestAdoptRefusesAlreadyBrokenChain(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	legacy := New(logPath, "app-v9.9.9", "deadbeef", Options{})
	fixedClock(legacy)
	appendN(t, legacy, 3)

	lines := readLines(t, logPath)
	lines[1] = strings.Replace(lines[1], "/api/edit/host", "/api/edit/xxxx", 1)
	writeLines(t, logPath, lines)

	l := newTestLog(t, logPath)
	if err := l.Adopt(); err == nil {
		t.Fatal("Adopt() sealed a chain that was already broken")
	}
	res := l.Verify()
	if v, _ := res["valid"].(bool); v {
		t.Fatalf("the broken chain verified after a refused adoption: %v", res)
	}
	if res["broken_index"] == nil {
		t.Fatalf("the broken chain lost its tamper verdict: %v", res)
	}
}

// TestLegacyEntryHashesAreUnchanged pins the compatibility requirement that
// mattered most: excluding "mac" from the hash payload must not alter the hash
// of any entry that has no mac. If it did, every existing operator's real audit
// log would suddenly read as tampered — a fabricated accusation shipped to
// everyone at once.
func TestLegacyEntryHashesAreUnchanged(t *testing.T) {
	exp := loadExpected(t)
	l := newTestLog(t, filepath.Join("testdata", "audit_log.jsonl"))
	for i, e := range mustRead(t, l) {
		got, err := l.entryHash(e)
		if err != nil {
			t.Fatal(err)
		}
		want := []string{exp.Entry0Hash, exp.Entry1Hash, exp.Entry2Hash}[i]
		if got != want {
			t.Fatalf("entry %d hash changed to %s, want %s", i, got, want)
		}
	}
}

// TestKeyAndSealAreNotStoredBesideTheLog is the structural requirement stated
// as a test: a key an attacker can rewrite along with the log protects nothing.
func TestKeyAndSealAreNotStoredBesideTheLog(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	l := newTestLog(t, logPath)
	fixedClock(l)
	appendN(t, l, 1)

	found, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range found {
		if f.Name() == keyFileName || strings.HasPrefix(f.Name(), headFileName) {
			t.Fatalf("%s was written into the log's own directory", f.Name())
		}
	}
	if filepath.Dir(l.headFile()) == dir {
		t.Fatal("the seal's directory is the log's directory")
	}
}

// TestTwoLogsShareATrustDirWithoutClobbering pins a bug this change introduced
// and then fixed: one trust directory serves more than one log on the same
// machine (this repo runs a dev copy on :8090 beside the installed one on
// :8080, each with its own state directory, both resolving to the same per-user
// config directory). With a single shared seal file, each instance overwrote
// the other's and the loser reported its own untouched chain as tampered — an
// accusation invented purely by the file naming.
func TestTwoLogsShareATrustDirWithoutClobbering(t *testing.T) {
	trust := t.TempDir()
	dirA, dirB := t.TempDir(), t.TempDir()

	newOne := func(dir string) *Log {
		l := New(filepath.Join(dir, "audit_log.jsonl"), "app-v9.9.9", "deadbeef", Options{TrustDir: trust})
		fixedClock(l)
		return l
	}
	a, b := newOne(dirA), newOne(dirB)
	if a.KeyID() != b.KeyID() {
		t.Fatal("two logs in one trust directory should share the generated key")
	}
	if a.headFile() == b.headFile() {
		t.Fatal("two logs in one trust directory share a seal file — each would overwrite the other's")
	}

	appendN(t, a, 3)
	appendN(t, b, 1) // b's seal must not displace a's
	appendN(t, a, 1)

	for name, l := range map[string]*Log{"a": a, "b": b} {
		if res := l.Verify(); !res["valid"].(bool) {
			t.Fatalf("log %s failed to verify after the other instance appended: %v", name, res)
		}
	}
}

// TestDefaultTrustDirIsNotTheStateDir pins the mistake made on the first pass:
// the trust root defaulted to the per-user config directory, which on macOS is
// exactly where vault.json, .env and audit_log.jsonl already live — so the
// default install kept the key in the same directory as the log it signs, and
// the whole control was worth nothing without an env var nobody would set.
func TestDefaultTrustDirIsNotTheStateDir(t *testing.T) {
	trust, err := DefaultTrustDir()
	if err != nil {
		t.Skipf("no home or config directory in this environment: %v", err)
	}
	cfg, err := os.UserConfigDir()
	if err != nil {
		t.Skipf("no config directory: %v", err)
	}
	// The state directory is dirname(vault.json); on macOS and Linux that
	// resolves to <config dir>/bloxsmith for a standalone install.
	for _, stateDir := range []string{
		filepath.Join(cfg, "bloxsmith"),
		"/vault",
	} {
		if trust == stateDir {
			t.Fatalf("the default trust directory %s is the state directory — the key would sit beside the log", trust)
		}
	}
}

func mustRead(t *testing.T, l *Log) []map[string]any {
	t.Helper()
	entries, skipped, err := l.Read()
	if err != nil || skipped != 0 {
		t.Fatalf("Read: err=%v skipped=%d", err, skipped)
	}
	return entries
}
