package dashboard

import (
	"net/http"
	"strconv"
	"testing"
)

// The regression this file covers (#85): every reader of
// /api/infra/v1/detail_hosts except one asked for fewer rows than the repo had
// already MEASURED the live tenant to hold — page.total_size 532
// (dashboard.go:591-599) and 548 (ai_tools.go:101-107) — and every one of them
// reported the short answer as if it were the estate.
//
// liveHostTotal is the smaller of the two measurements. Using a real measured
// number rather than a round one keeps the fixture honest about where this
// came from.
const liveHostTotal = 532

// hostsFake serves detail_hosts the way CSP does: it honours _limit, and it
// reports page.total_size only when the request asked for it. total < 0 means
// "serve no page object at all", which is how the no-metadata case is built.
func hostsFake(t *testing.T, have, total int) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/infra/v1/detail_hosts" {
			// FetchHubDomains reads six other feeds; they are not this test's
			// subject and an empty success keeps them out of the way.
			writeResults(w, nil)
			return
		}
		limit, _ := strconv.Atoi(r.URL.Query().Get("_limit"))
		if limit <= 0 || limit > have {
			limit = have
		}
		rows := make([]map[string]any, 0, limit)
		for i := 0; i < limit; i++ {
			rows = append(rows, map[string]any{
				"display_name": "host-" + strconv.Itoa(i), "composite_status": "online",
				"id": "id-" + strconv.Itoa(i), "ophid": "op-" + strconv.Itoa(i),
			})
		}
		if total < 0 {
			writeResults(w, rows)
			return
		}
		writeResultsWithPage(w, rows, map[string]any{"total_size": strconv.Itoa(total)})
	}
}

// TestHostsRequest pins what actually goes on the wire. The limit is the whole
// first half of the fix, and a constant in the source proves nothing about the
// request the server receives.
func TestHostsRequest(t *testing.T) {
	var gotLimit, gotTotalNeeded, gotFields string
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		gotLimit, gotTotalNeeded, gotFields = q.Get("_limit"), q.Get("_is_total_size_needed"), q.Get("_fields")
		writeResultsWithPage(w, nil, map[string]any{"total_size": "0"})
	})

	s.CSPHostHealth()

	if gotLimit != "1000" {
		t.Errorf("_limit = %q, want \"1000\" — at 500 the list drops rows the tenant total says exist", gotLimit)
	}
	if gotTotalNeeded != "true" {
		t.Errorf("_is_total_size_needed = %q, want \"true\" — without it there is no authoritative total and no truncation can be detected", gotTotalNeeded)
	}
	if gotFields == "" {
		t.Errorf("_fields was dropped; the tile's field selection must survive the shared params")
	}
}

// TestCSPHostHealth_Truncation is the tile an operator actually reads
// (Infra.jsx:82-86 renders its count in the card header).
func TestCSPHostHealth_Truncation(t *testing.T) {
	tests := []struct {
		name          string
		have, total   int
		wantCount     int
		wantTruncated bool
		wantTotal     any
	}{
		{"the estate fits, so the count IS the estate", 40, 40, 40, false, nil},
		{"the estate is larger than the cap", 2000, 2000, 1000, true, 2000},
		{"the measured live tenant fits under the new cap", liveHostTotal, liveHostTotal, liveHostTotal, false, nil},
		{"no total to read: no claim in either direction", 1000, -1, 1000, false, nil},
		{"a total smaller than what arrived is distrusted, not believed", 40, 10, 40, false, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newDashboardTestService(t, hostsFake(t, tc.have, tc.total))
			got := s.CSPHostHealth()

			if got["count"] != tc.wantCount {
				t.Errorf("count = %v, want %d", got["count"], tc.wantCount)
			}
			if got["status"] != "ok" {
				t.Errorf("status = %v, want \"ok\" — the rows are real and the tile must keep drawing them", got["status"])
			}
			if trunc, has := got["truncated"]; tc.wantTruncated {
				if trunc != true {
					t.Errorf("truncated = %v (present=%v), want true", trunc, has)
				}
				if got["total_available"] != tc.wantTotal {
					t.Errorf("total_available = %v, want %v", got["total_available"], tc.wantTotal)
				}
				if rs, ok := got["reason"].(string); !ok || rs == "" {
					t.Errorf("a truncated payload must carry a reason, got %v", got["reason"])
				}
			} else {
				if has {
					t.Errorf("truncated = %v, want the key absent — no claim without evidence", trunc)
				}
				if _, has := got["total_available"]; has {
					t.Errorf("total_available = %v, want the key absent", got["total_available"])
				}
			}
		})
	}
}

// TestCSPHostHealth_FailureShapeUnchanged: switching this reader from GetEx to
// the shared GetPageStrict must not change what a dead feed looks like.
func TestCSPHostHealth_FailureShapeUnchanged(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	got := s.CSPHostHealth()
	if got["status"] != "error" || got["count"] != 0 {
		t.Fatalf("failed read gave %v, want the existing errRows shape (status error, count 0)", got)
	}
	if _, has := got["truncated"]; has {
		t.Fatalf("a failed read must make no truncation claim, got %v", got["truncated"])
	}
}

// TestSourceRowsHosts_Truncation: the /api/source/hosts payload carries the
// same fact. count and total_available answer different questions — count is
// rows in THIS response after the local filter and limit, total_available is
// what upstream holds — and the payload must not collapse them.
func TestSourceRowsHosts_Truncation(t *testing.T) {
	s := newDashboardTestService(t, hostsFake(t, 2000, 2000))
	got := s.SourceRows(t.Context(), "hosts", map[string]string{"limit": "10"})

	if got["count"] != 10 {
		t.Errorf("count = %v, want 10 (the caller's own limit, applied locally)", got["count"])
	}
	if got["truncated"] != true {
		t.Errorf("truncated = %v, want true", got["truncated"])
	}
	if got["total_available"] != 2000 {
		t.Errorf("total_available = %v, want 2000 (what upstream holds, not what this response carries)", got["total_available"])
	}

	s2 := newDashboardTestService(t, hostsFake(t, 40, 40))
	clean := s2.SourceRows(t.Context(), "hosts", nil)
	if _, has := clean["truncated"]; has {
		t.Errorf("a complete read must make no truncation claim, got %v", clean["truncated"])
	}
}

// TestFetchHubDomains_HostInventoryTotal: "total" now means the tenant total,
// which is what the key has always said and never meant. Each case gets its own
// Service because FetchHubDomains caches its result under one key — a shared
// service would answer the second case out of the first case's cache.
func TestFetchHubDomains_HostInventoryTotal(t *testing.T) {
	t.Run("truncated: total is the estate, returned is the page, section is partial", func(t *testing.T) {
		s := newDashboardTestService(t, hostsFake(t, 2000, 2000))
		inv, _ := s.FetchHubDomains()["host_inventory"].(map[string]any)

		if inv["total"] != 2000 {
			t.Errorf("total = %v, want 2000 — the key means the estate, not the page", inv["total"])
		}
		if inv["returned"] != 1000 {
			t.Errorf("returned = %v, want 1000", inv["returned"])
		}
		if inv["truncated"] != true {
			t.Errorf("truncated = %v, want true", inv["truncated"])
		}
	})

	t.Run("availability marks the section partial, not the whole response", func(t *testing.T) {
		s := newDashboardTestService(t, hostsFake(t, 2000, 2000))
		avail, _ := s.FetchHubDomains()["availability"].(map[string]any)

		if avail["host_inventory"] != "partial" {
			t.Errorf("availability[host_inventory] = %v, want \"partial\" — by_status and hosts describe the page, not the estate", avail["host_inventory"])
		}
		if avail["threat_feeds"] != "ok" {
			t.Errorf("availability[threat_feeds] = %v, want \"ok\" — one partial section must not degrade the other six", avail["threat_feeds"])
		}
	})

	t.Run("complete: no truncation claim, total still authoritative", func(t *testing.T) {
		s := newDashboardTestService(t, hostsFake(t, liveHostTotal, liveHostTotal))
		result := s.FetchHubDomains()
		inv, _ := result["host_inventory"].(map[string]any)
		avail, _ := result["availability"].(map[string]any)

		if inv["total"] != liveHostTotal || inv["returned"] != liveHostTotal {
			t.Errorf("total = %v, returned = %v, want both %d", inv["total"], inv["returned"], liveHostTotal)
		}
		if _, has := inv["truncated"]; has {
			t.Errorf("truncated = %v, want the key absent", inv["truncated"])
		}
		if avail["host_inventory"] != "ok" {
			t.Errorf("availability[host_inventory] = %v, want \"ok\"", avail["host_inventory"])
		}
	})

	t.Run("no total to read: total is omitted rather than guessed from the rows", func(t *testing.T) {
		s := newDashboardTestService(t, hostsFake(t, 40, -1))
		inv, _ := s.FetchHubDomains()["host_inventory"].(map[string]any)

		if v, has := inv["total"]; has {
			t.Errorf("total = %v, want the key absent — len(rows) is not a tenant total", v)
		}
		if inv["returned"] != 40 {
			t.Errorf("returned = %v, want 40 — the rows in hand are always reportable", inv["returned"])
		}
	})
}

// TestHostDisplayNames_SeesTheWholeEstate: the lookup map has no caller-facing
// shape to carry a flag, so the only assertion worth making is that it stops
// losing rows it used to lose at _limit=500.
func TestHostDisplayNames_SeesTheWholeEstate(t *testing.T) {
	s := newDashboardTestService(t, hostsFake(t, liveHostTotal, liveHostTotal))
	names := s.hostDisplayNames()

	// Two keys per host: id and ophid.
	if len(names) != liveHostTotal*2 {
		t.Fatalf("resolved %d lookup keys, want %d (%d hosts x id+ophid) — at _limit=500 this lost %d hosts",
			len(names), liveHostTotal*2, liveHostTotal, liveHostTotal-500)
	}
	if names["id-531"] == "" {
		t.Errorf("the 532nd host resolved to no name; it is exactly the row the old cap dropped")
	}
}
