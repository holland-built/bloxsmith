package dashboard

import (
	"fmt"
	"strings"
)

// How every panel is built: where its numbers come from and whether Build a
// chart can redraw it. These are the facts a test can check. The sentence the
// About disclosure shows is composed from them in ui/src/lib/panelHelp.js,
// and the "How each panel is built" table in docs/TABS.md is generated from
// them, so neither can drift from this list. ui/src/lib/panelSources.json is
// the same list for the UI; TestPanelSources_MatchTheUIFile keeps it current.
//
// Traced 2026-10-22 (research/bloxsmith-chart-builder-v2/panel-inventory.md).

// PanelSource is one panel. Kind is cube (Infoblox's activity records, the
// ones Build a chart reads), rest (the ordinary Infoblox API), local (the
// app's own data) or vendor (another company's service). Builder is exact
// (Build a chart draws the same thing), copy (it draws the chart but not what
// the panel adds) or no. Why says what stops an exact redraw; Picks are the
// menu choices that draw it, for exact and copy.
type PanelSource struct {
	ID      string      `json:"id"`
	Page    string      `json:"page"`
	Name    string      `json:"name"`
	Kind    string      `json:"kind"`
	Source  string      `json:"source"`
	Builder string      `json:"builder"`
	Why     string      `json:"why,omitempty"`
	Picks   *ChartPicks `json:"picks,omitempty"`
}

// The reasons that repeat, said once.
const (
	whyList     = "it is a list, not a chart"
	whyForm     = "it is a form, not a chart"
	whyLog      = "it is a live log, not a chart"
	whyResult   = "it reports what a change did, not a chart"
	whyAPI      = "it comes from the ordinary Infoblox API, not the activity records Build a chart reads"
	whyFullness = "how full each subnet is, and its colour band, is worked out in the app"
	whySample   = "it reads a sample of the last hour's events, not a full count"
	whyIncident = "the incidents are worked out in the app"
	whyTotal    = "it counts asset records, which Build a chart does not read yet"
	whyTable    = "it is a searchable, paged table, not a chart"

	srcSubnets = "the subnet list"
	srcHosts   = "the host list"
	srcZones   = "the DNS zone list"
	srcEvents  = "a sample of the last hour's DNS security events"
	srcAPI     = "the Infoblox API"
	srcASM     = "Infoblox's attack surface service"
	srcAudit   = "the Infoblox audit log"
	srcQps     = "Infoblox's DNS server metrics"
)

var (
	picksQps     = &ChartPicks{Count: "qps", Split: "none", Window: "24h", Over: "hour"}
	picksVolume  = &ChartPicks{Count: "dns", Split: "none", Window: "7d", Over: "day"}
	picksThreats = &ChartPicks{Count: "threats", Split: "action", Window: "7d", Over: "day"}
)

func restPanel(id, page, name, source, why string) PanelSource {
	return PanelSource{ID: id, Page: page, Name: name, Kind: "rest", Source: source, Builder: "no", Why: why}
}

var panelSources = []PanelSource{
	// ---- Overview ----
	{ID: "dns-hero", Page: "Overview", Name: "DNS Query Rate — 24h", Kind: "cube", Source: srcQps, Builder: "copy",
		Why: "the latest-hour figure and the comparison beside it are worked out in the app", Picks: picksQps},
	restPanel("top-consumers", "Overview", "Top Consumers", srcSubnets, "it ranks subnets by addresses in use, worked out in the app"),
	restPanel("subnet-heatmap", "Overview", "Subnet Heatmap", srcSubnets, whyFullness),
	restPanel("host-status", "Overview", "Host Status", srcHosts, "the hosts are counted by status in the app"),
	restPanel("services-incidents", "Overview", "Services and incidents", "the service list and the app's incident checks", whyIncident),
	restPanel("subnet-table", "Overview", "Top Subnets by Utilization", srcSubnets, whyFullness),
	restPanel("license-inventory", "Overview", "License Inventory", "the licence list and account alerts", whyList),

	// ---- Daily ----
	restPanel("daily-open-issues", "Daily", "Open Issues", "the subnet, host and zone lists", "the issues are worked out in the app"),
	restPanel("daily-security-today", "Daily", "Security Today", srcEvents, whySample),
	restPanel("daily-top-capacity-risks", "Daily", "Top Capacity Risks", srcSubnets, whyFullness),
	restPanel("daily-hosts-attention", "Daily", "Hosts Needing Attention", srcHosts, whyList),
	restPanel("daily-dns-zone-issues", "Daily", "DNS Zone Issues", srcZones, "the zone problems are worked out in the app"),

	// ---- Network ----
	restPanel("network-utilization-distribution", "Network", "Utilization Distribution", srcSubnets, whyFullness),
	restPanel("network-ipam-spaces", "Network", "IPAM Spaces — Top Used", "the IP space tree", "it ranks spaces by addresses used, worked out in the app"),
	restPanel("network-dhcp-leases", "Network", "DHCP Leases", "the DHCP lease list", "it is a searchable list, not a chart"),
	restPanel("network-exhaustion", "Network", "Which Subnets Run Out First?", srcSubnets, whyFullness),

	// ---- DNS ----
	{ID: "dns-query-rate", Page: "DNS", Name: "DNS Query Rate — 24h", Kind: "cube", Source: srcQps, Builder: "copy",
		Why: "the latest-hour figure and the comparison beside it are worked out in the app", Picks: picksQps},
	restPanel("dns-zone-kpis", "DNS", "Zone Counts", srcZones, "the counts and zone checks are worked out in the app"),
	restPanel("dns-services", "DNS", "DNS Services", "the DNS service list", whyList),
	{ID: "dns-query-volume-7d", Page: "DNS", Name: "Query Volume — 7d", Kind: "cube", Source: "Infoblox's DNS activity records",
		Builder: "exact", Picks: picksVolume},
	restPanel("dns-zones", "DNS", "DNS Zones", srcZones, whyList),
	restPanel("dns-dnssec-health", "DNS", "DNSSEC Health", srcZones, "the signing checks are worked out in the app"),
	restPanel("dns-rpz", "DNS", "RPZ Policy Zones", "the response policy zone list", whyList),
	restPanel("dns-dtc-lbdn", "DNS", "DTC Load-Balanced Names", "the load-balanced name list", whyList),

	// ---- Security ----
	restPanel("security-threat-events", "Security", "Threat Events — by Severity", srcEvents, whySample),
	restPanel("security-response-summary", "Security", "Response Summary", srcEvents, whySample),
	restPanel("security-triage-inbox", "Security", "Triage Inbox", srcEvents, "it is a list to work through, not a chart"),
	restPanel("security-inventory", "Security", "Security Inventory", "the security policy, feed and service lists", "it counts several lists in the app"),
	restPanel("security-lookalike-domains", "Security", "Lookalike Domains", "Infoblox's lookalike domain service", whyList),
	{ID: "security-axur-incidents", Page: "Security", Name: "Axur Supplier Risk", Kind: "vendor", Source: "Axur's supplier risk service",
		Builder: "no", Why: "it comes from Axur, not Infoblox"},
	restPanel("security-ctem-exposure", "Security", "CTEM Exposure", srcASM, whyAPI),
	{ID: "security-threat-feed-activity", Page: "Security", Name: "Threat Feed Activity", Kind: "cube", Source: "Infoblox's security hit records",
		Builder: "copy", Why: "the blocked and allowed totals above the bars are worked out in the app", Picks: picksThreats},
	restPanel("security-soc-insights", "Security", "SOC Insights", "Infoblox's SOC insights", whyAPI),
	{ID: "security-asset-insights", Page: "Security", Name: "Asset Insights", Kind: "cube", Source: "Infoblox's asset insight records",
		Builder: "no", Why: whyTotal},
	restPanel("security-exposures", "Security", "Exposures", srcASM, whyAPI),
	restPanel("security-asset-risk", "Security", "Asset Risk", srcASM, whyAPI),
	restPanel("security-exposed-surface", "Security", "Exposed Surface", srcASM, whyAPI),
	restPanel("security-ctem-assets", "Security", "CTEM Assets", srcASM, whyAPI),

	// ---- Infra ----
	restPanel("infra-host-inventory", "Infra", "Host Inventory", srcHosts, whyList),
	restPanel("infra-host-status", "Infra", "Host Status", srcHosts, "the hosts are counted by status in the app"),
	restPanel("infra-service-health", "Infra", "Service Health", "the service list", "each group's health is rolled up in the app"),
	restPanel("infra-host-health", "Infra", "Host Health", srcHosts, whyList),
	restPanel("infra-onprem-hosts", "Infra", "On-Prem Hosts", "the on-prem host list", whyList),
	{ID: "infra-asset-discovery", Page: "Infra", Name: "Asset Discovery", Kind: "cube", Source: "Infoblox's asset discovery records",
		Builder: "no", Why: whyTotal},
	restPanel("infra-jobs", "Infra", "Jobs", "the job list", whyList),
	restPanel("infra-dfp-services", "Infra", "DFP Services", "the DNS forwarding proxy list", whyList),

	// ---- Assets ----
	{ID: "assets-filter-bar", Page: "Assets", Name: "Asset Inventory", Kind: "cube", Source: "Infoblox's asset records", Builder: "no",
		Why: "it is the search and filter controls, with a total and a count for each type"},
	{ID: "assets-list", Page: "Assets", Name: "Assets", Kind: "cube", Source: "Infoblox's asset records", Builder: "no", Why: whyTable},
	{ID: "assets-detail", Page: "Assets", Name: "Asset detail", Kind: "cube", Source: "Infoblox's asset records", Builder: "no",
		Why: "it shows one asset's details, not a chart"},

	// ---- Incidents ----
	restPanel("incidents-categories", "Incidents", "Categories", "the app's incident checks over the Infoblox API", whyIncident),
	restPanel("incidents-severity", "Incidents", "Severity Counts", "the app's incident checks over the Infoblox API", whyIncident),
	restPanel("incidents-triage", "Incidents", "Triage", "the app's incident checks over the Infoblox API", whyIncident),
	restPanel("incidents-soc-queue", "Incidents", "SOC Queue", "Infoblox IQ actions", "it is a list of actions to work through, not a chart"),
	restPanel("incidents-action-volume", "Incidents", "Action Volume", "Infoblox IQ actions", "the actions are counted by day in the app, not read from activity records"),

	// ---- Audit ----
	{ID: "audit-activity-summary", Page: "Audit", Name: "Activity Summary", Kind: "local", Source: "this app's own audit log",
		Builder: "no", Why: "it is this app's own record, not Infoblox's"},
	{ID: "audit-log", Page: "Audit", Name: "Audit Log", Kind: "local", Source: "this app's own audit log", Builder: "no", Why: whyList},
	restPanel("audit-csp-portal", "Audit", "CSP Portal Audit", srcAudit, whyList),

	// ---- Changes ----
	restPanel("changes-notability", "Changes", "Notability", srcAudit, "how notable each change is, is worked out in the app"),
	restPanel("changes-changed-objects", "Changes", "Changed objects", srcAudit, whyList),

	// ---- Provision ----
	restPanel("provision-subnet-request", "Provision", "Subnet: Request", srcAPI, whyForm),
	restPanel("provision-subnet-log", "Provision", "Subnet: Live log", srcAPI, whyLog),
	restPanel("provision-subnet-result", "Provision", "Subnet: Result", srcAPI, whyResult),
	restPanel("provision-site-request", "Provision", "Full site: Request", srcAPI, whyForm),
	restPanel("provision-site-log", "Provision", "Full site: Live log", srcAPI, whyLog),
	restPanel("provision-site-dhcp-skips", "Provision", "Full site: DHCP ranges not created", srcAPI, whyResult),
	restPanel("provision-site-result", "Provision", "Full site: Result", srcAPI, whyResult),
	restPanel("provision-site-teardown", "Provision", "Full site: Tear down this site", srcAPI, whyForm),
	restPanel("provision-site-teardown-log", "Provision", "Full site: Teardown log", srcAPI, whyLog),
	restPanel("provision-site-teardown-result", "Provision", "Full site: Teardown result", srcAPI, whyResult),
	restPanel("provision-seed-request", "Provision", "Seed demo: Request", srcAPI, whyForm),
	restPanel("provision-seed-progress", "Provision", "Seed demo: Progress", srcAPI, whyLog),
	restPanel("provision-seed-log", "Provision", "Seed demo: Log", srcAPI, whyLog),
	restPanel("provision-seed-summary", "Provision", "Seed demo: Summary", srcAPI, whyResult),
	restPanel("provision-seed-teardown", "Provision", "Seed demo: Tear down demo", srcAPI, whyForm),
	restPanel("provision-seed-teardown-progress", "Provision", "Seed demo: Teardown progress", srcAPI, whyLog),
	restPanel("provision-seed-teardown-log", "Provision", "Seed demo: Teardown log", srcAPI, whyLog),
	restPanel("provision-seed-teardown-summary", "Provision", "Seed demo: Teardown summary", srcAPI, whyResult),

	// ---- Self-Service ----
	restPanel("selfservice-allocate", "Self-Service", "Allocate Address", srcAPI, whyForm),
	restPanel("selfservice-create-record", "Self-Service", "Create DNS Record", srcAPI, whyForm),
	restPanel("selfservice-manage-records", "Self-Service", "Manage Records", srcAPI, whyForm),
	restPanel("selfservice-manage-addresses", "Self-Service", "Manage Addresses", srcAPI, whyForm),

	// ---- Editor ----
	restPanel("editor-object-form", "Editor", "Create or edit an object", srcAPI, whyForm),

	// ---- Drift ----
	restPanel("drift-check", "Drift", "Check drift", "your templates and the Infoblox API", whyForm),
	restPanel("drift-error", "Drift", "Error", "your templates and the Infoblox API", whyResult),
	restPanel("drift-result", "Drift", "Result", "your templates and the Infoblox API", "it compares your templates with what is there, worked out in the app"),

	// ---- AI ----
	{ID: "ai-ask", Page: "AI", Name: "Ask AI", Kind: "local", Source: "the AI model, reading the Infoblox API",
		Builder: "no", Why: "the AI writes the answer, and Build a chart uses no AI"},
	restPanel("ai-threat-lookup", "AI", "Threat lookup", "Infoblox's threat intelligence", "it looks up one name at a time, not a chart"),

	// ---- Build a chart ----
	{ID: "chart-picks", Page: "Build a chart", Name: "Choose", Kind: "local", Source: "your picks", Builder: "no", Why: "it is Build a chart's own menu"},
	{ID: "chart-result", Page: "Build a chart", Name: "Your chart", Kind: "cube", Source: "Infoblox's activity records, as your picks ask",
		Builder: "no", Why: "it is Build a chart itself"},
	{ID: "chart-how", Page: "Build a chart", Name: "How this chart was made", Kind: "cube", Source: "Infoblox's activity records, as your picks ask",
		Builder: "no", Why: "it is Build a chart itself"},
}

// PanelSources is every panel, in page order.
func PanelSources() []PanelSource { return panelSources }

// PanelSourcesTable is the "How each panel is built" table in docs/TABS.md.
func PanelSourcesTable() string {
	can := map[string]string{"exact": "Yes", "copy": "As a copy", "no": "No"}
	var b strings.Builder
	b.WriteString("| Page | Panel | Built from | Can Build a chart redraw it? | Why not |\n")
	b.WriteString("|---|---|---|---|---|\n")
	for _, p := range panelSources {
		fmt.Fprintf(&b, "| %s | %s | %s | %s | %s |\n", p.Page, p.Name, p.Source, can[p.Builder], p.Why)
	}
	return b.String()
}
