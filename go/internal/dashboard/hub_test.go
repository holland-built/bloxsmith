package dashboard

import (
	"net/http"
	"reflect"
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

// --- FetchServiceInventory ----------------------------------------------------

// serviceRows builds n detail_services rows that all carry one service_type.
// This is test INPUT, never an expectation: every want* below is a hand-written
// literal, so a bug in the production code cannot move the target.
func serviceRows(serviceType string, n int) []map[string]any {
	rows := make([]map[string]any, 0, n)
	for i := 0; i < n; i++ {
		rows = append(rows, map[string]any{"service_type": serviceType})
	}
	return rows
}

// TestFetchServiceInventory covers the three availability states this endpoint
// has and the two boundaries between them.
//
// The distinction that matters most is nil vs empty in service_types. An empty
// slice is an authoritative "this tenant genuinely owns nothing", and a UI is
// entitled to hide panels on it. nil is "we do not know" — returned whenever
// the answer could be wrong — and the UI must fail open. Collapsing the two
// would reproduce the failure-reads-as-safety bug the comment at hub.go:42-45
// exists to prevent, one layer up.
func TestFetchServiceInventory(t *testing.T) {
	tests := []struct {
		name             string
		fail             bool
		rows             []map[string]any
		wantAvailability string
		wantTypes        []string // nil means the JSON must be null, not []
	}{
		{
			name: "owned set is distinct and sorted, blanks dropped",
			rows: []map[string]any{
				{"service_type": "dns"},
				{"service_type": "dhcp"},
				{"service_type": "dns"},
				{"service_type": "dfp"},
				{"service_type": "ndns"},
				{"service_type": ""},
				{"other_field": "no service_type at all"},
			},
			wantAvailability: "ok",
			wantTypes:        []string{"dfp", "dhcp", "dns", "ndns"},
		},
		{
			name:             "empty tenant is ok with an empty set, not an error",
			rows:             []map[string]any{},
			wantAvailability: "ok",
			wantTypes:        []string{},
		},
		{
			name:             "dead feed is error and refuses to name an owned set",
			fail:             true,
			wantAvailability: "error",
			wantTypes:        nil,
		},
		{
			name:             "499 rows is under the cap, so ok",
			rows:             serviceRows("dns", 499),
			wantAvailability: "ok",
			wantTypes:        []string{"dns"},
		},
		{
			name:             "exactly 500 rows hits the cap, so partial",
			rows:             serviceRows("dns", 500),
			wantAvailability: "partial",
			wantTypes:        []string{"dns"},
		},
		{
			name:             "501 rows is over the cap, so partial",
			rows:             serviceRows("dns", 501),
			wantAvailability: "partial",
			wantTypes:        []string{"dns"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/infra/v1/detail_services" {
					t.Errorf("unexpected upstream path %q — the inventory must read the same feed as FetchHubHealth", r.URL.Path)
				}
				if tc.fail {
					w.WriteHeader(http.StatusInternalServerError)
					return
				}
				writeResults(w, tc.rows)
			})

			result := s.FetchServiceInventory()

			if result["availability"] != tc.wantAvailability {
				t.Fatalf("availability = %v, want %q", result["availability"], tc.wantAvailability)
			}
			got, ok := result["service_types"].([]string)
			if !ok {
				t.Fatalf("service_types missing or wrong type: %T (%v)", result["service_types"], result["service_types"])
			}
			if tc.wantTypes == nil && got != nil {
				t.Fatalf("service_types = %v on a %s result, want nil — an empty owned-set here would read as "+
					"\"this tenant owns nothing\" and hide panels on the strength of a failed read",
					got, tc.wantAvailability)
			}
			if !reflect.DeepEqual(got, tc.wantTypes) {
				t.Fatalf("service_types = %#v, want %#v", got, tc.wantTypes)
			}
			reason, hasReason := result["reason"]
			if tc.wantAvailability == "ok" && hasReason {
				t.Fatalf("reason should be absent on an ok result, got %v", reason)
			}
			if tc.wantAvailability != "ok" {
				if rs, isStr := reason.(string); !isStr || rs == "" {
					t.Fatalf("a %s result must carry a non-empty reason, got %v", tc.wantAvailability, reason)
				}
			}
		})
	}
}
