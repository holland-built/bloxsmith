package dashboard

import (
	"net/http"
	"testing"
)

// feedStatusHandler builds a handler that answers every /api/data feed with
// healthy, empty responses by default, except for the paths in overrides
// (matched by exact URL path), which get whatever the override writes. This
// keeps each test focused on the one feed under test while still letting
// buildAggregate run to completion (the subnet endpoint alone is hit four
// different ways: main page, >=70 at-risk, >=90 crit, and the _limit=1
// count).
func feedStatusHandler(t *testing.T, overrides map[string]http.HandlerFunc) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		if h, ok := overrides[r.URL.Path]; ok {
			h(w, r)
			return
		}
		q := r.URL.Query()
		if r.URL.Path == "/api/ddi/v1/ipam/subnet" || r.URL.Path == "/api/infra/v1/detail_hosts" {
			// The count queries (fetchCount, always _limit=1) and the
			// at-risk fetch (_filter>=70) treat page.total_size=="0" as
			// unparseable (pageTotalSize's n<=0 guard) and would flip
			// _totals[degraded] for a reason unrelated to feed status, so
			// they get a non-zero total_size here with zero rows — that's
			// enough to make fetchCount/fetchAtRiskSubnets succeed while
			// the feed itself still reports "empty".
			if q.Get("_limit") == "1" || q.Get("_filter") == "utilization.utilization>=70" {
				writeResultsWithPage(w, nil, map[string]any{"total_size": "1"})
				return
			}
		}
		writeResults(w, nil)
	}
}

// TestFetchDashboardData_FeedErrorMarksMetaAndDegraded verifies a single feed
// failing (5xx) reports "error" in _meta for that feed only, still leaves a
// usable (empty) slice under its data key so norm* shapers and the rest of
// the handler keep working, sets _totals[degraded], and the handler still
// returns a full payload rather than aborting.
func TestFetchDashboardData_FeedErrorMarksMetaAndDegraded(t *testing.T) {
	s := newDashboardTestService(t, feedStatusHandler(t, map[string]http.HandlerFunc{
		"/api/atcfw/v1/security_policies": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		},
	}))

	data := s.FetchDashboardData()

	meta, ok := data["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("_meta missing or wrong type: %v", data["_meta"])
	}
	if meta["secPolicies"] != "error" {
		t.Fatalf("_meta[secPolicies] = %v, want \"error\"", meta["secPolicies"])
	}
	policies, ok := data["secPolicies"].([]map[string]any)
	if !ok {
		t.Fatalf("secPolicies data key missing or wrong type after feed error: %T", data["secPolicies"])
	}
	if len(policies) != 0 {
		t.Fatalf("secPolicies should be an empty (not nil-panicking) slice on error, got %d rows", len(policies))
	}
	totals, ok := data["_totals"].(map[string]any)
	if !ok {
		t.Fatalf("_totals missing or wrong type: %v", data["_totals"])
	}
	if totals["degraded"] != true {
		t.Fatalf("_totals[degraded] = %v, want true when a feed errors", totals["degraded"])
	}
	// The rest of the payload must still be present — one dead feed must
	// never blank the whole /api/data response.
	for _, key := range []string{"subnets", "leases", "dnsViews", "zones", "hosts", "feeds", "auditLogs"} {
		if _, present := data[key]; !present {
			t.Fatalf("data[%q] missing after an unrelated feed errored — handler must not abort", key)
		}
	}
}

// TestFetchDashboardData_FeedEmptyStatusDoesNotDegrade verifies a feed that
// succeeds with zero rows reports "empty" (not "error"), and does not by
// itself flip _totals[degraded].
func TestFetchDashboardData_FeedEmptyStatusDoesNotDegrade(t *testing.T) {
	s := newDashboardTestService(t, feedStatusHandler(t, nil))

	data := s.FetchDashboardData()

	meta, ok := data["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("_meta missing or wrong type: %v", data["_meta"])
	}
	for _, key := range []string{"subnets", "leases", "dnsViews", "zones", "hosts", "secPolicies", "feeds"} {
		if meta[key] != "empty" {
			t.Fatalf("_meta[%s] = %v, want \"empty\" for a zero-row feed", key, meta[key])
		}
	}
	totals, ok := data["_totals"].(map[string]any)
	if !ok {
		t.Fatalf("_totals missing or wrong type: %v", data["_totals"])
	}
	if totals["degraded"] != false {
		t.Fatalf("_totals[degraded] = %v, want false — an empty (not failed) feed must not degrade", totals["degraded"])
	}
}

// TestFetchDashboardData_AllFeedsHealthyReportOK verifies that when every
// feed returns real rows, every _meta entry is "ok".
func TestFetchDashboardData_AllFeedsHealthyReportOK(t *testing.T) {
	rowsFor := map[string][]map[string]any{
		"/api/ddi/v1/ipam/subnet":         {{"id": "1", "name": "sub1", "address": "10.0.0.0", "cidr": 24, "utilization": map[string]any{"total": 100, "used": 10}}},
		"/api/ddi/v1/dhcp/lease":          {{"address": "10.0.0.5", "hostname": "h1", "state": "leased"}},
		"/api/ddi/v1/dns/view":            {{"id": "v1", "name": "default"}},
		"/api/ddi/v1/dns/auth_zone":       {{"id": "z1", "fqdn": "example.com", "view": "v1"}},
		"/api/infra/v1/detail_hosts":      {{"display_name": "host1", "composite_status": "online"}},
		"/api/atcfw/v1/security_policies": {{"id": "p1", "name": "policy1"}},
		"/api/atcfw/v1/named_lists":       {{"id": "f1", "name": "feed1"}},
		"/api/auditlog/v1/logs":           {{"id": "a1", "created_at": "2026-01-01"}},
	}
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if (r.URL.Path == "/api/ddi/v1/ipam/subnet" || r.URL.Path == "/api/infra/v1/detail_hosts") && q.Get("_limit") == "1" {
			writeResultsWithPage(w, nil, map[string]any{"total_size": "1"})
			return
		}
		writeResults(w, rowsFor[r.URL.Path])
	})

	data := s.FetchDashboardData()

	meta, ok := data["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("_meta missing or wrong type: %v", data["_meta"])
	}
	for _, key := range []string{"subnets", "leases", "dnsViews", "zones", "hosts", "secPolicies", "feeds", "auditLogs"} {
		if meta[key] != "ok" {
			t.Fatalf("_meta[%s] = %v, want \"ok\" when every feed returns rows", key, meta[key])
		}
	}
}
