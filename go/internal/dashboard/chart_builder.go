package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"

	"bloxsmith/internal/cache"
)

// The "Build a chart" tab. The person picks from plain menus; this file turns
// the picks into one Cube.js query from a fixed allow-list and runs it. No
// model is involved anywhere, so every number on the chart came from the
// tenant.
//
// chartCatalog is the ONE place plain names live. The screen reads its menus,
// its sentence and its labels from ChartOptions, so a name changed here
// changes everywhere.

// ChartPicks is one set of menu choices. Split and Over use "none" for "no
// split" and "one total"; Top is 0 when no top N applies.
type ChartPicks struct {
	Count  string `json:"count"`
	Split  string `json:"split"`
	Window string `json:"window"`
	Over   string `json:"over"`
	Top    int    `json:"top"`
}

type chartCount struct {
	ID, Name, Cube, Measure, Endpoint string
	Splits                            []string
	Filters                           []map[string]any
}

type chartChoice struct {
	ID, Name string
	Fields   []string // split: the dimensions it adds
	Value    string   // window: the dateRange; over: the granularity
}

const (
	cubeDNS     = "NetworkNstarDnsActivity"
	cubeThreats = "PortunusAggThreat_ch"
	cubeHost    = "HostMetrics"
	// Security cubes live on their own service (csp.go CSPThreats).
	cubeEndpoint         = "/api/cubejs/v1/query"
	cubeSecurityEndpoint = "/api/cubejs-security/v1/query"
)

var chartCatalog = struct {
	Counts  []chartCount
	Splits  []chartChoice
	Windows []chartChoice
	Overs   []chartChoice
	Tops    []int
	Names   map[string]string
	Values  map[string]map[string]string
}{
	Counts: []chartCount{
		{ID: "dns", Name: "DNS queries", Cube: cubeDNS, Measure: cubeDNS + ".total_query_count",
			Endpoint: cubeEndpoint, Splits: []string{"device", "qtype", "none"}},
		{ID: "threats", Name: "Security hits", Cube: cubeThreats, Measure: cubeThreats + ".requests",
			Endpoint: cubeSecurityEndpoint, Splits: []string{"action", "none"}},
		{ID: "qps", Name: "DNS queries per second", Cube: cubeHost, Measure: cubeHost + ".avg_value",
			Endpoint: cubeEndpoint, Splits: []string{"none"},
			Filters: []map[string]any{{"member": cubeHost + ".metric_name", "operator": "equals",
				"values": []string{"dns_qps_iq"}}}},
	},
	Splits: []chartChoice{
		{ID: "device", Name: "Device", Fields: []string{cubeDNS + ".device_name", cubeDNS + ".device_ip"}},
		{ID: "qtype", Name: "Record type", Fields: []string{cubeDNS + ".query_type"}},
		{ID: "action", Name: "What happened", Fields: []string{cubeThreats + ".action"}},
		{ID: "none", Name: "Nothing, one total"},
	},
	Windows: []chartChoice{
		{ID: "today", Name: "Today", Value: "today"},
		{ID: "7d", Name: "Last 7 days", Value: "last 7 days"},
		{ID: "30d", Name: "Last 30 days", Value: "last 30 days"},
	},
	Overs: []chartChoice{
		{ID: "none", Name: "No, one total"},
		{ID: "hour", Name: "By hour", Value: "hour"},
		{ID: "day", Name: "By day", Value: "day"},
	},
	Tops: []int{5, 10, 25},
	Names: map[string]string{
		cubeDNS:                        "DNS activity",
		cubeDNS + ".total_query_count": "DNS queries",
		cubeDNS + ".device_name":       "Device",
		cubeDNS + ".device_ip":         "Device address",
		cubeDNS + ".query_type":        "Record type",
		cubeDNS + ".timestamp":         "Time",
		cubeThreats:                    "Security hits",
		cubeThreats + ".requests":      "Hits",
		cubeThreats + ".action":        "What happened",
		cubeThreats + ".timestamp":     "Time",
		cubeHost:                       "DNS server metrics",
		cubeHost + ".avg_value":        "Queries per second",
		cubeHost + ".metric_name":      "Metric",
		cubeHost + ".timestamp":        "Time",
	},
	Values: map[string]map[string]string{
		// As the tenant sends them, capitalised (measured live 2026-10-21).
		cubeThreats + ".action":   {"Block": "Blocked", "Allow": "Allowed"},
		cubeHost + ".metric_name": {"dns_qps_iq": "DNS queries per second"},
	},
}

// chartAllowed is the picker rules, stated once:
//   - a measure splits only by its own cube's fields;
//   - by hour only with today, by day only with 7 or 30 days;
//   - a split over time only for security hits (blocked vs logged, stacked);
//   - no split means it must be over time, since one bare total has no chart;
//   - top N exactly when there is a split and no over-time.
func chartAllowed(c chartCount, split, window, over string, top int) bool {
	if !slices.Contains(c.Splits, split) {
		return false
	}
	if over == "hour" && window != "today" || over == "day" && window == "today" {
		return false
	}
	if split == "none" && over == "none" {
		return false
	}
	if split != "none" && over != "none" && split != "action" {
		return false
	}
	return (top > 0) == (split != "none" && over == "none")
}

// ChartCombos is every allowed set of picks, in menu order.
func ChartCombos() []ChartPicks {
	var out []ChartPicks
	for _, c := range chartCatalog.Counts {
		for _, s := range chartCatalog.Splits {
			for _, w := range chartCatalog.Windows {
				for _, o := range chartCatalog.Overs {
					for _, t := range append([]int{0}, chartCatalog.Tops...) {
						if chartAllowed(c, s.ID, w.ID, o.ID, t) {
							out = append(out, ChartPicks{Count: c.ID, Split: s.ID, Window: w.ID, Over: o.ID, Top: t})
						}
					}
				}
			}
		}
	}
	return out
}

func findChoice(xs []chartChoice, id string) (chartChoice, bool) {
	for _, x := range xs {
		if x.ID == id {
			return x, true
		}
	}
	return chartChoice{}, false
}

// BuildChartQuery turns picks into a Cube.js query and the service to send it
// to. It is pure, and it refuses anything outside the allow-list, so nothing
// the caller sends can reach the tenant except a query built here.
func BuildChartQuery(p ChartPicks) (map[string]any, string, error) {
	var count *chartCount
	for i := range chartCatalog.Counts {
		if chartCatalog.Counts[i].ID == p.Count {
			count = &chartCatalog.Counts[i]
		}
	}
	split, okS := findChoice(chartCatalog.Splits, p.Split)
	window, okW := findChoice(chartCatalog.Windows, p.Window)
	over, okO := findChoice(chartCatalog.Overs, p.Over)
	topOK := p.Top == 0 || slices.Contains(chartCatalog.Tops, p.Top)
	if count == nil || !okS || !okW || !okO || !topOK ||
		!chartAllowed(*count, p.Split, p.Window, p.Over, p.Top) {
		return nil, "", fmt.Errorf("that combination of choices isn't available")
	}

	td := map[string]any{"dimension": count.Cube + ".timestamp", "dateRange": window.Value}
	if over.Value != "" {
		td["granularity"] = over.Value
	}
	q := map[string]any{
		"measures":       []string{count.Measure},
		"timeDimensions": []map[string]any{td},
	}
	if len(split.Fields) > 0 {
		q["dimensions"] = split.Fields
	}
	if len(count.Filters) > 0 {
		q["filters"] = count.Filters
	}
	if p.Top > 0 {
		q["order"] = map[string]any{count.Measure: "desc"}
		q["limit"] = p.Top
	}
	return q, count.Endpoint, nil
}

// RunChart builds the query and runs it on the tenant. Rows keep their
// "Cube.field" keys (no cubeRow), because the "Show cube names" switch shows
// them as they are.
//
// status is "ok", "empty" (the query worked and found nothing) or "error"
// (it did not work), kept apart as FetchDNSAnalytics does: an outage must not
// read as "no activity". "invalid" means the picks were refused and nothing
// was sent. Only ok and empty are cached, the FetchInsights way.
func (s *Service) RunChart(ctx context.Context, p ChartPicks) map[string]any {
	q, endpoint, err := BuildChartQuery(p)
	if err != nil {
		return map[string]any{"status": "invalid", "reason": err.Error()}
	}
	qj, _ := json.Marshal(q)
	ck := cache.Key("chart", endpoint, map[string]string{"query": string(qj)}, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()
	body, st, err := s.Rest.GetEx(endpoint, map[string]string{"query": string(qj)})
	if errored(st, err) {
		return map[string]any{
			"query": q, "endpoint": endpoint, "rows": []map[string]any{},
			"status": "error", "reason": "Infoblox didn't answer this query (upstream error).",
		}
	}
	raw := cubeData(body)
	rows := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		rows = append(rows, asMap(r))
	}
	status := "ok"
	if len(rows) == 0 {
		status = "empty"
	}
	result := map[string]any{"query": q, "endpoint": endpoint, "rows": rows, "status": status}
	s.Cache.SetGen(ck, result, g)
	return result
}

// ChartOptions is the catalog with its plain names, plus every allowed
// combination, so the screen can hide choices that don't fit without keeping
// its own copy of the rules.
func ChartOptions() map[string]any {
	choices := func(xs []chartChoice) []map[string]any {
		out := make([]map[string]any, 0, len(xs))
		for _, x := range xs {
			out = append(out, map[string]any{"id": x.ID, "name": x.Name, "fields": x.Fields, "value": x.Value})
		}
		return out
	}
	counts := make([]map[string]any, 0, len(chartCatalog.Counts))
	for _, c := range chartCatalog.Counts {
		counts = append(counts, map[string]any{"id": c.ID, "name": c.Name, "cube": c.Cube,
			"measure": c.Measure, "endpoint": c.Endpoint})
	}
	return map[string]any{
		"counts":  counts,
		"splits":  choices(chartCatalog.Splits),
		"windows": choices(chartCatalog.Windows),
		"overs":   choices(chartCatalog.Overs),
		"tops":    chartCatalog.Tops,
		"combos":  ChartCombos(),
		"names":   chartCatalog.Names,
		"values":  chartCatalog.Values,
	}
}
