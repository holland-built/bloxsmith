package server

import "testing"

func TestOnlyCriticalHighKeepsMatchingEventsAndLeavesCacheAlone(t *testing.T) {
	events := []map[string]any{
		{"qname": "a", "severity": "CRITICAL"},
		{"qname": "b", "severity": "High"},
		{"qname": "c", "severity": "MEDIUM"},
		{"qname": "d", "severity": ""},
	}
	cached := map[string]any{
		"events": events, "returned": 4, "counted": 4,
		"counts":    map[string]int{"critical": 1, "high": 1, "medium": 1, "low": 0},
		"truncated": true, "complete": false, "availability": "ok",
	}

	got := onlyCriticalHigh(cached)

	kept := got["events"].([]map[string]any)
	if len(kept) != 2 || kept[0]["qname"] != "a" || kept[1]["qname"] != "b" {
		t.Fatalf("kept %v, want a and b", kept)
	}
	if got["returned"] != 2 {
		t.Errorf("returned = %v, want 2", got["returned"])
	}
	if got["truncated"] != true || got["complete"] != false || got["counted"] != 4 {
		t.Errorf("the capped-read flags did not carry over: %v", got)
	}
	if len(cached["events"].([]map[string]any)) != 4 || cached["returned"] != 4 {
		t.Errorf("the cached result was changed: %v", cached)
	}
}

func TestOnlyCriticalHighKeepsAFailedReadFailed(t *testing.T) {
	got := onlyCriticalHigh(map[string]any{
		"events": []map[string]any{}, "availability": "error", "reason": "Threat event information is unavailable",
	})
	if got["availability"] != "error" || got["reason"] != "Threat event information is unavailable" {
		t.Fatalf("a failed read lost its failure: %v", got)
	}
}

func TestHubSecurityListAllCoversTheCountCap(t *testing.T) {
	if hubSecurityListAll != 5000 {
		t.Fatalf("hubSecurityListAll = %d; it must equal the 5,000 events FetchHubSecurity counts", hubSecurityListAll)
	}
}
