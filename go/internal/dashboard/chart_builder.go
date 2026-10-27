package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"sync"
	"unicode"

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
	// One optional "Only show" filter: Only is one of the count's own splits
	// (never the split itself), Is is "is" or "not", Value is what to match.
	// The screen offers values from ChartValues, but any short plain string is
	// accepted: it is only ever a filter value, never part of a field name.
	Only  string `json:"only,omitempty"`
	Is    string `json:"is,omitempty"`
	Value string `json:"value,omitempty"`
}

// chartQuestion is a ready-made chart: a plain question and the picks that answer it.
type chartQuestion struct {
	Name  string
	Picks ChartPicks
}

const chartValueMax = 256

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
	// split: the Infoblox Portal's Asset Inventory filter for the same field,
	// so a bar can open the portal on those assets. Field and operator were
	// checked by hand in the portal on 2026-10-27 (asset.Type IN ["Virtual
	// Machine"] and the rest each returned their assets). Empty means no
	// portal field is known for this split.
	PortalField, PortalOp string
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
	// Questions are ready-made charts, most of them from the UAI Query
	// Library's tested questions (github.com/IngmarVG-IB/infoblox-uai-query-library).
	Questions []chartQuestion
	Names     map[string]string
	Values    map[string]map[string]string
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
		{ID: "atype", Name: "Asset type", Plural: "asset types", Fields: []string{cubeAssets + ".taxonomy_type_label"}, PortalField: "asset.Type", PortalOp: "IN"},
		{ID: "acat", Name: "Category", Plural: "categories", Fields: []string{cubeAssets + ".taxonomy_super_category_label"}},
		{ID: "os", Name: "Operating system", Plural: "operating systems", Fields: []string{cubeAssets + ".os_type"}, PortalField: "asset.OSType", PortalOp: "IN"},
		{ID: "source", Name: "Found by", Plural: "sources", Fields: []string{cubeAssets + ".provider_label"}, PortalField: "asset.Providers", PortalOp: "CONTAINS"},
		{ID: "where", Name: "Cloud or on-premises", Plural: "places", Fields: []string{cubeAssets + ".deploymentContext"}, PortalField: "asset.LocationType", PortalOp: "IN"},
		{ID: "vendor", Name: "Vendor", Plural: "vendors", Fields: []string{cubeAssets + ".vendor"}, PortalField: "asset.Vendor", PortalOp: "IN"},
		{ID: "region", Name: "Region", Plural: "regions", Fields: []string{cubeAssets + ".region_label"}},
		// Several values per asset, so one count each (see chartBucket).
		{ID: "problem", Name: "Problem", Fields: []string{cubeAssets + ".insight_classifications_label"},
			Buckets: []string{"Noncompliant", "Unregistered", "Zombie", "Lifecycle"}, PortalField: "asset.Classifications", PortalOp: "IN"},
		{ID: "missing", Name: "Missing record", Fields: []string{cubeAssets + ".insight_indicators_label"},
			Buckets: []string{"DNS Forward Record", "DNS Pointer Record", "IPAM"}, PortalField: "asset.MissingRecords", PortalOp: "IN"},
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
	Questions: []chartQuestion{
		{"Which kinds of asset have no DNS name?", ChartPicks{Count: "assets", Split: "atype", Window: "now", Over: "none", Top: 10,
			Only: "missing", Is: "is", Value: "DNS Forward Record"}},
		{"Which kinds of asset is IPAM not tracking?", ChartPicks{Count: "assets", Split: "atype", Window: "now", Over: "none", Top: 10,
			Only: "missing", Is: "is", Value: "IPAM"}},
		{"Where are the zombie assets found?", ChartPicks{Count: "assets", Split: "source", Window: "now", Over: "none", Top: 10,
			Only: "problem", Is: "is", Value: "Zombie"}},
		{"Which kinds of asset are noncompliant?", ChartPicks{Count: "assets", Split: "atype", Window: "now", Over: "none", Top: 10,
			Only: "problem", Is: "is", Value: "Noncompliant"}},
		{"Who found the assets nobody could identify?", ChartPicks{Count: "assets", Split: "source", Window: "now", Over: "none", Top: 10,
			Only: "atype", Is: "is", Value: "Unclassified"}},
		{"Who makes the IoT devices?", ChartPicks{Count: "assets", Split: "vendor", Window: "now", Over: "none", Top: 10,
			Only: "acat", Is: "is", Value: "IoT"}},
		{"Which regions hold the cloud assets?", ChartPicks{Count: "assets", Split: "region", Window: "now", Over: "none", Top: 10,
			Only: "where", Is: "is", Value: "Cloud"}},
		{"What problems do on-premises assets have?", ChartPicks{Count: "assets", Split: "problem", Window: "now", Over: "none",
			Only: "where", Is: "is", Value: "Onprem"}},
		{"What kinds of asset appeared this month?", ChartPicks{Count: "newassets", Split: "atype", Window: "thismonth", Over: "none", Top: 10}},
		{"Which policies blocked the most this week?", ChartPicks{Count: "threats", Split: "policy", Window: "7d", Over: "none", Top: 10,
			Only: "action", Is: "is", Value: "Block"}},
		{"Which names were looked up but don't exist?", ChartPicks{Count: "dns", Split: "domain", Window: "24h", Over: "none", Top: 10,
			Only: "rcode", Is: "is", Value: "3"}},
	},
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
	filters := slices.Clone(count.Filters)
	if p.Only != "" || p.Is != "" || p.Value != "" {
		f, err := onlyFilter(*count, p)
		if err != nil {
			return nil, "", err
		}
		filters = append(filters, f)
	}
	if len(filters) > 0 {
		q["filters"] = filters
	}
	if p.Top > 0 {
		q["order"] = map[string]any{count.Measure: "desc"}
		q["limit"] = p.Top
	}
	return q, count.Endpoint, nil
}

// onlyFilter is the "Only show" filter as a Cube filter, or why it can't be one.
func onlyFilter(count chartCount, p ChartPicks) (map[string]any, error) {
	bad := fmt.Errorf("that filter isn't available")
	only, ok := findChoice(chartCatalog.Splits, p.Only)
	if !ok || p.Only == "none" || p.Only == p.Split || !slices.Contains(count.Splits, p.Only) {
		return nil, bad
	}
	if p.Is != "is" && p.Is != "not" {
		return nil, bad
	}
	if p.Value == "" || len(p.Value) > chartValueMax || strings.ContainsFunc(p.Value, unicode.IsControl) {
		return nil, bad
	}
	if len(only.Buckets) > 0 {
		if !slices.Contains(only.Buckets, p.Value) {
			return nil, bad
		}
		op := map[string]string{"is": "contains", "not": "notContains"}[p.Is]
		return map[string]any{"member": only.Fields[0], "operator": op, "values": []string{`"` + p.Value + `"`}}, nil
	}
	op := map[string]string{"is": "equals", "not": "notEquals"}[p.Is]
	return map[string]any{"member": only.Fields[0], "operator": op, "values": []string{p.Value}}, nil
}

// chartValuesMax is how many values the "Only show" menu offers: the most
// common ones, since a menu of thousands of domains helps nobody.
const chartValuesMax = 50

// ChartValues is the values the "Only show" menu offers for one field of a
// count: a bucket field's fixed list, or the most common values over the
// window. A blank value is left out: "is blank" is not a filter Cube takes.
func (s *Service) ChartValues(ctx context.Context, countID, only, windowID string) map[string]any {
	invalid := map[string]any{"status": "invalid", "values": []string{}}
	var count *chartCount
	for i := range chartCatalog.Counts {
		if chartCatalog.Counts[i].ID == countID {
			count = &chartCatalog.Counts[i]
		}
	}
	field, ok := findChoice(chartCatalog.Splits, only)
	window, okW := findChoice(chartCatalog.Windows, windowID)
	if count == nil || !ok || !okW || only == "none" || !slices.Contains(count.Splits, only) ||
		count.Snapshot != (windowID == "now") {
		return invalid
	}
	if len(field.Buckets) > 0 {
		return map[string]any{"status": "ok", "values": field.Buckets}
	}
	q := map[string]any{
		"measures":   []string{count.Measure},
		"dimensions": field.Fields[:1],
		"order":      map[string]any{count.Measure: "desc"},
		"limit":      chartValuesMax,
	}
	if !count.Snapshot {
		q["timeDimensions"] = []map[string]any{{"dimension": count.timeField(), "dateRange": window.Value}}
	}
	if len(count.Filters) > 0 {
		q["filters"] = count.Filters
	}
	qj, _ := json.Marshal(q)
	ck := cache.Key("chartvalues", count.Endpoint, map[string]string{"query": string(qj)}, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()
	body, st, err := s.Rest.GetEx(count.Endpoint, map[string]string{"query": string(qj)})
	if errored(st, err) {
		return map[string]any{"status": "error", "values": []string{}}
	}
	values := []string{}
	for _, r := range cubeData(body) {
		if v := fmt.Sprint(asMap(r)[field.Fields[0]]); v != "" && v != "<nil>" {
			values = append(values, v)
		}
	}
	result := map[string]any{"status": "ok", "values": values}
	s.Cache.SetGen(ck, result, g)
	return result
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
			m := map[string]any{"id": x.ID, "name": x.Name, "plural": x.Plural, "fields": x.Fields, "value": x.Value, "buckets": x.Buckets}
			if x.PortalField != "" {
				m["portal"] = map[string]string{"field": x.PortalField, "op": x.PortalOp}
			}
			out = append(out, m)
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
		"questions": func() []map[string]any {
			out := make([]map[string]any, 0, len(chartCatalog.Questions))
			for _, q := range chartCatalog.Questions {
				out = append(out, map[string]any{"name": q.Name, "picks": q.Picks})
			}
			return out
		}(),
		"names":  chartCatalog.Names,
		"values": chartCatalog.Values,

		"otherValues": chartCatalog.OtherValues,
	}
}
