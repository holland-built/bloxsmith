package dashboard

import (
	"fmt"
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
// The cap+1 probe row is what does the work: it separates "I asked for 5000 and
// got 5000" from "there are exactly 5000", the case the obvious
// `len(rows) >= cap` test calls truncated and which is a false claim in the
// other direction.
//
// The total-bearing cases below are NOT the live path. This endpoint answers
// HTTP 400 to _is_total_size_needed, so nothing asks it for a count — see the
// comment in FetchHubSecurity. What they
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

	// The count cap plus one, whatever the caller's display limit. Without the
	// probe row "asked for 5000, got 5000" and "there are exactly 5000" cannot
	// be told apart, and this is the only place that is checked.
	if want := fmt.Sprint(hubSecurityCountCap + 1); gotLimit != want {
		t.Fatalf("_limit = %q, want %q (count cap + 1, the truncation probe)", gotLimit, want)
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
	cap := hubSecurityCountCap
	for _, tc := range []struct {
		name         string
		rows         []map[string]any
		page         any // nil = no page envelope at all
		wantReturned int
		wantCounted  int
		wantComplete bool
		wantTotal    any // nil = the key must be ABSENT
	}{{
		name: "more than the list, all read: the count is the true total",
		rows: hubEvents(354, "high"), page: nil,
		wantReturned: 50, wantCounted: 354, wantComplete: true, wantTotal: 354,
	}, {
		name: "upstream volunteers a larger total: the read is partial",
		rows: hubEvents(51, "high"), page: map[string]any{"total_size": "1204"},
		wantReturned: 50, wantCounted: 51, wantComplete: false, wantTotal: 1204,
	}, {
		name: "exactly the cap and that is genuinely all of them",
		rows: hubEvents(cap, "high"), page: nil,
		wantReturned: 50, wantCounted: cap, wantComplete: true, wantTotal: cap,
	}, {
		name: "one past the cap, no total published",
		rows: hubEvents(cap+1, "high"), page: nil,
		wantReturned: 50, wantCounted: cap, wantComplete: false, wantTotal: nil,
	}, {
		// An envelope claiming fewer than it just handed over is not a total.
		name: "total smaller than the rows read is incoherent and dropped",
		rows: hubEvents(cap+1, "high"), page: map[string]any{"total_size": "3"},
		wantReturned: 50, wantCounted: cap, wantComplete: false, wantTotal: nil,
	}, {
		name: "unparseable total is dropped",
		rows: hubEvents(cap+1, "high"), page: map[string]any{"total_size": "not-a-number"},
		wantReturned: 50, wantCounted: cap, wantComplete: false, wantTotal: nil,
	}, {
		name: "an ordinary short hour is complete",
		rows: hubEvents(7, "high"), page: map[string]any{"total_size": "7"},
		wantReturned: 7, wantCounted: 7, wantComplete: true, wantTotal: 7,
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
			if result["counted"] != tc.wantCounted {
				t.Errorf("counted = %v, want %d", result["counted"], tc.wantCounted)
			}
			if result["complete"] != tc.wantComplete {
				t.Errorf("complete = %v, want %v", result["complete"], tc.wantComplete)
			}
			if result["truncated"] != !tc.wantComplete {
				t.Errorf("truncated = %v, want %v", result["truncated"], !tc.wantComplete)
			}
			if tc.wantTotal == nil {
				if v, present := result["total"]; present {
					t.Errorf("total should be absent, got %v", v)
				}
			} else if result["total"] != tc.wantTotal {
				t.Errorf("total = %v, want %v", result["total"], tc.wantTotal)
			}
			events, ok := result["events"].([]map[string]any)
			if !ok || len(events) != tc.wantReturned {
				t.Errorf("events length = %v, want %d", len(events), tc.wantReturned)
			}
		})
	}
}

// The live defect of 2026-11-21: 21 critical or high events in the hour, and
// the app showed 2 because only the newest 50 rows were counted.
func TestFetchHubSecurity_CountsEventsBeyondTheDisplayedList(t *testing.T) {
	rows := hubEvents(50, "low")
	for i := range rows {
		rows[i]["event_time"] = "2026-11-21T02:00:00Z"
		rows[i]["policy_action"] = "log"
	}
	for i := 0; i < 21; i++ {
		sev := "high"
		if i < 4 {
			sev = "critical"
		}
		rows = append(rows, map[string]any{
			"event_time": "2026-11-21T01:30:00Z", "qname": "older.example",
			"severity": sev, "policy_action": "block",
		})
	}
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, rows)
	})

	result := s.FetchHubSecurity(3600, 50)

	counts := result["counts"].(map[string]int)
	if counts["critical"] != 4 || counts["high"] != 17 || counts["low"] != 50 {
		t.Errorf("counts = %v, want critical 4, high 17, low 50", counts)
	}
	if result["blocked"] != 21 || result["logged"] != 50 {
		t.Errorf("blocked = %v, logged = %v, want 21 and 50", result["blocked"], result["logged"])
	}
	if result["counted"] != 71 || result["complete"] != true || result["total"] != 71 {
		t.Errorf("counted = %v, complete = %v, total = %v, want 71, true, 71", result["counted"], result["complete"], result["total"])
	}
	if result["counted_since"] != "2026-11-21T01:30:00Z" {
		t.Errorf("counted_since = %v, want the oldest counted event", result["counted_since"])
	}
	// The payload stays small: the list is still the newest 50, in order.
	events := result["events"].([]map[string]any)
	if len(events) != 50 || events[0]["event_time"] != "2026-11-21T02:00:00Z" || events[49]["severity"] != "low" {
		t.Errorf("events = %d rows, want the newest 50 in upstream order", len(events))
	}
}

// The row past the cap is proof, not content. If it were counted, every capped
// window would report one more event than was counted.
func TestFetchHubSecurity_ProbeRowIsNotCounted(t *testing.T) {
	rows := hubEvents(hubSecurityCountCap, "high")
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
		t.Errorf("critical = %d, want 0 — the probe row was counted", counts["critical"])
	}
	if counts["high"] != hubSecurityCountCap {
		t.Errorf("high = %d, want %d", counts["high"], hubSecurityCountCap)
	}
	if result["blocked"] != hubSecurityCountCap {
		t.Errorf("blocked = %v, want %d — the probe row was counted as blocked", result["blocked"], hubSecurityCountCap)
	}
}

// A failed read must never look like a quiet, fully counted hour.
func TestFetchHubSecurity_FailedReadClaimsNoCompleteCount(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	result := s.FetchHubSecurity(3600, 50)

	if result["availability"] != "error" {
		t.Fatalf("availability = %v, want \"error\"", result["availability"])
	}
	if result["complete"] != false {
		t.Errorf("complete = %v, want false", result["complete"])
	}
	if v, present := result["counted"]; present {
		t.Errorf("counted should be absent on a failed read, got %v", v)
	}
}

// The list behind "n/m up": every service not counted as up, with its host, so
// the Infra page's count can never differ from the Overview's.
func TestFetchHubHealth_NotRunningMatchesUpCount(t *testing.T) {
	host := func(name, ip string) []map[string]any {
		return []map[string]any{{"display_name": name, "ip_address": ip, "ophid": "must-not-be-sent"}}
	}
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, []map[string]any{
			{"name": "dhcp_a", "service_type": "dhcp", "composite_status": "online", "hosts": host("a", "10.0.0.1")},
			{"name": "dhcp_b", "service_type": "ndhcp", "composite_status": "stopped", "hosts": host("b", "10.0.0.2")},
			{"name": "dhcp_c", "service_type": "dhcp", "composite_status": "error", "hosts": host("c", "10.0.0.3")},
			{"name": "dhcp_d", "service_type": "dhcp", "composite_status": "", "hosts": host("d", "10.0.0.4")},
			{"name": "dns_a", "service_type": "dns", "composite_status": "online", "hosts": host("a", "10.0.0.1")},
		})
	})

	byName := map[string]map[string]any{}
	for _, b := range s.FetchHubHealth() {
		byName[getStr(b["name"])] = b
	}
	if got := getStr(byName["DHCP"]["meta"]); got != "1 error · 1/4 up" {
		t.Fatalf("existing meta changed: %q", got)
	}
	rows := byName["DHCP"]["not_running"].([]map[string]any)
	if len(rows) != 3 {
		t.Fatalf("not_running has %d rows, want 3 (4 total minus 1 up): %v", len(rows), rows)
	}
	want := map[string]any{"name": "dhcp_b", "state": "stopped", "host": "b", "ip": "10.0.0.2"}
	if !reflect.DeepEqual(rows[0], want) {
		t.Fatalf("row = %v, want exactly %v", rows[0], want)
	}
	if got := byName["DNS"]["not_running"].([]map[string]any); len(got) != 0 {
		t.Fatalf("DNS is all up but listed %v", got)
	}
}

// A failed read has no list at all, so the page cannot read it as "none down".
func TestFetchHubHealth_FailedReadHasNoNotRunningList(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	for _, b := range s.FetchHubHealth() {
		if _, ok := b["not_running"]; ok {
			t.Fatalf("%v: a dead feed must not carry a list", b["name"])
		}
	}
}
