package server

import (
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// --- the newest-N cap on /api/audit/log (issue #169) -------------------------
//
// The route re-sent the entire chain on every 30-second poll: 380,936 bytes for
// 838 entries when it was measured on 2026-08-21, on a file that only grows. The
// cap trims what is serialised, sent and parsed; it does not and cannot trim the
// read or the verification, because Verify() runs its own full Read().
//
// WHY THESE TESTS APPEND REAL ENTRIES INSTEAD OF WRITING JSONL BY HAND. An
// earlier draft populated the log with hand-written hashless lines. That
// technique cannot tell the two implementations apart: walkLinks fails at entry
// 0 whether the verdict is computed over the whole log or over the returned
// slice, so `chain_state` reads "tampered" either way and the assertion that
// matters is dead. Ten genuine Appends produce a genuinely valid chain, which is
// the only setup in which the discriminating assertion below can discriminate.

// capDeps wires a Deps over a real audit.Log and appends n genuine, chained,
// signed entries — one per event name, so the slice boundary can be identified
// by content rather than by position.
func capDeps(t *testing.T, n int) *Deps {
	t.Helper()
	d := auditDepsAt(t, filepath.Join(t.TempDir(), "audit_log.jsonl"))
	for i := 0; i < n; i++ {
		d.auditAppend(fmt.Sprintf("event-%d", i), "tester", map[string]any{"i": i})
	}
	return d
}

// capAt lowers the package-level cap for one test and restores it afterwards.
// auditLogReturnCap is a var solely so this is possible without appending 2000
// hash-chained entries per run.
func capAt(t *testing.T, n int) {
	t.Helper()
	prev := auditLogReturnCap
	auditLogReturnCap = n
	t.Cleanup(func() { auditLogReturnCap = prev })
}

// capEvents pulls the event name out of each returned entry, in order.
func capEvents(t *testing.T, body map[string]any) []string {
	t.Helper()
	raw, ok := body["entries"].([]any)
	if !ok {
		t.Fatalf("entries missing or not an array in %v", body)
	}
	out := make([]string, 0, len(raw))
	for i, e := range raw {
		m, ok := e.(map[string]any)
		if !ok {
			t.Fatalf("entry %d is not an object: %v", i, e)
		}
		s, _ := m["event"].(string)
		out = append(out, s)
	}
	return out
}

func capInt(t *testing.T, body map[string]any, key string) int {
	t.Helper()
	v, ok := body[key].(float64)
	if !ok {
		t.Fatalf("%s missing or not a number in %v — a capped list with no count beside it "+
			"is a short array that reads as a short log", key, body)
	}
	return int(v)
}

func TestAuditLog_CapsToNewestAndSaysSo(t *testing.T) {
	d := capDeps(t, 10)
	capAt(t, 4)

	body := getAuditLog(t, d)

	if got := capInt(t, body, "returned"); got != 4 {
		t.Fatalf("returned = %d, want 4 (the cap)", got)
	}
	if got := capInt(t, body, "total"); got != 10 {
		t.Fatalf("total = %d, want 10 — total is the number of entries THIS READ decoded, "+
			"and all ten decoded", got)
	}
	if body["truncated"] != true {
		t.Fatalf("truncated = %v, want true — ten entries were read and four were sent", body["truncated"])
	}

	// NEWEST four, in the on-disk oldest-first order within the slice.
	// auditChain.js:112 documents that order as a contract and deliberately does
	// not re-sort, so reversing here would break the Audit tab, and taking the
	// OLDEST four would show an operator the least useful end of the log.
	want := []string{"event-6", "event-7", "event-8", "event-9"}
	got := capEvents(t, body)
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("entries = %v, want %v — the cap keeps the newest, oldest-first within the slice", got, want)
	}

	// THE DISCRIMINATING ASSERTION. If the verdict were computed over the
	// RETURNED slice, walkLinks would fail immediately at the slice's first entry
	// (event-6), whose prev_hash names event-5, an entry not in the slice — the
	// verdict would be "tampered" with broken_index 0. "intact" is reachable only
	// if Verify() walked the whole ten-entry log. This is what proves the cap is a
	// payload measure and not a change to what chain_valid means.
	if body["chain_state"] != "intact" {
		t.Fatalf("chain_state = %v (broken_index=%v, detail=%v), want intact — the chain verdict "+
			"must be a verdict on the WHOLE log, not on the slice that happened to be returned",
			body["chain_state"], body["broken_index"], body["chain_detail"])
	}
	if body["chain_valid"] != true {
		t.Fatalf("chain_valid = %v, want true on ten genuinely appended entries", body["chain_valid"])
	}
}

func TestAuditLog_UnderTheCapIsNotTruncated(t *testing.T) {
	d := capDeps(t, 3)
	capAt(t, 4)

	body := getAuditLog(t, d)

	if got := capInt(t, body, "returned"); got != 3 {
		t.Fatalf("returned = %d, want 3", got)
	}
	if got := capInt(t, body, "total"); got != 3 {
		t.Fatalf("total = %d, want 3", got)
	}
	// Published on every response, not only when it fires. A `truncated` that
	// appears only when true is a field a consumer learns to ignore.
	if body["truncated"] != false {
		t.Fatalf("truncated = %v, want false — three entries is under the cap of four", body["truncated"])
	}
}

// --- the boundary itself, so `>` cannot quietly become `>=` -------------------
//
// The two tests above compare 10 against 4 and 3 against 4. Neither touches the
// boundary, so swapping the operator, or an off-by-one in the slice bound, is
// invisible to them. These three do: exactly-at-cap and cap+1 sit either side of
// the comparison, and the empty log is the degenerate case where total-cap would
// be negative if the guard ever went missing.
func TestAuditLog_CapBoundary(t *testing.T) {
	cases := []struct {
		name          string
		entries, cap  int
		wantReturned  int
		wantTruncated bool
		why           string
	}{
		{"exactly at the cap", 4, 4, 4, false,
			"four entries and a cap of four is the whole log; `>=` here would report a complete " +
				"response as truncated and drop nothing, which is a lie in the safe direction but still a lie"},
		{"one over the cap", 5, 4, 4, true,
			"the smallest possible truncation — one entry withheld. If the operator is not told here, " +
				"the field only works once the log is comfortably large, which is not when anyone checks it"},
		{"empty log", 0, 4, 0, false,
			"nothing has ever been appended; entries[0-4:] would panic and `truncated: true` would " +
				"claim entries exist that were withheld"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := capDeps(t, tc.entries)
			capAt(t, tc.cap)

			body := getAuditLog(t, d)

			if got := capInt(t, body, "returned"); got != tc.wantReturned {
				t.Fatalf("returned = %d, want %d — %s", got, tc.wantReturned, tc.why)
			}
			if got := capInt(t, body, "total"); got != tc.entries {
				t.Fatalf("total = %d, want %d", got, tc.entries)
			}
			if body["truncated"] != tc.wantTruncated {
				t.Fatalf("truncated = %v, want %v — %s", body["truncated"], tc.wantTruncated, tc.why)
			}
		})
	}
}

// --- a partial read is never labelled "the newest N" --------------------------
//
// auditLog computes `truncated := readErr == nil && total > auditLogReturnCap`,
// and that first clause is the whole rule: when Read() failed, what came back is
// a PREFIX. Every line after the failure point was never seen, so the genuinely
// newest entries may be among the ones missing, and slicing a tail off a prefix
// and calling it "the newest 4" is a fabrication — the response would name a
// number of withheld entries it has no way to know, on the endpoint whose entire
// purpose is to be trustworthy.
//
// DELETING `readErr == nil` LEAVES EVERY OTHER TEST IN THIS FILE GREEN. None of
// them produces a partial prefix longer than the cap: the read-failure cases in
// audit_health_test.go and audit_export_gate_test.go use a log path that is a
// directory, which fails on the FIRST read and returns zero entries, so the
// comparison `total > cap` is false either way and the clause never decides
// anything. This test is the only one where the clause changes the answer.
//
// HOW THE PARTIAL PREFIX IS PRODUCED, down the real code path with no seam or
// injected error: Read() scans with a bufio.Scanner capped at 8 MB
// (audit.go:216). Ten genuine, chained entries are appended first, then one line
// longer than that buffer is written after them. The scanner decodes all ten,
// then fails on the eleventh with bufio.Scanner: token too long, and Read()
// returns (those ten, 0, err) — exactly the shape the clause exists for.
func TestAuditLog_PartialReadIsNotCappedOrLabelledNewest(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	d := auditDepsAt(t, logPath)
	for i := 0; i < 10; i++ {
		d.auditAppend(fmt.Sprintf("event-%d", i), "tester", map[string]any{"i": i})
	}

	// One line over the scanner's 8 MB token limit, appended after the ten real
	// entries so the read gets a genuine partial prefix rather than nothing.
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open log to append the oversized line: %v", err)
	}
	if _, err := f.WriteString(strings.Repeat("x", 9*1024*1024) + "\n"); err != nil {
		t.Fatalf("write oversized line: %v", err)
	}
	f.Close()

	capAt(t, 4)
	body := getAuditLog(t, d)

	// Guard against the test proving nothing: if the read had succeeded, or had
	// failed before any entry decoded, the clause under test would not be the
	// thing deciding the answer.
	if msg, _ := body["read_error"].(string); msg == "" {
		t.Fatalf("read_error missing from %v — this test's premise is a read that failed PARTWAY, "+
			"and without it the clause under test is not being exercised", body)
	}
	if got := capInt(t, body, "total"); got != 10 {
		t.Fatalf("total = %d, want 10 — the ten appended entries must have decoded before the "+
			"oversized line, or this is not a partial prefix", got)
	}

	if body["truncated"] != false {
		t.Fatalf("truncated = %v, want false — the read failed partway, so the returned entries are a "+
			"PREFIX and the newest ones may be among the lines never seen; calling this \"the newest 4\" "+
			"invents a fact about entries nobody read", body["truncated"])
	}
	if got := capInt(t, body, "returned"); got != 10 {
		t.Fatalf("returned = %d, want all 10 — a partial result must be handed over whole with "+
			"read_error beside it, never sliced as though the tail were the newest", got)
	}
	if got := capEvents(t, body); got[0] != "event-0" {
		t.Fatalf("entries start at %q, want event-0 — the prefix was sliced, which is exactly the "+
			"fabrication the readErr == nil clause prevents (got %v)", got[0], got)
	}
}

func TestAuditExport_IsNotCapped(t *testing.T) {
	// Same ten-entry log, same lowered cap: the export must still carry all ten.
	// Once the read is capped, this route is the ONLY way to reach the older
	// entries, which is exactly why it was ungated in #170. A cap that applied
	// here too would quietly turn a performance constant into the thing standing
	// between a viewer and half the audit log.
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	d := exportDeps(t, logPath)
	for i := 0; i < 10; i++ {
		d.auditAppend(fmt.Sprintf("event-%d", i), "tester", map[string]any{"i": i})
	}
	capAt(t, 4)

	rr := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/audit/export", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	d.auditExport(rr, r)
	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	body := decodeBody(t, rr)

	if got := capEvents(t, body); len(got) != 10 {
		t.Fatalf("exported entries = %d (%v), want all 10 — the export is the only route to "+
			"entries older than the live view's cap", len(got), got)
	}
}
