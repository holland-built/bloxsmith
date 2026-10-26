package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sync"

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
	// Snapshot: the cube holds things as they are now (one row per asset),
	// not events with a time, so it has one window, "now", and no over-time.
	Snapshot bool
	// NoWeek: the cube refuses a week step (HostMetrics answered 400 to
	// granularity "week", measured 2026-10-26; day and hour work).
	NoWeek bool
	// Time is the time dimension windows and over-time apply to; "" is
	// "timestamp", the activity cubes' event time.
	Time string
}

// timeField is the count's time dimension, "<cube>.<field>".
func (c chartCount) timeField() string {
	if c.Time == "" {
		return c.Cube + ".timestamp"
	}
	return c.Cube + "." + c.Time
}

// chartBucket is one bar of a split that can't be grouped by: the field
// holds several values per row as JSON-array text ('["Noncompliant","Zombie"]'),
// so grouping by it counts combinations. Each bucket is its own count of the
// rows whose field contains Value, quotes included so "IPAM" can't match
// inside a longer name. One row can be in several buckets.
type chartBucket struct{ Value string }

type chartChoice struct {
	ID, Name string
	Plural   string   // split: what "Top 10 ..." calls them
	Fields   []string // split: the dimensions it adds; with Buckets, the field they filter
	Value    string   // window: the dateRange; over: the granularity
	Buckets  []string // split: one count per value instead of a group-by (see chartBucket)
}

const (
	cubeDNS     = "NetworkNstarDnsActivity"
	cubeThreats = "PortunusAggThreat_ch"
	cubeHost    = "HostMetrics"
	cubeDHCP    = "NetworkNstarDhcpLeaseActivity"
	// One row per asset Infoblox holds now (assets.go has the measured facts).
	cubeAssets = "AssetDetails_ch_agg"
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
			Endpoint: cubeEndpoint, Splits: []string{"none"}, NoWeek: true,
			Filters: []map[string]any{{"member": cubeHost + ".metric_name", "operator": "equals",
				"values": []string{"dns_qps_iq"}}}},
		// Changes the lease log recorded, not the leases held now.
		{ID: "dhcp", Name: "DHCP lease changes", Cube: cubeDHCP, Measure: cubeDHCP + ".total_count",
			Endpoint: cubeEndpoint, Splits: []string{"leaseop", "none"}},
		{ID: "assets", Name: "Assets", Cube: cubeAssets, Measure: cubeAssets + ".assetsCount",
			Endpoint: cubeEndpoint, Snapshot: true, Splits: assetSplits("problem", "missing")},
		// Counted by when each asset was first seen. Only assets Infoblox still
		// holds are counted: one removed since is gone from the cube.
		{ID: "newassets", Name: "New assets still held", Cube: cubeAssets, Measure: cubeAssets + ".assetsCount",
			Endpoint: cubeEndpoint, Time: "first_seen", Splits: assetSplits()},
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
		// Asset splits, each a field holding one value per asset (measured 2026-10-26).
		{ID: "atype", Name: "Asset type", Plural: "asset types", Fields: []string{cubeAssets + ".taxonomy_type_label"}},
		{ID: "acat", Name: "Category", Plural: "categories", Fields: []string{cubeAssets + ".taxonomy_super_category_label"}},
		{ID: "os", Name: "Operating system", Plural: "operating systems", Fields: []string{cubeAssets + ".os_type"}},
		{ID: "source", Name: "Found by", Plural: "sources", Fields: []string{cubeAssets + ".provider_label"}},
		{ID: "where", Name: "Cloud or on-premises", Plural: "places", Fields: []string{cubeAssets + ".deploymentContext"}},
		{ID: "vendor", Name: "Vendor", Plural: "vendors", Fields: []string{cubeAssets + ".vendor"}},
		{ID: "region", Name: "Region", Plural: "regions", Fields: []string{cubeAssets + ".region_label"}},
		// Several values per asset, so one count each (see chartBucket).
		{ID: "problem", Name: "Problem", Fields: []string{cubeAssets + ".insight_classifications_label"},
			Buckets: []string{"Noncompliant", "Unregistered", "Zombie", "Lifecycle"}},
		{ID: "missing", Name: "Missing record", Fields: []string{cubeAssets + ".insight_indicators_label"},
			Buckets: []string{"DNS Forward Record", "DNS Pointer Record", "IPAM"}},
		{ID: "none", Name: "Nothing, one total"},
	},
	Windows: []chartChoice{
		{ID: "now", Name: "Latest inventory"},
		{ID: "today", Name: "Today", Value: "today"},
		{ID: "24h", Name: "Last 24 hours", Value: "last 24 hours"},
		{ID: "7d", Name: "Last 7 days", Value: "last 7 days"},
		{ID: "30d", Name: "Last 30 days", Value: "last 30 days"},
		{ID: "thismonth", Name: "This month", Value: "this month"},
		{ID: "lastmonth", Name: "Last month", Value: "last month"},
		{ID: "90d", Name: "Last 90 days", Value: "last 90 days"},
	},
	// "One total" is last so a pick that stops fitting settles on a line
	// over time, the chart this menu drew before one total was allowed.
	Overs: []chartChoice{
		{ID: "hour", Name: "By hour", Value: "hour"},
		{ID: "day", Name: "By day", Value: "day"},
		{ID: "week", Name: "By week", Value: "week"},
		{ID: "none", Name: "No, one total"},
	},
	Tops: []int{5, 10, 25},
	Names: map[string]string{
		cubeDNS:                                       "DNS activity",
		cubeDNS + ".total_query_count":                "DNS queries",
		cubeDNS + ".device_name":                      "Device",
		cubeDNS + ".device_ip":                        "Device address",
		cubeDNS + ".query_type":                       "Record type",
		cubeDNS + ".qname":                            "Domain",
		cubeDNS + ".rcode":                            "Answer",
		cubeDNS + ".timestamp":                        "Time",
		cubeThreats:                                   "Security hits",
		cubeThreats + ".requests":                     "Hits",
		cubeThreats + ".action":                       "What happened",
		cubeThreats + ".tclass":                       "Threat type",
		cubeThreats + ".policy_name":                  "Policy",
		cubeThreats + ".severity":                     "Severity",
		cubeThreats + ".timestamp":                    "Time",
		cubeHost:                                      "DNS server metrics",
		cubeHost + ".avg_value":                       "Queries per second",
		cubeHost + ".metric_name":                     "Metric",
		cubeHost + ".timestamp":                       "Time",
		cubeDHCP:                                      "DHCP lease activity",
		cubeDHCP + ".total_count":                     "Lease changes recorded",
		cubeDHCP + ".lease_op":                        "What changed",
		cubeDHCP + ".timestamp":                       "Time",
		cubeAssets:                                    "Assets",
		cubeAssets + ".assetsCount":                   "Assets",
		cubeAssets + ".first_seen":                    "First seen",
		cubeAssets + ".taxonomy_type_label":           "Asset type",
		cubeAssets + ".taxonomy_super_category_label": "Category",
		cubeAssets + ".os_type":                       "Operating system",
		cubeAssets + ".provider_label":                "Found by",
		cubeAssets + ".deploymentContext":             "Cloud or on-premises",
		cubeAssets + ".vendor":                        "Vendor",
		cubeAssets + ".region_label":                  "Region",
		cubeAssets + ".insight_classifications_label": "Problem",
		cubeAssets + ".insight_indicators_label":      "Missing record",
	},
	Values: map[string]map[string]string{
		// As the tenant sends them, capitalised (measured live 2026-10-21).
		cubeThreats + ".action":   {"Block": "Blocked", "Allow": "Allowed"},
		cubeHost + ".metric_name": {"dns_qps_iq": "DNS queries per second"},
		// The codes seen on the tenant (measured 2026-10-22); others fall to OtherValues.
		cubeDNS + ".rcode": {"0": "Answered", "2": "Server failed", "3": "No such name"},
		// About 2.55M hits (the CAT class) carry no severity at all.
		cubeThreats + ".severity": {"": "Not graded"},
		// Blank on 84% of assets (measured 2026-10-26).
		cubeAssets + ".os_type":           {"": "Not reported"},
		cubeAssets + ".vendor":            {"": "Not reported"},
		cubeAssets + ".deploymentContext": {"Onprem": "On-premises"},
		cubeAssets + ".insight_indicators_label": {"DNS Forward Record": "DNS name (forward record)",
			"DNS Pointer Record": "Reverse DNS (pointer record)", "IPAM": "IPAM record"},
	},
	OtherValues: map[string]string{
		cubeDNS + ".rcode": "Answer code %s",
	},
}

// assetSplits is the single-value asset splits, then extra, then none.
func assetSplits(extra ...string) []string {
	out := []string{"atype", "acat", "os", "source", "where", "vendor", "region"}
	return append(append(out, extra...), "none")
}

// chartAllowed is the picker rules, stated once:
//   - a measure splits only by its own cube's fields;
//   - a snapshot (assets) has only "now" and no over-time; nothing else has "now";
//   - by hour only with today or the last 24 hours, by day with 7 or 30 days or a
//     calendar month, by week with 30 or 90 days;
//   - a cube kept by day gets neither by hour nor the last 24 hours;
//   - a cube that refuses a week step (NoWeek) is never offered by week;
//   - a split over time only for security hits (blocked vs logged, stacked);
//   - no split and no over-time is one total, drawn as a single number;
//   - top N exactly when there is a split by group-by and no over-time; a
//     split by buckets always shows every bucket.
func chartAllowed(c chartCount, split, window, over string, top int) bool {
	if !slices.Contains(c.Splits, split) {
		return false
	}
	if c.Snapshot || window == "now" {
		if !c.Snapshot || window != "now" || over != "none" {
			return false
		}
	}
	if c.DaysOnly && (over == "hour" || window == "24h") {
		return false
	}
	switch over {
	case "hour":
		if window != "today" && window != "24h" {
			return false
		}
	case "day":
		if !slices.Contains([]string{"7d", "30d", "thismonth", "lastmonth"}, window) {
			return false
		}
	case "week":
		if c.NoWeek || window != "30d" && window != "90d" {
			return false
		}
	}
	if split != "none" && over != "none" && split != "action" {
		return false
	}
	s, _ := findChoice(chartCatalog.Splits, split)
	return (top > 0) == (split != "none" && over == "none" && len(s.Buckets) == 0)
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

	q := map[string]any{"measures": []string{count.Measure}}
	if !count.Snapshot {
		td := map[string]any{"dimension": count.timeField(), "dateRange": window.Value}
		if over.Value != "" {
			td["granularity"] = over.Value
		}
		q["timeDimensions"] = []map[string]any{td}
	}
	// A bucket split adds a filter per bucket in RunChart, not a dimension.
	if len(split.Fields) > 0 && len(split.Buckets) == 0 {
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
	split, _ := findChoice(chartCatalog.Splits, p.Split)
	qj, _ := json.Marshal(q)
	ck := cache.Key("chart", endpoint, map[string]string{"query": string(qj), "split": p.Split}, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()
	if len(split.Buckets) > 0 {
		result := s.runBuckets(q, endpoint, split)
		if result["status"] != "error" {
			s.Cache.SetGen(ck, result, g)
		}
		return result
	}
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

// runBuckets counts each bucket with its own query, all at once, and returns
// one row per bucket keyed like a group-by row ({field: value, measure: n}),
// so the screen draws it like any other split. One failed count fails the
// chart: a missing bar would read as zero.
func (s *Service) runBuckets(base map[string]any, endpoint string, split chartChoice) map[string]any {
	field := split.Fields[0]
	measure := base["measures"].([]string)[0]
	queries := make([]map[string]any, len(split.Buckets))
	rows := make([]map[string]any, len(split.Buckets))
	failed := false
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i, b := range split.Buckets {
		q := map[string]any{}
		for k, v := range base {
			q[k] = v
		}
		filters := []map[string]any{{"member": field, "operator": "contains", "values": []string{`"` + b + `"`}}}
		if f, ok := base["filters"].([]map[string]any); ok {
			filters = append(slices.Clone(f), filters...)
		}
		q["filters"] = filters
		queries[i] = q
		wg.Add(1)
		go func() {
			defer wg.Done()
			qj, _ := json.Marshal(q)
			body, st, err := s.Rest.GetEx(endpoint, map[string]string{"query": string(qj)})
			var n any = "0"
			if errored(st, err) {
				mu.Lock()
				failed = true
				mu.Unlock()
			} else if raw := cubeData(body); len(raw) > 0 {
				n = asMap(raw[0])[measure]
			}
			rows[i] = map[string]any{field: b, measure: n}
		}()
	}
	wg.Wait()
	if failed {
		return map[string]any{
			"query": queries, "endpoint": endpoint, "rows": []map[string]any{},
			"status": "error", "reason": "Infoblox didn't answer this query (upstream error).",
		}
	}
	return map[string]any{"query": queries, "endpoint": endpoint, "rows": rows, "status": "ok"}
}

// ChartOptions is the catalog with its plain names, plus every allowed
// combination, so the screen can hide choices that don't fit without keeping
// its own copy of the rules.
func ChartOptions() map[string]any {
	choices := func(xs []chartChoice) []map[string]any {
		out := make([]map[string]any, 0, len(xs))
		for _, x := range xs {
			out = append(out, map[string]any{"id": x.ID, "name": x.Name, "plural": x.Plural, "fields": x.Fields, "value": x.Value, "buckets": x.Buckets})
		}
		return out
	}
	counts := make([]map[string]any, 0, len(chartCatalog.Counts))
	for _, c := range chartCatalog.Counts {
		counts = append(counts, map[string]any{"id": c.ID, "name": c.Name, "cube": c.Cube,
			"measure": c.Measure, "endpoint": c.Endpoint, "filters": c.Filters, "time": c.timeField()})
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
