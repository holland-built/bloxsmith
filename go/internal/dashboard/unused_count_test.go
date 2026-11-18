package dashboard

import (
	"net/http"
	"strings"
	"testing"
)

// The Network table's "Show unused networks" label needs the count across the
// whole tenant, not just the 5,000 rows the table holds (live tenant
// 2026-11-17: 72,599 networks, 47,661 unused). The count is one more
// page.total_size query whose filter is the unused rule itself: only network
// and broadcast in use (used==2), a /30 or larger (cidr<=30, which leaves out
// /31 and /32), and a measured total of 4 or more (IPv6 rows report total 0,
// so they are left out too).
func TestFetchDashboardData_UnusedSubnetCount(t *testing.T) {
	var seen string
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if r.URL.Path == "/api/ddi/v1/ipam/subnet" && strings.Contains(q.Get("_filter"), "utilization.used==2") {
			seen = q.Get("_filter")
			writeResultsWithPage(w, nil, map[string]any{"total_size": "47661"})
			return
		}
		if q.Get("_limit") == "1" {
			writeResultsWithPage(w, nil, map[string]any{"total_size": "10"})
			return
		}
		writeResults(w, nil)
	})
	data := s.FetchDashboardData(nil)
	totals := data["_totals"].(map[string]any)
	if totals["subnetsUnused"] != 47661 {
		t.Fatalf("_totals[subnetsUnused] = %v, want 47661", totals["subnetsUnused"])
	}
	for _, part := range []string{"utilization.used==2", "cidr<=30", "utilization.total>=4"} {
		if !strings.Contains(seen, part) {
			t.Fatalf("unused filter %q is missing %q", seen, part)
		}
	}
}

// A failed count is left out, never shown as 0 unused.
func TestFetchDashboardData_UnusedSubnetCountFailureOmitted(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if strings.Contains(q.Get("_filter"), "utilization.used==2") {
			w.WriteHeader(500)
			return
		}
		writeResults(w, nil)
	})
	totals := s.FetchDashboardData(nil)["_totals"].(map[string]any)
	if v, ok := totals["subnetsUnused"]; ok {
		t.Fatalf("_totals[subnetsUnused] = %v on a failed count, want absent", v)
	}
}
