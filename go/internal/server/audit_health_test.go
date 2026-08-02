package server

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/config"
)

// --- what the audit API says about the entries that never reached disk --------
//
// audit.Append can refuse (an unreadable chain, a detail value canonicalJSON
// rejects, a write that fails), and every caller in this package funnels through
// auditAppend, which discards the error into a log line. Before append_failures
// reached the API, the operator's only view of the audit trail — the Audit tab —
// showed a shorter list of entries and a chain that verified as intact, which is
// exactly what a quiet day looks like. These tests pin the difference.
//
// They assert on the decoded HTTP body rather than on AppendHealth's return
// value on purpose: the handler is the part that could drop the keys, and a
// helper-level assertion would still pass with the merge deleted.

// auditDepsAt wires a Deps whose audit log lives at logPath. No upstream server
// is needed — nothing here talks to CSP.
func auditDepsAt(t *testing.T, logPath string) *Deps {
	t.Helper()
	return &Deps{
		Cfg:   &config.Config{Port: "8080"},
		Audit: audit.New(logPath, "app-v-test", "test-instance", audit.Options{TrustDir: t.TempDir()}),
	}
}

// getAuditLog runs GET /api/audit/log and returns the decoded body.
func getAuditLog(t *testing.T, d *Deps) map[string]any {
	t.Helper()
	rr := httptest.NewRecorder()
	d.auditLog(rr, httptest.NewRequest("GET", "/api/audit/log", nil))
	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	return decodeBody(t, rr)
}

func TestAuditLog_ReportsAppendFailures(t *testing.T) {
	// A directory where the log file should be: os.Open succeeds, the first read
	// returns EISDIR, so Append refuses to extend a chain it cannot read. This is
	// a real refusal through the real code path, not an injected counter.
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	if err := os.Mkdir(logPath, 0o755); err != nil {
		t.Fatalf("prepare unreadable log path: %v", err)
	}
	d := auditDepsAt(t, logPath)

	d.auditAppend("snooze", "tester", map[string]any{"category": "dns"})
	d.auditAppend("dns-record-update", "someone-else", map[string]any{"id": "dns/record/rec-1"})

	body := getAuditLog(t, d)

	n, ok := body["append_failures"].(float64)
	if !ok {
		t.Fatalf("append_failures missing or not a number in %v — two events were refused and "+
			"the response is the only place an operator would see that", body)
	}
	if int(n) != 2 {
		t.Fatalf("append_failures = %d, want 2", int(n))
	}

	last, ok := body["last_append_failure"].(map[string]any)
	if !ok {
		t.Fatalf("last_append_failure missing or not an object in %v", body)
	}
	if last["event"] != "dns-record-update" {
		t.Fatalf("last_append_failure.event = %v, want dns-record-update (the most recent refusal)", last["event"])
	}
	if last["actor"] != "someone-else" {
		t.Fatalf("last_append_failure.actor = %v, want someone-else", last["actor"])
	}
	if s, _ := last["error"].(string); s == "" {
		t.Fatalf("last_append_failure.error is empty; want the reason the entry was refused: %v", last)
	}
}

func TestAuditLog_CleanInstanceOmitsLastAppendFailure(t *testing.T) {
	d := auditDepsAt(t, filepath.Join(t.TempDir(), "audit_log.jsonl"))
	d.auditAppend("snooze", "tester", map[string]any{"category": "dns"})

	body := getAuditLog(t, d)

	n, ok := body["append_failures"].(float64)
	if !ok || int(n) != 0 {
		t.Fatalf("append_failures = %v, want 0 on a log that recorded everything it was given", body["append_failures"])
	}
	// Absent, not present-and-empty. A consumer that renders on the key existing
	// would otherwise show a failure banner naming an event that never failed.
	if _, present := body["last_append_failure"]; present {
		t.Fatalf("last_append_failure is present (%v) on a clean log; it must be absent, "+
			"since a zero-value placeholder reads as a real dropped entry", body["last_append_failure"])
	}
}
