package provision

import (
	"fmt"
	"net"
	"sort"
	"strings"
)

// QuerySiteLive is query_site_live (server.py:2278): a read-only live-state
// snapshot shaped for DetectDrift. Never writes. site/ipSpace/dnsView/dnsZone
// come from a SiteConfig (or DecommissionConfig) — both expose the same fields.
func (e *Engine) QuerySiteLive(site, ipSpace, dnsView, dnsZone string) (M, error) {
	space, err := cspq(ipSpace)
	if err != nil {
		return nil, err
	}
	spaceResults, err := e.Rest.GetStrict("/api/ddi/v1/ipam/ip_space", map[string]string{"_filter": fmt.Sprintf(`name=="%s"`, space)})
	if err != nil {
		return nil, perrWrap(err, "reading IP space %q: %s", ipSpace, upstreamPublic(err))
	}
	if len(spaceResults) == 0 {
		return nil, perr("IP space not found: %s", ipSpace)
	}
	spaceID := pyStr(asMap(spaceResults[0])["id"])
	view, err := cspq(dnsView)
	if err != nil {
		return nil, err
	}
	viewResults, err := e.Rest.GetStrict("/api/ddi/v1/dns/view", map[string]string{"_filter": fmt.Sprintf(`name=="%s"`, view)})
	if err != nil {
		return nil, perrWrap(err, "reading DNS view %q: %s", dnsView, upstreamPublic(err))
	}
	if len(viewResults) == 0 {
		return nil, perr("DNS view not found: %s", dnsView)
	}
	viewID := pyStr(asMap(viewResults[0])["id"])

	spaceQ, err := cspq(spaceID)
	if err != nil {
		return nil, err
	}
	siteQ, err := cspq(site)
	if err != nil {
		return nil, err
	}
	subnetsRaw, err := e.Rest.GetStrict("/api/ddi/v1/ipam/subnet", map[string]string{
		"_filter": fmt.Sprintf(`space=="%s"`, spaceQ), "_tfilter": fmt.Sprintf(`Site=="%s"`, siteQ)})
	if err != nil {
		return nil, perrWrap(err, "reading subnets for site %q: %s", site, upstreamPublic(err))
	}
	found := len(subnetsRaw) > 0
	var allHosts []any
	if found {
		// Paged, and refusing rather than truncating — same read as the teardown
		// uses (readAllHosts, hosts.go). A truncated page here does not just
		// under-report: it makes DetectDrift say "Expected host 'gw01' not found"
		// about a host that is present, which sends an operator to re-create
		// something that already exists.
		allHosts, err = e.readAllHosts()
		if err != nil {
			if IsError(err) {
				return nil, err
			}
			return nil, perrWrap(err, "reading hosts: %s", upstreamPublic(err))
		}
	}

	subnetsOut := []any{}
	for _, s := range subnetsRaw {
		subnet := asMap(s)
		var n *net.IPNet
		if cidr, ok := intCoerce(subnet["cidr"]); ok && subnet["address"] != nil {
			if nn, err := ipNet(pyStr(subnet["address"]), cidr); err == nil {
				n = nn
			}
		}
		hostsOut := []any{}
		if n != nil {
			for _, h := range allHosts {
				host := asMap(h)
				for _, ae := range getList(host, "addresses") {
					ip := net.ParseIP(pyStr(asMap(ae)["address"]))
					if ip == nil {
						continue
					}
					if n.Contains(ip) {
						hostsOut = append(hostsOut, M{"name": pyStr(host["name"])})
						break
					}
				}
			}
		}
		stags := getMap(subnet, "tags")
		name := pyStr(subnet["name"])
		if name == "" {
			name = pyStr(stags["Name"])
		}
		subnetsOut = append(subnetsOut, M{
			"id": pyStr(subnet["id"]), "address": pyStr(subnet["address"]), "cidr": subnet["cidr"],
			"name": name, "tags": stags, "hosts": hostsOut})
	}

	dz, err := cspq(dnsZone)
	if err != nil {
		return nil, err
	}
	vq, err := cspq(viewID)
	if err != nil {
		return nil, err
	}
	zoneResults, err := e.Rest.GetStrict("/api/ddi/v1/dns/auth_zone", map[string]string{
		"_filter": fmt.Sprintf(`fqdn=="%s." and view=="%s"`, dz, vq)})
	if err != nil {
		return nil, perrWrap(err, "reading DNS zone %q: %s", dnsZone, upstreamPublic(err))
	}
	zone := M{}
	if len(zoneResults) > 0 {
		zone = asMap(zoneResults[0])
	}
	zfqdn := pyStr(zone["fqdn"])
	if zfqdn == "" {
		zfqdn = dnsZone
	}
	return M{"site": site, "found": found, "subnets": subnetsOut,
		"dns_zone_found": len(zone) > 0, "dns_zone_fqdn": zfqdn}, nil
}

// DetectDrift is detect_drift (server.py:2330): a pure comparison of a template's
// expected state against a live query. No API calls.
func DetectDrift(template, live M, siteName string) M {
	drifts := []any{}
	drift := func(category, severity, field, message string) {
		drifts = append(drifts, M{"category": category, "severity": severity, "field": field, "message": message})
	}
	resolvedSite := siteName
	if resolvedSite == "" {
		resolvedSite = pyStr(live["site"])
	}

	liveSubnets := getList(live, "subnets")
	if len(liveSubnets) == 0 && !truthy(live["found"], false) {
		drift("site", "error", "site", "Site is not provisioned — no subnets found")
		return M{"site": resolvedSite, "found": false, "drifted": true, "subnet_count": 0,
			"drifts": drifts, "summary": M{"total": 1, "errors": 1, "warnings": 0}}
	}

	net := getMap(template, "network")
	dns := getMap(template, "dns")
	tagsTmpl := getMap(template, "tags")
	labelled := labelSubnets(liveSubnets)

	expectedSubnetNames := stringSet()
	for _, s := range getList(net, "subnets") {
		if nm := strings.TrimSpace(pyStr(asMap(s)["name"])); nm != "" {
			expectedSubnetNames[nm] = true
		}
	}
	liveSubnetNames := stringSet()
	for _, s := range liveSubnets {
		if nm := strings.TrimSpace(pyStr(asMap(s)["name"])); nm != "" {
			liveSubnetNames[nm] = true
		}
	}
	for _, name := range sortedDiff(expectedSubnetNames, liveSubnetNames) {
		drift("subnet", "error", fmt.Sprintf("network.subnets[%s]", name), fmt.Sprintf("Expected subnet '%s' not found in API", name))
	}
	for _, name := range sortedDiff(liveSubnetNames, expectedSubnetNames) {
		drift("subnet", "warning", "subnet:"+name, fmt.Sprintf("Subnet '%s' exists in API but is not in the template", name))
	}

	wantsZone := !isFalsy(dns["create_zone"])
	zoneFound := truthy(live["dns_zone_found"], false)
	if wantsZone && !zoneFound {
		drift("dns", "error", "dns.create_zone", "Template specifies create_zone: true but no DNS zone was found")
	} else if !wantsZone && zoneFound {
		drift("dns", "warning", "dns.create_zone",
			fmt.Sprintf("DNS zone '%s' exists in API but template does not specify create_zone: true", pyStr(live["dns_zone_fqdn"])))
	}

	tagKeys := make([]string, 0, len(tagsTmpl))
	for k := range tagsTmpl {
		tagKeys = append(tagKeys, k)
	}
	sort.Strings(tagKeys)
	// EVERY live subnet, not just the first one. Tags used to be read off
	// liveSubnets[0] while names and hosts above were compared as sets, so a
	// site whose second subnet had lost a tag reported "in sync" or "drifted"
	// depending only on which row the API listed first — the same estate, two
	// opposite verdicts. Tags are what teardown SELECTS subnets by, so the
	// clean answer was the damaging one.
	for _, ls := range labelled {
		liveTags := getMap(ls.row, "tags")
		for _, key := range tagKeys {
			expectedVal := pyStr(tagsTmpl[key])
			if liveTags[key] == nil {
				drift("tags", "warning", "subnet:"+ls.label+".tags."+key,
					fmt.Sprintf("Tag '%s' missing from subnet '%s' tags (expected '%s')", key, ls.label, expectedVal))
			} else if pyStr(liveTags[key]) != expectedVal {
				drift("tags", "warning", "subnet:"+ls.label+".tags."+key,
					fmt.Sprintf("Tag '%s' on subnet '%s': expected '%s', live value is '%s'",
						key, ls.label, expectedVal, pyStr(liveTags[key])))
			}
		}
	}

	expectedHosts := stringSet()
	for _, h := range getList(template, "hosts") {
		if hn := strings.TrimSpace(pyStr(asMap(h)["hostname"])); hn != "" {
			expectedHosts[hn] = true
		}
	}
	liveHosts := stringSet()
	for _, s := range liveSubnets {
		for _, h := range getList(asMap(s), "hosts") {
			hm := asMap(h)
			raw := pyStr(hm["name"])
			if raw == "" {
				raw = pyStr(hm["id"])
			}
			base := strings.TrimSpace(strings.SplitN(raw, ".", 2)[0])
			if base != "" {
				liveHosts[base] = true
			}
		}
	}
	for _, hostname := range sortedDiff(expectedHosts, liveHosts) {
		drift("hosts", "warning", fmt.Sprintf("hosts[%s]", hostname), fmt.Sprintf("Expected host '%s' not found in any subnet", hostname))
	}
	for _, hostname := range sortedDiff(liveHosts, expectedHosts) {
		drift("hosts", "info", "host:"+hostname, fmt.Sprintf("Host '%s' exists in API but is not in the template", hostname))
	}

	errors, warnings := 0, 0
	for _, d := range drifts {
		switch pyStr(asMap(d)["severity"]) {
		case "error":
			errors++
		case "warning", "info":
			warnings++
		}
	}
	return M{"site": resolvedSite, "found": true, "drifted": len(drifts) > 0, "subnet_count": len(liveSubnets),
		"drifts": drifts, "summary": M{"total": len(drifts), "errors": errors, "warnings": warnings}}
}

// labelledSubnet pairs a live subnet row with the name the drift report calls
// it by.
type labelledSubnet struct {
	label string
	row   M
}

// rawSubnetLabel names a live subnet from its OWN content, never from where it
// sat in the list. An index would have been the obvious fallback and is the one
// thing that cannot be used here: the whole defect being fixed is a report that
// changes with row order, so a label derived from row order would carry it
// straight back in.
func rawSubnetLabel(m M) string {
	if s := strings.TrimSpace(pyStr(m["name"])); s != "" {
		return s
	}
	if s := strings.TrimSpace(pyStr(m["id"])); s != "" {
		return s
	}
	addr := strings.TrimSpace(pyStr(m["address"]))
	cidr := strings.TrimSpace(pyStr(m["cidr"]))
	if addr != "" && cidr != "" {
		return addr + "/" + cidr
	}
	if addr != "" {
		return addr
	}
	return "(unnamed)"
}

// subnetSortKey is what orders the report. It has to separate rows that a
// reader can tell apart, so it carries the identifying fields AND the tags
// being compared: two subnets both called "data" with different tags are
// different findings, and leaving them on an equal key would let their two
// drift rows swap places with the upstream row order.
//
// Rows whose key is identical are identical in everything this function reads,
// so they produce the same drift rows in either order and their relative
// position genuinely does not matter.
func subnetSortKey(m M) string {
	tags := getMap(m, "tags")
	keys := make([]string, 0, len(tags))
	for k := range tags {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(rawSubnetLabel(m))
	b.WriteByte(0)
	b.WriteString(pyStr(m["id"]))
	b.WriteByte(0)
	b.WriteString(pyStr(m["address"]) + "/" + pyStr(m["cidr"]))
	for _, k := range keys {
		b.WriteByte(0)
		b.WriteString(k + "=" + pyStr(tags[k]))
	}
	return b.String()
}

// labelSubnets orders the live subnets deterministically and gives each one a
// label that is unique whenever the data allows it: a repeated label gains its
// row's id, so two subnets sharing a name do not produce two rows a reader
// cannot tell apart. When there is no id either, the rows are indistinguishable
// in the source data and identical output is the honest result.
func labelSubnets(rows []any) []labelledSubnet {
	out := make([]labelledSubnet, 0, len(rows))
	counts := map[string]int{}
	for _, r := range rows {
		m := asMap(r)
		counts[rawSubnetLabel(m)]++
		out = append(out, labelledSubnet{row: m})
	}
	for i := range out {
		label := rawSubnetLabel(out[i].row)
		if counts[label] > 1 {
			if id := strings.TrimSpace(pyStr(out[i].row["id"])); id != "" {
				label += " (" + id + ")"
			}
		}
		out[i].label = label
	}
	sort.SliceStable(out, func(i, j int) bool {
		return subnetSortKey(out[i].row) < subnetSortKey(out[j].row)
	})
	return out
}

func stringSet() map[string]bool { return map[string]bool{} }

// sortedDiff returns sorted(a - b).
func sortedDiff(a, b map[string]bool) []string {
	var out []string
	for k := range a {
		if !b[k] {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}
