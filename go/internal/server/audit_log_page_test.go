package server

import (
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// --- ?before= paging on /api/audit/log (issue #172) ---------------------------
//
// The newest-N cap (#169) left entries older than the cap reachable only through
// /api/audit/export, which the app deliberately has no button for. ?before=N
// returns the window of entries whose position in the decoded log is < N. The
// log is append-only, so a position never moves; an offset counted from the
// newest end would shift under every append and make "Load older" overlap or
// skip rows. Setup reuses capDeps/capAt from audit_log_cap_test.go.

func getAuditLogQuery(t *testing.T, d *Deps, query string) *httptest.ResponseRecorder {
	t.Helper()
	rr := httptest.NewRecorder()
	d.auditLog(rr, httptest.NewRequest("GET", "/api/audit/log?"+query, nil))
	return rr
}

func pagedBody(t *testing.T, d *Deps, query string) map[string]any {
	t.Helper()
	rr := getAuditLogQuery(t, d, query)
	if rr.Code != 200 {
		t.Fatalf("?%s: status = %d, want 200; body=%s", query, rr.Code, rr.Body.String())
	}
	return decodeBody(t, rr)
}

func TestAuditLog_UnpagedResponseCarriesTheCursor(t *testing.T) {
	d := capDeps(t, 10)
	capAt(t, 4)
	body := getAuditLog(t, d)
	if got := capInt(t, body, "first_index"); got != 6 {
		t.Fatalf("first_index = %d, want 6 (entries 6..9 were returned)", got)
	}
	if got := capInt(t, body, "next_before"); got != 6 {
		t.Fatalf("next_before = %d, want 6 — the cursor for the page before this one", got)
	}

	small := capDeps(t, 3)
	body = getAuditLog(t, small)
	if got := capInt(t, body, "first_index"); got != 0 {
		t.Fatalf("first_index = %d, want 0 on an uncapped log", got)
	}
	if v, present := body["next_before"]; !present || v != nil {
		t.Fatalf("next_before = %v (present=%v), want null — there is nothing older to load", v, present)
	}
}

func TestAuditLog_BeforeReturnsTheWindowEndingAtCursor(t *testing.T) {
	d := capDeps(t, 10)
	capAt(t, 4)
	body := pagedBody(t, d, "before=6")

	want := []string{"event-2", "event-3", "event-4", "event-5"}
	if got := capEvents(t, body); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("entries = %v, want %v", got, want)
	}
	for key, want := range map[string]int{"returned": 4, "total": 10, "first_index": 2, "next_before": 2} {
		if got := capInt(t, body, key); got != want {
			t.Fatalf("%s = %d, want %d", key, got, want)
		}
	}
	if body["truncated"] != true {
		t.Fatalf("truncated = %v, want true — four of ten entries were sent", body["truncated"])
	}
}

func TestAuditLog_BeforeReachesTheOldestEntry(t *testing.T) {
	d := capDeps(t, 10)
	capAt(t, 4)
	body := pagedBody(t, d, "before=2")

	want := []string{"event-0", "event-1"}
	if got := capEvents(t, body); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("entries = %v, want %v", got, want)
	}
	if got := capInt(t, body, "first_index"); got != 0 {
		t.Fatalf("first_index = %d, want 0", got)
	}
	if v := body["next_before"]; v != nil {
		t.Fatalf("next_before = %v, want null at the start of the log", v)
	}
	if body["truncated"] != true {
		t.Fatalf("truncated = %v, want true — two of ten entries is still not the whole log", body["truncated"])
	}
}

func TestAuditLog_BeforeEqualToTotalIsTheNewestPage(t *testing.T) {
	d := capDeps(t, 10)
	capAt(t, 4)
	paged := pagedBody(t, d, "before=10")
	plain := getAuditLog(t, d)
	for _, key := range []string{"entries", "first_index", "next_before", "returned", "truncated"} {
		if fmt.Sprint(paged[key]) != fmt.Sprint(plain[key]) {
			t.Fatalf("%s: ?before=10 gave %v, unpaged gave %v", key, paged[key], plain[key])
		}
	}
}

// The window's first entry (event-2) has a prev_hash naming event-1, which is
// outside the window. "intact" is reachable only if the verdict still covers the
// whole log — the same discriminating trick as TestAuditLog_CapsToNewestAndSaysSo.
func TestAuditLog_PagedVerdictIsAboutTheWholeChain(t *testing.T) {
	d := capDeps(t, 10)
	capAt(t, 4)
	body := pagedBody(t, d, "before=6")
	if body["chain_state"] != "intact" || body["chain_valid"] != true {
		t.Fatalf("chain_state = %v, chain_valid = %v, want intact/true — a page must carry the "+
			"verdict on the WHOLE chain", body["chain_state"], body["chain_valid"])
	}
}

// A cursor this server issued is always in 1..total, because total only grows.
// Anything else is a typo or a log that shrank, and both deserve a refusal
// rather than a normal-looking page.
func TestAuditLog_BadCursorIs400(t *testing.T) {
	d := capDeps(t, 10)
	capAt(t, 4)
	for _, q := range []string{"before=abc", "before=0", "before=-1", "before=11", "before=2.5"} {
		rr := getAuditLogQuery(t, d, q)
		if rr.Code != 400 {
			t.Fatalf("?%s: status = %d, want 400; body=%s", q, rr.Code, rr.Body.String())
		}
		if msg, _ := decodeBody(t, rr)["error"].(string); msg == "" {
			t.Fatalf("?%s: 400 body carries no error message", q)
		}
	}
	// An empty value is the same as no parameter.
	if got := capInt(t, pagedBody(t, d, "before="), "first_index"); got != 6 {
		t.Fatalf("?before= (empty): first_index = %d, want 6 — the unpaged newest page", got)
	}
}

// When the read failed partway, positions past the failure were never seen, so
// no window can honestly be described as "the entries before N". The whole
// prefix is returned, as the unpaged route already does.
func TestAuditLog_BeforeIsIgnoredOnAPartialRead(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	d := auditDepsAt(t, logPath)
	for i := 0; i < 10; i++ {
		d.auditAppend(fmt.Sprintf("event-%d", i), "tester", map[string]any{"i": i})
	}
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open log to append the oversized line: %v", err)
	}
	if _, err := f.WriteString(strings.Repeat("x", 9*1024*1024) + "\n"); err != nil {
		t.Fatalf("write oversized line: %v", err)
	}
	f.Close()
	capAt(t, 4)

	body := pagedBody(t, d, "before=4")
	if msg, _ := body["read_error"].(string); msg == "" {
		t.Fatalf("read_error missing — this test's premise is a read that failed partway: %v", body)
	}
	if got := capInt(t, body, "returned"); got != 10 {
		t.Fatalf("returned = %d, want all 10 of the partial prefix", got)
	}
	if got := capInt(t, body, "first_index"); got != 0 {
		t.Fatalf("first_index = %d, want 0", got)
	}
	if v := body["next_before"]; v != nil {
		t.Fatalf("next_before = %v, want null on a partial read", v)
	}
	if body["truncated"] != false {
		t.Fatalf("truncated = %v, want false on a partial read", body["truncated"])
	}
}
