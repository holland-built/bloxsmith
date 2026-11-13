package dashboard

import (
	"fmt"
	"reflect"
	"testing"
)

func newListItems(f *fakeTenant) []any { return f.lists[901]["items"].([]any) }

// A risky site is flagged and left out of the preview and of what Apply adds.
func TestARiskySiteIsLeftOutUnlessTicked(t *testing.T) {
	f := newFakeTenant()
	f.threats = map[string]int{"zoom.us": 80}
	s := f.serve(t)
	res, status := applyAfterPreview(t, s, newListBody(false))
	if status != 200 || res["ok"] != true {
		t.Fatalf("apply = %d %v", status, res)
	}
	th := asMap(res["threats"])
	risky := th["risky"].([]map[string]any)
	if len(risky) != 1 || risky[0]["domain"] != "zoom.us" || risky[0]["added"] != false || th["left_out"] != 1 {
		t.Fatalf("threats = %v", th)
	}
	if items := newListItems(f); !reflect.DeepEqual(items, []any{"google.com"}) {
		t.Fatalf("list holds %v, want only google.com", items)
	}

	// Ticked: it goes in, and the preview still says it was flagged.
	f2 := newFakeTenant()
	f2.threats = map[string]int{"zoom.us": 80}
	b := newListBody(false)
	b["risky_ok"] = []any{"zoom.us"}
	res, _ = applyAfterPreview(t, f2.serve(t), b)
	if r := asMap(res["threats"])["risky"].([]map[string]any); r[0]["added"] != true {
		t.Fatalf("threats = %v", res["threats"])
	}
	if items := newListItems(f2); len(items) != 2 {
		t.Fatalf("list holds %v, want both", items)
	}
}

// A level of 0 is not a threat (threatintel.go, #87).
func TestALevelZeroRecordIsNotFlagged(t *testing.T) {
	f := newFakeTenant()
	f.threats = map[string]int{"zoom.us": 0}
	res, _ := f.serve(t).ApplyList(plan(t, newListBody(true)))
	if th := asMap(res["threats"]); len(th["risky"].([]map[string]any)) != 0 || th["left_out"] != 0 {
		t.Fatalf("threats = %v", th)
	}
}

// When the lookup fails, nothing is called clean: every site is left out and
// the preview says why, unless the owner says to add them unchecked.
func TestSitesTheCheckCouldNotLookUpAreLeftOut(t *testing.T) {
	f := newFakeTenant()
	f.threatDown = true
	res, _ := f.serve(t).ApplyList(plan(t, newListBody(true)))
	th := asMap(res["threats"])
	if th["unchecked"] != 2 || th["left_out"] != 2 || th["reason"] == "" || asMap(res["list"])["will_add"] != 0 {
		t.Fatalf("preview = %v", res)
	}
	b := newListBody(true)
	b["unchecked_ok"] = true
	res, _ = f.serve(t).ApplyList(plan(t, b))
	if th := asMap(res["threats"]); th["left_out"] != 0 || th["unchecked_added"] != true || asMap(res["list"])["will_add"] != 2 {
		t.Fatalf("preview with unchecked_ok = %v", res)
	}
}

// A site listed as a threat after the preview changes what Apply would add,
// so Apply refuses and writes nothing.
func TestASiteFlaggedAfterThePreviewStopsApply(t *testing.T) {
	f := newFakeTenant()
	s := f.serve(t)
	b := newListBody(true)
	pre, _ := s.ApplyList(plan(t, b))
	f.threats = map[string]int{"zoom.us": 80}
	b["dry"], b["fingerprint"] = false, pre["fingerprint"]
	if res, status := s.ApplyList(plan(t, b)); status != 409 {
		t.Fatalf("apply = %d %v, want 409", status, res)
	}
	if len(f.writes) != 0 {
		t.Fatalf("writes = %v", f.writes)
	}
}

func TestCheckSitesAsksInBatchesOf100(t *testing.T) {
	f := newFakeTenant()
	f.threats = map[string]int{"site-249.com": 100}
	ds := make([]string, 250)
	for i := range ds {
		ds[i] = fmt.Sprintf("site-%d.com", i)
	}
	risky, unchecked, _ := f.serve(t).CheckSites(ds)
	if f.lookups != 3 || len(unchecked) != 0 || len(risky) != 1 || risky[0].Domain != "site-249.com" || risky[0].Level != 100 {
		t.Fatalf("lookups %d risky %v unchecked %v", f.lookups, risky, unchecked)
	}
}

// A reply Bloxsmith cannot read is "could not check", never clean.
func TestAnUnreadableThreatReplyIsNotClean(t *testing.T) {
	for _, body := range []string{
		`{"threat": {}}`,
		`{"threat": [{"host": "zoom.us", "threat_level": "high"}]}`,
		`{"threat": ["zoom.us"]}`,
		`{"record_count": 0}`,
		`{"threat": [{"host": "", "threat_level": 80}]}`,
	} {
		f := newFakeTenant()
		f.threatBody = body
		_, unchecked, reason := f.serve(t).CheckSites([]string{"zoom.us", "google.com"})
		if len(unchecked) != 2 || reason == "" {
			t.Errorf("%s: unchecked %v reason %q, want both unchecked", body, unchecked, reason)
		}
	}
}

// What the check found is part of the preview: a ticked site whose listing
// changed after the preview stops Apply too.
func TestAChangedThreatListingStopsApply(t *testing.T) {
	f := newFakeTenant()
	f.threats = map[string]int{"zoom.us": 80}
	s := f.serve(t)
	b := newListBody(true)
	b["risky_ok"] = []any{"zoom.us"}
	pre, _ := s.ApplyList(plan(t, b))
	f.threatClass = "MalwareC2"
	b["dry"], b["fingerprint"] = false, pre["fingerprint"]
	if res, status := s.ApplyList(plan(t, b)); status != 409 {
		t.Fatalf("apply = %d %v, want 409", status, res)
	}
	if len(f.writes) != 0 {
		t.Fatalf("writes = %v", f.writes)
	}
}
