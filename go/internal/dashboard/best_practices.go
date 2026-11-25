package dashboard

// Best practices: design rules checked against the tenant, read-only. The
// rules come from a colleague's Infoblox CSP MCP bundle (used with his OK,
// 2026-11-06), rewritten here; none of its code is copied.
//
// One rule over all of them: a check reports a problem only when the data
// proves it. When the data can't prove it either way (a list cut short, a
// failed read, a grid whose members aren't all visible), the check says it
// couldn't tell, never "passed". A result built on a failed read is not
// cached, so the page recovers on the next load.

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"bloxsmith/internal/cache"
)

type bpCheck struct {
	ID       string           `json:"id"`
	Severity string           `json:"severity"` // high, medium, low
	Title    string           `json:"title"`
	Why      string           `json:"why"`
	Status   string           `json:"status"` // problem, passed, unknown
	Reason   string           `json:"reason,omitempty"`
	Note     string           `json:"note,omitempty"`
	Link     string           `json:"link,omitempty"`
	Items    []map[string]any `json:"items"`
	// partial: the check stands but part of what backs it failed to read,
	// so the result is not cached and the next load asks again.
	partial bool
}

// listComplete reports whether rows are the whole list. Only a total from the
// API proves it (hosts.go: no total, no claim either way). Both lists used
// here send one, measured live on 2026-11-06.
func listComplete(rows []any, total int, totalOK bool) bool {
	return totalOK && total == len(rows)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

// BestPractices runs every check and returns them in a fixed order.
func (s *Service) BestPractices(ctx context.Context) map[string]any {
	return shared(s, "best-practices", func() map[string]any { return s.bestPractices(ctx) })
}

// bestPractices is BestPractices without the single-flight wrapper (shared.go).
func (s *Service) bestPractices(ctx context.Context) map[string]any {
	ck := cache.Key("best-practices", "", nil, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()

	failed := false
	hosts, total, totalOK, err := s.fetchHosts("")
	hostsOK := err == nil
	hostsWhole := hostsOK && listComplete(hosts, total, totalOK)
	failed = failed || !hostsOK

	ha, haBody, haErr := s.Rest.GetPageStrict("/api/ddi/v1/dhcp/ha_group",
		map[string]string{"_limit": "1000", "_is_total_size_needed": "true"})
	haTotal := pageTotalSize(haBody, -1)
	haWhole := haErr == nil && listComplete(ha, haTotal, haTotal >= 0)
	failed = failed || haErr != nil

	_, dnsBody, dnsErr := s.Rest.GetPageStrict("/api/ddi/v1/dns/global", nil)
	as := activeSearchCheck(dnsBody, dnsErr == nil)
	failed = failed || as.Status == "unknown"

	checks := []bpCheck{
		hostsDownCheck(hosts, hostsOK, hostsWhole),
		gmResilienceCheck(hosts, hostsOK, hostsWhole),
		dhcpAAPCheck(ha, haErr == nil, haWhole),
		as,
	}
	for _, c := range s.dnsRecordChecks(ctx) {
		failed = failed || c.Status == "unknown" || c.partial
		checks = append(checks, c)
	}
	out := map[string]any{"checks": checks}
	if !failed {
		s.Cache.SetGen(ck, out, g)
	}
	return out
}

func unknown(c bpCheck, readOK bool, what string) bpCheck {
	c.Status = "unknown"
	if !readOK {
		c.Reason = "Couldn't read the " + what + "."
	} else {
		c.Reason = "The " + what + " came back cut short, so a problem could be in the part not read."
	}
	c.Items = []map[string]any{}
	return c
}

func hostsDownCheck(hosts []any, readOK, whole bool) bpCheck {
	c := bpCheck{
		ID: "hosts-down", Severity: "high", Link: "#infra",
		Why: "These are the on-prem hosts. A host that's down serves nothing, and its zones and subnets lean on the others.",
	}
	var items []map[string]any
	for _, r := range hosts {
		h := asMap(r)
		st := strings.ToLower(getStr(h["composite_status"]))
		if st == "offline" || st == "error" {
			items = append(items, map[string]any{"name": getStr(h["display_name"]), "detail": st})
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i]["name"].(string) < items[j]["name"].(string) })
	switch {
	case !readOK:
		c.Title = "Infoblox servers that are offline or have an error"
		return unknown(c, false, "host list")
	case len(items) > 0:
		c.Title = plural(len(items), "Infoblox server is offline or has an error", "Infoblox servers are offline or have an error")
		c.Status, c.Items = "problem", items
		if !whole {
			c.Note = "The host list was cut short, so there may be more."
		}
	case !whole:
		c.Title = "Infoblox servers that are offline or have an error"
		return unknown(c, true, "host list")
	default:
		c.Title = "Every Infoblox server is online"
		c.Status, c.Items = "passed", []map[string]any{}
	}
	return c
}

func gmResilienceCheck(hosts []any, readOK, whole bool) bpCheck {
	c := bpCheck{
		ID: "gm-resilience", Severity: "high", Link: "#infra",
		Why: "The main grid server is the Grid Master; its backup is an HA pair or a Grid Master Candidate. Without an HA Grid Master or a Grid Master Candidate, losing the Grid Master leaves the grid unmanaged until it's rebuilt from backup.",
	}
	if !readOK || !whole {
		c.Title = "Main grid servers with no backup"
		return unknown(c, readOK, "host list")
	}
	type grid struct {
		name, gm  string
		hasBackup bool
		gmSeen    bool
		nodes     map[string]bool
		nodeCount int
		missingID bool
	}
	grids := map[string]*grid{}
	var order []string
	for _, r := range hosts {
		h := asMap(r)
		t := asMap(h["tags"])
		name := getStr(t["host/grid_name"])
		role := strings.ToLower(getStr(t["host/nios_role"]))
		if name == "" {
			continue
		}
		// Grid names repeat across grids, so the Grid Master address is part of the key.
		key := name + "|" + getStr(t["host/gridmaster_ip"])
		gr := grids[key]
		if gr == nil {
			gr = &grid{name: name, nodes: map[string]bool{}}
			grids[key] = gr
			order = append(order, key)
		}
		// Without a physical node id, two records could be one node, and
		// without a role a member could be the candidate, so either way the
		// grid can't be proven complete.
		if node := getStr(t["host/physical_oid"]); node != "" && role != "" {
			gr.nodes[node] = true
		} else {
			gr.missingID = true
		}
		if n, err := strconv.Atoi(getStr(t["host/grid_pnode_count"])); err == nil && n > gr.nodeCount {
			gr.nodeCount = n
		}
		switch role {
		case "gm":
			gr.gmSeen = true
			gr.gm = getStr(h["display_name"])
			if strings.EqualFold(getStr(t["host/ha_pair"]), "true") {
				gr.hasBackup = true
			}
		case "gmc":
			gr.hasBackup = true
		}
	}
	sort.Strings(order)
	var items []map[string]any
	cantTell := 0
	for _, k := range order {
		gr := grids[k]
		switch {
		case gr.hasBackup:
		case gr.gmSeen && !gr.missingID && gr.nodeCount > 0 && len(gr.nodes) >= gr.nodeCount:
			items = append(items, map[string]any{"name": gr.name, "detail": "Grid Master " + gr.gm})
		default:
			cantTell++
		}
	}
	if cantTell > 0 {
		c.Note = plural(cantTell, "grid", "grids") + " couldn't be checked: not all of their members are visible in the Portal, so a candidate may exist."
	}
	switch {
	case len(items) > 0:
		c.Title = plural(len(items), "main grid server has no backup", "main grid servers have no backup")
		c.Status, c.Items = "problem", items
	case cantTell > 0:
		c.Title = "Main grid servers with no backup"
		c.Status, c.Items, c.Reason = "unknown", []map[string]any{}, c.Note
		c.Note = ""
	case len(grids) == 0:
		c.Title = "No on-site Infoblox grids are connected to this account"
		c.Status, c.Items = "passed", []map[string]any{}
	default:
		c.Title = fmt.Sprintf("Every main grid server has a backup (%s)", plural(len(grids), "grid", "grids"))
		c.Status, c.Items = "passed", []map[string]any{}
	}
	return c
}

func dhcpAAPCheck(ha []any, readOK, whole bool) bpCheck {
	c := bpCheck{
		ID: "dhcp-aap", Severity: "medium",
		Why: "A DHCP failover pair is an HA group. Advanced Active/Passive is deprecated and doesn't support DHCPv6. Move these to Active/Active or Active/Passive.",
	}
	var items []map[string]any
	for _, r := range ha {
		h := asMap(r)
		if getStr(h["mode"]) == "advanced-active-passive" {
			items = append(items, map[string]any{"name": getStr(h["name"])})
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i]["name"].(string) < items[j]["name"].(string) })
	switch {
	case !readOK:
		c.Title = "DHCP failover pairs on the old Advanced Active/Passive setting"
		return unknown(c, false, "DHCP HA group list")
	case len(items) > 0:
		c.Title = plural(len(items), "DHCP failover pair uses the old Advanced Active/Passive setting", "DHCP failover pairs use the old Advanced Active/Passive setting")
		c.Status, c.Items = "problem", items
		if !whole {
			c.Note = "The HA group list was cut short, so there may be more."
		}
	case !whole:
		c.Title = "DHCP failover pairs on the old Advanced Active/Passive setting"
		return unknown(c, true, "DHCP HA group list")
	default:
		c.Title = "No DHCP failover pair uses the old Advanced Active/Passive setting"
		c.Status, c.Items = "passed", []map[string]any{}
	}
	return c
}

// activeSearchCheck reads result.active_search_enable from dns/global (the
// path the IQ Agent onboarding prompt names, /api/v1/dns/global, is a 404).
// Only a true or false proves anything; a failed read, or a reply without the
// field, is "couldn't tell".
func activeSearchCheck(body map[string]any, readOK bool) bpCheck {
	c := bpCheck{
		ID: "active-search", Severity: "medium", Title: "30-day Active Search",
		Why: "Infoblox's IQ Agent needs 30-day Active Search turned on to show DNS activity history.",
	}
	if !readOK {
		return unknown(c, false, "DNS settings")
	}
	on, ok := asMap(body["result"])["active_search_enable"].(bool)
	switch {
	case !ok:
		c.Status, c.Items = "unknown", []map[string]any{}
		c.Reason = "The DNS settings didn't say whether Active Search is on."
	case on:
		c.Title = "30-day Active Search is on"
		c.Status, c.Items = "passed", []map[string]any{}
	default:
		c.Title = "30-day Active Search is off"
		c.Status, c.Items = "problem", []map[string]any{}
	}
	return c
}

// --- Risky DNS records -------------------------------------------------------
//
// Infoblox already flags risky DNS records (Universal Asset Insights, "DNS
// Record Classification"). The cube NetworkInsightsDnsRecordsRolledByIndicatorIdV1
// has one row per record, and indicator_ids_str lists every flag the record
// carries, for example ['Abandoned','Untrusted']. The cube's own notes say to
// filter that field with contains, never equals, so a record with two flags is
// found by both checks. NetworkInsightsDnsRecordsV1 has no indicator_id field
// to filter on (checked against /api/cubejs/v1/meta on 2026-11-20).
//
// On the demo tenant on 2026-11-20 this read Dangling 3, Abandoned 13,
// Untrusted 40 and Stale 3,068, the same as uniqueRecordCount grouped by
// indicator_ids_str.

const dnsRecCube = "NetworkInsightsDnsRecordsRolledByIndicatorIdV1"

// dnsRecLimit is the most rows one read asks for. A read that comes back with
// this many rows may have been cut short, so its check says it couldn't tell.
var dnsRecLimit = 10000

type dnsRecFlag struct {
	flag, id, severity, why string
	found                   func(n int) string // problem title for n records
	none, unsure            string             // passed title, couldn't-tell title
}

var dnsRecFlags = []dnsRecFlag{
	{
		flag: "Dangling", id: "dns-dangling", severity: "high",
		why: "These records point at something that no longer exists, such as a deleted cloud service or domain. Someone else can claim that name and take over your subdomain.",
		found: func(n int) string {
			return plural(n, "DNS record points at something that no longer exists", "DNS records point at something that no longer exists")
		},
		none:   "No DNS records point at something that no longer exists",
		unsure: "DNS records that point at something that no longer exists",
	},
	{
		flag: "Abandoned", id: "dns-abandoned", severity: "high",
		why: "These records point at an address or name that answers nothing. Left in place they confuse people and give an attacker more to aim at.",
		found: func(n int) string {
			return plural(n, "DNS record points at something that doesn't answer", "DNS records point at something that doesn't answer")
		},
		none:   "No DNS records point at something that doesn't answer",
		unsure: "DNS records that point at something that doesn't answer",
	},
	{
		flag: "Untrusted", id: "dns-untrusted", severity: "medium",
		why: "These records point at a name or address that isn't in your Infoblox inventory, so your organisation may not control it. If that outside place is taken over, your name sends people to it.",
		found: func(n int) string {
			return plural(n, "DNS record points outside what you manage", "DNS records point outside what you manage")
		},
		none:   "No DNS records point outside what you manage",
		unsure: "DNS records that point outside what you manage",
	},
	{
		flag: "Stale", id: "dns-stale", severity: "low",
		why: "Nobody has looked these records up in 180 days. Old records clutter your zones and can be forgotten until they cause trouble. Infoblox only checks this in your own internal primary zones.",
		found: func(n int) string {
			return plural(n, "DNS record hasn't been used in 180 days", "DNS records haven't been used in 180 days")
		},
		none:   "No DNS records have gone unused for 180 days",
		unsure: "DNS records unused for 180 days",
	},
}

// cubeRowsStrict is cubeQuery for checks that must not pass on a bad read: ok
// is false on a failed request and on a reply without result.data (Cube.js
// can answer 200 with {"error":"Continue wait"}), never an empty list.
func (s *Service) cubeRowsStrict(query map[string]any) (rows []map[string]any, ok bool) {
	q, _ := json.Marshal(query)
	body, st, err := s.Rest.GetEx("/api/cubejs/v1/query", map[string]string{"query": string(q)})
	if errored(st, err) {
		return nil, false
	}
	rows = strictCubeRows(body)
	return rows, rows != nil
}

// dnsRecordChecks reads the four flags at once, one read per flag, so a long
// Stale list that runs past the row limit can't hide a Dangling record. Each
// flag goes through readDNSFlag (visibility_read.go), the reader the
// Visibility Assessment shares, which counts records with its own aggregate
// query rather than by counting sample rows.
func (s *Service) dnsRecordChecks(ctx context.Context) []bpCheck {
	out := make([]bpCheck, len(dnsRecFlags))
	tasks := make([]func(), len(dnsRecFlags))
	for i, f := range dnsRecFlags {
		tasks[i] = func() {
			out[i] = dnsRecordCheck(f, s.readDNSFlag(ctx, f.flag, dnsRecLimit))
		}
	}
	mustFanOut(tasks...)
	return out
}

func dnsRecordCheck(f dnsRecFlag, r dnsFlagRead) bpCheck {
	c := bpCheck{ID: f.id, Severity: f.severity, Why: f.why}
	// The count is the cube's own count of records; one record that points
	// two places is two sample rows, so the rows are never the count.
	if !r.Count.OK() {
		c.Title = f.unsure
		c.Status, c.Items = "unknown", []map[string]any{}
		c.Reason = "Couldn't read how many DNS records Infoblox flagged " + f.flag + ". " + r.Count.Reason
		return c
	}
	// The list is only the examples shown under the count; a list that failed
	// or came back cut short is said in the note and never changes the count.
	items := []map[string]any{}
	if r.SampleOK {
		for _, row := range r.Sample {
			items = append(items, dnsRecordItem(row))
		}
	}
	n := r.Count.N()
	if n == 0 {
		if len(items) > 0 {
			c.Title = f.unsure
			c.Status, c.Items = "unknown", []map[string]any{}
			c.Reason = "Infoblox's count and its list of flagged records disagree."
			return c
		}
		c.Title = f.none
		c.Status, c.Items = "passed", items
		return c
	}
	c.Title = f.found(n)
	c.Status, c.Items = "problem", items
	switch {
	case !r.SampleOK:
		c.Note = "Couldn't read the list of these records, so none are shown."
		c.partial = true
	case len(r.Sample) >= dnsRecLimit:
		c.Note = fmt.Sprintf("The list came back cut short, so only the first %d are shown.", len(items))
		c.partial = true
	}
	return c
}

// dnsRecordItem names a record by its full name (label plus zone, as the
// cube's notes say to build it) and puts its type, zone, where it points and
// when it was last looked up in the detail line, which is all the page shows.
func dnsRecordItem(r map[string]any) map[string]any {
	label := getStr(r["record_asset_name"])
	zone := strings.TrimSuffix(getStr(r["record_asset_absolute_zone_name"]), ".")
	name := zone
	if label != "" && label != "@" {
		name = label + "." + zone
	}
	var parts []string
	if t := getStr(r["record_asset_record_type"]); t != "" {
		parts = append(parts, t+" record in "+zone)
	} else {
		parts = append(parts, "in "+zone)
	}
	if to := getStr(r["record_asset_dns_rdata"]); to != "" {
		parts = append(parts, "points to "+to)
	}
	// Live values look like 2025-06-06T18:40:10.000; the day is enough. Blank
	// means Infoblox has no lookup on record: never looked up, or only before
	// it started keeping track (the cube's notes).
	if q, _, _ := strings.Cut(getStr(r["record_asset_last_queried_str"]), "T"); q != "" {
		parts = append(parts, "last looked up "+q)
	} else {
		parts = append(parts, "no lookup on record")
	}
	return map[string]any{"name": name, "detail": strings.Join(parts, ", ")}
}
