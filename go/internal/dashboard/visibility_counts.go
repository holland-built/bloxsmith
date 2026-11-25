package dashboard

// visibility_counts: the 18 counts of the IT Visibility Assessment, in the
// exact data.json shape the Glean "Visibility Assessment Tech Debt" agent
// takes (build-report SKILL.md section 3, Portal variant in the
// visibility-collect skill). Built here in Go from the typed readers, never
// by the AI: the model only gets a short summary and the download link
// (/api/visibility-counts), because an 18-row file is longer than its answer
// budget and a copied number could drift.
//
// The agent refuses to build the customer page when any of counts 1 to 17 is
// blank, so every count this app can't read is null with a note that says
// why and which Portal screen to read instead. A null is never turned into 0.
//
// customer and region are left blank: the agent fills both from its own form
// when the upload is a .json file (SKILL.md section 1b).

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"bloxsmith/internal/cache"
)

// visBudget bounds the whole assessment, well inside the AI loop's 55-second
// deadline, so the model still has time to answer. Reads still running when
// it ends are stopped and their counts come back null with the reason.
var visBudget = 25 * time.Second

// visTypesTop is how many asset types charts.assetTypes lists.
const visTypesTop = 50

type VisCount struct {
	N     int    `json:"n"`
	Count *int   `json:"count"`
	Raw   string `json:"raw"`
	From  string `json:"from"`
	Ref   string `json:"ref"`
	Note  string `json:"note"`
}

type VisSource struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
	Link string `json:"link"`
}

type VisCharts struct {
	AssetTypes          []chartItem `json:"assetTypes"`
	CmdbMissingBySource []chartItem `json:"cmdbMissingBySource"`
	CmdbOrphanedByType  []chartItem `json:"cmdbOrphanedByType"`
	CloudProviders      []chartItem `json:"cloudProviders"`
}

type VisNote struct {
	Ref  string `json:"ref"`
	Text string `json:"text"`
}

// VisFile is data.json. Field order follows the schema's example.
type VisFile struct {
	Customer      string     `json:"customer"`
	Region        string     `json:"region"`
	ReportDate    string     `json:"reportDate"`
	Source        VisSource  `json:"source"`
	Counts        []VisCount `json:"counts"`
	Charts        VisCharts  `json:"charts"`
	DNSPanelTotal *string    `json:"dnsPanelTotal"`
	Notes         []VisNote  `json:"notes"`
}

// visFindings names the 18 rows and the Portal screen each is read from
// (visibility-collect skill), so a null count can say where to look.
var visFindings = [18]struct{ Name, Ref string }{
	{"Detached storage volumes", "Inventory: Zombie + Storage Volume"},
	{"Orphan public IPs", "Inventory: Zombie + Public IP Address"},
	{"Underutilized virtual machines", "Inventory: Zombie + Virtual Machine"},
	{"Orphan load balancers", "Inventory: Zombie + Load Balancer"},
	{"Public access assets", "Networked Assets: Noncompliant Assets"},
	{"Unencrypted assets", "Networked Assets: Noncompliant Assets"},
	{"Assets missing from CMDB", "Inventory: Providers NOTIN ServiceNow"},
	{"Assets orphaned in CMDB", "Asset Reconciliation"},
	{"Missing DNS forward records", "Networked Assets: Assets with Missing Records"},
	{"Missing DNS pointer records", "Networked Assets: Assets with Missing Records"},
	{"Underutilized subnets", "UDDI DDI: Subnet Utilization, 0-20% bar"},
	{"Overutilized subnets", "UDDI DDI: Subnet Utilization, 80-100% bar"},
	{"Overlapping subnets", "UDDI DDI: Overlapping IP Blocks"},
	{"Dangling DNS records", "UDDI DDI: DNS Record Classifications"},
	{"Abandoned DNS records", "UDDI DDI: DNS Record Classifications"},
	{"Untrusted DNS records", "UDDI DDI: DNS Record Classifications"},
	{"Other high-risk DNS records", "UDDI DDI: DNS Record Classifications"},
	{"Stale DNS records", "UDDI DDI: DNS Record Classifications"},
}

const reasonOverlap = "Bloxsmith's overlap check (ranges used in more than one IP space) is not confirmed to count what the Portal's Overlapping IP Blocks card counts."

// visInputs is every read the assessment makes, count-only.
type visInputs struct {
	Zombie        [4]Metric
	Noncompliant  Metric
	NonIndicators map[string]Metric
	Combos        []coverageCombo
	CombosM       Metric
	Connectors    map[string]any
	MissFwd       Metric
	MissPtr       Metric
	Under         Metric
	Over          Metric
	OverSmall     Metric
	DNS           map[string]Metric
	OtherFlags    map[string]int
	OtherM        Metric
	Types         []chartItem
	TypesComplete bool
	TypesM        Metric
}

// readVisibility makes every read, visConcurrency at a time, inside ctx.
func (s *Service) readVisibility(ctx context.Context) visInputs {
	in := visInputs{NonIndicators: map[string]Metric{}, DNS: map[string]Metric{}}
	nonInd := make([]Metric, len(noncomplyIndicators))
	dns := make([]Metric, len(dnsKnownFlags))
	var tasks []func()
	for i, t := range zombieTypes {
		tasks = append(tasks, func() { in.Zombie[i] = s.assetCount(ctx, classIs("Zombie"), assetTypeIs(t)) })
	}
	for i, f := range dnsKnownFlags {
		tasks = append(tasks, func() { dns[i] = s.readDNSFlag(ctx, f, 0).Count })
	}
	tasks = append(tasks,
		func() { in.Combos, in.CombosM = s.readCombos(ctx) },
		func() { in.Connectors = s.FetchConnectorHealth(ctx) },
		func() { in.MissFwd = s.assetCount(ctx, indicatorIs("DNS Forward Record")) },
		func() { in.MissPtr = s.assetCount(ctx, indicatorIs("DNS Pointer Record")) },
		func() { in.Under = s.restCountCtx(ctx, subnetPath, subnetFilter(subnetUnderFilter)) },
		func() { in.Over = s.restCountCtx(ctx, subnetPath, subnetFilter(subnetOverFilter)) },
		func() {
			in.OverSmall = s.restCountCtx(ctx, subnetPath, subnetFilter(subnetOverFilter, subnetSmallFilter))
		},
		func() { in.OtherFlags, in.OtherM = s.readDNSOtherFlags(ctx) },
		func() {
			in.Types, in.TypesComplete, in.TypesM = s.assetSplit(ctx, "taxonomy_type_label", visTypesTop)
		},
		func() { in.Noncompliant = s.assetCount(ctx, classIs("Noncompliant")) },
	)
	for i, ind := range noncomplyIndicators {
		tasks = append(tasks, func() { nonInd[i] = s.assetCount(ctx, indicatorIs(ind)) })
	}
	runBounded(tasks...)
	for i, f := range dnsKnownFlags {
		in.DNS[f] = dns[i]
	}
	for i, ind := range noncomplyIndicators {
		in.NonIndicators[ind] = nonInd[i]
	}
	return in
}

// cloudLabels maps an asset source name to the provider name the chart uses.
func cloudLabel(source string) string {
	l := strings.ToLower(source)
	switch {
	case l == "aws" || strings.Contains(l, "amazon"):
		return "AWS"
	case strings.Contains(l, "azure"):
		return "Azure"
	case l == "gcp" || strings.Contains(l, "google"):
		return "GCP"
	case l == "oci" || strings.Contains(l, "oracle"):
		return "OCI"
	}
	return ""
}

// assembleVisibility is pure: the reads in, data.json out. whole is false
// when any read failed or was stopped, so a partial file is never cached.
func assembleVisibility(in visInputs, date string) (f VisFile, whole bool) {
	whole = true
	f = VisFile{
		ReportDate: date,
		Source:     VisSource{Kind: "bloxsmith", Name: "Bloxsmith, read from the Infoblox Portal API", Link: ""},
		Charts: VisCharts{AssetTypes: []chartItem{}, CmdbMissingBySource: []chartItem{},
			CmdbOrphanedByType: []chartItem{}, CloudProviders: []chartItem{}},
		Notes: []VisNote{},
	}
	set := func(n int, m Metric, how string) {
		row := VisCount{N: n, From: "portal", Ref: visFindings[n-1].Ref}
		if m.OK() {
			c := m.N()
			row.Count, row.Raw, row.Note = &c, fmt.Sprint(c), how
		} else {
			if m.Status != MetricNotRead {
				whole = false
			}
			row.Note = strings.TrimSpace(m.Reason + " Read it on the Portal: " + row.Ref + ".")
			f.Notes = append(f.Notes, VisNote{Ref: "Portal", Text: fmt.Sprintf("Count %d, %s, was not read: %s", n, strings.ToLower(visFindings[n-1].Name), m.Reason)})
		}
		f.Counts = append(f.Counts, row)
	}

	for i, t := range zombieTypes {
		set(i+1, in.Zombie[i], "Assets with the Zombie problem and type "+t+", the Portal's Inventory filter.")
	}
	// 5 and 6: the cube's Noncompliant reasons, for the SE to match to the card.
	nonWhy := reasonPublicUnencryp
	if in.Noncompliant.OK() {
		var parts []string
		for _, ind := range noncomplyIndicators {
			if m := in.NonIndicators[ind]; m.OK() {
				parts = append(parts, fmt.Sprintf("%s %d", ind, m.N()))
			}
		}
		nonWhy += fmt.Sprintf(" Infoblox counts %d Noncompliant assets", in.Noncompliant.N())
		if len(parts) > 0 {
			nonWhy += " (" + strings.Join(parts, ", ") + ")"
		}
		nonWhy += "."
	}
	set(5, metricFail(MetricNotRead, nonWhy), "")
	set(6, metricFail(MetricNotRead, nonWhy), "")

	g := assembleCmdbGap(in.Combos, in.CombosM, in.Connectors)
	if g.Connected == "unknown" {
		whole = false
	}
	set(7, g.Missing, "Assets no ServiceNow source reports, across every source, cloud included.")
	orphaned := g.Orphaned
	if g.OnlyInServiceNow.OK() {
		orphaned.Reason += fmt.Sprintf(" Assets only ServiceNow reports: %d.", g.OnlyInServiceNow.N())
	}
	set(8, orphaned, "")
	if g.Missing.OK() {
		f.Charts.CmdbMissingBySource = g.MissingBySource
	}

	set(9, in.MissFwd, "Assets missing a DNS forward record.")
	set(10, in.MissPtr, "Assets missing a DNS pointer record.")
	band := "Every subnet is counted, IPv4 /29 to /32 links and IPv6 included."
	set(11, in.Under, fmt.Sprintf("Subnets under %d%% used. %s", subnetUnderPct, band))
	overHow := fmt.Sprintf("Subnets %d%% used or more. %s", subnetOverPct, band)
	if in.OverSmall.OK() {
		overHow += fmt.Sprintf(" %d of them are /29 to /32 links.", in.OverSmall.N())
	}
	set(12, in.Over, overHow)
	set(13, metricFail(MetricNotRead, reasonOverlap+" Bloxsmith's own list is in Ask AI (get_overlapping_ranges)."), "")

	for i, flag := range []string{"Dangling", "Abandoned", "Untrusted"} {
		set(14+i, in.DNS[flag], "Records Infoblox flags "+flag+"; a record can carry more than one flag.")
	}
	switch {
	case !in.OtherM.OK():
		set(17, in.OtherM, "")
	case len(in.OtherFlags) == 0:
		set(17, metricOK(0), "No DNS record carries a flag other than Dangling, Abandoned, Untrusted or Stale.")
	default:
		names := make([]string, 0, len(in.OtherFlags))
		for k, v := range in.OtherFlags {
			names = append(names, fmt.Sprintf("%s %d", k, v))
		}
		sort.Strings(names)
		set(17, metricFail(MetricNotRead, "Records carry other flags ("+strings.Join(names, ", ")+"); whether the Portal counts them as high-risk is not confirmed."), "")
	}
	set(18, in.DNS["Stale"], "Records Infoblox flags Stale (not looked up in 180 days, internal primary zones only).")

	if in.TypesM.OK() {
		f.Charts.AssetTypes = in.Types
		if !in.TypesComplete {
			f.Notes = append(f.Notes, VisNote{Ref: "Portal", Text: fmt.Sprintf("Assets by type lists the %d most common types only.", visTypesTop)})
		}
	} else {
		whole = false
		f.Notes = append(f.Notes, VisNote{Ref: "Portal", Text: "Assets by type was not read: " + in.TypesM.Reason})
	}
	if in.CombosM.OK() {
		by := map[string]int{}
		for _, c := range in.Combos {
			seen := map[string]bool{}
			for _, l := range c.labels {
				if p := cloudLabel(l); p != "" && !seen[p] {
					seen[p] = true
					by[p] += c.count
				}
			}
		}
		for _, p := range []string{"AWS", "Azure", "GCP", "OCI"} {
			if by[p] > 0 {
				f.Charts.CloudProviders = append(f.Charts.CloudProviders, chartItem{p, by[p]})
			}
		}
	} else {
		f.Notes = append(f.Notes, VisNote{Ref: "Portal", Text: "Assets by cloud provider was not read: " + in.CombosM.Reason})
	}
	return f, whole
}

// VisibilityCounts runs the assessment inside visBudget. A whole result is
// cached briefly, so the AI tool and the download link it hands out read the
// same numbers without asking Infoblox twice.
func (s *Service) VisibilityCounts(ctx context.Context) VisFile {
	key := cache.Key("visibility-counts", s.Rest.TenantTag(), nil, false)
	if v, ok := s.Cache.Get(key); ok {
		if f, ok := v.(VisFile); ok {
			return f
		}
	}
	g := s.Cache.Gen()
	bctx, cancel := context.WithTimeout(ctx, visBudget)
	defer cancel()
	in := s.readVisibility(bctx)
	f, whole := assembleVisibility(in, time.Now().Format("2006-01-02"))
	if whole && bctx.Err() == nil {
		s.Cache.SetGen(key, f, g)
	}
	return f
}

// visibilityCountsTool gives the model a short summary and the link, never
// the whole file.
func (s *Service) visibilityCountsTool(ctx context.Context) string {
	f := s.VisibilityCounts(ctx)
	read := 0
	var missing []string
	for _, c := range f.Counts {
		if c.Count != nil {
			read++
			continue
		}
		missing = append(missing, fmt.Sprintf("%d %s", c.N, visFindings[c.N-1].Name))
	}
	summary := fmt.Sprintf("Read %d of 18 Visibility Assessment counts.", read)
	if len(missing) > 0 {
		summary += " Not read (the file says why and which Portal screen to check): " + strings.Join(missing, "; ") + "."
	}
	return jstr(map[string]any{
		"summary":  summary,
		"download": "/api/visibility-counts",
		"how_to_use": "Give the user the download as a markdown link. They upload the file to the Glean Visibility " +
			"Assessment Tech Debt agent and enter the customer name and region there. Do not list the counts.",
	})
}

// visCountsRead is how many counts in f have a number, for tests and logs.
func visCountsRead(f VisFile) int {
	return len(slices.DeleteFunc(slices.Clone(f.Counts), func(c VisCount) bool { return c.Count == nil }))
}
