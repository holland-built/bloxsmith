package dashboard

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/mcp"
)

// comboRow is one row of the grouped providers_label query, in the shape the
// cube sends: the label list as JSON text, the count as a string.
func comboRow(labels string, n string) map[string]any {
	return map[string]any{assetsCube + ".providers_label": labels, assetsMeasure: n}
}

// liveCombos is every source combination the live tenant had on 2026-11-17,
// with its count. They add up to its 2,219 assets.
func liveCombos() []map[string]any {
	return []map[string]any{
		comboRow(`["AWS"]`, "756"),
		comboRow(`["NIOS Grid"]`, "592"),
		comboRow(`["Azure"]`, "399"),
		comboRow(`["GCP"]`, "347"),
		comboRow(`["DHCP Logs"]`, "90"),
		comboRow(`["NIOS-X Discovery"]`, "21"),
		comboRow(`["Infoblox Endpoint"]`, "7"),
		comboRow(`["DHCP Logs","NIOS Grid"]`, "6"),
		comboRow(`["Infoblox Endpoint","NIOS Grid"]`, "1"),
	}
}

func gapsOf(t *testing.T, got map[string]any) []map[string]any {
	t.Helper()
	list, ok := got["gaps"].([]map[string]any)
	if !ok {
		t.Fatalf("gaps is %T: %v", got["gaps"], got)
	}
	return list
}

func TestCoverageRole_SortsSourcesIntoNetworkAndInventory(t *testing.T) {
	cases := map[string][2]string{
		"DHCP Logs":          {"network", ""},
		"NIOS Grid":          {"network", ""},
		"NIOS-X Discovery":   {"network", ""},
		"Network Insight":    {"network", ""},
		"Infoblox Endpoint":  {"inventory", "Infoblox agent"},
		"CrowdStrike Falcon": {"inventory", "security agent"},
		"SentinelOne":        {"inventory", "security agent"},
		"Microsoft Defender": {"inventory", "security agent"},
		"ServiceNow":         {"inventory", "asset register"},
		"Microsoft Intune":   {"inventory", "device management"},
		"Jamf":               {"inventory", "device management"},
		"AWS":                {"", ""},
		"Azure":              {"", ""},
		"GCP":                {"", ""},
	}
	for label, want := range cases {
		kind, role := coverageRole(label)
		if kind != want[0] || role != want[1] {
			t.Errorf("coverageRole(%q) = %q, %q; want %q, %q", label, kind, role, want[0], want[1])
		}
	}
}

func TestAssembleCoverage_CountsTheLiveTenant(t *testing.T) {
	got := assembleCoverage(liveCombos(), nil)
	if got["availability"] != "ok" || got["total"] != 2219 {
		t.Fatalf("payload %v", got)
	}
	if n := strings.Join(got["network"].([]string), ","); n != "DHCP Logs,NIOS Grid,NIOS-X Discovery" {
		t.Errorf("network sources %q", n)
	}
	gaps := gapsOf(t, got)
	if len(gaps) != 1 {
		t.Fatalf("gaps %v", gaps)
	}
	// 592 NIOS Grid + 90 DHCP Logs + 21 NIOS-X + 6 DHCP Logs and NIOS Grid.
	// The one asset Infoblox Endpoint shares with NIOS Grid is not a gap.
	if g := gaps[0]; g["source"] != "Infoblox Endpoint" || g["count"] != 709 || g["role"] != "Infoblox agent" {
		t.Errorf("gap %v, want Infoblox Endpoint 709", g)
	}
}

func TestAssembleCoverage_OneTilePerInventorySourceLargestGapFirst(t *testing.T) {
	rows := []map[string]any{
		comboRow(`["DHCP Logs"]`, "100"),
		comboRow(`["DHCP Logs","CrowdStrike Falcon"]`, "40"),
		comboRow(`["DHCP Logs","CrowdStrike Falcon","ServiceNow"]`, "50"),
		comboRow(`["NIOS Grid","ServiceNow"]`, "5"),
		comboRow(`["ServiceNow"]`, "9"),
		comboRow(`["AWS"]`, "500"),
	}
	gaps := gapsOf(t, assembleCoverage(rows, nil))
	want := []struct {
		source string
		count  int
	}{
		// Not in ServiceNow: 100 + 40 = 140. Not in CrowdStrike: 100 + 5 = 105.
		{"ServiceNow", 140},
		{"CrowdStrike Falcon", 105},
	}
	if len(gaps) != len(want) {
		t.Fatalf("gaps %v", gaps)
	}
	for i, w := range want {
		if gaps[i]["source"] != w.source || gaps[i]["count"] != w.count {
			t.Errorf("gap %d = %v, want %s %d", i, gaps[i], w.source, w.count)
		}
	}
}

func TestAssembleCoverage_AFailedReadIsNotZero(t *testing.T) {
	got := assembleCoverage(nil, nil)
	if got["availability"] != "error" || got["total"] != nil {
		t.Fatalf("payload %v", got)
	}
	if r, _ := got["reason"].(string); r == "" {
		t.Error("no reason")
	}
}

func TestAssembleCoverage_TooManyCombinationsSaysCouldNotCount(t *testing.T) {
	rows := make([]map[string]any, 0, coverageComboLimit)
	rows = append(rows, comboRow(`["DHCP Logs"]`, "3"), comboRow(`["Infoblox Endpoint"]`, "1"))
	for len(rows) < coverageComboLimit {
		rows = append(rows, comboRow(`["AWS"]`, "1"))
	}
	got := assembleCoverage(rows, nil)
	gaps := gapsOf(t, got)
	if len(gaps) != 1 || gaps[0]["count"] != nil {
		t.Fatalf("gaps %v; a list cut off at the limit must not be counted", gaps)
	}
	if r, _ := got["reason"].(string); r == "" {
		t.Error("no reason for the missing counts")
	}
}

func TestAssembleCoverage_ALabelListItCannotReadSaysCouldNotCount(t *testing.T) {
	rows := []map[string]any{comboRow(`["DHCP Logs"]`, "3"), comboRow(`["Infoblox Endpoint"]`, "1"), comboRow(`not json`, "4")}
	gaps := gapsOf(t, assembleCoverage(rows, nil))
	if len(gaps) != 1 || gaps[0]["count"] != nil {
		t.Fatalf("gaps %v", gaps)
	}
}

func TestAssembleCoverage_NothingToCompareGivesNoTiles(t *testing.T) {
	// Network sources but no inventory source, and the other way round.
	for _, rows := range [][]map[string]any{
		{comboRow(`["DHCP Logs"]`, "3"), comboRow(`["AWS"]`, "1")},
		{comboRow(`["Infoblox Endpoint"]`, "3"), comboRow(`["AWS"]`, "1")},
	} {
		got := assembleCoverage(rows, nil)
		if got["availability"] != "ok" || len(gapsOf(t, got)) != 0 {
			t.Errorf("payload %v", got)
		}
	}
}

func TestGapCombos_AreExactlyTheCombinationsCounted(t *testing.T) {
	got, ok := gapCombos(liveCombos(), "Infoblox Endpoint")
	if !ok {
		t.Fatal("not ok")
	}
	want := `["NIOS Grid"]|["DHCP Logs"]|["NIOS-X Discovery"]|["DHCP Logs","NIOS Grid"]`
	if strings.Join(got, "|") != want {
		t.Errorf("combos %q", got)
	}
	if _, ok := gapCombos(liveCombos(), "ServiceNow"); ok {
		t.Error("a source the tenant does not have is not a gap")
	}
}

// coverageCubeService answers the grouped combination query with combos and
// any other query with rows, and records every query it was sent.
func coverageCubeService(t *testing.T, combos string, rows string) (*Service, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var req struct {
			Query string `json:"query"`
		}
		_ = json.Unmarshal(raw, &req)
		mu.Lock()
		seen = append(seen, req.Query)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(req.Query, `"dimensions":["AssetDetails_ch_agg.providers_label"]`) {
			_, _ = w.Write([]byte(combos))
			return
		}
		_, _ = w.Write([]byte(rows))
	}))
	t.Cleanup(srv.Close)
	s := &Service{Mcp: mcp.New(srv.URL+"/mcp", func() string { return "Token k" }), Cache: cache.New()}
	return s, func() []string { mu.Lock(); defer mu.Unlock(); return append([]string{}, seen...) }
}

const liveCombosJSON = `{"result":{"data":[
	{"AssetDetails_ch_agg.providers_label":"[\"NIOS Grid\"]","AssetDetails_ch_agg.assetsCount":"592"},
	{"AssetDetails_ch_agg.providers_label":"[\"DHCP Logs\"]","AssetDetails_ch_agg.assetsCount":"90"},
	{"AssetDetails_ch_agg.providers_label":"[\"Infoblox Endpoint\",\"NIOS Grid\"]","AssetDetails_ch_agg.assetsCount":"1"}
]}}`

func TestFetchAssetCoverage_ReadsTheCombinationsOnce(t *testing.T) {
	s, seen := coverageCubeService(t, liveCombosJSON, `{"result":{"data":[]}}`)
	got := s.FetchAssetCoverage(context.Background())
	if g := gapsOf(t, got); len(g) != 1 || g[0]["count"] != 682 {
		t.Fatalf("gaps %v", g)
	}
	s.FetchAssetCoverage(context.Background())
	if n := len(seen()); n != 1 {
		t.Errorf("%d cube reads, want 1 (the second is cached)", n)
	}
}

func TestFetchAssetInventory_AGapFiltersToItsCombinations(t *testing.T) {
	s, seen := coverageCubeService(t, liveCombosJSON, `{"result":{"data":[
		{"AssetDetails_ch_agg.cqid":"cq-1","AssetDetails_ch_agg.name":"pc-1","AssetDetails_ch_agg.assetsCount":"1"}
	]}}`)
	got := s.FetchAssetInventory(context.Background(), "", "", "", "", 0, "Infoblox Endpoint")
	if got["availability"] != "ok" || got["gap"] != "Infoblox Endpoint" {
		t.Fatalf("payload %v", got)
	}
	var list string
	for _, q := range seen() {
		if strings.Contains(q, `"limit":50`) {
			list = q
		}
	}
	want := `{"member":"AssetDetails_ch_agg.providers_label","operator":"equals","values":["[\"NIOS Grid\"]","[\"DHCP Logs\"]"]}`
	if !strings.Contains(list, want) {
		t.Errorf("list query %s\nwant filter %s", list, want)
	}
}

func TestFetchAssetInventory_AGapItCannotWorkOutIsUnavailableNotEverything(t *testing.T) {
	s, _ := coverageCubeService(t, `{"oops":1}`, `{"result":{"data":[{"AssetDetails_ch_agg.cqid":"cq-1"}]}}`)
	got := s.FetchAssetInventory(context.Background(), "", "", "", "", 0, "Infoblox Endpoint")
	if got["availability"] != "error" {
		t.Fatalf("payload %v; an unfiltered list would pass for the gap", got)
	}
}

// Review finding: a count that is not a number used to read as 0, so a gap
// showed 0 instead of "couldn't count".
func TestAssembleCoverage_ACountThatIsNotANumberSaysCouldNotCount(t *testing.T) {
	for _, bad := range []any{"unknown", "", nil, map[string]any{}} {
		rows := []map[string]any{
			comboRow(`["DHCP Logs"]`, "3"),
			{assetsCube + ".providers_label": `["Infoblox Endpoint"]`, assetsMeasure: bad},
		}
		got := assembleCoverage(rows, nil)
		gaps := gapsOf(t, got)
		if len(gaps) != 1 || gaps[0]["count"] != nil || got["total"] != nil {
			t.Errorf("count %#v: gaps %v total %v", bad, gaps, got["total"])
		}
		if _, ok := gapCombos(rows, "Infoblox Endpoint"); ok {
			t.Errorf("count %#v: the list filter must not trust it either", bad)
		}
	}
}
