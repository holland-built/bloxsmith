package dashboard

import (
	"net/http"
	"testing"
)

// TestFetchHubSecurity_DnsEventFailure_MarksUnavailable verifies a dead
// dns_event feed (500) reports availability "error" with an
// operator-safe reason and zero events/counts — never the "ok" empty shape,
// which would render the Security tab's threat panels as "no threats" when
// the feed actually failed to load.
func TestFetchHubSecurity_DnsEventFailure_MarksUnavailable(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	result := s.FetchHubSecurity(3600, 50)

	if result["availability"] != "error" {
		t.Fatalf("availability = %v, want \"error\"", result["availability"])
	}
	if _, ok := result["reason"].(string); !ok {
		t.Fatalf("reason missing or wrong type: %v", result["reason"])
	}
	events, ok := result["events"].([]map[string]any)
	if !ok {
		t.Fatalf("events missing or wrong type after feed failure: %T", result["events"])
	}
	if len(events) != 0 {
		t.Fatalf("events should be empty on an unavailable feed, got %d", len(events))
	}
	if result["total"] != 0 {
		t.Fatalf("total = %v, want 0", result["total"])
	}
}

// TestFetchHubSecurity_EmptyRows_StaysOK verifies a feed that succeeds with
// zero rows reports availability "ok" — a genuine empty result must never be
// confused with an unavailable one.
func TestFetchHubSecurity_EmptyRows_StaysOK(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, nil)
	})

	result := s.FetchHubSecurity(3600, 50)

	if result["availability"] != "ok" {
		t.Fatalf("availability = %v, want \"ok\"", result["availability"])
	}
	if _, present := result["reason"]; present {
		t.Fatalf("reason should be absent on an ok result, got %v", result["reason"])
	}
	events, ok := result["events"].([]map[string]any)
	if !ok || len(events) != 0 {
		t.Fatalf("events = %v, want an empty slice", result["events"])
	}
}

// TestFetchHubHealth_DetailServicesFailure_MarksUnavailable verifies a dead
// detail_services feed never fabricates a healthy "0 deployed" rollup —
// every bucket must report availability "error" instead.
func TestFetchHubHealth_DetailServicesFailure_MarksUnavailable(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	rollup := s.FetchHubHealth()

	if len(rollup) != len(hubBuckets) {
		t.Fatalf("rollup has %d buckets, want %d", len(rollup), len(hubBuckets))
	}
	for _, b := range rollup {
		if b["availability"] != "error" {
			t.Fatalf("bucket %v availability = %v, want \"error\"", b["name"], b["availability"])
		}
		if b["status"] == "ok" {
			t.Fatalf("bucket %v status = %q, must not read as healthy on a failed feed", b["name"], b["status"])
		}
	}
}

// TestFetchHubDomains_OneFeedFailure_OthersIntact verifies a single failed
// feed (named_lists) marks only that section unavailable while the other six
// sections still populate from their own successful fetches.
func TestFetchHubDomains_OneFeedFailure_OthersIntact(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/atcfw/v1/named_lists" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if r.URL.Path == "/api/atcfw/v1/threat_feeds" {
			writeResults(w, []map[string]any{{"name": "feed1", "threat_level": "HIGH"}})
			return
		}
		writeResults(w, nil)
	})

	result := s.FetchHubDomains()

	availability, ok := result["availability"].(map[string]any)
	if !ok {
		t.Fatalf("availability missing or wrong type: %v", result["availability"])
	}
	if availability["named_lists"] != "error" {
		t.Fatalf("availability[named_lists] = %v, want \"error\"", availability["named_lists"])
	}
	if availability["threat_feeds"] != "ok" {
		t.Fatalf("availability[threat_feeds] = %v, want \"ok\"", availability["threat_feeds"])
	}
	threatFeeds, ok := result["threat_feeds"].([]map[string]any)
	if !ok || len(threatFeeds) != 1 {
		t.Fatalf("threat_feeds = %v, want the one fetched row despite named_lists failing", result["threat_feeds"])
	}
}
