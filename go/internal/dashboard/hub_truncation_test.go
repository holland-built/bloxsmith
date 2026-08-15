package dashboard

import (
	"net/http"
	"testing"
)

// The regression this file covers (#81): FetchHubHealth and
// FetchServiceInventory read the SAME feed at the SAME limit, and only one of
// them refused to stand behind a list that hit the cap. The other reported
// every unseen bucket as an authoritative healthy "0 deployed" — a green
// all-clear assembled from rows nobody had seen.
//
// Every want* below is a hand-written literal. None is computed from the
// production code, so a bug there cannot move the target.

// mixedServiceRows builds exactly n rows: n-dnsCount of a type no bucket
// matches, then dnsCount of "dns". Exactly n, never n+dnsCount — a fixture
// that returns MORE rows than _limit asked for does not model the cap it is
// supposed to be testing.
func mixedServiceRows(n, dnsCount int) []map[string]any {
	rows := make([]map[string]any, 0, n)
	for i := 0; i < n-dnsCount; i++ {
		rows = append(rows, map[string]any{"service_type": "cdc"})
	}
	for i := 0; i < dnsCount; i++ {
		rows = append(rows, map[string]any{"service_type": "dns", "composite_status": "online"})
	}
	return rows
}

// wantBucket is the whole row, spelled out. Every field of every bucket is
// asserted — "keeps its real severity" in a plan is not an assertion in a test.
type wantBucket struct {
	name         string
	status       string
	statusLabel  string
	meta         string
	availability string
	wantReason   bool
}

func TestFetchHubHealth_TruncatedInventoryIsNotAnAllClear(t *testing.T) {
	// page is nil when the fixture serves no "page" object at all, which is
	// how the total-unreadable fallback path is exercised.
	tests := []struct {
		name  string
		rows  []map[string]any
		page  any
		wants []wantBucket
	}{
		{
			name: "well under the cap: an absent bucket really is 0 deployed",
			rows: mixedServiceRows(3, 3),
			page: map[string]any{"total_size": "3"},
			wants: []wantBucket{
				{"DNS", "ok", "healthy", "3/3 online", "ok", false},
				{"DHCP", "ok", "no services", "0 deployed", "ok", false},
				{"Security", "ok", "no services", "0 deployed", "ok", false},
			},
		},
		{
			// The case len(rows) >= limit gets WRONG on its own: a tenant with
			// exactly 500 services is complete, and upstream says so.
			name: "exactly at the cap but upstream's total agrees: still authoritative",
			rows: mixedServiceRows(500, 0),
			page: map[string]any{"total_size": "500"},
			wants: []wantBucket{
				{"DNS", "ok", "no services", "0 deployed", "ok", false},
				{"DHCP", "ok", "no services", "0 deployed", "ok", false},
				{"Security", "ok", "no services", "0 deployed", "ok", false},
			},
		},
		{
			name: "truncated, every bucket empty: no bucket may claim zero",
			rows: mixedServiceRows(500, 0),
			page: map[string]any{"total_size": "900"},
			wants: []wantBucket{
				{"DNS", "unknown", "not listed", "beyond the row cap", "partial", true},
				{"DHCP", "unknown", "not listed", "beyond the row cap", "partial", true},
				{"Security", "unknown", "not listed", "beyond the row cap", "partial", true},
			},
		},
		{
			// A bucket WITH members keeps the severity actually measured — the
			// two members really are online — but stops calling that answer
			// authoritative, because more members may sit past the cap.
			name: "truncated, one bucket has members: its severity is real, its authority is not",
			rows: mixedServiceRows(500, 2),
			page: map[string]any{"total_size": "900"},
			wants: []wantBucket{
				{"DNS", "ok", "healthy", "2/2 online", "partial", true},
				{"DHCP", "unknown", "not listed", "beyond the row cap", "partial", true},
				{"Security", "unknown", "not listed", "beyond the row cap", "partial", true},
			},
		},
		{
			name: "no total to read: a full page falls back to assuming truncation",
			rows: mixedServiceRows(500, 0),
			page: nil,
			wants: []wantBucket{
				{"DNS", "unknown", "not listed", "beyond the row cap", "partial", true},
				{"DHCP", "unknown", "not listed", "beyond the row cap", "partial", true},
				{"Security", "unknown", "not listed", "beyond the row cap", "partial", true},
			},
		},
		{
			// An internally inconsistent answer (fewer in the total than
			// arrived) is a reason to distrust it, never to trust it.
			name: "total smaller than the rows in hand is not a clean bill of health",
			rows: mixedServiceRows(3, 0),
			page: map[string]any{"total_size": "1"},
			wants: []wantBucket{
				{"DNS", "unknown", "not listed", "beyond the row cap", "partial", true},
				{"DHCP", "unknown", "not listed", "beyond the row cap", "partial", true},
				{"Security", "unknown", "not listed", "beyond the row cap", "partial", true},
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/infra/v1/detail_services" {
					t.Errorf("unexpected upstream path %q", r.URL.Path)
				}
				assertServiceInventoryParams(t, r)
				if tc.page == nil {
					writeResults(w, tc.rows)
					return
				}
				writeResultsWithPage(w, tc.rows, tc.page)
			})

			got := s.FetchHubHealth()
			if len(got) != len(tc.wants) {
				t.Fatalf("got %d buckets, want %d", len(got), len(tc.wants))
			}
			for i, want := range tc.wants {
				b := got[i]
				if b["name"] != want.name {
					t.Fatalf("bucket %d name = %v, want %q", i, b["name"], want.name)
				}
				for field, wantVal := range map[string]string{
					"status": want.status, "statusLabel": want.statusLabel,
					"meta": want.meta, "availability": want.availability,
				} {
					if b[field] != wantVal {
						t.Errorf("%s %s = %v, want %q", want.name, field, b[field], wantVal)
					}
				}
				reason, has := b["reason"]
				if want.wantReason {
					if rs, ok := reason.(string); !ok || rs == "" {
						t.Errorf("%s: a partial bucket must carry a non-empty reason, got %v", want.name, reason)
					}
				} else if has {
					t.Errorf("%s: reason must be absent on an authoritative bucket, got %v", want.name, reason)
				}
			}
		})
	}
}

// assertServiceInventoryParams pins the outbound request both readers share.
// Hoisting the limit onto one constant is only worth anything if a change to
// what actually goes on the wire is caught here.
func assertServiceInventoryParams(t *testing.T, r *http.Request) {
	t.Helper()
	q := r.URL.Query()
	if q.Get("_limit") != "500" {
		t.Errorf("_limit = %q, want \"500\"", q.Get("_limit"))
	}
	if q.Get("_is_total_size_needed") != "true" {
		t.Errorf("_is_total_size_needed = %q, want \"true\" — without it there is no authoritative total and every full page is assumed truncated",
			q.Get("_is_total_size_needed"))
	}
}

// TestFetchServiceInventory_SharesTheTruncationTest is the other half of #81:
// the sibling must reach the same verdict from the same response, including
// the case the old row-count-only rule got wrong.
func TestFetchServiceInventory_SharesTheTruncationTest(t *testing.T) {
	tests := []struct {
		name             string
		rows             []map[string]any
		page             any
		wantAvailability string
	}{
		{"exactly at the cap, total agrees", mixedServiceRows(500, 500), map[string]any{"total_size": "500"}, "ok"},
		{"exactly at the cap, more upstream", mixedServiceRows(500, 500), map[string]any{"total_size": "900"}, "partial"},
		{"full page, no total to read", mixedServiceRows(500, 500), nil, "partial"},
		{"under the cap, total agrees", mixedServiceRows(3, 3), map[string]any{"total_size": "3"}, "ok"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
				assertServiceInventoryParams(t, r)
				if tc.page == nil {
					writeResults(w, tc.rows)
					return
				}
				writeResultsWithPage(w, tc.rows, tc.page)
			})

			got := s.FetchServiceInventory()
			if got["availability"] != tc.wantAvailability {
				t.Fatalf("availability = %v, want %q", got["availability"], tc.wantAvailability)
			}

			// Both readers must agree on the same response — that agreement is
			// the whole point of sharing one test.
			h := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
				if tc.page == nil {
					writeResults(w, tc.rows)
					return
				}
				writeResultsWithPage(w, tc.rows, tc.page)
			})
			healthPartial := h.FetchHubHealth()[0]["availability"] == "partial"
			if healthPartial != (tc.wantAvailability == "partial") {
				t.Fatalf("hub health says partial=%v while the inventory says %q — the two readers disagree about the same response",
					healthPartial, tc.wantAvailability)
			}
		})
	}
}
