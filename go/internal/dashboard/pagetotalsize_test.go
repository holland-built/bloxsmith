package dashboard

import (
	"net/http"
	"testing"
)

// TestPageTotalSize_ZeroIsValidNotFallback is the regression guard for the
// "good news reported as a fetch failure" bug: CSP legitimately answers
// page.total_size: "0" when a filtered query (e.g. the >=90% utilization
// subnetsCrit count) genuinely matches nothing. That must come back as the
// real 0, not the caller's fallback — a prior `n <= 0` guard treated a
// truthful zero as unparseable and made fetchCount degrade the whole
// dashboard for a query that simply had no hits.
func TestPageTotalSize_ZeroIsValidNotFallback(t *testing.T) {
	body := map[string]any{"page": map[string]any{"total_size": "0"}}
	if got := pageTotalSize(body, -1); got != 0 {
		t.Fatalf("pageTotalSize(total_size=\"0\", fallback=-1) = %d, want 0 (a genuine zero, not the fallback)", got)
	}
}

// TestPageTotalSize_Table covers the full parsing contract in one place:
// a valid positive number, a valid zero, a negative value, unparseable
// strings, absent/wrong-shaped page data, and whitespace padding.
func TestPageTotalSize_Table(t *testing.T) {
	const fallback = -1
	cases := []struct {
		name string
		body any
		want int
	}{
		{"positive total_size", map[string]any{"page": map[string]any{"total_size": "42"}}, 42},
		{"zero total_size", map[string]any{"page": map[string]any{"total_size": "0"}}, 0},
		{"negative total_size falls back", map[string]any{"page": map[string]any{"total_size": "-3"}}, fallback},
		{"garbage total_size falls back", map[string]any{"page": map[string]any{"total_size": "abc"}}, fallback},
		{"empty total_size falls back", map[string]any{"page": map[string]any{"total_size": ""}}, fallback},
		{"missing page key falls back", map[string]any{}, fallback},
		{"page not a map falls back", map[string]any{"page": "not-a-map"}, fallback},
		{"total_size not a string falls back", map[string]any{"page": map[string]any{"total_size": 42}}, fallback},
		{"missing total_size key falls back", map[string]any{"page": map[string]any{}}, fallback},
		{"whitespace-padded total_size", map[string]any{"page": map[string]any{"total_size": " 7 "}}, 7},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := pageTotalSize(tc.body, fallback); got != tc.want {
				t.Fatalf("pageTotalSize(%v, fallback=%d) = %d, want %d", tc.body, fallback, got, tc.want)
			}
		})
	}
}

// TestFetchCount_GenuineZeroReportsPresentNotDegraded is fetchCount's
// contract test for the same bug at the level dashboard.go actually calls
// it: a fake upstream answering a filtered, zero-hit query with
// page.total_size="0" must be reported as (0, true) — a present, real
// zero — not (0, false)/(-1, false), which is how a genuinely failed or
// unparseable count is signaled and which previously caused the caller
// (e.g. subnetsCrit in FetchDashboardData) to omit the key and set
// _totals[degraded] for a query that simply matched nothing.
func TestFetchCount_GenuineZeroReportsPresentNotDegraded(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResultsWithPage(w, nil, map[string]any{"total_size": "0"})
	})
	n, ok := s.fetchCount("/api/ddi/v1/ipam/subnet", map[string]string{"_filter": "utilization.utilization>=90"})
	if !ok {
		t.Fatalf("fetchCount ok = false, want true for a genuine zero-hit count")
	}
	if n != 0 {
		t.Fatalf("fetchCount n = %d, want 0", n)
	}
}

// TestFetchDashboardData_SubnetsCritZeroDoesNotDegrade is the end-to-end
// regression guard: a subnetsCrit query (>=90% utilization) that genuinely
// matches zero subnets must appear in _totals as subnetsCrit=0 and must NOT
// by itself flip _totals[degraded] to true. Before the fix, page.total_size
// "0" made fetchCount report failure, so subnetsCrit was silently omitted
// from _totals and degraded was set true — the Overview then showed "some
// estate-wide counts could not be fetched" for a cycle that actually had a
// clean, truthful zero.
func TestFetchDashboardData_SubnetsCritZeroDoesNotDegrade(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		switch r.URL.Path {
		case "/api/ddi/v1/ipam/subnet":
			switch {
			case q.Get("_filter") == "utilization.utilization>=90":
				// The genuine-zero case: nothing meets the crit threshold.
				writeResultsWithPage(w, nil, map[string]any{"total_size": "0"})
			case q.Get("_filter") == "utilization.utilization>=70":
				writeResultsWithPage(w, nil, map[string]any{"total_size": "0"})
			case q.Get("_limit") == "1":
				writeResultsWithPage(w, nil, map[string]any{"total_size": "487"})
			default:
				writeResults(w, []map[string]any{{"id": "1", "name": "sub1"}})
			}
		case "/api/infra/v1/detail_hosts":
			if q.Get("_limit") == "1" {
				writeResultsWithPage(w, nil, map[string]any{"total_size": "12"})
				return
			}
			writeResults(w, []map[string]any{{"display_name": "host1", "composite_status": "online"}})
		default:
			writeResults(w, nil)
		}
	})

	data := s.FetchDashboardData()

	totals, ok := data["_totals"].(map[string]any)
	if !ok {
		t.Fatalf("_totals missing or wrong type: %v", data["_totals"])
	}
	if v, present := totals["subnetsCrit"]; !present || v != 0 {
		t.Fatalf("_totals[subnetsCrit] = %v (present=%v), want 0 present", totals["subnetsCrit"], present)
	}
	if totals["degraded"] != false {
		t.Fatalf("_totals[degraded] = %v, want false — a genuine zero-hit count must not degrade the dashboard", totals["degraded"])
	}
}
