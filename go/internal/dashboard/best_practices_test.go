package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// Fake rows shaped like the live detail_hosts and dhcp/ha_group reads
// (field and tag names checked against the live tenant on 2026-11-06).
func bpHost(name, status string, tags map[string]any) map[string]any {
	return map[string]any{"display_name": name, "composite_status": status, "tags": tags}
}

func nios(grid, gmIP, role, oid string, extra map[string]any) map[string]any {
	t := map[string]any{"host/grid_name": grid, "host/gridmaster_ip": gmIP, "host/nios_role": role, "host/physical_oid": oid, "host/ha_pair": "false"}
	for k, v := range extra {
		t[k] = v
	}
	return t
}

func bpService(t *testing.T, hosts []map[string]any, hostsTotal any, ha []map[string]any, haStatus int) *Service {
	t.Helper()
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/infra/v1/detail_hosts"):
			if hostsTotal == nil {
				writeResults(w, hosts)
				return
			}
			writeResultsWithPage(w, hosts, map[string]any{"total_size": hostsTotal})
		case strings.HasPrefix(r.URL.Path, "/api/ddi/v1/dhcp/ha_group"):
			if haStatus != 200 {
				w.WriteHeader(haStatus)
				return
			}
			writeResultsWithPage(w, ha, map[string]any{"total_size": strconv.Itoa(len(ha))})
		default:
			w.WriteHeader(404)
		}
	})
	return s
}

// findCheck reads the result the way the page does: as JSON.
func findCheck(t *testing.T, out map[string]any, id string) map[string]any {
	t.Helper()
	b, _ := json.Marshal(out)
	var got struct {
		Checks []map[string]any `json:"checks"`
	}
	_ = json.Unmarshal(b, &got)
	for _, c := range got.Checks {
		if c["id"] == id {
			return c
		}
	}
	t.Fatalf("no check %q in %v", id, out)
	return nil
}

func itemNames(c map[string]any) []string {
	var n []string
	for _, it := range c["items"].([]any) {
		n = append(n, it.(map[string]any)["name"].(string))
	}
	return n
}

func TestBestPractices_HostsOffline(t *testing.T) {
	s := bpService(t, []map[string]any{
		bpHost("a", "online", nil), bpHost("b", "error", nil), bpHost("c", "offline", nil), bpHost("d", "pending", nil),
	}, "4", nil, 200)
	c := findCheck(t, s.BestPractices(context.Background()), "hosts-down")
	if c["status"] != "problem" || strings.Join(itemNames(c), ",") != "b,c" {
		t.Fatalf("want problem with b,c; got %v", c)
	}
	if !strings.HasPrefix(c["title"].(string), "2 ") {
		t.Fatalf("title should lead with the count: %q", c["title"])
	}
}

func TestBestPractices_HostsAllOnlinePasses(t *testing.T) {
	s := bpService(t, []map[string]any{bpHost("a", "online", nil)}, "1", nil, 200)
	if c := findCheck(t, s.BestPractices(context.Background()), "hosts-down"); c["status"] != "passed" {
		t.Fatalf("want passed, got %v", c)
	}
}

// A truncated list must not pass: the offline host may be past the last row.
func TestBestPractices_HostsTruncatedCannotPass(t *testing.T) {
	s := bpService(t, []map[string]any{bpHost("a", "online", nil)}, "5000", nil, 200)
	c := findCheck(t, s.BestPractices(context.Background()), "hosts-down")
	if c["status"] != "unknown" || c["reason"] == "" {
		t.Fatalf("a truncated list must say couldn't check, got %v", c)
	}
}

func TestBestPractices_GridMasterResilience(t *testing.T) {
	hosts := []map[string]any{
		// Grid lone: GM only, the grid says it has 1 node. Proven: no HA, no candidate.
		bpHost("lone-gm", "online", nios("lone", "10.0.0.1", "GM", "p1", map[string]any{"host/grid_pnode_count": "1"})),
		// Grid ok-gmc: has a candidate.
		bpHost("ok-gm", "online", nios("ok", "10.0.0.2", "GM", "p2", map[string]any{"host/grid_pnode_count": "2"})),
		bpHost("ok-gmc", "online", nios("ok", "10.0.0.2", "GMC", "p3", nil)),
		// Grid ha: its GM is an HA pair.
		bpHost("ha-gm", "online", nios("ha", "10.0.0.3", "GM", "p4", map[string]any{"host/ha_pair": "true", "host/grid_pnode_count": "3"})),
		// Grid partial: says 4 nodes, only 2 visible, no candidate seen. Can't tell.
		bpHost("part-gm", "online", nios("part", "10.0.0.4", "GM", "p5", map[string]any{"host/grid_pnode_count": "4"})),
		bpHost("part-m", "online", nios("part", "10.0.0.4", "member", "p6", nil)),
		// Same grid name as "lone" but a different Grid Master: a separate grid with a candidate.
		bpHost("lone2-gm", "online", nios("lone", "10.9.9.9", "GM", "p7", map[string]any{"host/grid_pnode_count": "2"})),
		bpHost("lone2-gmc", "online", nios("lone", "10.9.9.9", "GMC", "p8", nil)),
	}
	s := bpService(t, hosts, "8", nil, 200)
	c := findCheck(t, s.BestPractices(context.Background()), "gm-resilience")
	if c["status"] != "problem" || strings.Join(itemNames(c), ",") != "lone" {
		t.Fatalf("want only grid lone flagged, got %v", c)
	}
	if note, _ := c["note"].(string); !strings.Contains(note, "1 grid") {
		t.Fatalf("the grid that can't be told should be counted in the note, got %q", c["note"])
	}
}

func TestBestPractices_GridOnlyUnknownSaysSo(t *testing.T) {
	s := bpService(t, []map[string]any{
		bpHost("gm", "online", nios("g", "10.0.0.1", "GM", "p1", map[string]any{"host/grid_pnode_count": "3"})),
	}, "1", nil, 200)
	c := findCheck(t, s.BestPractices(context.Background()), "gm-resilience")
	if c["status"] != "unknown" {
		t.Fatalf("one grid with hidden members: want unknown, got %v", c)
	}
}

func TestBestPractices_AdvancedActivePassive(t *testing.T) {
	s := bpService(t, nil, "0", []map[string]any{
		{"name": "pair-a", "mode": "active-active"},
		{"name": "pair-b", "mode": "advanced-active-passive"},
	}, 200)
	c := findCheck(t, s.BestPractices(context.Background()), "dhcp-aap")
	if c["status"] != "problem" || strings.Join(itemNames(c), ",") != "pair-b" {
		t.Fatalf("want pair-b, got %v", c)
	}
}

// A failed read says so for its own check and leaves the others alone.
func TestBestPractices_FailedReadIsUnknownNotPassed(t *testing.T) {
	s := bpService(t, []map[string]any{bpHost("a", "online", nil)}, "1", nil, 500)
	out := s.BestPractices(context.Background())
	if c := findCheck(t, out, "dhcp-aap"); c["status"] != "unknown" {
		t.Fatalf("failed HA group read: want unknown, got %v", c)
	}
	if c := findCheck(t, out, "hosts-down"); c["status"] != "passed" {
		t.Fatalf("host check should still run, got %v", c)
	}
}

// A result with a failed read is not cached, so the page recovers on retry.
func TestBestPractices_FailureNotCached(t *testing.T) {
	fail := true
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/ddi/v1/dhcp/ha_group") && fail {
			w.WriteHeader(500)
			return
		}
		writeResultsWithPage(w, nil, map[string]any{"total_size": "0"})
	})
	if c := findCheck(t, s.BestPractices(context.Background()), "dhcp-aap"); c["status"] != "unknown" {
		t.Fatalf("first read failed: want unknown, got %v", c)
	}
	fail = false
	if c := findCheck(t, s.BestPractices(context.Background()), "dhcp-aap"); c["status"] != "passed" {
		t.Fatalf("after recovery: want passed, got %v", c)
	}
}

// No total from the API: fewer rows than the limit is not proof of the whole list.
func TestBestPractices_NoTotalCannotPass(t *testing.T) {
	s := bpService(t, []map[string]any{bpHost("a", "online", nil)}, nil, nil, 200)
	if c := findCheck(t, s.BestPractices(context.Background()), "hosts-down"); c["status"] != "unknown" {
		t.Fatalf("no total: want unknown, got %v", c)
	}
}

// A member with no physical node id could be a second record of a node already
// counted, so the grid can't be proven complete.
func TestBestPractices_MissingNodeIDIsUnknown(t *testing.T) {
	gm := nios("g", "10.0.0.1", "GM", "p1", map[string]any{"host/grid_pnode_count": "2"})
	twin := nios("g", "10.0.0.1", "member", "", nil)
	delete(twin, "host/physical_oid")
	s := bpService(t, []map[string]any{bpHost("gm", "online", gm), bpHost("gm-again", "online", twin)}, "2", nil, 200)
	if c := findCheck(t, s.BestPractices(context.Background()), "gm-resilience"); c["status"] != "unknown" {
		t.Fatalf("missing node id: want unknown, got %v", c)
	}
}

// A total smaller than the rows returned is an inconsistent answer, not proof.
func TestBestPractices_InconsistentTotalCannotPass(t *testing.T) {
	s := bpService(t, []map[string]any{bpHost("a", "online", nil)}, "0", nil, 200)
	if c := findCheck(t, s.BestPractices(context.Background()), "hosts-down"); c["status"] != "unknown" {
		t.Fatalf("total 0 with 1 row: want unknown, got %v", c)
	}
}

// A grid host with no role is still a grid: never "no grids connected".
func TestBestPractices_GridHostWithoutRoleIsUnknown(t *testing.T) {
	tags := nios("g", "10.0.0.1", "", "p1", nil)
	delete(tags, "host/nios_role")
	s := bpService(t, []map[string]any{bpHost("x", "online", tags)}, "1", nil, 200)
	if c := findCheck(t, s.BestPractices(context.Background()), "gm-resilience"); c["status"] != "unknown" {
		t.Fatalf("grid host with no role: want unknown, got %v", c)
	}
}
