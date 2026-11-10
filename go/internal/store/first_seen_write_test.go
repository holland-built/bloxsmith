package store

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

// TestStampFirstSeen_RepeatPollDoesNotRewrite: /api/incidents polls every 20
// seconds. A poll that starts no record and prunes none must not rewrite
// first_seen.json; before, every poll rewrote it (last_poll always moves).
// Ages must still come out the same.
func TestStampFirstSeen_RepeatPollDoesNotRewrite(t *testing.T) {
	s := New(t.TempDir())
	first := s.StampFirstSeen([]map[string]any{sig("dns", "e1")})
	before, err := os.ReadFile(s.firstSeenFile())
	if err != nil {
		t.Fatalf("first poll did not write the history: %v", err)
	}

	second := s.StampFirstSeen([]map[string]any{sig("dns", "e1")})
	after, _ := os.ReadFile(s.firstSeenFile())
	if !bytes.Equal(before, after) {
		t.Fatal("a poll with nothing new rewrote first_seen.json")
	}
	if first[0]["detected_at"] != second[0]["detected_at"] {
		t.Fatalf("detected_at moved between polls: %v -> %v", first[0]["detected_at"], second[0]["detected_at"])
	}

	// A new signal is a new record, so it is written at once.
	s.StampFirstSeen([]map[string]any{sig("dns", "e1"), sig("dhcp", "e2")})
	var m map[string]map[string]float64
	b, _ := os.ReadFile(s.firstSeenFile())
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["dhcp"+firstSeenEntitySep+"e2"]; !ok {
		t.Fatal("a newly seen signal was not written to first_seen.json")
	}
}

// TestStampFirstSeen_OutsideEditIsReadBack: the in-memory copy is used only
// while the file is as this process left it. An edit from outside (here, an
// older first-seen time for the same signal) must be read and believed.
func TestStampFirstSeen_OutsideEditIsReadBack(t *testing.T) {
	s := New(t.TempDir())
	s.StampFirstSeen([]map[string]any{sig("dns", "e1")})

	n := now()
	edited := map[string]map[string]float64{
		"dns" + firstSeenEntitySep + "e1": {"first": n - 600, "last": n},
		firstSeenMeta:                     {"last_poll": n},
	}
	b, _ := json.Marshal(edited)
	if err := os.WriteFile(s.firstSeenFile(), append(b, ' ', ' ', ' '), 0o600); err != nil {
		t.Fatal(err)
	}
	out := s.StampFirstSeen([]map[string]any{sig("dns", "e1")})
	if got := out[0]["detected_at"]; got != n-600 {
		t.Fatalf("detected_at = %v, want the edited first-seen %v", got, n-600)
	}
}
