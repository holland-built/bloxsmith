package dashboard

import (
	"context"
	"fmt"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"testing"
)

func sp(space, cidr string) SpacePrefix {
	return SpacePrefix{Space: space, Prefix: netip.MustParsePrefix(cidr)}
}

func TestOutermost_EqualStartKeepsOnlyTheWidest(t *testing.T) {
	// The /16 comes first on purpose: a sort on start alone would keep it.
	got := Outermost([]SpacePrefix{sp("A", "10.0.0.0/16"), sp("A", "10.0.0.0/8")})
	if len(got) != 1 || got[0].Prefix.String() != "10.0.0.0/8" {
		t.Fatalf("got %v, want only 10.0.0.0/8", got)
	}
}

func TestGroupOverlaps_EqualStartInOneSpaceIsNotDoubleCounted(t *testing.T) {
	groups := GroupOverlaps([]SpacePrefix{sp("A", "10.0.0.0/16"), sp("A", "10.0.0.0/8"), sp("B", "10.0.0.0/16")}, nil)
	if len(groups) != 1 || groups[0].Spaces != 2 {
		t.Fatalf("got %+v, want one group of 2 spaces", groups)
	}
	for _, m := range groups[0].Members {
		if m.ID == "A" && strings.Join(m.Prefixes, ",") != "10.0.0.0/8" {
			t.Fatalf("space A lists %v, want only 10.0.0.0/8", m.Prefixes)
		}
	}
}

func TestGroupOverlaps_TouchingRangesFormOneGroup(t *testing.T) {
	// B and C do not overlap each other, but both sit inside A's /8.
	groups := GroupOverlaps([]SpacePrefix{sp("C", "10.2.0.0/16"), sp("A", "10.0.0.0/8"), sp("B", "10.1.0.0/16")}, nil)
	if len(groups) != 1 {
		t.Fatalf("got %d groups, want 1: %+v", len(groups), groups)
	}
	g := groups[0]
	if g.Range != "10.0.0.0/8" || g.Spaces != 3 || len(g.Members) != 3 {
		t.Fatalf("got %+v, want 10.0.0.0/8 in 3 spaces", g)
	}
	want := map[string]string{"A": "10.0.0.0/8", "B": "10.1.0.0/16", "C": "10.2.0.0/16"}
	for _, m := range g.Members {
		if strings.Join(m.Prefixes, ",") != want[m.ID] {
			t.Fatalf("space %s lists %v, want %s", m.ID, m.Prefixes, want[m.ID])
		}
	}
}

func TestGroupOverlaps_OneSpaceOnlyIsNoGroup(t *testing.T) {
	groups := GroupOverlaps([]SpacePrefix{sp("A", "10.0.0.0/8"), sp("A", "10.0.0.0/8"), sp("A", "10.1.0.0/16")}, nil)
	if len(groups) != 0 {
		t.Fatalf("got %+v, want no group", groups)
	}
}

func TestGroupOverlaps_IPv4AndIPv6NeverGroup(t *testing.T) {
	groups := GroupOverlaps([]SpacePrefix{sp("A", "0.0.0.0/0"), sp("B", "::/0"), sp("C", "::ffff:10.0.0.0/104")}, nil)
	for _, g := range groups {
		if g.Spaces > 1 && strings.Contains(g.Range, ".") != strings.Contains(g.Members[0].Prefixes[0], ".") {
			t.Fatalf("mixed families: %+v", g)
		}
	}
	// B's ::/0 does hold C's IPv4-mapped range, so that is the one group;
	// A's IPv4 0.0.0.0/0 must not join it.
	if len(groups) != 1 || groups[0].Range != "::/0" || groups[0].Spaces != 2 {
		t.Fatalf("got %+v, want only ::/0 in B and C", groups)
	}
}

func TestGroupOverlaps_BiggestFirstAndNamesKeptApart(t *testing.T) {
	groups := GroupOverlaps([]SpacePrefix{
		sp("s1", "192.168.0.0/16"), sp("s2", "192.168.1.0/24"),
		sp("s1", "10.0.0.0/8"), sp("s2", "10.0.0.0/8"), sp("s3", "10.9.0.0/16"),
	}, map[string]string{"s1": "Lab", "s2": "Lab"})
	if len(groups) != 2 || groups[0].Range != "10.0.0.0/8" || groups[1].Range != "192.168.0.0/16" {
		t.Fatalf("got %+v, want 10/8 (3 spaces) before 192.168/16 (2)", groups)
	}
	names := map[string]string{}
	for _, m := range groups[0].Members {
		names[m.ID] = m.Name
	}
	// Two spaces both named Lab stay two members; a space with no name shows its id.
	if names["s1"] != "Lab" || names["s2"] != "Lab" || names["s3"] != "s3" {
		t.Fatalf("names = %v", names)
	}
}

// overlapUpstream fakes the three reads. subnets answers with the given rows
// and total; blocks and spaces page by _offset.
func overlapUpstream(subnets []map[string]any, subnetTotal int, blocks []map[string]any) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		off, _ := strconv.Atoi(q.Get("_offset"))
		lim, _ := strconv.Atoi(q.Get("_limit"))
		page := func(rows []map[string]any) []map[string]any {
			if off >= len(rows) {
				return []map[string]any{}
			}
			end := off + lim
			if lim == 0 || end > len(rows) {
				end = len(rows)
			}
			return rows[off:end]
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			writeResultsWithPage(w, page(subnets), map[string]any{"total_size": strconv.Itoa(subnetTotal)})
		case strings.HasSuffix(r.URL.Path, "/ipam/address_block"):
			writeResults(w, page(blocks))
		case strings.HasSuffix(r.URL.Path, "/ipam/ip_space"):
			writeResults(w, page([]map[string]any{{"id": "sA", "name": "Alpha"}, {"id": "sB", "name": "Beta"}}))
		default:
			w.WriteHeader(404)
		}
	}
}

func row(id, space, addr string, cidr any) map[string]any {
	return map[string]any{"id": id, "space": space, "address": addr, "cidr": cidr}
}

func TestFetchOverlaps_ReadsBlocksAndTopSubnets(t *testing.T) {
	s, paths := newAIToolsTestService(t, overlapUpstream(
		[]map[string]any{row("n1", "sB", "10.1.0.0", 16)}, 1,
		[]map[string]any{row("b1", "sA", "10.0.0.0", 8)}))
	res := s.FetchOverlaps()
	if res["status"] != "ok" {
		t.Fatalf("got %v", res)
	}
	groups := res["groups"].([]OverlapGroup)
	if len(groups) != 1 || groups[0].Spaces != 2 || groups[0].Members[0].Name != "Alpha" {
		t.Fatalf("groups = %+v", groups)
	}
	sawParentFilter := false
	for _, p := range *paths {
		if strings.Contains(p, "/ipam/subnet?") && strings.Contains(p, "parent%3D%3Dnull") {
			sawParentFilter = true
		}
	}
	if !sawParentFilter {
		t.Fatalf("subnets were not read with parent==null: %v", *paths)
	}
}

func TestFetchOverlaps_SubnetTotalMismatchIsAnError(t *testing.T) {
	s, _ := newAIToolsTestService(t, overlapUpstream(
		[]map[string]any{row("n1", "sA", "10.1.0.0", 16), row("n2", "sB", "10.1.0.0", 16)}, 3, nil))
	res := s.FetchOverlaps()
	if res["status"] != "error" || !strings.Contains(fmt.Sprint(res["error"]), "every subnet") {
		t.Fatalf("got %v, want the every-subnet error", res)
	}
	if _, ok := res["groups"]; ok {
		t.Fatalf("an incomplete read still returned groups: %v", res)
	}
}

func TestFetchOverlaps_UnreadableCIDRIsAnError(t *testing.T) {
	s, _ := newAIToolsTestService(t, overlapUpstream(
		[]map[string]any{row("n1", "sA", "10.1.0.0", "x")}, 1, nil))
	if res := s.FetchOverlaps(); res["status"] != "error" {
		t.Fatalf("got %v, want an error", res)
	}
}

func TestFetchOverlaps_RowWithNoSpaceIsAnError(t *testing.T) {
	s, _ := newAIToolsTestService(t, overlapUpstream(nil, 0,
		[]map[string]any{row("b1", "", "10.0.0.0", 8)}))
	if res := s.FetchOverlaps(); res["status"] != "error" {
		t.Fatalf("got %v, want an error", res)
	}
}

func TestFetchOverlaps_BlocksArePagedToTheEnd(t *testing.T) {
	// More blocks than one page: the second page must be read.
	var blocks []map[string]any
	for i := 0; i < overlapPage+3; i++ {
		blocks = append(blocks, row(fmt.Sprintf("b%d", i), "sA", fmt.Sprintf("10.%d.%d.0", i/256, i%256), 24))
	}
	blocks = append(blocks, row("last", "sB", "10.0.0.0", 8))
	s, _ := newAIToolsTestService(t, overlapUpstream(nil, 0, blocks))
	res := s.FetchOverlaps()
	groups, _ := res["groups"].([]OverlapGroup)
	if res["status"] != "ok" || len(groups) != 1 || groups[0].Spaces != 2 {
		t.Fatalf("got %v, want the last block (on page 2) to make a group", res)
	}
}

func TestRunAITool_OverlappingRanges(t *testing.T) {
	s, _ := newAIToolsTestService(t, overlapUpstream(
		[]map[string]any{row("n1", "sB", "10.1.0.0", 16)}, 1,
		[]map[string]any{row("b1", "sA", "10.0.0.0", 8)}))
	out := s.RunAITool(context.Background(), "get_overlapping_ranges", map[string]any{})
	for _, want := range []string{"10.0.0.0/8", "Alpha", "Beta", "10.1.0.0/16", "UNTRUSTED_DATA_NOTICE"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in %s", want, out)
		}
	}
}

func TestRunAITool_OverlappingRangesNoneAndFailure(t *testing.T) {
	s, _ := newAIToolsTestService(t, overlapUpstream(nil, 0, []map[string]any{row("b1", "sA", "10.0.0.0", 8)}))
	if out := s.RunAITool(context.Background(), "get_overlapping_ranges", nil); !strings.Contains(out, "No address range is used in more than one IP space") {
		t.Fatalf("got %q", out)
	}
	bad, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) })
	out := bad.RunAITool(context.Background(), "get_overlapping_ranges", nil)
	if !strings.Contains(out, "lookup failure") || strings.Contains(out, "No address range") {
		t.Fatalf("got %q, want a lookup failure", out)
	}
}

func TestOverlapsForAI_CapsGroupsAndNames(t *testing.T) {
	var items []SpacePrefix
	for g := 0; g < 22; g++ {
		for i := 0; i < 30; i++ {
			items = append(items, sp(fmt.Sprintf("s%d", i), fmt.Sprintf("10.%d.0.0/16", g)))
		}
	}
	p := overlapsForAI(GroupOverlaps(items, nil))
	if p.TotalGroups != 22 || len(p.Groups) != 20 || p.MoreGroups != 2 {
		t.Fatalf("got %d shown of %d, more %d", len(p.Groups), p.TotalGroups, p.MoreGroups)
	}
	if len(p.Groups[0].Spaces) != 25 || p.Groups[0].MoreSpaces != 5 {
		t.Fatalf("got %d names, more %d", len(p.Groups[0].Spaces), p.Groups[0].MoreSpaces)
	}
}

func TestFetchOverlaps_BlockPageWithNoResultsIsAnError(t *testing.T) {
	// The second block page answers {}: no results array at all. That is not
	// the end of the list, so the read must fail rather than stop there.
	base := overlapUpstream(nil, 0, nil)
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/ipam/address_block") {
			if r.URL.Query().Get("_offset") == "0" {
				writeResults(w, []map[string]any{row("b1", "sA", "10.0.0.0", 8)})
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{}`))
			return
		}
		base(w, r)
	})
	if res := s.FetchOverlaps(); res["status"] != "error" || !strings.Contains(fmt.Sprint(res["error"]), "address block") {
		t.Fatalf("got %v, want the every-address-block error", res)
	}
}
