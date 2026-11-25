package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// visAssets is a small made-up estate: zombies of each Portal type, assets
// with missing records, a cloud-only asset, and one only ServiceNow reports.
func visAssets() []fakeAsset {
	return []fakeAsset{
		{Type: "Storage Volume", Providers: []string{"AWS"}, Classes: []string{"Zombie"}, Indicators: []string{"Detached Storage Volume"}},
		{Type: "Storage Volume", Providers: []string{"AWS"}, Classes: []string{"Noncompliant", "Zombie"}, Indicators: []string{"Unsecured Storage Volume", "Detached Storage Volume"}},
		{Type: "Public IP Address", Providers: []string{"Azure"}, Classes: []string{"Zombie"}, Indicators: []string{"Orphan Public IP"}},
		{Type: "Virtual Machine", Providers: []string{"AWS"}, Classes: []string{"Noncompliant", "Unregistered", "Zombie"}, Indicators: []string{"Publicly Accessible VM", "DNS Forward Record", "DNS Pointer Record", "Underutilized Virtual Machine"}},
		{Type: "Virtual Machine", Providers: []string{"GCP"}, Classes: []string{"Noncompliant"}, Indicators: []string{"Publicly Accessible VM"}},
		{Type: "Workstation", Providers: []string{"DHCP Logs", "ServiceNow"}, Classes: []string{"Unregistered"}, Indicators: []string{"DNS Pointer Record"}},
		{Type: "Workstation", Providers: []string{"ServiceNow"}},
		{Type: "Server", Providers: []string{"NIOS Grid"}, Classes: []string{"Unregistered"}, Indicators: []string{"IPAM"}},
	}
}

func visDecode(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, s)
	}
	return m
}

func countOf(t *testing.T, m any) any {
	t.Helper()
	mm, ok := m.(map[string]any)
	if !ok {
		t.Fatalf("not a metric: %v", m)
	}
	return mm["count"]
}

func TestAssetProblemsTool(t *testing.T) {
	f := &visTenant{Assets: visAssets()}
	out := visDecode(t, f.service(t).RunAITool(context.Background(), "asset_problems", map[string]any{"split": "type"}))
	res := out["result"].(map[string]any)
	want := map[string]map[string]float64{
		"problems":        {"Zombie": 4, "Noncompliant": 3, "Unregistered": 3},
		"missing_records": {"DNS Forward Record": 1, "DNS Pointer Record": 2, "IPAM": 1},
		"zombies_by_type": {"Storage Volume": 2, "Public IP Address": 1, "Virtual Machine": 1, "Load Balancer": 0},
		"indicators":      {"Detached Storage Volume": 2, "Publicly Accessible VM": 2, "Unsecured Storage Volume": 1},
	}
	for group, counts := range want {
		g := res[group].(map[string]any)
		for k, n := range counts {
			if got := countOf(t, g[k]); got != n {
				t.Errorf("%s %s: want %v, got %v", group, k, n, got)
			}
		}
	}
	for k, v := range res["not_proven"].(map[string]any) {
		if countOf(t, v) != nil || v.(map[string]any)["status"] != MetricNotRead {
			t.Errorf("%s must be not_read with no count, got %v", k, v)
		}
	}
	split := res["top_split"].(map[string]any)
	if !strings.Contains(split["note"].(string), "Top 10") {
		t.Errorf("a split must be labelled top-N: %v", split)
	}
	if !strings.Contains(out["summary"].(string), "Zombie 4") {
		t.Errorf("summary: %v", out["summary"])
	}
}

// Every total is its own unsplit count query: no total reads a split.
func TestAssetProblems_TotalsAreUnsplit(t *testing.T) {
	f := &visTenant{Assets: visAssets()}
	f.service(t).RunAITool(context.Background(), "asset_problems", map[string]any{})
	if n := f.calls("dimensions"); n != 0 {
		t.Fatalf("with no split, no query should group by anything; %d did", n)
	}
}

func combosOf(t *testing.T, assets []fakeAsset) []coverageCombo {
	t.Helper()
	f := &visTenant{Assets: assets}
	combos, m := f.service(t).readCombos(context.Background())
	if !m.OK() {
		t.Fatalf("combos: %+v", m)
	}
	return combos
}

var connWhole = map[string]any{"availability": "ok", "truncated": false, "connectors": []map[string]any{{"name": "aws-prod", "type": "Amazon Web Services"}}}

// Cloud-only assets count as missing from ServiceNow: the coverage tiles'
// network-only rule must not be reused here.
func TestCmdbGap_CountsCloudOnlyAssets(t *testing.T) {
	combos := combosOf(t, visAssets())
	g := assembleCmdbGap(combos, metricOK(len(combos)), connWhole)
	if g.Connected != "yes" {
		t.Fatalf("ServiceNow is an asset source: want yes, got %s (%s)", g.Connected, g.ConnectedWhy)
	}
	// 8 assets: 2 with ServiceNow (one only ServiceNow), 6 without.
	if !g.Missing.OK() || g.Missing.N() != 6 || g.OnlyInServiceNow.N() != 1 || g.InBoth.N() != 1 || g.Total.N() != 8 {
		t.Fatalf("got missing %+v only %+v both %+v total %+v", g.Missing, g.OnlyInServiceNow, g.InBoth, g.Total)
	}
	if len(g.MissingBySource) == 0 || g.MissingBySource[0] != (chartItem{"AWS", 3}) {
		t.Fatalf("by source, largest first: %v", g.MissingBySource)
	}
	if g.Completeness.Count != nil || g.Orphaned.Count != nil || g.Orphaned.Status != MetricNotRead {
		t.Fatalf("completeness and orphaned stay null: %+v %+v", g.Completeness, g.Orphaned)
	}
}

// A failed or capped connector list never proves ServiceNow is missing.
func TestCmdbGap_ConnectorListMustBeWholeToSayNo(t *testing.T) {
	noSN := []fakeAsset{{Type: "Server", Providers: []string{"AWS"}}}
	combos := combosOf(t, noSN)
	cases := map[string]struct {
		conn map[string]any
		want string
	}{
		"whole list":  {connWhole, "no"},
		"failed read": {map[string]any{"availability": "error"}, "unknown"},
		"cut short":   {map[string]any{"availability": "ok", "truncated": true, "connectors": []map[string]any{}}, "unknown"},
		"listed":      {map[string]any{"availability": "ok", "truncated": true, "connectors": []map[string]any{{"name": "cmdb", "type": "ServiceNow"}}}, "yes"},
	}
	for name, c := range cases {
		g := assembleCmdbGap(combos, metricOK(len(combos)), c.conn)
		if g.Connected != c.want {
			t.Errorf("%s: want %s, got %s", name, c.want, g.Connected)
		}
		if c.want != "yes" && g.Missing.Count != nil {
			t.Errorf("%s: missing must be null when ServiceNow isn't connected, got %+v", name, g.Missing)
		}
	}
	// A failed combination read is unknown, never 0 missing.
	g := assembleCmdbGap(nil, metricFail(MetricUnknown, "boom"), connWhole)
	if g.Connected != "unknown" || g.Missing.Count != nil || g.Total.Count != nil {
		t.Fatalf("failed combos: %+v", g)
	}
}

func TestCmdbGapTool(t *testing.T) {
	f := &visTenant{Assets: visAssets(), Connectors: []map[string]any{}}
	out := visDecode(t, f.service(t).RunAITool(context.Background(), "cmdb_gap", nil))
	if !strings.Contains(out["summary"].(string), "missing from ServiceNow (every source, cloud included): 6") {
		t.Fatalf("summary: %v", out["summary"])
	}
}

func TestSubnetBands_Boundaries(t *testing.T) {
	for u, want := range map[int][2]bool{0: {true, false}, 19: {true, false}, 20: {false, false}, 79: {false, false}, 80: {false, true}, 100: {false, true}} {
		if inUnderBand(u) != want[0] || inOverBand(u) != want[1] {
			t.Errorf("%d%%: want under=%v over=%v", u, want[0], want[1])
		}
	}
	// The server-side filters say the same thing.
	f := &visTenant{Subnets: []fakeSubnet{{24, 19, "", ""}, {24, 20, "", ""}, {24, 79, "", ""}, {24, 80, "", ""}}}
	s := f.service(t)
	under := s.restCountCtx(context.Background(), subnetPath, subnetFilter(subnetUnderFilter))
	over := s.restCountCtx(context.Background(), subnetPath, subnetFilter(subnetOverFilter))
	if under.N() != 1 || over.N() != 1 {
		t.Fatalf("filters: under %+v over %+v, want 1 and 1", under, over)
	}
}

func cloudSubnets() []fakeSubnet {
	return []fakeSubnet{
		{24, 5, "AWS", ""}, {24, 85, "AWS", ""}, {24, 50, "AWS", ""},
		{24, 10, "Azure", ""}, {30, 100, "", ""}, {24, 3, "", ""},
		{24, 90, "GCP", "tag"}, // tagged GCP, no discoverer name
	}
}

func TestSubnetClouds_Summary(t *testing.T) {
	f := &visTenant{Subnets: cloudSubnets()}
	sum := f.service(t).readSubnetClouds(context.Background())
	if sum.Total.N() != 7 || sum.Underutilized.N() != 3 || sum.Overutilized.N() != 3 {
		t.Fatalf("all: %+v %+v %+v", sum.Total, sum.Underutilized, sum.Overutilized)
	}
	aws := sum.Clouds[0]
	if aws.Cloud != "AWS" || aws.Subnets.N() != 3 || aws.Underutilized.N() != 1 || aws.Overutilized.N() != 1 {
		t.Fatalf("AWS: %+v", aws)
	}
	// The GCP subnet known only by its tag is GCP, as cloudOfSubnet reads it.
	if gcp := sum.Clouds[2]; gcp.Subnets.N() != 1 || gcp.Overutilized.N() != 1 {
		t.Fatalf("GCP: %+v", gcp)
	}
	if !sum.Unconfirmed.OK() || sum.Unconfirmed.N() != 0 || sum.NotCloud.N() != 2 {
		t.Fatalf("unknown %+v not cloud %+v, want 0 and 2", sum.Unconfirmed, sum.NotCloud)
	}
}

func TestGetSubnets_ByCloudAndMax(t *testing.T) {
	f := &visTenant{Subnets: cloudSubnets()}
	s := f.service(t)
	out := visDecode(t, s.RunAITool(context.Background(), "get_subnets", map[string]any{"by_cloud": true}))
	if _, ok := out["by_cloud"]; !ok {
		t.Fatalf("by_cloud summary missing: %v", out)
	}
	s.RunAITool(context.Background(), "get_subnets", map[string]any{"max_utilization": 19.0})
	if f.calls("utilization.utilization%3C%3D19") == 0 {
		t.Fatalf("max_utilization should filter server-side: %v", f.Calls)
	}
}

func TestRiskyDNSTool(t *testing.T) {
	f := &visTenant{Records: append(staleRecords(30), fakeRecord{Name: "x", Zone: "z.", Flags: []string{"Dangling"}})}
	out := visDecode(t, f.service(t).RunAITool(context.Background(), "risky_dns_records", nil))
	counts := out["counts"].(map[string]any)
	if countOf(t, counts["Stale"]) != 30.0 || countOf(t, counts["Dangling"]) != 1.0 || countOf(t, counts["Abandoned"]) != 0.0 {
		t.Fatalf("counts: %v", counts)
	}
	if n := len(out["samples"].(map[string]any)["Stale"].([]any)); n != aiSampleCap {
		t.Fatalf("Stale sample: want %d, got %d", aiSampleCap, n)
	}
	if out["other_flags"] != "none: no record carries any other flag" {
		t.Fatalf("other_flags: %v", out["other_flags"])
	}
}

// A refused read is reported as refused in the tool, not as zero.
func TestRiskyDNSTool_Refused(t *testing.T) {
	f := &visTenant{Fail: func(*http.Request) (int, string) { return 403, "" }}
	out := visDecode(t, f.service(t).RunAITool(context.Background(), "risky_dns_records", nil))
	c := out["counts"].(map[string]any)["Dangling"].(map[string]any)
	if c["count"] != nil || c["status"] != MetricForbidden {
		t.Fatalf("want forbidden with no count, got %v", c)
	}
}

// A connection's name is typed by an admin, so it proves nothing: an AWS
// connection called servicenow-sync does not connect ServiceNow.
func TestCmdbGap_ConnectorNameIsNotProof(t *testing.T) {
	combos := combosOf(t, []fakeAsset{{Type: "Server", Providers: []string{"AWS"}}})
	conn := map[string]any{"availability": "ok", "truncated": false,
		"connectors": []map[string]any{{"name": "servicenow-sync", "type": "Amazon Web Services"}}}
	g := assembleCmdbGap(combos, metricOK(len(combos)), conn)
	if g.Connected != "no" || g.Missing.Count != nil {
		t.Fatalf("want not connected and no count, got %s %+v", g.Connected, g.Missing)
	}
}

// One AWS subnet known only by its tag and one known only by its discoverer
// are both AWS (cloudOfSubnet reads either), so neither is "not cloud".
func TestSubnetClouds_TagAndDiscovererOverlap(t *testing.T) {
	f := &visTenant{Subnets: []fakeSubnet{
		{24, 5, "AWS", "tag"}, {24, 90, "AWS", "disc"}, {24, 50, "", ""},
	}}
	sum := f.service(t).readSubnetClouds(context.Background())
	aws := sum.Clouds[0]
	if aws.Subnets.N() != 2 || aws.Underutilized.N() != 1 || aws.Overutilized.N() != 1 {
		t.Fatalf("AWS: %+v", aws)
	}
	if !sum.Unconfirmed.OK() || sum.Unconfirmed.N() != 0 || sum.NotCloud.N() != 1 {
		t.Fatalf("unknown %+v not cloud %+v, want 0 and 1", sum.Unconfirmed, sum.NotCloud)
	}
}

// pagedSubnets serves total ids, at most pageMax per page from _offset; when
// emptyAfter > 0, every page past that offset comes back empty.
func pagedSubnets(t *testing.T, total, pageMax, emptyAfter int) *Service {
	t.Helper()
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		off, _ := strconv.Atoi(r.URL.Query().Get("_offset"))
		rows := []map[string]any{}
		for i := off; i < total && len(rows) < pageMax && !(emptyAfter > 0 && off >= emptyAfter); i++ {
			rows = append(rows, map[string]any{"id": "subnet/" + strconv.Itoa(i)})
		}
		writeResultsWithPage(w, rows, map[string]any{"total_size": strconv.Itoa(total)})
	})
	return s
}

// A page shorter than asked for moves the offset by what came back, so no
// row is skipped.
func TestSubnetRowsAll_ShortPagesSkipNothing(t *testing.T) {
	rows, m := pagedSubnets(t, 5, 2, 0).subnetRowsAll(context.Background(), nil)
	if !m.OK() || len(rows) != 5 {
		t.Fatalf("want all 5 rows, got %d %+v", len(rows), m)
	}
}

// An empty page while the total says rows remain is incomplete, never a
// complete count of what came back.
func TestSubnetRowsAll_EmptyPageEarlyIsIncomplete(t *testing.T) {
	_, m := pagedSubnets(t, 5, 2, 2).subnetRowsAll(context.Background(), nil)
	if m.Status != MetricIncomplete || m.Reason == "" {
		t.Fatalf("want incomplete with a reason, got %+v", m)
	}
}
