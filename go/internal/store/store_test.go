package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	return New(t.TempDir())
}

// sig mirrors what BuildSignals hands StampFirstSeen in production: every
// signal already carries a fabricated detected_at:now stamp (signals.go)
// before StampFirstSeen ever runs. Without this, the degraded-path
// assertions below ("detected_at must be absent") passed vacuously — there
// was never a detected_at to begin with, fabricated or not, so the tests
// could not have caught StampFirstSeen failing to delete it.
func sig(category, entityID string) map[string]any {
	return map[string]any{"category": category, "entity_id": entityID, "detected_at": now()}
}

// First run: no first_seen.json on disk yet. This is a legitimate empty
// state, not a failure — StampFirstSeen must behave exactly as before:
// stamp detected_at = now, no degraded flag, and persist the new history.
func TestStampFirstSeen_FirstRun_NoFileYet(t *testing.T) {
	s := newTestStore(t)
	out := s.StampFirstSeen([]map[string]any{sig("dns", "e1")})

	if v, ok := out[0]["first_seen_unknown"]; ok {
		t.Fatalf("first run must not be flagged degraded, got first_seen_unknown=%v", v)
	}
	if out[0]["detected_at"] == nil {
		t.Fatalf("expected detected_at to be stamped on a genuine first run")
	}
	if _, err := os.Stat(s.firstSeenFile()); err != nil {
		t.Fatalf("expected first_seen.json to be written after a first run: %v", err)
	}
}

// A valid, decodable history file must be loaded and used: an existing
// signal's original first-seen timestamp must survive, not be reset to now.
// "last" is set a few seconds ago (inside the 15-minute flap-protection
// grace window) so the entry is recognized as still open, matching the
// normal poll-to-poll case — not the "we were away a long time" reset case.
func TestStampFirstSeen_ValidHistory_AgesPreserved(t *testing.T) {
	s := newTestStore(t)
	n := now()
	oldFirst := n - 3600 // detected an hour ago
	lastSeen := n - 5    // and still active 5s ago
	history := map[string]map[string]float64{
		"dns" + firstSeenEntitySep + "e1": {"first": oldFirst, "last": lastSeen},
	}
	b, err := json.Marshal(history)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(s.firstSeenFile()), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.firstSeenFile(), b, 0o600); err != nil {
		t.Fatal(err)
	}

	out := s.StampFirstSeen([]map[string]any{sig("dns", "e1")})

	if v, ok := out[0]["first_seen_unknown"]; ok {
		t.Fatalf("valid history must not be flagged degraded, got first_seen_unknown=%v", v)
	}
	got, _ := out[0]["detected_at"].(float64)
	if got != oldFirst {
		t.Fatalf("expected preserved first-seen %v, got %v (age would have reset to 0)", oldFirst, got)
	}
}

// An undecodable (corrupt) history file must be treated as a failure, not as
// "nothing has ever been seen": the signal must not get a fabricated
// detected_at=now, must be flagged first_seen_unknown, and — the data-loss
// guard — the original bytes on disk must survive untouched (no empty map
// written back over real history).
func TestStampFirstSeen_UndecodableFile_FailsSafely(t *testing.T) {
	s := newTestStore(t)
	if err := os.MkdirAll(filepath.Dir(s.firstSeenFile()), 0o755); err != nil {
		t.Fatal(err)
	}
	original := []byte(`not valid json{{{`)
	if err := os.WriteFile(s.firstSeenFile(), original, 0o600); err != nil {
		t.Fatal(err)
	}

	out := s.StampFirstSeen([]map[string]any{sig("dns", "e1")})

	if out[0]["first_seen_unknown"] != true {
		t.Fatalf("expected first_seen_unknown=true on decode failure, got %v", out[0]["first_seen_unknown"])
	}
	if v, ok := out[0]["detected_at"]; ok {
		t.Fatalf("must not stamp a fabricated detected_at=now on a failed load, got %v", v)
	}

	after, err := os.ReadFile(s.firstSeenFile())
	if err != nil {
		t.Fatalf("first_seen.json should still exist untouched: %v", err)
	}
	if string(after) != string(original) {
		t.Fatalf("data loss: original bytes were not preserved.\nwant: %s\ngot:  %s", original, after)
	}
}

// An unreadable path (here: a directory sitting where the file should be, so
// os.ReadFile fails with something other than "not exist") must be handled
// the same as a corrupt file: flagged, not stamped with now, and the path
// left untouched rather than being clobbered by a write attempt.
func TestStampFirstSeen_UnreadablePath_FailsSafely(t *testing.T) {
	s := newTestStore(t)
	if err := os.MkdirAll(s.firstSeenFile(), 0o755); err != nil {
		t.Fatal(err)
	}

	out := s.StampFirstSeen([]map[string]any{sig("dns", "e1")})

	if out[0]["first_seen_unknown"] != true {
		t.Fatalf("expected first_seen_unknown=true when the path is unreadable, got %v", out[0]["first_seen_unknown"])
	}
	if v, ok := out[0]["detected_at"]; ok {
		t.Fatalf("must not stamp a fabricated detected_at=now when unreadable, got %v", v)
	}

	fi, err := os.Stat(s.firstSeenFile())
	if err != nil || !fi.IsDir() {
		t.Fatalf("path should still be the untouched directory: err=%v isDir=%v", err, fi != nil && fi.IsDir())
	}
}

// A brand-new store whose views/ directory has never been created is a
// legitimate first run — no view has ever been saved. This must behave
// exactly as before: an empty list, reported as success (nil error), not a
// failure.
func TestViewsList_DirMissing_EmptyAndSuccessful(t *testing.T) {
	s := newTestStore(t)

	out, err := s.ViewsList()
	if err != nil {
		t.Fatalf("a never-created views dir must not be an error, got %v", err)
	}
	views, _ := out["views"].([]map[string]any)
	if len(views) != 0 {
		t.Fatalf("expected an empty views list, got %v", views)
	}
}

// If the views directory exists but cannot be read (here: a plain file sits
// where the directory should be, so os.ReadDir fails with something other
// than "not exist"), that is a real failure and must NOT be reported as "no
// saved views" — the caller needs to be able to tell the two apart.
func TestViewsList_DirUnreadable_ReportsFailureNotEmpty(t *testing.T) {
	s := newTestStore(t)
	if err := os.WriteFile(s.viewsDir, []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}

	out, err := s.ViewsList()
	if err == nil {
		t.Fatalf("expected an error when the views dir is unreadable, got out=%v", out)
	}
	if out != nil {
		t.Fatalf("must not also hand back a (fabricated) views list alongside the error, got %v", out)
	}
}

// One undecodable file among several otherwise-valid saved views must not
// silently vanish from the list while the rest render normally — that would
// misreport a real read/decode failure as "this one view doesn't exist". The
// failure must surface to the caller instead.
func TestViewsList_OneUndecodableFile_FailureSurfaced(t *testing.T) {
	s := newTestStore(t)
	if err := os.MkdirAll(s.viewsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	good := `{"name":"good-view","saved_at":"2026-01-01T00:00:00Z","folder":""}`
	if err := os.WriteFile(filepath.Join(s.viewsDir, "a-good.json"), []byte(good), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.viewsDir, "b-bad.json"), []byte("not valid json{{{"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.viewsDir, "c-good.json"), []byte(good), 0o644); err != nil {
		t.Fatal(err)
	}

	out, err := s.ViewsList()
	if err == nil {
		t.Fatalf("expected the undecodable file to surface as an error, got out=%v", out)
	}
	if out != nil {
		t.Fatalf("must not hand back a partial views list alongside the error, got %v", out)
	}
}
