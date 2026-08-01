package dashboard

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

// newDashboardTestService is newAIToolsTestService's twin for FetchDashboardData
// tests: it wires a Service to an httptest fake and lets each test's handler
// distinguish requests by path + query (subnet is hit up to four different
// ways: the main 5000-row page, the >=70 at-risk page(s), the total count,
// and the >=90 crit count).
func newDashboardTestService(t *testing.T, handler http.HandlerFunc) *Service {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	c := rest.New(srv.URL, rest.NewAuth("test-key", nil))
	return New(c, cache.New())
}

// TestFetchDashboardData_TotalsFromPageTotalSize verifies _totals is
// populated from the STRING page.total_size ("72316" -> int 72316, not the
// row count actually fetched), and that data["subnets"] is the union of the
// first page and the >=70 at-risk page, deduped by id, so an at-risk subnet
// absent from the first page (util-only 92%, id "999") is present in the
// final list even though only 1 row came back from the first page.
func TestFetchDashboardData_TotalsFromPageTotalSize(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		switch r.URL.Path {
		case "/api/ddi/v1/ipam/subnet":
			switch {
			case q.Get("_filter") == "utilization.utilization>=90":
				writeResultsWithPage(w, nil, map[string]any{"total_size": "963"})
			case q.Get("_filter") == "utilization.utilization>=70":
				// The at-risk fetch: one row, id "999", NOT in the first page.
				writeResultsWithPage(w, []map[string]any{
					{"id": "999", "name": "at-risk", "address": "10.9.0.0", "cidr": 24,
						"utilization": map[string]any{"total": 100, "used": 92}},
				}, map[string]any{"total_size": "1"})
			case q.Get("_limit") == "1":
				writeResultsWithPage(w, nil, map[string]any{"total_size": "72316"})
			default:
				// The main first page: one row, id "1".
				writeResults(w, []map[string]any{
					{"id": "1", "name": "sub1", "address": "10.0.0.0", "cidr": 24,
						"utilization": map[string]any{"total": 100, "used": 10}},
				})
			}
		case "/api/infra/v1/detail_hosts":
			if q.Get("_limit") == "1" {
				writeResultsWithPage(w, nil, map[string]any{"total_size": "548"})
				return
			}
			writeResults(w, []map[string]any{{"display_name": "host1", "composite_status": "online"}})
		default:
			writeResults(w, nil)
		}
	})

	data := s.FetchDashboardData(nil)

	totals, ok := data["_totals"].(map[string]any)
	if !ok {
		t.Fatalf("_totals missing or wrong type: %v", data["_totals"])
	}
	if totals["subnets"] != 72316 {
		t.Fatalf("_totals[subnets] = %v, want 72316", totals["subnets"])
	}
	if totals["subnetsCrit"] != 963 {
		t.Fatalf("_totals[subnetsCrit] = %v, want 963", totals["subnetsCrit"])
	}
	if totals["subnetsWarn"] != 1 {
		t.Fatalf("_totals[subnetsWarn] = %v, want 1", totals["subnetsWarn"])
	}
	if totals["hosts"] != 548 {
		t.Fatalf("_totals[hosts] = %v, want 548", totals["hosts"])
	}
	if totals["degraded"] != false {
		t.Fatalf("_totals[degraded] = %v, want false", totals["degraded"])
	}

	subnets, ok := data["subnets"].([]map[string]any)
	if !ok {
		t.Fatalf("subnets missing or wrong type: %T", data["subnets"])
	}
	if len(subnets) != 2 {
		t.Fatalf("subnets union length = %d, want 2 (first page + at-risk, deduped)", len(subnets))
	}
	found999 := false
	for _, s := range subnets {
		if s["id"] == "999" {
			found999 = true
		}
	}
	if !found999 {
		t.Fatalf("at-risk subnet id 999 missing from unioned subnets: %v", subnets)
	}
}

// TestFetchDashboardData_AtRiskPagingCapDegrades verifies the at-risk paging
// loop stops at atRiskPageCap pages rather than looping forever against a
// backend that always claims more rows remain, and marks _totals[degraded].
func TestFetchDashboardData_AtRiskPagingCapDegrades(t *testing.T) {
	pageHits := 0
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		switch r.URL.Path {
		case "/api/ddi/v1/ipam/subnet":
			switch {
			case q.Get("_filter") == "utilization.utilization>=90":
				writeResultsWithPage(w, nil, map[string]any{"total_size": "0"})
			case q.Get("_filter") == "utilization.utilization>=70":
				pageHits++
				// Always claim a huge total and return a non-empty batch, so
				// only the page cap (not "batch empty" or "reached total")
				// can end the loop.
				writeResultsWithPage(w, []map[string]any{
					{"id": "row", "name": "x", "utilization": map[string]any{"total": 100, "used": 99}},
				}, map[string]any{"total_size": "999999"})
			case q.Get("_limit") == "1":
				writeResultsWithPage(w, nil, map[string]any{"total_size": "1"})
			default:
				writeResults(w, nil)
			}
		default:
			writeResults(w, nil)
		}
	})

	data := s.FetchDashboardData(nil)

	if pageHits != atRiskPageCap {
		t.Fatalf("at-risk paging made %d requests, want exactly atRiskPageCap=%d (loop must stop, not run forever)",
			pageHits, atRiskPageCap)
	}
	totals, ok := data["_totals"].(map[string]any)
	if !ok {
		t.Fatalf("_totals missing or wrong type: %v", data["_totals"])
	}
	if totals["degraded"] != true {
		t.Fatalf("_totals[degraded] = %v, want true when the page cap trips", totals["degraded"])
	}
}

// TestFetchDashboardData_FailedCountQueryDegradesWithoutContradiction verifies
// that when a count query fails (5xx), the corresponding _totals key is
// omitted rather than populated with a number that would contradict the
// actual row data — and degraded is set instead.
func TestFetchDashboardData_FailedCountQueryDegradesWithoutContradiction(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		switch r.URL.Path {
		case "/api/ddi/v1/ipam/subnet":
			switch {
			case q.Get("_filter") == "utilization.utilization>=90":
				writeResultsWithPage(w, nil, map[string]any{"total_size": "0"})
			case q.Get("_filter") == "utilization.utilization>=70":
				writeResultsWithPage(w, nil, map[string]any{"total_size": "0"})
			case q.Get("_limit") == "1":
				writeResultsWithPage(w, nil, map[string]any{"total_size": "72316"})
			default:
				writeResults(w, []map[string]any{{"id": "1", "name": "sub1"}})
			}
		case "/api/infra/v1/detail_hosts":
			if q.Get("_limit") == "1" {
				// The hosts count query fails outright.
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			writeResults(w, []map[string]any{
				{"display_name": "host1", "composite_status": "online"},
				{"display_name": "host2", "composite_status": "online"},
			})
		default:
			writeResults(w, nil)
		}
	})

	data := s.FetchDashboardData(nil)

	totals, ok := data["_totals"].(map[string]any)
	if !ok {
		t.Fatalf("_totals missing or wrong type: %v", data["_totals"])
	}
	if _, present := totals["hosts"]; present {
		t.Fatalf("_totals[hosts] should be OMITTED on a failed count query, got %v", totals["hosts"])
	}
	if totals["degraded"] != true {
		t.Fatalf("_totals[degraded] = %v, want true when a count query fails", totals["degraded"])
	}
	hosts, ok := data["hosts"].([]map[string]any)
	if !ok || len(hosts) != 2 {
		t.Fatalf("hosts row data should be unaffected by the failed count query: %v", data["hosts"])
	}
}
