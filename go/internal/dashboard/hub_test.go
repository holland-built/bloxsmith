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
	// A dead feed knows no counts. It used to answer `total: 0`, and this test
	// asserted that; both were wrong in the same way the panels were. "total"
	// now means the estate figure and is ABSENT whenever there isn't one, so
	// the assertion is that the key is not there at all rather than that it
	// holds a number nobody measured.
	if v, present := result["total"]; present {
		t.Fatalf("total should be absent on an unavailable feed, got %v", v)
	}
	if result["returned"] != 0 {
		t.Fatalf("returned = %v, want 0", result["returned"])
	}
	if result["truncated"] != false {
		t.Fatalf("truncated = %v, want false", result["truncated"])
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

// --- the sample-vs-total contract (issue #157) --------------------------------
//
// Every number FetchHubSecurity returns is derived by looping the rows it got
// back. Until 2026-08-20 it asked for exactly `limit` rows and published
// `"total": len(rows)`, so three panels printed a count OF THE SAMPLE under
// labels that read as the hour. Measured live that day: 50 rows against a limit
// of 50, `total: 50`, `blocked: 50`, and "Total Events 50" on screen.
//
// The `_limit+1` probe row is what does the work: it separates "I asked for 50
// and got 50" from "there are exactly 50", the case the obvious
// `len(rows) >= limit` test calls truncated and which is a false claim in the
// other direction.
//
// The total-bearing cases below are NOT the live path. This endpoint answers
// HTTP 400 to _is_total_size_needed, so nothing asks it for a count and the
// panels say "total unknown" — see the comment in FetchHubSecurity. What they
// pin is the reading of a total that ARRIVES unasked: it is believed only when
// coherent with the rows beside it, and a page envelope appearing here later
// must not be trusted blindly. The absence of the parameter is pinned
// separately, in the request-contract test above.

// hubEvents builds n dns_event rows, all "high"/"block" unless overridden.
func hubEvents(n int, sev string) []map[string]any {
	out := make([]map[string]any, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, map[string]any{
			"event_time": "2026-08-20T00:00:00Z", "qname": "x.example",
			"severity": sev, "policy_action": "block",
		})
	}
	return out
}

func TestFetchHubSecurity_AsksForOneExtraRowAndNotForATotal(t *testing.T) {
	var gotLimit, gotTotalNeeded string
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		gotLimit = r.URL.Query().Get("_limit")
		gotTotalNeeded = r.URL.Query().Get("_is_total_size_needed")
		writeResults(w, hubEvents(3, "high"))
	})

	s.FetchHubSecurity(3600, 50)

	// 51, not 50. Without the probe row "asked for 50, got 50" and "there are
	// exactly 50" cannot be told apart, and this is the only place that is
	// checked.
	if gotLimit != "51" {
		t.Fatalf("_limit = %q, want \"51\" (limit+1, the truncation probe)", gotLimit)
	}
	// ABSENT, and this assertion is the whole reason this test names it.
	// /api/dnsdata/v2/dns_event answers HTTP 400 to _is_total_size_needed, which
	// drops FetchHubSecurity into its dead-feed branch and blanks the Security
	// tab with "threat feed unavailable". Measured live on 2026-08-20 by sending
	// it, seeing the 400, and removing only that parameter. Every other count in
	// this package sends it because every other count talks to ddi/v1 or
	// infra/v1; dnsdata/v2 is the reporting API and does not take DDI's paging
	// parameters. Without this line, the obvious "make it consistent with its
	// neighbours" edit breaks the tab and every unit test still passes, because
	// a stub server accepts any query string.
	if gotTotalNeeded != "" {
		t.Fatalf("_is_total_size_needed = %q, want it ABSENT — dnsdata/v2 answers 400 to it", gotTotalNeeded)
	}
}

func TestFetchHubSecurity_SampleAndTotalContract(t *testing.T) {
	for _, tc := range []struct {
		name          string
		rows          []map[string]any
		page          any // nil = no page envelope at all
		wantReturned  int
		wantTruncated bool
		wantTotal     any // nil = the key must be ABSENT
	}{{
		// The live case on 2026-08-20, with a total now asked for.
		name: "more than a page, upstream reports the estate figure",
		rows: hubEvents(51, "high"), page: map[string]any{"total_size": "1204"},
		wantReturned: 50, wantTruncated: true, wantTotal: 1204,
	}, {
		// No total available. The 51st row is the only evidence there is, and
		// it is enough to refuse to print a bare count.
		name: "more than a page, no total published",
		rows: hubEvents(51, "high"), page: nil,
		wantReturned: 50, wantTruncated: true, wantTotal: nil,
	}, {
		// THE CASE `len(rows) >= limit` GETS WRONG. An hour holding exactly 50
		// events is not truncated, and saying so is its own false claim.
		name: "exactly a page and that is genuinely all of them",
		rows: hubEvents(50, "high"), page: map[string]any{"total_size": "50"},
		wantReturned: 50, wantTruncated: false, wantTotal: 50,
	}, {
		name: "exactly a page, no total published, no 51st row",
		rows: hubEvents(50, "high"), page: nil,
		wantReturned: 50, wantTruncated: false, wantTotal: nil,
	}, {
		// An envelope claiming fewer than it just handed over is not a total.
		// Dropped rather than displayed; the probe row still stands.
		name: "total smaller than the rows returned is incoherent and dropped",
		rows: hubEvents(51, "high"), page: map[string]any{"total_size": "3"},
		wantReturned: 50, wantTruncated: true, wantTotal: nil,
	}, {
		name: "unparseable total is dropped",
		rows: hubEvents(51, "high"), page: map[string]any{"total_size": "not-a-number"},
		wantReturned: 50, wantTruncated: true, wantTotal: nil,
	}, {
		name: "an ordinary short hour is neither truncated nor qualified",
		rows: hubEvents(7, "high"), page: map[string]any{"total_size": "7"},
		wantReturned: 7, wantTruncated: false, wantTotal: 7,
	}} {
		t.Run(tc.name, func(t *testing.T) {
			s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
				if tc.page == nil {
					writeResults(w, tc.rows)
					return
				}
				writeResultsWithPage(w, tc.rows, tc.page)
			})

			result := s.FetchHubSecurity(3600, 50)

			if result["availability"] != "ok" {
				t.Fatalf("availability = %v, want \"ok\"", result["availability"])
			}
			if result["returned"] != tc.wantReturned {
				t.Errorf("returned = %v, want %d", result["returned"], tc.wantReturned)
			}
			if result["truncated"] != tc.wantTruncated {
				t.Errorf("truncated = %v, want %v", result["truncated"], tc.wantTruncated)
			}
			if tc.wantTotal == nil {
				if v, present := result["total"]; present {
					t.Errorf("total should be absent, got %v", v)
				}
			} else if result["total"] != tc.wantTotal {
				t.Errorf("total = %v, want %v", result["total"], tc.wantTotal)
			}
			// The events list is the sample, and it must be the SAME sample the
			// counts were taken over.
			events, ok := result["events"].([]map[string]any)
			if !ok || len(events) != tc.wantReturned {
				t.Errorf("events length = %v, want %d", len(events), tc.wantReturned)
			}
		})
	}
}

// The probe row is proof, not content. If it were counted, every truncated hour
// would report one more event than it shows, which is a new wrong number
// introduced by the fix for the old one.
func TestFetchHubSecurity_ProbeRowIsNotCounted(t *testing.T) {
	rows := hubEvents(50, "high")
	rows = append(rows, map[string]any{
		"event_time": "2026-08-20T00:00:00Z", "qname": "probe.example",
		"severity": "critical", "policy_action": "block",
	})
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, rows)
	})

	result := s.FetchHubSecurity(3600, 50)

	counts, ok := result["counts"].(map[string]int)
	if !ok {
		t.Fatalf("counts missing or wrong type: %T", result["counts"])
	}
	if counts["critical"] != 0 {
		t.Errorf("critical = %d, want 0 — the 51st row was counted", counts["critical"])
	}
	if counts["high"] != 50 {
		t.Errorf("high = %d, want 50", counts["high"])
	}
	if result["blocked"] != 50 {
		t.Errorf("blocked = %v, want 50 — the probe row was counted as blocked", result["blocked"])
	}
}
