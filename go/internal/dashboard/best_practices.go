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
		Why: "A host that's down serves nothing, and its zones and subnets lean on the others.",
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
		c.Title = "On-prem hosts offline or in error"
		return unknown(c, false, "host list")
	case len(items) > 0:
		c.Title = plural(len(items), "on-prem host is offline or in error", "on-prem hosts are offline or in error")
		c.Status, c.Items = "problem", items
		if !whole {
			c.Note = "The host list was cut short, so there may be more."
		}
	case !whole:
		c.Title = "On-prem hosts offline or in error"
		return unknown(c, true, "host list")
	default:
		c.Title = "Every on-prem host is online"
		c.Status, c.Items = "passed", []map[string]any{}
	}
	return c
}

func gmResilienceCheck(hosts []any, readOK, whole bool) bpCheck {
	c := bpCheck{
		ID: "gm-resilience", Severity: "high", Link: "#infra",
		Why: "Without an HA Grid Master or a Grid Master Candidate, losing the Grid Master leaves the grid unmanaged until it's rebuilt from backup.",
	}
	if !readOK || !whole {
		c.Title = "Grid Masters with no HA and no candidate"
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
		c.Title = plural(len(items), "Grid Master has no HA and no candidate", "Grid Masters have no HA and no candidate")
		c.Status, c.Items = "problem", items
	case cantTell > 0:
		c.Title = "Grid Masters with no HA and no candidate"
		c.Status, c.Items, c.Reason = "unknown", []map[string]any{}, c.Note
		c.Note = ""
	case len(grids) == 0:
		c.Title = "No NIOS grids are connected to this account"
		c.Status, c.Items = "passed", []map[string]any{}
	default:
		c.Title = fmt.Sprintf("Every Grid Master has HA or a candidate (%s)", plural(len(grids), "grid", "grids"))
		c.Status, c.Items = "passed", []map[string]any{}
	}
	return c
}

func dhcpAAPCheck(ha []any, readOK, whole bool) bpCheck {
	c := bpCheck{
		ID: "dhcp-aap", Severity: "medium",
		Why: "Advanced Active/Passive is deprecated and doesn't support DHCPv6. Move these to Active/Active or Active/Passive.",
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
		c.Title = "DHCP HA groups in Advanced Active/Passive mode"
		return unknown(c, false, "DHCP HA group list")
	case len(items) > 0:
		c.Title = plural(len(items), "DHCP HA group uses the deprecated Advanced Active/Passive mode", "DHCP HA groups use the deprecated Advanced Active/Passive mode")
		c.Status, c.Items = "problem", items
		if !whole {
			c.Note = "The HA group list was cut short, so there may be more."
		}
	case !whole:
		c.Title = "DHCP HA groups in Advanced Active/Passive mode"
		return unknown(c, true, "DHCP HA group list")
	default:
		c.Title = "No DHCP HA group uses Advanced Active/Passive"
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
