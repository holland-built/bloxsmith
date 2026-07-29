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

// TestNormAuditHTTPCode locks the three-state result contract: an absent
// http_code must render as "unknown", never as a fabricated "success" (the
// old default was 200) and never as "failure" either. Explicit codes still
// resolve to their real outcome.
func TestNormAuditHTTPCode(t *testing.T) {
	out := normAudit([]any{
		map[string]any{"id": "1", "action": "GET"},                     // no http_code at all
		map[string]any{"id": "2", "action": "GET", "http_code": "200"}, // explicit success
		map[string]any{"id": "3", "action": "GET", "http_code": "500"}, // explicit failure
	})
	if got := out[0]["result"]; got != "unknown" {
		t.Fatalf("missing http_code: got result=%v, want \"unknown\" (must not fabricate success)", got)
	}
	if got := out[1]["result"]; got != "success" {
		t.Fatalf("http_code 200: got result=%v, want \"success\"", got)
	}
	if got := out[2]["result"]; got != "failure" {
		t.Fatalf("http_code 500: got result=%v, want \"failure\"", got)
	}
}
