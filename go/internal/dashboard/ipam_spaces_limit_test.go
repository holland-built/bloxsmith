package dashboard

import (
	"net/http"
	"strconv"
	"testing"
)

// The regression this file covers. CSPIpamUtil makes ONE read of the IP-space
// tree with _limit=500, and the Network tab ranks what comes back as "IPAM
// Spaces — Top Used". On a tenant with more than 500 spaces that read is a
// slice, and nothing said so: seen on a live tenant on 2026-10-04, the feed
// returned exactly 500 rows and the "top used" space showed 24 addresses while
// single subnets on the same page used 512.
//
// The feed cannot be made complete from here: `_offset`, `_order_by` and
// `_is_total_size_needed` have never been sent to /api/ddi/v1/ipam/htree
// anywhere in this repo, and hosts.go explains why a param nobody has
// exercised is not added on a guess. What it CAN do is say what happened: the
// read came back full. `atLimit` is that statement and nothing more. It is not
// `truncated`, which this package reserves for an authoritative total that
// exceeds the rows in hand (hostsTruncated).

// spacesFake serves htree the way CSP does for this feed: it honours _limit and
// sends no page object.
func spacesFake(t *testing.T, have int) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/ddi/v1/ipam/htree" {
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
				"id":          "ipam/ip_space/" + strconv.Itoa(i),
				"label":       "space-" + strconv.Itoa(i),
				"utilization": map[string]any{"used": strconv.Itoa(i), "total": "1024"},
			})
		}
		writeResults(w, rows)
	}
}

// TestIpamSpacesRequest pins what goes on the wire: the one request shape this
// endpoint has always been sent, with no param added on a guess.
func TestIpamSpacesRequest(t *testing.T) {
	var got map[string][]string
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/ddi/v1/ipam/htree" {
			got = r.URL.Query()
		}
		writeResults(w, nil)
	})
	s.CSPIpamUtil()
	want := map[string]string{"view": "SPACE", "_limit": strconv.Itoa(ipamSpacesLimit), "_fields": "id,label,utilization"}
	if len(got) != len(want) {
		t.Fatalf("htree was sent %d params %v, want exactly %v", len(got), got, want)
	}
	for k, v := range want {
		if len(got[k]) != 1 || got[k][0] != v {
			t.Errorf("param %s = %v, want %q", k, got[k], v)
		}
	}
}

func TestIpamSpacesSaysWhenTheReadCameBackFull(t *testing.T) {
	// 620 upstream, 500 read: the shape of the live tenant.
	s := newDashboardTestService(t, spacesFake(t, 620))
	got := s.CSPIpamUtil()
	if n, _ := got["count"].(int); n != ipamSpacesLimit {
		t.Fatalf("count = %v, want the %d the read returned", got["count"], ipamSpacesLimit)
	}
	if got["atLimit"] != true {
		t.Errorf("atLimit = %v: a read that came back full made no mention of it", got["atLimit"])
	}
	if got["limit"] != ipamSpacesLimit {
		t.Errorf("limit = %v, want %d", got["limit"], ipamSpacesLimit)
	}
	if got["status"] != "ok" {
		t.Errorf("status = %v: a full read is still a good read", got["status"])
	}
}

func TestIpamSpacesMakesNoClaimWhenTheReadWasNotFull(t *testing.T) {
	for _, have := range []int{0, 31, ipamSpacesLimit - 1} {
		s := newDashboardTestService(t, spacesFake(t, have))
		got := s.CSPIpamUtil()
		if _, said := got["atLimit"]; said {
			t.Errorf("%d spaces upstream: atLimit = %v, want the key absent", have, got["atLimit"])
		}
		if _, said := got["limit"]; said {
			t.Errorf("%d spaces upstream: limit = %v, want the key absent", have, got["limit"])
		}
	}
}
