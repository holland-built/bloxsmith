package dashboard

// The Visibility Assessment's Ask AI tools: risky_dns_records,
// asset_problems, cmdb_gap, and get_subnets' by_cloud summary. Each is built
// from the typed readers in visibility_read.go, and visibility_counts
// (visibility_counts.go) reuses the same functions, so a number means the
// same thing in every tool. All reads only.

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"
)

// visConcurrency is how many reads one tool runs at once, so a tool never
// sends Infoblox a burst of 20 queries.
const visConcurrency = 4

// runBounded runs tasks visConcurrency at a time. Every reader checks ctx
// before it sends, so once the deadline passes the rest finish at once.
func runBounded(tasks ...func()) {
	if fanOut(visConcurrency, tasks...) > 0 {
		panic(errTaskPanicked)
	}
}

// --- risky_dns_records -----------------------------------------------------

func (s *Service) riskyDNSTool(ctx context.Context) string {
	reads := make([]dnsFlagRead, len(dnsKnownFlags))
	var other map[string]int
	var otherM Metric
	tasks := []func(){func() { other, otherM = s.readDNSOtherFlags(ctx) }}
	for i, f := range dnsKnownFlags {
		tasks = append(tasks, func() { reads[i] = s.readDNSFlag(ctx, f, aiSampleCap) })
	}
	runBounded(tasks...)

	counts := map[string]Metric{}
	samples := map[string][]map[string]any{}
	var parts []string
	for i, f := range dnsKnownFlags {
		counts[f] = reads[i].Count
		parts = append(parts, f+" "+metricWord(reads[i].Count))
		if reads[i].SampleOK {
			list := make([]map[string]any, 0, len(reads[i].Sample))
			for _, r := range reads[i].Sample {
				list = append(list, dnsRecordItem(r))
			}
			samples[f] = list
		}
	}
	out := map[string]any{
		"summary": "DNS records Infoblox flagged: " + strings.Join(parts, ", ") +
			fmt.Sprintf(". Counts are every flagged record; each sample lists at most %d. A record can carry more than one flag.", aiSampleCap),
		"UNTRUSTED_DATA_NOTICE": untrustedNotice,
		"counts":                counts,
		"samples":               samples,
	}
	switch {
	case !otherM.OK():
		out["other_flags"] = otherM
	case len(other) > 0:
		out["other_flags"] = other
	default:
		out["other_flags"] = "none: no record carries any other flag"
	}
	return jstr(out)
}

// metricWord is a count for a sentence: the number, or why there is none.
func metricWord(m Metric) string {
	if m.OK() {
		return fmt.Sprint(m.N())
	}
	return "couldn't count (" + m.Reason + ")"
}

// --- asset_problems ----------------------------------------------------------
//
// Counts from AssetDetails_ch_agg, one asset per row (assets.go). Each total
// is its own unsplit count query, so it never depends on how many bars a
// split returns. The label fields hold JSON lists as text, so a value is
// matched with "contains" on the quoted name, as the chart builder does.
//
// The indicator names below were read from the live demo tenant on
// 2026-11-25: Zombie assets carry Detached Storage Volume, Orphan Public IP or
// Underutilized Virtual Machine; Noncompliant assets carry Permissive Security
// Group, Publicly Accessible VM or Unsecured Storage Volume.

var (
	assetProblemClasses = []string{"Zombie", "Noncompliant", "Unregistered"}
	assetMissingRecords = []string{"DNS Forward Record", "DNS Pointer Record", "IPAM"}
	// zombieTypes are the four asset types of assessment counts 1 to 4, the
	// visibility-collect skill's Portal filter: Zombie plus the asset type.
	zombieTypes          = []string{"Storage Volume", "Public IP Address", "Virtual Machine", "Load Balancer"}
	zombieIndicators     = []string{"Detached Storage Volume", "Orphan Public IP", "Underutilized Virtual Machine"}
	noncomplyIndicators  = []string{"Publicly Accessible VM", "Unsecured Storage Volume", "Permissive Security Group"}
	assetSplitTop        = 10
	reasonIdleOrphaned   = "The asset data has no idle or orphaned label for zombies, so that split isn't counted. Read it on the Portal's Zombie assets view."
	reasonPublicUnencryp = "The asset data names the Noncompliant reasons Publicly Accessible VM, Unsecured Storage Volume and Permissive Security Group, but which of them the Portal's Noncompliant Assets card calls Public Access and Unencrypted is not confirmed. Read that card instead."
)

func labelHas(field, value string) map[string]any {
	return map[string]any{"member": cubeAssets + "." + field, "operator": "contains", "values": []string{`"` + value + `"`}}
}

func classIs(c string) map[string]any     { return labelHas("insight_classifications_label", c) }
func indicatorIs(i string) map[string]any { return labelHas("insight_indicators_label", i) }
func assetTypeIs(t string) map[string]any {
	return map[string]any{"member": cubeAssets + ".taxonomy_type_label", "operator": "equals", "values": []string{t}}
}

// assetCount counts the assets that pass every filter.
func (s *Service) assetCount(ctx context.Context, filters ...map[string]any) Metric {
	q := map[string]any{"measures": []string{assetsMeasure}}
	if len(filters) > 0 {
		q["filters"] = filters
	}
	return s.cubeCountCtx(ctx, q, "assetsCount")
}

// chartItem is one bar: {"label","value"}, the data.json chart shape.
type chartItem struct {
	Label string `json:"label"`
	Value int    `json:"value"`
}

// assetSplit is the top n values of field among the assets that pass the
// filters. complete is false when n bars came back, so there may be more.
func (s *Service) assetSplit(ctx context.Context, field string, n int, filters ...map[string]any) (items []chartItem, complete bool, m Metric) {
	q := map[string]any{
		"measures":   []string{assetsMeasure},
		"dimensions": []string{cubeAssets + "." + field},
		"order":      map[string]any{assetsMeasure: "desc"},
		"limit":      n,
	}
	if len(filters) > 0 {
		q["filters"] = filters
	}
	rows, m := s.cubeReadCtx(ctx, q)
	if rows == nil {
		return nil, false, m
	}
	items = []chartItem{}
	for _, r := range rows {
		v, ok := comboCount(r["assetsCount"])
		if !ok {
			return nil, false, metricFail(MetricUnknown, "Infoblox sent a count this app could not read.")
		}
		label := getStr(r[field])
		if label == "" {
			label = "Not reported"
		}
		items = append(items, chartItem{label, v})
	}
	return items, len(rows) < n, metricOK(len(items))
}

type assetProblems struct {
	Problems       map[string]Metric `json:"problems"`
	MissingRecords map[string]Metric `json:"missing_records"`
	ZombiesByType  map[string]Metric `json:"zombies_by_type"`
	Indicators     map[string]Metric `json:"indicators"`
	NotProven      map[string]Metric `json:"not_proven"`
	TopSplit       map[string]any    `json:"top_split,omitempty"`
}

// readAssetProblems runs every count; split ("type", "source" or "") adds a
// top-10 split of each problem.
func (s *Service) readAssetProblems(ctx context.Context, split string) assetProblems {
	out := assetProblems{
		Problems: map[string]Metric{}, MissingRecords: map[string]Metric{},
		ZombiesByType: map[string]Metric{}, Indicators: map[string]Metric{},
		NotProven: map[string]Metric{
			"zombie_idle_vs_orphaned":      metricFail(MetricNotRead, reasonIdleOrphaned),
			"public_access_vs_unencrypted": metricFail(MetricNotRead, reasonPublicUnencryp),
		},
	}
	type job struct {
		into    map[string]Metric
		key     string
		filters []map[string]any
	}
	var jobs []job
	for _, c := range assetProblemClasses {
		jobs = append(jobs, job{out.Problems, c, []map[string]any{classIs(c)}})
	}
	for _, r := range assetMissingRecords {
		jobs = append(jobs, job{out.MissingRecords, r, []map[string]any{indicatorIs(r)}})
	}
	for _, t := range zombieTypes {
		jobs = append(jobs, job{out.ZombiesByType, t, []map[string]any{classIs("Zombie"), assetTypeIs(t)}})
	}
	for _, i := range slices.Concat(zombieIndicators, noncomplyIndicators) {
		jobs = append(jobs, job{out.Indicators, i, []map[string]any{indicatorIs(i)}})
	}
	results := make([]Metric, len(jobs))
	var tasks []func()
	for i, j := range jobs {
		tasks = append(tasks, func() { results[i] = s.assetCount(ctx, j.filters...) })
	}
	field := map[string]string{"type": "taxonomy_type_label", "source": "provider_label"}[split]
	splits := map[string]any{}
	var mu sync.Mutex
	if field != "" {
		for _, c := range assetProblemClasses {
			tasks = append(tasks, func() {
				items, complete, m := s.assetSplit(ctx, field, assetSplitTop, classIs(c))
				var v any = m
				if m.OK() {
					v = map[string]any{"top": assetSplitTop, "complete": complete, "bars": items}
				}
				mu.Lock()
				splits[c] = v
				mu.Unlock()
			})
		}
	}
	runBounded(tasks...)
	for i, j := range jobs {
		j.into[j.key] = results[i]
	}
	if field != "" {
		out.TopSplit = map[string]any{"by": split, "note": fmt.Sprintf("Top %d only; the totals are in problems.", assetSplitTop), "splits": splits}
	}
	return out
}

func (s *Service) assetProblemsTool(ctx context.Context, split string) string {
	if split != "type" && split != "source" {
		split = ""
	}
	p := s.readAssetProblems(ctx, split)
	var parts []string
	for _, c := range assetProblemClasses {
		parts = append(parts, c+" "+metricWord(p.Problems[c]))
	}
	return jstr(map[string]any{
		"summary": "Assets by problem: " + strings.Join(parts, ", ") +
			". One asset can have several problems, so these do not add up to a total.",
		"result": p,
	})
}

// --- cmdb_gap ----------------------------------------------------------------
//
// Reconciliation against ServiceNow, worked out from the same grouped
// providers_label query as the coverage tiles (assetcoverage.go), but over
// EVERY asset: assembleCoverage only counts assets a network source saw, so a
// cloud-only asset would drop out of "missing from the CMDB".

const (
	reasonCompleteness = "The Portal's CMDB completeness percentage uses a definition that is not confirmed, so it isn't worked out here."
	reasonOrphaned     = "Assets only ServiceNow reports are not proof of an orphaned CMDB entry, and the Portal's Asset Reconciliation definition is not confirmed. See only_in_servicenow for the literal count."
)

func isServiceNow(label string) bool {
	return strings.Contains(strings.ToLower(label), "servicenow")
}

type cmdbGap struct {
	Connected        string      `json:"servicenow_connected"` // yes, no, unknown
	ConnectedWhy     string      `json:"servicenow_connected_reason"`
	Total            Metric      `json:"total_assets"`
	Missing          Metric      `json:"missing_from_servicenow"`
	MissingBySource  []chartItem `json:"missing_by_source"`
	OnlyInServiceNow Metric      `json:"only_in_servicenow"`
	InBoth           Metric      `json:"in_both"`
	Completeness     Metric      `json:"completeness_pct"`
	Orphaned         Metric      `json:"orphaned_in_cmdb"`
}

// readCombos is the grouped providers_label read: every distinct list of
// sources with its asset count.
func (s *Service) readCombos(ctx context.Context) ([]coverageCombo, Metric) {
	rows, m := s.cubeReadCtx(ctx, map[string]any{
		"measures":   []string{assetsMeasure},
		"dimensions": []string{cubeAssets + ".providers_label"},
		"order":      map[string]any{assetsMeasure: "desc"},
		"limit":      coverageComboLimit,
	})
	if rows == nil {
		return nil, m
	}
	combos, readable := parseCombos(rows)
	switch {
	case !readable:
		return nil, metricFail(MetricUnknown, "A list of asset sources came back in a form this app could not read.")
	case len(rows) >= coverageComboLimit:
		return nil, metricFail(MetricIncomplete, "There were more combinations of asset sources than this app reads at once.")
	}
	return combos, metricOK(len(combos))
}

// assembleCmdbGap is pure: the source combinations and the connector list in,
// the reconciliation out. A failed or capped connector list never proves that
// ServiceNow is missing.
func assembleCmdbGap(combos []coverageCombo, combosM Metric, conn map[string]any) cmdbGap {
	g := cmdbGap{
		Completeness: metricFail(MetricNotRead, reasonCompleteness),
		Orphaned:     metricFail(MetricNotRead, reasonOrphaned),
	}
	inSources := false
	for _, c := range combos {
		if slices.ContainsFunc(c.labels, isServiceNow) {
			inSources = true
		}
	}
	connOK := conn["availability"] == "ok"
	connWhole := connOK && conn["truncated"] != true
	inConnectors := false
	if list, ok := conn["connectors"].([]map[string]any); ok {
		for _, c := range list {
			// The provider type only: the name is whatever an admin typed.
			if isServiceNow(getStr(c["type"])) {
				inConnectors = true
			}
		}
	}
	switch {
	case inSources:
		g.Connected, g.ConnectedWhy = "yes", "ServiceNow is one of the asset sources."
	case inConnectors:
		g.Connected, g.ConnectedWhy = "yes", "ServiceNow is one of the discovery connections."
	case combosM.OK() && connWhole:
		g.Connected, g.ConnectedWhy = "no", "ServiceNow is not an asset source or a discovery connection on this account."
	case !combosM.OK():
		g.Connected, g.ConnectedWhy = "unknown", "The asset sources couldn't be read: "+combosM.Reason
	case !connOK:
		g.Connected, g.ConnectedWhy = "unknown", "ServiceNow is not an asset source, and the discovery connection list couldn't be read, so it may still be connected."
	default:
		g.Connected, g.ConnectedWhy = "unknown", "ServiceNow is not an asset source, and the discovery connection list was cut short, so it may still be connected."
	}

	if !combosM.OK() {
		for _, m := range []*Metric{&g.Total, &g.Missing, &g.OnlyInServiceNow, &g.InBoth} {
			*m = combosM
		}
		g.MissingBySource = []chartItem{}
		return g
	}
	total, missing, only, both := 0, 0, 0, 0
	bySource := map[string]int{}
	for _, c := range combos {
		total += c.count
		hasSN := slices.ContainsFunc(c.labels, isServiceNow)
		switch {
		case !hasSN:
			missing += c.count
			for _, l := range c.labels {
				bySource[l] += c.count
			}
		case len(c.labels) == 1:
			only += c.count
		default:
			both += c.count
		}
	}
	g.Total, g.OnlyInServiceNow, g.InBoth = metricOK(total), metricOK(only), metricOK(both)
	g.MissingBySource = []chartItem{}
	switch g.Connected {
	case "yes":
		g.Missing = metricOK(missing)
		for l, n := range bySource {
			g.MissingBySource = append(g.MissingBySource, chartItem{l, n})
		}
		sort.Slice(g.MissingBySource, func(i, j int) bool {
			a, b := g.MissingBySource[i], g.MissingBySource[j]
			return a.Value > b.Value || a.Value == b.Value && a.Label < b.Label
		})
	case "no":
		g.Missing = metricFail(MetricNotRead, "ServiceNow isn't connected, so there is no CMDB to compare against.")
	default:
		g.Missing = metricFail(MetricUnknown, g.ConnectedWhy)
	}
	return g
}

func (s *Service) readCmdbGap(ctx context.Context) cmdbGap {
	var combos []coverageCombo
	var combosM Metric
	var conn map[string]any
	runBounded(
		func() { combos, combosM = s.readCombos(ctx) },
		func() { conn = s.FetchConnectorHealth(ctx) },
	)
	return assembleCmdbGap(combos, combosM, conn)
}

func (s *Service) cmdbGapTool(ctx context.Context) string {
	g := s.readCmdbGap(ctx)
	return jstr(map[string]any{
		"summary": "ServiceNow connected: " + g.Connected + ". Assets missing from ServiceNow (every source, cloud included): " +
			metricWord(g.Missing) + ". Assets only in ServiceNow: " + metricWord(g.OnlyInServiceNow) + ".",
		"result": g,
	})
}

// --- Subnet bands ------------------------------------------------------------
//
// Assessment counts 11 and 12 are the Portal's Subnet Utilization card: the
// 0-20% bar and the 80-100% bar (visibility-collect skill, build-report
// section 2). The bars are read as under 20% and 20% or more up to 80% and
// more, so a subnet at exactly 20% is in neither band and one at exactly 80%
// is overutilized. The report slide that splits cloud subnets at 50% is a
// different chart and is not used for these counts.
const (
	subnetUnderPct = 20 // underutilized: less than this percent used
	subnetOverPct  = 80 // overutilized: this percent used or more
)

func inUnderBand(util int) bool { return util < subnetUnderPct }
func inOverBand(util int) bool  { return util >= subnetOverPct }

// The same rules as server-side filters.
var (
	subnetUnderFilter = fmt.Sprintf("utilization.utilization<%d", subnetUnderPct)
	subnetOverFilter  = fmt.Sprintf("utilization.utilization>=%d", subnetOverPct)
	// subnetSmallFilter is IPv4 /29 to /32 (IPv6 prefixes are /33 or longer
	// in practice, as get_subnets assumes).
	subnetSmallFilter = "cidr>=29 and cidr<=32"
)

const subnetPath = "/api/ddi/v1/ipam/subnet"

// subnetClouds are the clouds the by_cloud summary counts, with the name
// discovery_metadata.discoverer gives each (cloud.go cloudOfSubnet).
var subnetClouds = []struct{ Name, Discoverer string }{
	{"AWS", "Amazon Web Services"}, {"Azure", "Microsoft Azure"}, {"GCP", "Google Cloud Platform"},
}

func subnetFilter(clauses ...string) map[string]string {
	var keep []string
	for _, c := range clauses {
		if c != "" {
			keep = append(keep, c)
		}
	}
	if len(keep) == 0 {
		return nil
	}
	return map[string]string{"_filter": strings.Join(keep, " and ")}
}

type subnetCloudRow struct {
	Cloud         string `json:"cloud"`
	Subnets       Metric `json:"subnets"`
	Underutilized Metric `json:"underutilized"`
	Overutilized  Metric `json:"overutilized"`
}

type subnetCloudSummary struct {
	Rule          string           `json:"rule"`
	Total         Metric           `json:"all_subnets"`
	Underutilized Metric           `json:"all_underutilized"`
	Overutilized  Metric           `json:"all_overutilized"`
	Clouds        []subnetCloudRow `json:"by_cloud"`
	Unconfirmed   Metric           `json:"cloud_unknown"`
	NotCloud      Metric           `json:"not_cloud"`
	UnknownWhy    string           `json:"cloud_unknown_meaning"`
}

// subnetCloudPage and subnetCloudRowCap bound the cloud-row reads: a tenant
// with more cloud subnets than the cap gets an incomplete summary, never a
// short one.
const (
	subnetCloudPage   = 1000
	subnetCloudRowCap = 20000
)

// subnetRowsAll pages through every subnet matching params. The offset moves
// by the rows each page actually returned, so a short page skips nothing. The
// rows are complete only when their distinct ids reach the total Infoblox
// reported; an empty page before that is an incomplete read, never a smaller
// complete one.
func (s *Service) subnetRowsAll(ctx context.Context, params map[string]string) ([]map[string]any, Metric) {
	var out []map[string]any
	seen := map[string]bool{}
	for off := 0; ; {
		p := map[string]string{"_fields": "id,cidr,utilization,tags,discovery_metadata",
			"_limit": fmt.Sprint(subnetCloudPage), "_offset": fmt.Sprint(off), "_is_total_size_needed": "true"}
		for k, v := range params {
			p[k] = v
		}
		if ctx.Err() != nil {
			return nil, metricFail(MetricUnknown, reasonTimeUp)
		}
		rows, body, err := s.Rest.GetPageStrictCtx(ctx, subnetPath, p)
		if err != nil {
			return nil, readFailure(ctx, 0, err)
		}
		total := pageTotalSize(body, -1)
		if total < 0 {
			return nil, metricFail(MetricUnknown, "Infoblox didn't send a total for the subnet list.")
		}
		if total > subnetCloudRowCap {
			return nil, metricFail(MetricIncomplete, fmt.Sprintf("There are more than %d cloud subnets, more than this summary reads.", subnetCloudRowCap))
		}
		for _, r := range rows {
			m := asMap(r)
			if id := getStr(m["id"]); !seen[id] {
				seen[id] = true
				out = append(out, m)
			}
		}
		if len(seen) >= total {
			return out, metricOK(len(out))
		}
		if len(rows) == 0 {
			return nil, metricFail(MetricIncomplete, fmt.Sprintf(
				"Infoblox reported %d cloud subnets but sent %d before its pages ran out, so the cloud counts would be too low.", total, len(seen)))
		}
		off += len(rows)
	}
}

// readSubnetClouds counts subnets per cloud and band. The overall totals are
// server-side counts. The cloud rows are every subnet that carries a cloud tag
// or a cloud discoverer name, fetched and joined by id, then each classified
// with cloudOfSubnet, the rule the subnet lists use (tag first, then the
// discoverer). Subtracting tag and discoverer totals could not see subnets
// that have one but not the other. On the live demo tenant on 2026-11-25 the
// tag and discoverer counts agreed (AWS 587, Azure 221, GCP 168).
func (s *Service) readSubnetClouds(ctx context.Context) subnetCloudSummary {
	out := subnetCloudSummary{
		Rule:       fmt.Sprintf("Underutilized is under %d%% used, overutilized is %d%% or more. Every subnet is counted, IPv4 /29 to /32 and IPv6 included.", subnetUnderPct, subnetOverPct),
		UnknownWhy: "Subnets with a cloud tag or discoverer name that couldn't be matched to AWS, Azure or GCP.",
	}
	var discs []string
	for _, c := range subnetClouds {
		discs = append(discs, "discovery_metadata.discoverer=='"+c.Discoverer+"'")
	}
	sets := []map[string]string{{"_filter": strings.Join(discs, " or ")}}
	for _, c := range subnetClouds {
		sets = append(sets, map[string]string{"_tfilter": `"external_provider/` + strings.ToLower(c.Name) + `"~''`})
	}
	rows := make([][]map[string]any, len(sets))
	ms := make([]Metric, len(sets))
	tasks := []func(){
		func() { out.Total = s.restCountCtx(ctx, subnetPath, nil) },
		func() { out.Underutilized = s.restCountCtx(ctx, subnetPath, subnetFilter(subnetUnderFilter)) },
		func() { out.Overutilized = s.restCountCtx(ctx, subnetPath, subnetFilter(subnetOverFilter)) },
	}
	for i, p := range sets {
		tasks = append(tasks, func() { rows[i], ms[i] = s.subnetRowsAll(ctx, p) })
	}
	runBounded(tasks...)

	bad := out.Total
	for _, m := range ms {
		if !m.OK() && bad.OK() {
			bad = m
		}
	}
	if !bad.OK() {
		out.Clouds = make([]subnetCloudRow, len(subnetClouds))
		for i, c := range subnetClouds {
			out.Clouds[i] = subnetCloudRow{Cloud: c.Name, Subnets: bad, Underutilized: bad, Overutilized: bad}
		}
		out.Unconfirmed, out.NotCloud = bad, bad
		return out
	}
	seen := map[string]bool{}
	count := map[string]*[3]int{}
	for _, c := range subnetClouds {
		count[c.Name] = &[3]int{}
	}
	unknown, inCloud := 0, 0
	for _, set := range rows {
		for _, r := range set {
			id := getStr(r["id"])
			if seen[id] {
				continue
			}
			seen[id] = true
			inCloud++
			cloud, _ := cloudOfSubnet(r)
			n, ok := count[cloud]
			if !ok {
				unknown++
				continue
			}
			n[0]++
			if u, ok := asMap(r["utilization"])["utilization"].(float64); ok {
				if inUnderBand(int(u)) {
					n[1]++
				}
				if inOverBand(int(u)) {
					n[2]++
				}
			}
		}
	}
	for _, c := range subnetClouds {
		n := count[c.Name]
		out.Clouds = append(out.Clouds, subnetCloudRow{Cloud: c.Name,
			Subnets: metricOK(n[0]), Underutilized: metricOK(n[1]), Overutilized: metricOK(n[2])})
	}
	out.Unconfirmed = metricOK(unknown)
	out.NotCloud = metricOK(max(0, out.Total.N()-inCloud))
	return out
}
