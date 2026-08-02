package audit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every assertion in this file is about what is ON DISK. A test that only
// checked Append's return value would have passed all through the period when
// provision-seed-demo, teardown-seed-demo and dns-record-update were writing
// nothing at all — the caller discards that error, so the file is the only
// witness that matters.

// readOnlyLine returns the single line the log is expected to hold.
func onlyLine(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("audit log not written at all: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("audit log holds %d lines, want exactly 1", len(lines))
	}
	return lines[0]
}

// TestAppendWritesOrdinaryGoValuesToDisk is the regression for the whole class:
// a detail map holding the types a Go author actually reaches for.
func TestAppendWritesOrdinaryGoValuesToDisk(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	l := newTestLog(t, logPath)
	fixedClock(l)

	if _, err := l.Append("provision-seed-demo", "loopback", map[string]any{
		"regions": []string{"amer", "emea"},
		"ports":   []int{53, 853},
		"tags":    map[string]string{"env": "prod"},
		"nested":  map[string]any{"zones": []string{"a", "b"}},
	}); err != nil {
		t.Fatalf("Append: %v", err)
	}

	entries, skipped, err := l.Read()
	if err != nil || skipped != 0 {
		t.Fatalf("Read: err=%v skipped=%d", err, skipped)
	}
	if len(entries) != 1 {
		t.Fatalf("the log holds %d entries, want 1 — the entry never reached disk", len(entries))
	}
	d, ok := entries[0]["detail"].(map[string]any)
	if !ok {
		t.Fatalf("detail is %T, want an object", entries[0]["detail"])
	}

	if got := d["regions"]; !equalAny(got, []any{"amer", "emea"}) {
		t.Fatalf("detail.regions = %#v, want []any{\"amer\",\"emea\"}", got)
	}
	if got := d["ports"]; !equalAny(got, []any{json.Number("53"), json.Number("853")}) {
		t.Fatalf("detail.ports = %#v, want the two port numbers unchanged", got)
	}
	tags, _ := d["tags"].(map[string]any)
	if tags == nil || tags["env"] != "prod" {
		t.Fatalf("detail.tags = %#v, want {\"env\":\"prod\"}", d["tags"])
	}
	nested, _ := d["nested"].(map[string]any)
	if nested == nil {
		t.Fatalf("detail.nested = %#v, want an object", d["nested"])
	}
	// The nested slice is what a non-recursive widen would drop on the floor.
	if got := nested["zones"]; !equalAny(got, []any{"a", "b"}) {
		t.Fatalf("detail.nested.zones = %#v, want []any{\"a\",\"b\"} — widening must recurse", got)
	}

	if v := l.Verify(); v["valid"] != true {
		t.Fatalf("Verify() = %#v, want intact — a widened entry must still hash and chain normally", v)
	}
}

// TestAppendWidenPreservesBytes is the hash-stability guard. widen sits upstream
// of the hash input, so anything that already encoded must still encode to the
// SAME bytes — otherwise this change silently rewrites what future entries hash.
func TestAppendWidenPreservesBytes(t *testing.T) {
	// One shared trust root so both logs sign with the same key; separate log
	// directories so each holds exactly one entry at seq 0 off the same zero
	// prev_hash. Every field except detail is then identical by construction,
	// which is what makes a whole-line comparison meaningful.
	trust := t.TempDir()
	write := func(detail map[string]any) string {
		p := filepath.Join(t.TempDir(), "audit_log.jsonl")
		l := New(p, "app-v9.9.9", "deadbeef", Options{TrustDir: trust})
		fixedClock(l)
		if _, err := l.Append("write-authorized", "loopback", detail); err != nil {
			t.Fatalf("Append: %v", err)
		}
		return onlyLine(t, p)
	}

	// 9007199254740993 is 2^53+1: it survives an int, and does NOT survive a
	// trip through float64. Routing ints through a float (or through a float-
	// formatted json.Number) is the realistic way this could go wrong.
	const bigInt = 9007199254740993

	viaGoTypes := write(map[string]any{"regions": []string{"a"}, "n": 3, "big": bigInt})
	viaAnyTypes := write(map[string]any{"regions": []any{"a"}, "n": 3, "big": bigInt})

	if viaGoTypes != viaAnyTypes {
		t.Fatalf("widening changed the written line.\n []string: %s\n   []any: %s", viaGoTypes, viaAnyTypes)
	}

	// And pin the exact bytes, so "identical to each other" cannot mean
	// "identically wrong". Python's json.dumps(sort_keys=True) spacing.
	want := `"detail": {"big": 9007199254740993, "image_digest": "app-v9.9.9", ` +
		`"instance_id": "deadbeef", "n": 3, "regions": ["a"]}`
	if !strings.Contains(viaAnyTypes, want) {
		t.Fatalf("canonical detail bytes changed.\n got line: %s\nwant substring: %s", viaAnyTypes, want)
	}
}

// TestAppendRefusesStructAndCountsIt pins the deliberate limit: a value widen
// cannot represent faithfully is still refused, and the refusal is counted
// rather than papered over with a stringified rendering of the Go value.
func TestAppendRefusesStructAndCountsIt(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit_log.jsonl")
	l := newTestLog(t, logPath)
	fixedClock(l)

	type opaque struct{ Field string }
	_, err := l.Append("dns-record-update", "loopback", map[string]any{"bad": opaque{"x"}})
	if err == nil {
		t.Fatal("Append accepted a struct — widen must not invent a rendering for a value " +
			"canonicalJSON cannot encode; a made-up value in the permanent record is worse than a counted gap")
	}
	if !strings.Contains(err.Error(), "unsupported type") {
		t.Fatalf("error = %v, want it to name the unsupported type", err)
	}
	if _, serr := os.Stat(logPath); !os.IsNotExist(serr) {
		t.Fatalf("a refused entry left something on disk (stat err = %v)", serr)
	}

	h := l.AppendHealth()
	if h["append_failures"] != 1 {
		t.Fatalf("AppendHealth()[append_failures] = %v, want 1", h["append_failures"])
	}
	last, _ := h["last_append_failure"].(map[string]any)
	if last == nil {
		t.Fatal("last_append_failure missing after a refusal — the count alone does not say what was lost")
	}
	if last["event"] != "dns-record-update" || last["actor"] != "loopback" {
		t.Fatalf("last_append_failure = %#v, want the refused event and actor", last)
	}
	if s, _ := last["error"].(string); !strings.Contains(s, "unsupported type") {
		t.Fatalf("last_append_failure.error = %q, want the underlying reason", s)
	}
}

// TestAppendHealthCleanOmitsLastFailure: absent, not a zero-value placeholder.
func TestAppendHealthCleanOmitsLastFailure(t *testing.T) {
	l := newTestLog(t, filepath.Join(t.TempDir(), "audit_log.jsonl"))
	fixedClock(l)
	appendN(t, l, 2)

	h := l.AppendHealth()
	if h["append_failures"] != 0 {
		t.Fatalf("append_failures = %v after two clean appends, want 0", h["append_failures"])
	}
	if _, present := h["last_append_failure"]; present {
		t.Fatalf("last_append_failure present on a clean log (%#v) — an empty placeholder makes "+
			"\"nothing failed\" and \"something failed\" look the same", h)
	}
}

// TestAppendHealthCountsEveryFailurePath walks Append's error returns one at a
// time. Each sub-test is a different recordAppendFailure call site; delete any
// one of them and exactly one of these goes red.
func TestAppendHealthCountsEveryFailurePath(t *testing.T) {
	cases := []struct {
		name    string
		setup   func(t *testing.T, dir string) string // returns the log path
		wantErr string
	}{
		{
			name: "chain unreadable",
			setup: func(t *testing.T, dir string) string {
				// A directory where the log file should be: opens fine, reads EISDIR.
				p := filepath.Join(dir, "audit_log.jsonl")
				if err := os.Mkdir(p, 0o755); err != nil {
					t.Fatal(err)
				}
				return p
			},
			wantErr: "chain unreadable",
		},
		{
			name: "undecodable line",
			setup: func(t *testing.T, dir string) string {
				p := filepath.Join(dir, "audit_log.jsonl")
				if err := os.WriteFile(p, []byte("this is not json\n"), 0o600); err != nil {
					t.Fatal(err)
				}
				return p
			},
			wantErr: "dropped 1 line(s)",
		},
		{
			name: "parent directory cannot be created",
			setup: func(t *testing.T, dir string) string {
				parent := filepath.Join(dir, "locked")
				if err := os.Mkdir(parent, 0o500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(parent, 0o700) })
				return filepath.Join(parent, "sub", "audit_log.jsonl")
			},
			wantErr: "permission denied",
		},
		{
			name: "log file cannot be opened",
			setup: func(t *testing.T, dir string) string {
				parent := filepath.Join(dir, "locked")
				if err := os.Mkdir(parent, 0o500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(parent, 0o700) })
				return filepath.Join(parent, "audit_log.jsonl")
			},
			wantErr: "permission denied",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if strings.Contains(tc.wantErr, "permission denied") && os.Geteuid() == 0 {
				t.Skip("running as root: a 0500 directory does not deny anything")
			}
			l := newTestLog(t, tc.setup(t, t.TempDir()))
			fixedClock(l)

			_, err := l.Append("teardown-seed-demo", "loopback", map[string]any{"k": "v"})
			if err == nil {
				t.Fatal("Append reported success on a path that cannot hold the entry")
			}
			h := l.AppendHealth()
			if h["append_failures"] != 1 {
				t.Fatalf("append_failures = %v, want 1 — this failure path is not counted, so an "+
					"operator reading AppendHealth would be told the log is healthy", h["append_failures"])
			}
			last, _ := h["last_append_failure"].(map[string]any)
			if last == nil {
				t.Fatal("last_append_failure missing")
			}
			if s, _ := last["error"].(string); !strings.Contains(s, tc.wantErr) {
				t.Fatalf("last_append_failure.error = %q, want it to contain %q", s, tc.wantErr)
			}
			if last["event"] != "teardown-seed-demo" {
				t.Fatalf("last_append_failure.event = %v, want teardown-seed-demo", last["event"])
			}
		})
	}
}

// TestWidenLeavesAcceptedTypesIdentical is the unit-level companion to the
// on-disk byte check: the accepted set must come back as itself.
func TestWidenLeavesAcceptedTypesIdentical(t *testing.T) {
	for _, v := range []any{nil, true, "s", json.Number("1.5"), 1.5, 3, int64(4)} {
		if got := widen(v); got != v {
			t.Fatalf("widen(%#v) = %#v, want the identical value — anything else changes the hash input", v, got)
		}
	}
	// uint64 above MaxInt64 keeps every digit rather than rounding through a float.
	if got := widen(uint64(18446744073709551615)); got != json.Number("18446744073709551615") {
		t.Fatalf("widen(max uint64) = %#v, want the exact decimal token", got)
	}
	// A struct comes back untouched so canonicalJSON can still refuse it.
	type opaque struct{ A int }
	if got := widen(opaque{1}); got != (any)(opaque{1}) {
		t.Fatalf("widen(struct) = %#v, want it unchanged so the refusal is honest", got)
	}
}

// equalAny compares two []any shallowly; the elements here are comparable.
func equalAny(got any, want []any) bool {
	gs, ok := got.([]any)
	if !ok || len(gs) != len(want) {
		return false
	}
	for i := range want {
		if gs[i] != want[i] {
			return false
		}
	}
	return true
}
