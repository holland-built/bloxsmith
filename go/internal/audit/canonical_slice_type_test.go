package audit

import (
	"strings"
	"testing"
)

// The []string trap.
//
// canonicalJSON's type switch is CLOSED: nil, bool, string, json.Number,
// float64, int, int64, map[string]any, []any — everything else hits the default
// branch and comes back as an error. A Go author writing an audit detail map
// reaches for []string by reflex ([]string{"amer","emea"}, a fields list, a set
// of ids), and []string is not on that list.
//
// What makes it a trap rather than a compile error is what happens next:
// Append propagates the error, and the server's auditAppend wrapper only
// log.Printf's it. The HTTP request still returns 200. The audit entry is never
// written. Nothing anywhere says the record is missing except one line in the
// server log. That is exactly how provision-seed-demo and teardown-seed-demo
// (which passed parseRegions' []string straight through) went unrecorded from
// the day they were written.
//
// So: widen to []any at the audit boundary. Append now does that for every
// caller (widen.go), which is what makes the closed switch below safe to rely
// on rather than a trap — but the switch staying closed is the reason widen can
// refuse a struct honestly instead of inventing a rendering for it. This test
// pins both halves: the rejection that keeps unrepresentable values out, and
// the []any encoding that widening must produce.
func TestCanonicalJSONRejectsStringSliceAcceptsAnySlice(t *testing.T) {
	regions := []string{"amer", "emea"}

	if _, err := canonicalJSON(map[string]any{"regions": regions}); err == nil {
		t.Fatal("canonicalJSON accepted a []string — the closed type switch is the whole " +
			"defence here, and auditAppend turns this error into a silently dropped entry")
	} else if !strings.Contains(err.Error(), "unsupported type []string") {
		t.Fatalf("rejection message = %q, want it to name the offending type []string "+
			"(the server log line is the ONLY signal an entry was dropped)", err)
	}

	widened := make([]any, len(regions))
	for i, v := range regions {
		widened[i] = v
	}
	got, err := canonicalJSON(map[string]any{"regions": widened})
	if err != nil {
		t.Fatalf("canonicalJSON([]any) = %v, want nil — widening is the prescribed fix", err)
	}
	// Python's json.dumps(..., sort_keys=True) spacing, since the hash depends on it.
	if want := `{"regions": ["amer", "emea"]}`; string(got) != want {
		t.Fatalf("canonicalJSON([]any) = %s, want %s", got, want)
	}
}
