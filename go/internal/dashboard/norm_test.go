package dashboard

import "testing"

// TestNormFeedsNumericID locks the parity bug found in the 1d smoke: named_lists
// return a numeric id, and norm_feeds keeps it raw (Python f.get("id","")). An
// earlier orStr coercion blanked it to "". JSON decodes numbers to float64.
func TestNormFeedsNumericID(t *testing.T) {
	out := normFeeds([]any{
		map[string]any{"id": float64(736196), "name": "custom", "confidence_level": "HIGH"},
		map[string]any{"name": "no-id"}, // absent id -> ""
	})
	if got := out[0]["id"]; got != float64(736196) {
		t.Fatalf("numeric id not preserved: got %v (%T)", got, got)
	}
	if got := out[1]["id"]; got != "" {
		t.Fatalf("absent id should default to \"\": got %v", got)
	}
	// active is always true (Python: is_default or not is_default -> True).
	if out[0]["active"] != true {
		t.Fatalf("active should be true")
	}
}

// TestNormSubnetsUtil checks the utilization percentage + string-fallback chain.
func TestNormSubnetsUtil(t *testing.T) {
	out := normSubnets([]any{
		map[string]any{
			"address":     "10.0.0.0",
			"cidr":        float64(24),
			"utilization": map[string]any{"total": float64(256), "used": float64(64)},
			"tags":        map[string]any{"location": "hq"},
		},
	})
	r := out[0]
	if r["name"] != "10.0.0.0" { // name falls back to address
		t.Fatalf("name fallback: %v", r["name"])
	}
	if r["util"] != 25 {
		t.Fatalf("util: got %v want 25", r["util"])
	}
	if r["site"] != "hq" { // site falls back to tags.location
		t.Fatalf("site: %v", r["site"])
	}
}
