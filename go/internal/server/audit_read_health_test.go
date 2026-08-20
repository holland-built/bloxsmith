package server

import (
	"os"
	"path/filepath"
	"testing"
)

// --- what the audit API says about the entries it could not READ -------------
//
// Sibling of audit_health_test.go, and deliberately a separate file because it
// is a separate failure. That one covers entries that never reached disk;
// this one covers entries that are on disk and did not reach the response.
//
// audit.Log.Read returns (entries, skipped, error) and auditLog discarded the
// last two: `entries, _, _ := d.Audit.Read()`. So a log the process could not
// open answered 200 with `entries: []`, and a log with corrupt lines answered
// 200 with a shorter list, with nothing in the payload attached to the LIST
// saying either had happened.
//
// WHAT WAS ALREADY THERE, measured before this was written rather than assumed:
// chain_verify_error is set on both paths, carrying "audit log could not be
// read: ..." and "audit log incomplete: 2 line(s) could not be decoded". So the
// operator was not blind. What they got was an integrity verdict — the line
// about whether the file was tampered with — standing in for a fact about
// whether the table under it is complete. Those are different questions with
// different answers: on the skipped-lines path the surviving entries are all
// genuine, and on a healthy day a short list means a quiet day.
//
// These two fields let the list answer for itself. They are additive; every
// existing consumer of chain_verify_error is untouched.

func TestAuditLog_UnreadableLogIsNotAQuietDay(t *testing.T) {
	// A directory where the log file should be. os.Open succeeds and the first
	// read returns EISDIR — a real read failure through the real path, not an
	// injected error.
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	if err := os.Mkdir(logPath, 0o755); err != nil {
		t.Fatalf("prepare unreadable log path: %v", err)
	}
	d := auditDepsAt(t, logPath)

	body := getAuditLog(t, d)

	entries, _ := body["entries"].([]any)
	if len(entries) != 0 {
		t.Fatalf("entries = %d, want 0 — this test's premise is that the read returns nothing", len(entries))
	}
	msg, ok := body["read_error"].(string)
	if !ok || msg == "" {
		t.Fatalf("read_error missing from %v — the response returned an empty log with no way to tell "+
			"an unreadable file apart from a log with nothing in it", body)
	}
}

func TestAuditLog_CorruptLinesAreCounted(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	d := auditDepsAt(t, logPath)
	d.auditAppend("snooze", "tester", map[string]any{"category": "dns"})

	// Two lines the JSON decoder will refuse, appended after a real entry so the
	// file is genuinely part-readable rather than wholly broken.
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open log for corruption: %v", err)
	}
	if _, err := f.WriteString("{not json at all\n[\"also\", \"not\", \"an\", \"object\"\n"); err != nil {
		t.Fatalf("write corrupt lines: %v", err)
	}
	f.Close()

	body := getAuditLog(t, d)

	n, ok := body["skipped_lines"].(float64)
	if !ok {
		t.Fatalf("skipped_lines missing from %v — two unparseable lines were dropped and the response "+
			"is the only place an operator would see the list is short", body)
	}
	if int(n) != 2 {
		t.Fatalf("skipped_lines = %d, want 2", int(n))
	}
}

func TestAuditLog_HealthyLogOmitsBothReadFields(t *testing.T) {
	d := auditDepsAt(t, filepath.Join(t.TempDir(), "audit_log.jsonl"))
	d.auditAppend("snooze", "tester", map[string]any{"category": "dns"})

	body := getAuditLog(t, d)

	// Absent, not present-and-zero. Same rule as last_append_failure: a field
	// that appears on every healthy response is a field nobody reads on the one
	// response that sets it.
	for _, k := range []string{"read_error", "skipped_lines"} {
		if v, present := body[k]; present {
			t.Fatalf("%s is present (%v) on a log that read cleanly; it must be absent", k, v)
		}
	}
}
