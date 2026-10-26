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
	// DaysOnly: the cube keeps one row per day, so "by hour" would draw a
	// single bar at midnight, and a rolling 24 hours can't be cut from day rows.
	DaysOnly bool
}

type chartChoice struct {
	ID, Name string
	Plural   string   // split: what "Top 10 ..." calls them
	Fields   []string // split: the dimensions it adds
	Value    string   // window: the dateRange; over: the granularity
}

const (
	cubeDNS     = "NetworkNstarDnsActivity"
	cubeThreats = "PortunusAggThreat_ch"
	cubeHost    = "HostMetrics"
	cubeDHCP    = "NetworkNstarDhcpLeaseActivity"
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
	// OtherValues names a value Values doesn't list, "%s" being the value,
	// so an answer code nobody mapped still shows instead of being dropped.
	OtherValues map[string]string
}{
	Counts: []chartCount{
		{ID: "dns", Name: "DNS queries", Cube: cubeDNS, Measure: cubeDNS + ".total_query_count",
			Endpoint: cubeEndpoint, Splits: []string{"device", "qtype", "domain", "rcode", "none"}},
		{ID: "threats", Name: "Security hits", Cube: cubeThreats, Measure: cubeThreats + ".requests",
			Endpoint: cubeSecurityEndpoint, Splits: []string{"action", "tclass", "policy", "severity", "none"},
			// Every hourly slice came back as one midnight row (measured live 2026-10-22).
			DaysOnly: true},
		{ID: "qps", Name: "DNS queries per second", Cube: cubeHost, Measure: cubeHost + ".avg_value",
			Endpoint: cubeEndpoint, Splits: []string{"none"},
			Filters: []map[string]any{{"member": cubeHost + ".metric_name", "operator": "equals",
				"values": []string{"dns_qps_iq"}}}},
		// Changes the lease log recorded, not the leases held now.
		{ID: "dhcp", Name: "DHCP lease changes", Cube: cubeDHCP, Measure: cubeDHCP + ".total_count",
			Endpoint: cubeEndpoint, Splits: []string{"leaseop", "none"}},
	},
	Splits: []chartChoice{
		{ID: "device", Name: "Device", Plural: "devices", Fields: []string{cubeDNS + ".device_name", cubeDNS + ".device_ip"}},
		{ID: "qtype", Name: "Record type", Plural: "record types", Fields: []string{cubeDNS + ".query_type"}},
		{ID: "domain", Name: "Domain", Plural: "domains", Fields: []string{cubeDNS + ".qname"}},
		{ID: "rcode", Name: "Answer", Plural: "answers", Fields: []string{cubeDNS + ".rcode"}},
		{ID: "action", Name: "What happened", Fields: []string{cubeThreats + ".action"}},
		{ID: "tclass", Name: "Threat type", Plural: "threat types", Fields: []string{cubeThreats + ".tclass"}},
		{ID: "policy", Name: "Policy", Plural: "policies", Fields: []string{cubeThreats + ".policy_name"}},
		{ID: "severity", Name: "Severity", Plural: "severities", Fields: []string{cubeThreats + ".severity"}},
		{ID: "leaseop", Name: "What changed", Plural: "kinds of change", Fields: []string{cubeDHCP + ".lease_op"}},
		{ID: "none", Name: "Nothing, one total"},
	},
	Windows: []chartChoice{
		{ID: "today", Name: "Today", Value: "today"},
		{ID: "24h", Name: "Last 24 hours", Value: "last 24 hours"},
		{ID: "7d", Name: "Last 7 days", Value: "last 7 days"},
		{ID: "30d", Name: "Last 30 days", Value: "last 30 days"},
	},
	// "One total" is last so a pick that stops fitting settles on a line
	// over time, the chart this menu drew before one total was allowed.
	Overs: []chartChoice{
		{ID: "hour", Name: "By hour", Value: "hour"},
		{ID: "day", Name: "By day", Value: "day"},
		{ID: "none", Name: "No, one total"},
	},
	Tops: []int{5, 10, 25},
	Names: map[string]string{
		cubeDNS:                        "DNS activity",
		cubeDNS + ".total_query_count": "DNS queries",
		cubeDNS + ".device_name":       "Device",
		cubeDNS + ".device_ip":         "Device address",
		cubeDNS + ".query_type":        "Record type",
		cubeDNS + ".qname":             "Domain",
		cubeDNS + ".rcode":             "Answer",
		cubeDNS + ".timestamp":         "Time",
		cubeThreats:                    "Security hits",
		cubeThreats + ".requests":      "Hits",
		cubeThreats + ".action":        "What happened",
		cubeThreats + ".tclass":        "Threat type",
		cubeThreats + ".policy_name":   "Policy",
		cubeThreats + ".severity":      "Severity",
		cubeThreats + ".timestamp":     "Time",
		cubeHost:                       "DNS server metrics",
		cubeHost + ".avg_value":        "Queries per second",
		cubeHost + ".metric_name":      "Metric",
		cubeHost + ".timestamp":        "Time",
		cubeDHCP:                       "DHCP lease activity",
		cubeDHCP + ".total_count":      "Lease changes recorded",
		cubeDHCP + ".lease_op":         "What changed",
		cubeDHCP + ".timestamp":        "Time",
	},
	Values: map[string]map[string]string{
		// As the tenant sends them, capitalised (measured live 2026-10-21).
		cubeThreats + ".action":   {"Block": "Blocked", "Allow": "Allowed"},
		cubeHost + ".metric_name": {"dns_qps_iq": "DNS queries per second"},
		// The codes seen on the tenant (measured 2026-10-22); others fall to OtherValues.
		cubeDNS + ".rcode": {"0": "Answered", "2": "Server failed", "3": "No such name"},
		// About 2.55M hits (the CAT class) carry no severity at all.
		cubeThreats + ".severity": {"": "Not graded"},
	},
	OtherValues: map[string]string{
		cubeDNS + ".rcode": "Answer code %s",
	},
}

// chartAllowed is the picker rules, stated once:
//   - a measure splits only by its own cube's fields;
//   - by hour only with today or the last 24 hours, by day only with 7 or 30 days;
//   - a cube kept by day gets neither by hour nor the last 24 hours;
//   - a split over time only for security hits (blocked vs logged, stacked);
//   - no split and no over-time is one total, drawn as a single number;
//   - top N exactly when there is a split and no over-time.
func chartAllowed(c chartCount, split, window, over string, top int) bool {
	if !slices.Contains(c.Splits, split) {
		return false
	}
	hourly := window == "today" || window == "24h"
	if c.DaysOnly && (over == "hour" || window == "24h") {
		return false
	}
	if over == "hour" && !hourly || over == "day" && hourly {
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
			out = append(out, map[string]any{"id": x.ID, "name": x.Name, "plural": x.Plural, "fields": x.Fields, "value": x.Value})
		}
		return out
	}
	counts := make([]map[string]any, 0, len(chartCatalog.Counts))
	for _, c := range chartCatalog.Counts {
		counts = append(counts, map[string]any{"id": c.ID, "name": c.Name, "cube": c.Cube,
			"measure": c.Measure, "endpoint": c.Endpoint, "filters": c.Filters})
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

		"otherValues": chartCatalog.OtherValues,
	}
}
