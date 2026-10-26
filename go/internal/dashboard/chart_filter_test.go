package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

// The "Only show" filter: one field of the count's own, is or is not, one value.

func TestBuildChartQuery_OneFilterExactly(t *testing.T) {
	for _, c := range []struct {
		p    ChartPicks
		want string
	}{
		{ChartPicks{Count: "threats", Split: "policy", Window: "7d", Over: "none", Top: 10, Only: "action", Is: "is", Value: "Block"},
			`[{"member":"PortunusAggThreat_ch.action","operator":"equals","values":["Block"]}]`},
		{ChartPicks{Count: "dns", Split: "domain", Window: "24h", Over: "none", Top: 10, Only: "device", Is: "not", Value: "ws-014.lab"},
			`[{"member":"NetworkNstarDnsActivity.device_name","operator":"notEquals","values":["ws-014.lab"]}]`},
		// A field holding several values per asset: contains, the value quoted.
		{ChartPicks{Count: "assets", Split: "atype", Window: "now", Over: "none", Top: 10, Only: "missing", Is: "is", Value: "DNS Forward Record"},
			`[{"member":"AssetDetails_ch_agg.insight_indicators_label","operator":"contains","values":["\"DNS Forward Record\""]}]`},
		{ChartPicks{Count: "assets", Split: "source", Window: "now", Over: "none", Top: 10, Only: "problem", Is: "not", Value: "Zombie"},
			`[{"member":"AssetDetails_ch_agg.insight_classifications_label","operator":"notContains","values":["\"Zombie\""]}]`},
		// A filter on a chart over time.
		{ChartPicks{Count: "dns", Split: "none", Window: "7d", Over: "day", Only: "qtype", Is: "is", Value: "AAAA"},
			`[{"member":"NetworkNstarDnsActivity.query_type","operator":"equals","values":["AAAA"]}]`},
	} {
		q, _, err := BuildChartQuery(c.p)
		if err != nil {
			t.Errorf("%+v: refused: %v", c.p, err)
			continue
		}
		if b, _ := json.Marshal(q["filters"]); string(b) != c.want {
			t.Errorf("%+v: filters\n got %s\nwant %s", c.p, b, c.want)
		}
	}
}

func TestBuildChartQuery_RefusesABadFilter(t *testing.T) {
	ok := ChartPicks{Count: "threats", Split: "policy", Window: "7d", Over: "none", Top: 10}
	with := func(only, is, value string) ChartPicks { p := ok; p.Only, p.Is, p.Value = only, is, value; return p }
	for name, p := range map[string]ChartPicks{
		"the split itself":          with("policy", "is", "x"),
		"another cube's field":      with("device", "is", "x"),
		"no such field":             with("nope", "is", "x"),
		"none":                      with("none", "is", "x"),
		"an unknown is":             with("action", "like", "Block"),
		"no value":                  with("action", "is", ""),
		"a value too long":          with("action", "is", strings.Repeat("a", 257)),
		"a control character":       with("action", "is", "Bl\nock"),
		"a value with no field":     with("", "", "Block"),
		"a field with no value":     with("action", "is", ""),
		"a bucket not in the list":  {Count: "assets", Split: "atype", Window: "now", Over: "none", Top: 10, Only: "problem", Is: "is", Value: "Evil"},
		"qps has nothing to filter": {Count: "qps", Split: "none", Window: "7d", Over: "day", Only: "device", Is: "is", Value: "x"},
	} {
		if q, _, err := BuildChartQuery(p); err == nil {
			t.Errorf("%s: accepted, built %v", name, q)
		}
	}
}

func TestBuildChartQuery_FilterKeepsTheCountsOwnFilter(t *testing.T) {
	// qps carries a fixed metric filter; nothing can be added to it, but the
	// fixed one must survive on every other path too.
	q, _, err := BuildChartQuery(ChartPicks{Count: "qps", Split: "none", Window: "7d", Over: "day"})
	if err != nil || len(asSlice(roundTrip(t, q)["filters"])) != 1 {
		t.Fatalf("qps filter lost: %v %v", q, err)
	}
}

func TestChartValues_TopValuesOfTheField(t *testing.T) {
	var calls atomic.Int32
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		q := cubeQueryFromRequest(t, r)
		if !reflect.DeepEqual(asSlice(q["dimensions"]), []any{"PortunusAggThreat_ch.policy_name"}) || q["limit"] != float64(50) {
			t.Errorf("values query = %v", q)
		}
		_, _ = w.Write([]byte(`{"result":{"data":[{"PortunusAggThreat_ch.policy_name":"Default","PortunusAggThreat_ch.requests":"9"},{"PortunusAggThreat_ch.policy_name":"","PortunusAggThreat_ch.requests":"2"}]}}`))
	})
	res := s.ChartValues(context.Background(), "threats", "policy", "7d")
	if res["status"] != "ok" || !reflect.DeepEqual(res["values"], []string{"Default"}) {
		t.Fatalf("values = %v (a blank value can't be picked: equals \"\" is not a filter)", res)
	}
	// A bucket field's values are its fixed list, with no call at all.
	before := calls.Load()
	res = s.ChartValues(context.Background(), "assets", "missing", "now")
	if !reflect.DeepEqual(res["values"], []string{"DNS Forward Record", "DNS Pointer Record", "IPAM"}) || calls.Load() != before {
		t.Fatalf("bucket values = %v after %d calls", res["values"], calls.Load()-before)
	}
	if res := s.ChartValues(context.Background(), "dns", "atype", "7d"); res["status"] != "invalid" {
		t.Fatalf("a field the count doesn't have must be refused, got %v", res)
	}
}

func TestChartQuestions_EveryOneIsAllowed(t *testing.T) {
	if len(chartCatalog.Questions) < 6 {
		t.Fatalf("only %d questions", len(chartCatalog.Questions))
	}
	names := map[string]bool{}
	for _, q := range chartCatalog.Questions {
		if names[q.Name] || q.Name == "" {
			t.Errorf("question name %q is blank or repeated", q.Name)
		}
		names[q.Name] = true
		if _, _, err := BuildChartQuery(q.Picks); err != nil {
			t.Errorf("%q: %v", q.Name, err)
		}
	}
	if len(asSlice(roundTrip(t, ChartOptions())["questions"])) != len(chartCatalog.Questions) {
		t.Errorf("options must carry the questions")
	}
}

func TestValidSavedChart_KeepsAGoodFilterAndRefusesABadOne(t *testing.T) {
	good := map[string]any{"v": float64(1), "title": "Blocked by policy", "tab": "security",
		"picks": map[string]any{"count": "threats", "split": "policy", "window": "7d", "over": "none", "top": float64(10),
			"only": "action", "is": "is", "value": "Block"}}
	out, err := ValidSavedChart("__chart_abcdefgh", good)
	if err != nil {
		t.Fatal(err)
	}
	if p := out["picks"].(ChartPicks); p.Only != "action" || p.Value != "Block" {
		t.Fatalf("filter dropped: %+v", p)
	}
	bad := map[string]any{"v": float64(1), "title": "x", "tab": "security",
		"picks": map[string]any{"count": "threats", "split": "policy", "window": "7d", "over": "none", "top": float64(10),
			"only": "device", "is": "is", "value": "x"}}
	if _, err := ValidSavedChart("__chart_abcdefgh", bad); err == nil {
		t.Fatal("a filter on another cube's field was saved")
	}
}
