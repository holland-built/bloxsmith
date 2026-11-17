package server

import (
	"reflect"
	"testing"
)

// A seed preview runs one block read and one read per site. Its final frame
// carries what all of them checked, added up, and every pick they skipped, so
// the Provision page can say what the seed checked as the other previews do.
func TestSeedFinishCarriesCheckedAndSkippedPicks(t *testing.T) {
	var frames []map[string]any
	run := &seedRun{emit: func(f map[string]any) { frames = append(frames, f) }, dry: true,
		summary: map[string]any{"succeeded": []any{}, "failed": []any{}, "skipped": []any{}}}

	run.saw(map[string]any{
		"checked":       map[string]any{"spaces": 2, "networks": 10, "ranges": 3, "reservations": 4, "hosts": 1, "age_seconds": 12, "read_at": "2026-11-17T10:00:12Z"},
		"skipped_picks": []any{map[string]any{"candidate": "10.1.0.0/24", "reason": "a subnet in lab already uses 10.1.0.0/24"}},
	})
	run.saw(map[string]any{
		"checked":       map[string]any{"spaces": 3, "networks": 5, "ranges": 1, "reservations": 0, "hosts": 2, "age_seconds": 40, "read_at": "2026-11-17T10:00:00Z"},
		"skipped_picks": []any{},
	})
	run.saw(map[string]any{"skipped": true}) // a site skipped as already there read nothing
	run.finish("provision-seed-demo", nil)

	last := frames[len(frames)-1]
	want := map[string]any{"spaces": 3, "networks": 15, "ranges": 4, "reservations": 4, "hosts": 3,
		"age_seconds": 40, "read_at": "2026-11-17T10:00:00Z"}
	if !reflect.DeepEqual(last["checked"], want) {
		t.Fatalf("checked = %#v, want %#v", last["checked"], want)
	}
	picks, _ := last["skipped_picks"].([]any)
	if len(picks) != 1 || picks[0].(map[string]any)["candidate"] != "10.1.0.0/24" {
		t.Fatalf("skipped_picks = %#v", last["skipped_picks"])
	}
	if last["skipped"] != 0 {
		t.Fatalf("skipped count changed: %#v", last["skipped"])
	}
}

// A run that read nothing (a teardown, or a seed whose templates would not
// load) says nothing about what was checked, rather than "0 of everything".
func TestSeedFinishWithoutReadsHasNoChecked(t *testing.T) {
	var frames []map[string]any
	run := &seedRun{emit: func(f map[string]any) { frames = append(frames, f) }, dry: true,
		summary: map[string]any{"succeeded": []any{}, "failed": []any{}, "skipped": []any{}}}
	run.finish("provision-seed-demo", nil)
	if _, ok := frames[0]["checked"]; ok {
		t.Fatalf("checked sent for a run that read nothing: %#v", frames[0])
	}
}
