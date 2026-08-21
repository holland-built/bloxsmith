package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/config"
	"bloxsmith/internal/httpx"
)

// --- /api/audit/export is not admin-only any more (issue #170) ----------------
//
// The gate was removed on 2026-08-20 because it withheld nothing: /api/audit/log
// serves the same entries, the same chain verdict and the same append counters
// to a viewer, ungated, so the 403 cost the caller only exported_at and
// app_version while still stamping an rbac_denied row for a request that was not
// really being refused anything. See auditExport's doc comment.
//
// Both halves are pinned here. Re-adding the gate breaks the positive half; a
// leftover denial-logging path that fires on a request now permitted breaks the
// negative half. The negative half is the one that would otherwise rot quietly:
// a log that records a denial for every allowed request makes the real denials
// unfindable, and this route is polled by whoever presses Export.
//
// The read-honesty cases below are the export's half of the fix that
// audit_read_health_test.go pinned for /api/audit/log. They exist separately
// because the export is a DIFFERENT payload built by a DIFFERENT handler, and
// the live-view tests stay green with the export still discarding both values.

// exportDeps wires a token-guarded Deps over a real audit.Log, exactly as
// uaTokenDeps does. With Guard.Token set, a request carrying no X-Auth-Token
// resolves to viewer — the role the old gate refused — so these tests drive the
// real role resolver rather than asserting against a faked role.
func exportDeps(t *testing.T, logPath string) *Deps {
	t.Helper()
	return &Deps{
		Cfg:     &config.Config{Port: "8080"},
		Guard:   &httpx.Guard{Port: "8080", Token: "s3cr3t-dashboard-token"},
		Audit:   audit.New(logPath, "app-v-test", "test-instance", audit.Options{TrustDir: t.TempDir()}),
		Version: "v9.9.9-test",
	}
}

// getAuditExport runs GET /api/audit/export as a tokenless (viewer) caller.
func getAuditExport(t *testing.T, d *Deps) (int, map[string]any) {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/audit/export", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	d.auditExport(rr, r)
	return rr.Code, decodeBody(t, rr)
}

func TestAuditExport_ViewerIsServedTheBundle(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	d := exportDeps(t, logPath)
	d.auditAppend("snooze", "tester", map[string]any{"category": "dns"})

	// Guard against the test proving nothing: if a tokenless request resolved to
	// admin, a re-added gate would pass this file unnoticed.
	if role := d.Guard.ResolveRole(httptest.NewRequest("GET", "/api/audit/export", nil)); role != "viewer" {
		t.Fatalf("a tokenless request resolved to %q, want viewer — this test would not be "+
			"exercising the role the removed gate refused", role)
	}

	code, body := getAuditExport(t, d)
	if code != 200 {
		t.Fatalf("status = %d, want 200 — the admin gate was removed in #170; body=%v", code, body)
	}
	entries, ok := body["entries"].([]any)
	if !ok || len(entries) != 1 {
		t.Fatalf("entries = %v, want the one appended entry — a viewer already gets these "+
			"from /api/audit/log, so withholding them here bought nothing", body["entries"])
	}
	// The two fields the gate actually withheld. If they are missing, the route is
	// no longer worth calling and the gate removal fixed nothing.
	if _, ok := body["exported_at"].(float64); !ok {
		t.Fatalf("exported_at = %v (%T), want a number — it is one of only two fields this "+
			"route adds over /api/audit/log", body["exported_at"], body["exported_at"])
	}
	if body["app_version"] != "v9.9.9-test" {
		t.Fatalf("app_version = %v, want v9.9.9-test — the other field the gate withheld", body["app_version"])
	}

	// The negative half, read FROM DISK rather than from the status code: a
	// permitted request must leave no denial row. auditAppend swallows its error
	// into a log line, so a spy on the call site would be green through the bug.
	uaNone(t, logPath, "rbac_denied",
		"the export is no longer admin-gated, so a viewer's successful download is not a denial")
}

// --- the export itself is now an audited event --------------------------------
//
// Until 2026-08-21 a SUCCESSFUL export wrote nothing: state.go's only
// auditAppend calls were the rbac_denied on the removed gate and snooze's. That
// was survivable while the route was admin-only and every refusal was recorded,
// because the set of people who could reach it was already written down. #170
// removed the gate, so downloading the entire append-only audit trail — every
// actor, every tenant write, every refusal, months of it — became an
// unauthenticated, unrecorded read. Per unaudited_events_test.go's own rule, a
// security-relevant action that leaves no trace is indistinguishable from one
// nobody made.
//
// The assertion reads audit_log.jsonl FROM DISK, not a spy on the call site:
// auditAppend swallows its error into a log.Printf and the handler still returns
// the bundle with a 200, so a status-code or call-site assertion is green
// through exactly the bug.

// uaRemoteExportRequest is a NON-loopback caller, so httpx.Actor resolves to the
// IP rather than the constant "loopback". A test whose expected actor is
// "loopback" cannot tell Actor(r) apart from a hardcoded string.
func uaRemoteExportRequest() *http.Request {
	r := httptest.NewRequest("GET", "/api/audit/export", nil)
	r.RemoteAddr = "10.9.9.9:5555"
	return r
}

func TestAuditExport_SuccessfulDownloadWritesAuditEntry(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	d := exportDeps(t, logPath)
	for i := 0; i < 3; i++ {
		d.auditAppend("snooze", "tester", map[string]any{"i": i})
	}

	rr := httptest.NewRecorder()
	d.auditExport(rr, uaRemoteExportRequest())
	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	body := decodeBody(t, rr)

	entries := auditEntries(t, logPath, "audit-export")
	if len(entries) != 1 {
		t.Fatalf("audit-export entries on disk = %d, want exactly 1 — the whole audit trail left "+
			"the process and nothing records who took it", len(entries))
	}
	if entries[0]["actor"] != "10.9.9.9" {
		t.Fatalf("audit actor = %v, want 10.9.9.9 — the row exists to name the caller, and this "+
			"route no longer requires one to be an admin", entries[0]["actor"])
	}
	detail := uaDetail(t, entries[0])
	if detail["entries"] != float64(3) {
		t.Fatalf("audit detail entries = %v, want 3 — the count is how much of the trail left, "+
			"and it is the one number worth keeping", detail["entries"])
	}

	// THE ORDERING, PINNED. The row is appended after Read() has already returned,
	// so the bundle carries the three pre-existing entries and NOT the row that
	// records its own download. The alternative — appending first — would make the
	// bundle contain a row claiming N entries were exported while carrying N+1,
	// i.e. a bundle that contradicts the count inside it.
	got, _ := body["entries"].([]any)
	if len(got) != 3 {
		t.Fatalf("exported entries = %d, want the 3 that existed when the read ran — the export's "+
			"own audit row must not land inside the bundle it is counting", len(got))
	}
	for _, e := range got {
		if m, _ := e.(map[string]any); m["event"] == "audit-export" {
			t.Fatalf("the bundle contains its own audit-export row: %v", m)
		}
	}
}

// The negative half. auditExport is the only handler in this file that appends,
// and "audit unconditionally" would pass the test above while stamping a
// permanent download row for a read that never produced a bundle. A log path
// that is a directory fails Read AND fails Append, so this pins the ordering
// from the other side: nothing is recorded as exported when nothing could be.
func TestAuditExport_UnreadableLogRecordsNoExport(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	if err := os.Mkdir(logPath, 0o755); err != nil {
		t.Fatalf("prepare unreadable log path: %v", err)
	}
	d := exportDeps(t, logPath)

	rr := httptest.NewRecorder()
	d.auditExport(rr, uaRemoteExportRequest())
	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	body := decodeBody(t, rr)

	// The bundle must SAY it was a failed read rather than pass for an empty log,
	// and it must own up to the append that could not be made either — that
	// counter is the only trace left of the attempt.
	if msg, _ := body["read_error"].(string); msg == "" {
		t.Fatalf("read_error missing from %v — this test's premise is a failed read", body)
	}
	if n, _ := body["append_failures"].(float64); n < 1 {
		t.Fatalf("append_failures = %v, want at least 1 — the export row could not be written and "+
			"the bundle is the only place that can say the record of this download is missing", body["append_failures"])
	}
}

func TestAuditExport_UnreadableLogIsNotAnEmptyBundle(t *testing.T) {
	// A directory where the log file should be: os.Open succeeds and the first
	// read returns EISDIR. A real read failure down the real path.
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	if err := os.Mkdir(logPath, 0o755); err != nil {
		t.Fatalf("prepare unreadable log path: %v", err)
	}
	d := exportDeps(t, logPath)

	code, body := getAuditExport(t, d)
	if code != 200 {
		t.Fatalf("status = %d, want 200 — the export still answers, it just has to say what it could not read", code)
	}
	if entries, _ := body["entries"].([]any); len(entries) != 0 {
		t.Fatalf("entries = %d, want 0 — this test's premise is that the read returned nothing", len(entries))
	}
	msg, ok := body["read_error"].(string)
	if !ok || msg == "" {
		t.Fatalf("read_error missing from the exported bundle %v — a downloaded file that says "+
			"`entries: []` and nothing else will be read months later as proof that nothing happened", body)
	}
}

func TestAuditExport_CorruptLinesAreCountedInTheBundle(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	d := exportDeps(t, logPath)
	d.auditAppend("snooze", "tester", map[string]any{"category": "dns"})

	// Two undecodable lines after a genuine entry, so the file is part-readable
	// rather than wholly broken — the case that exports SHORT instead of empty,
	// and therefore the case nobody notices.
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open log for corruption: %v", err)
	}
	if _, err := f.WriteString("{not json at all\n[\"also\", \"not\", \"an\", \"object\"\n"); err != nil {
		t.Fatalf("write corrupt lines: %v", err)
	}
	f.Close()

	_, body := getAuditExport(t, d)
	n, ok := body["skipped_lines"].(float64)
	if !ok {
		t.Fatalf("skipped_lines missing from the exported bundle %v — two lines on disk never "+
			"reached the download and the bundle is the only place that could say so", body)
	}
	if int(n) != 2 {
		t.Fatalf("skipped_lines = %d, want 2", int(n))
	}
}

func TestAuditExport_HealthyBundleOmitsBothReadFields(t *testing.T) {
	d := exportDeps(t, filepath.Join(t.TempDir(), "audit_log.jsonl"))
	d.auditAppend("snooze", "tester", map[string]any{"category": "dns"})

	_, body := getAuditExport(t, d)

	// Absent, not present-and-zero. Same rule as read_error on /api/audit/log: a
	// key on every healthy bundle is a key nobody reads on the one that sets it.
	for _, k := range []string{"read_error", "skipped_lines"} {
		if v, present := body[k]; present {
			t.Fatalf("%s is present (%v) in a bundle that read cleanly; it must be absent", k, v)
		}
	}
}
