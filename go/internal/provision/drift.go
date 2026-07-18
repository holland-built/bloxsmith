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
	spaceResults := e.Rest.Get("/api/ddi/v1/ipam/ip_space", map[string]string{"_filter": fmt.Sprintf(`name=="%s"`, space)})
	if len(spaceResults) == 0 {
		return nil, perr("IP space not found: %s", ipSpace)
	}
	spaceID := pyStr(asMap(spaceResults[0])["id"])
	view, err := cspq(dnsView)
	if err != nil {
		return nil, err
	}
	viewResults := e.Rest.Get("/api/ddi/v1/dns/view", map[string]string{"_filter": fmt.Sprintf(`name=="%s"`, view)})
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
	subnetsRaw := e.Rest.Get("/api/ddi/v1/ipam/subnet", map[string]string{
		"_filter": fmt.Sprintf(`space=="%s"`, spaceQ), "_tfilter": fmt.Sprintf(`Site=="%s"`, siteQ)})
	found := len(subnetsRaw) > 0
	var allHosts []any
	if found {
		allHosts = e.Rest.Get("/api/ddi/v1/ipam/host", map[string]string{"_limit": "1000"})
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
	zoneResults := e.Rest.Get("/api/ddi/v1/dns/auth_zone", map[string]string{
		"_filter": fmt.Sprintf(`fqdn=="%s." and view=="%s"`, dz, vq)})
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
	liveTags := M{}
	if len(liveSubnets) > 0 {
		liveTags = getMap(asMap(liveSubnets[0]), "tags")
	}

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
	for _, key := range tagKeys {
		expectedVal := pyStr(tagsTmpl[key])
		if liveTags[key] == nil {
			drift("tags", "warning", "tags."+key, fmt.Sprintf("Tag '%s' missing from subnet tags (expected '%s')", key, expectedVal))
		} else if pyStr(liveTags[key]) != expectedVal {
			drift("tags", "warning", "tags."+key,
				fmt.Sprintf("Tag '%s': expected '%s', live value is '%s'", key, expectedVal, pyStr(liveTags[key])))
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
