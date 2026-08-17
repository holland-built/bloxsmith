package provision

import (
	"fmt"
	"strings"
)

// SubnetDef is server.py's SubnetDef dataclass (1499). Cidr/DhcpStart/DhcpEnd
// are optional (nil == "not set", falls back to the config default).
type SubnetDef struct {
	Name      string
	Purpose   string
	Dhcp      string // "true"/"false" lowercased string, matching Python
	Cidr      any
	DhcpStart any
	DhcpEnd   any
}

// HostDef is server.py's HostDef dataclass (1509).
type HostDef struct {
	Hostname string
	Subnet   string
	Comment  string
}

// SiteConfig is server.py's SiteConfig dataclass (1516).
type SiteConfig struct {
	Site              string
	Region            string
	Environment       string
	Location          string
	IPSpace           string
	DNSParent         string
	DNSView           string
	Owner             string
	SubnetSize        int
	DryRun            bool
	CreateZone        bool
	CreateReverseZone bool
	IfNotExists       bool
	ExtraTags         M
	SubnetPlan        []SubnetDef
	Hosts             []HostDef
}

// DNSZone is the SiteConfig.dns_zone property (server.py:1536).
func (c *SiteConfig) DNSZone() string { return fmt.Sprintf("site-%s.%s", c.Site, c.DNSParent) }

// TemplateToSiteConfig is template_to_site_config (server.py:1540).
func TemplateToSiteConfig(template, params M) (*SiteConfig, error) {
	siteSec := getMap(template, "site")
	netSec := getMap(template, "network")
	dnsSec := getMap(template, "dns")
	tagsSec := getMap(template, "tags")
	hostsSec := getList(template, "hosts")
	subnetsSec := getList(netSec, "subnets")

	site := resolve(params["site"], siteSec["name"], "")
	region := resolve(params["region"], siteSec["region"], "")
	environment := resolve(params["environment"], siteSec["environment"], "")
	ipSpace := resolve(params["ip_space"], netSec["ip_space"], defaultIPSpace)
	dnsParent := resolve(params["dns_parent"], dnsSec["parent"], defaultDNSParent)

	var missing []string
	for _, pair := range [][2]string{{"site", site}, {"region", region},
		{"environment", environment}, {"ip_space", ipSpace}, {"dns_parent", dnsParent}} {
		if pair[1] == "" {
			missing = append(missing, pair[0])
		}
	}
	if len(missing) > 0 {
		return nil, perr("Required values missing: %s", strings.Join(missing, ", "))
	}
	site = strings.ToLower(site)

	location := resolve(params["location"], siteSec["location"], capitalize(site))
	dnsView := resolve(params["dns_view"], dnsSec["view"], "default")
	ownerYAML := tagsSec["Owner"]
	if isFalsy(ownerYAML) {
		ownerYAML = siteSec["owner"]
	}
	owner := resolve(nil, ownerYAML, "network-team")
	subnetSizeRaw := resolve(params["subnet_size"], netSec["subnet_size"], "24")
	subnetSize, ok := atoi(subnetSizeRaw)
	if !ok {
		return nil, perr("subnet_size must be an integer, got '%s'", subnetSizeRaw)
	}

	var subnetPlan []SubnetDef
	for _, s := range subnetsSec {
		sm := asMap(s)
		if sm == nil {
			continue
		}
		purpose := resolve(nil, sm["purpose"], "general")
		name := resolve(nil, sm["name"], fmt.Sprintf("%s-%s", site, resolve(nil, sm["purpose"], "net")))
		subnetPlan = append(subnetPlan, SubnetDef{
			Name: name, Purpose: purpose,
			Dhcp: strings.ToLower(pyBoolStr(sm["dhcp"])),
			Cidr: sm["cidr"], DhcpStart: sm["dhcp_start"], DhcpEnd: sm["dhcp_end"],
		})
	}
	if len(subnetPlan) == 0 {
		subnetPlan = []SubnetDef{
			{Name: site + "-mgmt", Purpose: "mgmt", Dhcp: "false"},
			{Name: site + "-lan", Purpose: "user-lan", Dhcp: "true"},
			{Name: site + "-server", Purpose: "server", Dhcp: "false"},
		}
	}

	var hostList []HostDef
	for _, h := range hostsSec {
		hm := asMap(h)
		if hm == nil || hm["hostname"] == nil {
			continue
		}
		defaultSubnet := site + "-mgmt"
		if len(subnetPlan) > 0 {
			defaultSubnet = subnetPlan[0].Name
		}
		hostList = append(hostList, HostDef{
			Hostname: pyStr(hm["hostname"]),
			Subnet:   resolve(nil, hm["subnet"], defaultSubnet),
			Comment:  pyStr(hm["comment"]),
		})
	}
	if len(hostList) == 0 {
		hostList = []HostDef{{Hostname: "gw01", Subnet: subnetPlan[0].Name,
			Comment: fmt.Sprintf("%s site gateway", capitalize(site))}}
	}

	extraTags := M{}
	for k, v := range tagsSec {
		extraTags[k] = pyStr(v)
	}

	return &SiteConfig{
		Site: site, Region: region, Environment: environment, Location: location,
		IPSpace: ipSpace, DNSParent: dnsParent, DNSView: dnsView, Owner: owner,
		SubnetSize: subnetSize, DryRun: TruthyDry(params["dry"]),
		CreateZone:        resolveBool(params["create_zone"], dnsSec["create_zone"]),
		CreateReverseZone: resolveBool(params["create_reverse_zone"], dnsSec["create_reverse_zone"]),
		IfNotExists:       resolveBool(params["if_not_exists"], false),
		ExtraTags:         extraTags, SubnetPlan: subnetPlan, Hosts: hostList,
	}, nil
}

// idUnknown is the id recorded for an object THIS RUN CREATED UPSTREAM whose
// create response carried no id.
//
// It exists because the three states below were being collapsed into one
// string, and one of them is the dangerous one:
//
//	""            a reused or pre-existing object whose row carried no id, and
//	              legacy entries. Not ours; rollback leaves it alone.
//	"(dry-run)"   a preview. NOTHING was created upstream.
//	"(exists)"    upstream answered 409: the customer already had it.
//	idUnknown     we created it, it is live, and we cannot name it.
//
// Writing "(dry-run)" for the last case told rollback — whose del() documents
// that value as "a preview placeholder" — to skip an object that really exists,
// with no residual entry, so nobody was ever told. It also put "(dry-run)" in
// the same result map as "dry_run": false, which is a false claim about a
// customer's tenant in an operator-facing summary.
//
// A parenthesised token cannot be mistaken for a CSP id: those are
// "ipam/subnet/<uuid>"-shaped paths, and del() sends the id straight into a
// DELETE path, so a marker that never leaves this package is required to be
// unmistakable rather than merely unlikely.
const idUnknown = "(unknown-id)"

// SiteProvisioner is server.py's SiteProvisioner (1633).
type SiteProvisioner struct {
	e           *Engine
	cfg         *SiteConfig
	emit        Emitter
	spaceID     string
	viewID      string
	zoneID      string
	zoneCreated bool
}

func (e *Engine) NewSiteProvisioner(cfg *SiteConfig, emit Emitter) *SiteProvisioner {
	return &SiteProvisioner{e: e, cfg: cfg, emit: emit}
}

// noteUnknownID says out loud that an object was created and cannot be named.
//
// Two channels, because they reach different people at different times. The
// emitted step is what the operator watching the run sees, in the same stream
// and the same "  Warning:" shape as every other mid-run problem in this file.
// result["unknown_ids"] is the machine-readable half, and it is what makes a
// SUCCESSFUL run report this at all: a run that succeeds never calls rollback,
// so there is no residual list to carry the fact.
//
// Called exactly once per object. For hosts that means from Provision's copy
// loop and not from provisionHosts, which has no result map — appending in both
// would list the same host twice.
func (p *SiteProvisioner) noteUnknownID(result M, kind, label string) {
	p.emit(M{"step": fmt.Sprintf("  Warning: %s %s was created upstream but the response carried no id — "+
		"it cannot be rolled back automatically or found again by id", kind, label)})
	appendTo(result, "unknown_ids", M{"kind": kind, "label": label})
}

func (p *SiteProvisioner) resolveIPSpace() error {
	space, err := cspq(p.cfg.IPSpace)
	if err != nil {
		return err
	}
	results, err := p.e.Rest.GetStrict("/api/ddi/v1/ipam/ip_space", map[string]string{"_filter": fmt.Sprintf(`name=="%s"`, space)})
	if err != nil {
		return perrWrap(err, "could not read IP space %s: %s", p.cfg.IPSpace, upstreamPublic(err))
	}
	if len(results) == 0 {
		return perr("IP space not found: %s", p.cfg.IPSpace)
	}
	p.spaceID = pyStr(asMap(results[0])["id"])
	return nil
}

func (p *SiteProvisioner) findExistingSite() ([]any, error) {
	space, err := cspq(p.spaceID)
	if err != nil {
		return nil, err
	}
	site, err := cspq(p.cfg.Site)
	if err != nil {
		return nil, err
	}
	results, err := p.e.Rest.GetStrict("/api/ddi/v1/ipam/subnet", map[string]string{
		"_filter": fmt.Sprintf(`space=="%s"`, space), "_tfilter": fmt.Sprintf(`Site=="%s"`, site)})
	if err != nil {
		return nil, perrWrap(err, "could not read existing subnets for site %s: %s", p.cfg.Site, upstreamPublic(err))
	}
	return results, nil
}

func (p *SiteProvisioner) findAvailableBlock() (M, error) {
	space, err := cspq(p.spaceID)
	if err != nil {
		return nil, err
	}
	region, err := cspq(p.cfg.Region)
	if err != nil {
		return nil, err
	}
	env, err := cspq(p.cfg.Environment)
	if err != nil {
		return nil, err
	}
	results, err := p.e.Rest.GetStrict("/api/ddi/v1/ipam/address_block", map[string]string{
		"_filter":  fmt.Sprintf(`space=="%s"`, space),
		"_tfilter": fmt.Sprintf(`Region=="%s" and Environment=="%s" and Status=="available"`, region, env)})
	if err != nil {
		return nil, perrWrap(err, "could not read address blocks for region %s environment %s: %s",
			p.cfg.Region, p.cfg.Environment, upstreamPublic(err))
	}
	if len(results) == 0 {
		// Fallback: region + available, ignoring Environment (server.py:1672).
		results, err = p.e.Rest.GetStrict("/api/ddi/v1/ipam/address_block", map[string]string{
			"_filter":  fmt.Sprintf(`space=="%s"`, space),
			"_tfilter": fmt.Sprintf(`Region=="%s" and Status=="available"`, region)})
		if err != nil {
			return nil, perrWrap(err, "could not read address blocks for region %s: %s", p.cfg.Region, upstreamPublic(err))
		}
	}
	if len(results) == 0 {
		return nil, perr("No available address block found for Region=%s Environment=%s", p.cfg.Region, p.cfg.Environment)
	}
	return minByBlockSortKey(results), nil
}

func (p *SiteProvisioner) resolveDNSView() error {
	view, err := cspq(p.cfg.DNSView)
	if err != nil {
		return err
	}
	results, err := p.e.Rest.GetStrict("/api/ddi/v1/dns/view", map[string]string{"_filter": fmt.Sprintf(`name=="%s"`, view)})
	if err != nil {
		return perrWrap(err, "could not read DNS view %s: %s", p.cfg.DNSView, upstreamPublic(err))
	}
	if len(results) == 0 {
		return perr("DNS view not found: %s", p.cfg.DNSView)
	}
	p.viewID = pyStr(asMap(results[0])["id"])
	return nil
}

// createSubnet is _create_subnet (server.py:1691). Returns the subnet dict.
func (p *SiteProvisioner) createSubnet(blockID string, sdef SubnetDef, result M) (M, error) {
	cidr := p.cfg.SubnetSize
	if sdef.Cidr != nil {
		if c, ok := intCoerce(sdef.Cidr); ok {
			cidr = c
		}
	}
	tags := M{"Site": p.cfg.Site, "Region": p.cfg.Region, "Environment": p.cfg.Environment,
		"Owner": p.cfg.Owner, "Purpose": sdef.Purpose, "DHCP": sdef.Dhcp, "Name": sdef.Name}
	for k, v := range p.cfg.ExtraTags {
		if k != "Owner" {
			tags[k] = v
		}
	}
	mode := dryPrefix(p.cfg.DryRun)
	p.emit(M{"step": fmt.Sprintf("%sCreating subnet /%d  name=%s  purpose=%s", mode, cidr, sdef.Name, sdef.Purpose)})

	if p.cfg.DryRun {
		// GetStrict so a failed preview is DETECTABLE — but it must still
		// never abort the dry run: the real creation path below uses
		// Rest.Write with its own status check, so nothing here can create a
		// false duplicate. What changes is that a failed preview is now
		// reported as "unavailable" (with an operator-safe reason) instead of
		// leaving subnetAddr blank, which used to be indistinguishable from a
		// genuine "no address available in this block" result.
		preview, err := p.e.Rest.GetStrict("/api/ddi/v1/"+blockID+"/nextavailablesubnet",
			map[string]string{"cidr": itoa(cidr), "count": "1"})
		subnetAddr := ""
		extra := M{}
		switch {
		case err != nil:
			// Case 3: the lookup failed outright — never render a blank
			// address that could pass for a real (if empty) result.
			subnetAddr = "(unavailable)"
			extra["address_preview"] = "unavailable"
			extra["reason"] = upstreamPublic(err)
		case len(preview) == 0:
			// Case 2: the lookup succeeded but found nothing — a legitimate
			// "block is full", kept distinct from a broken lookup.
			extra["address_preview"] = "none-available"
		default:
			// Case 1: unchanged behavior, unchanged fields.
			subnetAddr = pyStr(asMap(preview[0])["address"])
		}
		appendTo(result, "subnets", M{"address": fmt.Sprintf("%s/%d", subnetAddr, cidr), "name": sdef.Name, "id": "(dry-run)"})
		out := M{"dry_run": true, "address": subnetAddr, "cidr": cidr, "name": sdef.Name, "tags": tags}
		for k, v := range extra {
			out[k] = v
		}
		return out, nil
	}

	resp, status, _ := p.e.Rest.Write("POST", "/api/ddi/v1/"+blockID+"/nextavailablesubnet", nil,
		map[string]string{"cidr": itoa(cidr), "count": "1"})
	if (status != 200 && status != 201) || resp == nil {
		return nil, perr("Failed to create subnet %s: status %d %v", sdef.Name, status, resp)
	}
	subnet := firstRow(resp)
	sid := pyStr(subnet["id"])
	if pyStr(subnet["address"]) == "" || sid == "" {
		return nil, perr("No free /%d subnet available in block for %s", cidr, sdef.Name)
	}
	// Recorded the moment the subnet EXISTS upstream, before the tagging PATCH —
	// same rule as createDHCPRange and createSubnets' reverse zones, and the same
	// bug provisionHosts had. The PATCH below can fail, and when it does this
	// function returns an error saying tagging is "needed for teardown". Recording
	// afterwards meant that subnet was simultaneously untagged (teardown cannot
	// find it by tag) and unrecorded (rollback cannot find it by id) — nothing
	// could ever find it again. The values come from the create response rather
	// than the PATCH echo: `sid` is already validated non-empty here, and the
	// allocated address/cidr are what the create returned.
	scidr := cidr
	if c, ok := intCoerce(subnet["cidr"]); ok {
		scidr = c
	}
	appendTo(result, "subnets", M{"address": fmt.Sprintf("%s/%d", pyStr(subnet["address"]), scidr),
		"name": sdef.Name, "id": sid})
	patchBody := M{"name": sdef.Name,
		"comment": fmt.Sprintf("%s site - %s network", capitalize(p.cfg.Site), sdef.Purpose), "tags": tags}
	presp, pstatus, _ := p.e.Rest.Write("PATCH", "/api/ddi/v1/"+sid, patchBody, nil)
	if pstatus != 200 && pstatus != 201 {
		return nil, perr("Subnet %s created but tagging failed (needed for teardown): status %d %v", sdef.Name, pstatus, presp)
	}
	if pr := asMap(asMap(presp)["result"]); pr != nil {
		subnet = pr
	}
	p.emit(M{"step": fmt.Sprintf("  Created subnet id=%s", sid)})
	return subnet, nil
}

// createDHCPRange is create_dhcp_range (server.py:1732).
func (p *SiteProvisioner) createDHCPRange(subnet M, sdef SubnetDef, result M) error {
	startOff := 10
	if sdef.DhcpStart != nil {
		if v, ok := intCoerce(sdef.DhcpStart); ok {
			startOff = v
		}
	}
	endOff := 250
	if sdef.DhcpEnd != nil {
		if v, ok := intCoerce(sdef.DhcpEnd); ok {
			endOff = v
		}
	}
	scidr := p.cfg.SubnetSize
	if c, ok := intCoerce(subnet["cidr"]); ok {
		scidr = c
	}
	n, err := ipNet(pyStr(subnet["address"]), scidr)
	if err != nil {
		p.emit(M{"step": fmt.Sprintf("  Cannot compute DHCP range for %s: %s", sdef.Name, err.Error())})
		return nil
	}
	startIP, _ := addOffset(n, startOff)
	endIP, _ := addOffset(n, endOff)
	start, end := startIP.String(), endIP.String()
	mode := dryPrefix(p.cfg.DryRun)
	p.emit(M{"step": fmt.Sprintf("%sCreating DHCP range %s-%s  subnet=%s", mode, start, end, sdef.Name)})
	if p.cfg.DryRun {
		appendTo(result, "dhcp_ranges", M{"id": "(dry-run)", "start": start, "end": end, "name": sdef.Name + "-dhcp"})
		return nil
	}
	tags := M{"Site": p.cfg.Site, "Purpose": sdef.Purpose, "Name": sdef.Name + "-dhcp"}
	for k, v := range p.cfg.ExtraTags {
		tags[k] = v
	}
	body := M{"start": start, "end": end, "space": p.spaceID,
		"comment": fmt.Sprintf("DHCP range for %s", sdef.Name), "tags": tags}
	resp, status, _ := p.e.Rest.Write("POST", "/api/ddi/v1/ipam/range", body, nil)
	if (status != 200 && status != 201) || resp == nil {
		return perr("Failed to create DHCP range for %s: status %d %v", sdef.Name, status, resp)
	}
	rng := asMap(asMap(resp)["result"])
	rid := pyStr(rng["id"])
	if rid == "" {
		// The range exists upstream — status was 200/201 — so an empty id here is
		// "created, unnameable", not "not created". Left as "" it fell into the
		// same silent skip in rollback's del() that the zone and host cases did.
		rid = idUnknown
		p.noteUnknownID(result, "dhcp_range", start+"-"+end)
	}
	appendTo(result, "dhcp_ranges", M{"id": rid, "start": start, "end": end, "name": sdef.Name + "-dhcp"})
	return nil
}

// createDNSZone is create_dns_zone (server.py:1756).
func (p *SiteProvisioner) createDNSZone() (M, error) {
	fqdn := p.cfg.DNSZone()
	mode := dryPrefix(p.cfg.DryRun)
	p.emit(M{"step": fmt.Sprintf("%sEnsuring DNS zone exists: %s  view=%s", mode, fqdn, p.cfg.DNSView)})
	if p.cfg.DryRun {
		return M{"dry_run": true, "fqdn": fqdn, "id": "(dry-run)"}, nil
	}
	fq, err := cspq(fqdn)
	if err != nil {
		return nil, err
	}
	vw, err := cspq(p.viewID)
	if err != nil {
		return nil, err
	}
	existing, err := p.e.Rest.GetStrict("/api/ddi/v1/dns/auth_zone", map[string]string{
		"_filter": fmt.Sprintf(`fqdn=="%s." and view=="%s"`, fq, vw)})
	if err != nil {
		return nil, perrWrap(err, "could not read DNS zone %s: %s", fqdn, upstreamPublic(err))
	}
	if len(existing) > 0 {
		zone := asMap(existing[0])
		p.zoneID = pyStr(zone["id"])
		p.emit(M{"step": fmt.Sprintf("  Zone already exists: %s  id=%s — skipping creation", fqdn, p.zoneID)})
		return zone, nil
	}
	if !p.cfg.CreateZone {
		return nil, perr(`DNS zone "%s" does not exist in view "%s"; set dns.create_zone: true to create it`, fqdn, p.cfg.DNSView)
	}
	resp, status, _ := p.e.Rest.Write("POST", "/api/ddi/v1/dns/auth_zone",
		M{"fqdn": fqdn, "view": p.viewID, "primary_type": "cloud"}, nil)
	if (status != 200 && status != 201) || resp == nil {
		return nil, perr("Failed to create DNS zone %s: status %d %v", fqdn, status, resp)
	}
	zone := asMap(asMap(resp)["result"])
	if zone == nil {
		zone = M{}
	}
	p.zoneID = pyStr(zone["id"])
	p.zoneCreated = true
	p.emit(M{"step": fmt.Sprintf("  Created zone id=%s", p.zoneID)})
	return zone, nil
}

// createReverseZone is create_reverse_zone (server.py:1781).
//
// The second return value says whether THIS run created the zone, and it is the
// reverse-zone counterpart of the forward zone's p.zoneCreated flag. One bool on
// the provisioner cannot carry it: a run creates one reverse zone per subnet, so
// the fact is per-zone and travels with each zone back to createSubnets.
//
// Why it has to be tracked at all: a reverse zone is routinely SHARED. A /16 or
// /8 in-addr.arpa zone covers every subnet under it, so a second site build, or
// a retry after a partial run, finds the customer's existing zone and reuses it.
// Deleting a reused zone on rollback destroys reverse DNS for everything else
// living in it — the one rollback action that is not recoverable by re-running.
func (p *SiteProvisioner) createReverseZone(subnetAddr string, cidr int) (M, bool, error) {
	fqdn, err := CidrToReverseZone(subnetAddr, cidr)
	if err != nil {
		return nil, false, err
	}
	if cidr != 8 && cidr != 16 && cidr != 24 && cidr < 24 {
		p.emit(M{"step": fmt.Sprintf("  Warning: /%d spans multiple reverse zones; only %s will be created", cidr, fqdn)})
	}
	mode := dryPrefix(p.cfg.DryRun)
	p.emit(M{"step": fmt.Sprintf("%sEnsuring reverse DNS zone: %s  view=%s", mode, fqdn, p.cfg.DNSView)})
	if p.cfg.DryRun {
		return M{"dry_run": true, "fqdn": fqdn, "id": "(dry-run)"}, false, nil
	}
	fq, err := cspq(fqdn)
	if err != nil {
		return nil, false, err
	}
	vw, err := cspq(p.viewID)
	if err != nil {
		return nil, false, err
	}
	existing, err := p.e.Rest.GetStrict("/api/ddi/v1/dns/auth_zone", map[string]string{
		"_filter": fmt.Sprintf(`fqdn=="%s" and view=="%s"`, fq, vw)})
	if err != nil {
		return nil, false, perrWrap(err, "could not read reverse DNS zone %s: %s", fqdn, upstreamPublic(err))
	}
	if len(existing) > 0 {
		// Reused, not created — the customer's zone. created=false is what keeps
		// rollback's hands off it.
		zone := asMap(existing[0])
		p.emit(M{"step": fmt.Sprintf("  Reverse zone already exists: %s  id=%s — reusing (rollback will not delete it)",
			fqdn, pyStr(zone["id"]))})
		return zone, false, nil
	}
	resp, status, _ := p.e.Rest.Write("POST", "/api/ddi/v1/dns/auth_zone",
		M{"fqdn": fqdn, "view": p.viewID, "primary_type": "cloud"}, nil)
	if (status != 200 && status != 201) || resp == nil {
		return nil, false, perr("Failed to create reverse zone %s: status %d %v", fqdn, status, resp)
	}
	zone := asMap(asMap(resp)["result"])
	if zone == nil {
		zone = M{}
	}
	p.emit(M{"step": fmt.Sprintf("  Created reverse zone id=%s", pyStr(zone["id"]))})
	return zone, true, nil
}

// createSubnets is create_subnets (server.py:1805).
func (p *SiteProvisioner) createSubnets(block, result M) (map[string]M, error) {
	created := map[string]M{}
	blockID := pyStr(block["id"])
	for _, sdef := range p.cfg.SubnetPlan {
		subnet, err := p.createSubnet(blockID, sdef, result)
		if err != nil {
			return nil, err
		}
		if sdef.Dhcp == "true" {
			if err := p.createDHCPRange(subnet, sdef, result); err != nil {
				return nil, err
			}
		}
		if p.cfg.CreateReverseZone {
			// address_preview is set by createSubnet's dry-run branch, and ONLY
			// when it has no usable address to offer: "none-available" (the block
			// is full, address is "") or "unavailable" (the preview lookup
			// failed, address is the placeholder "(unavailable)"). Neither can be
			// turned into a reverse-zone FQDN, and neither is a reason to kill a
			// preview — createSubnet's own comment says a failed preview "must
			// still never abort the dry run", and feeding "(unavailable)" to
			// CidrToReverseZone did exactly that, killing the whole dry run over
			// one transient 500. createDHCPRange one branch up has always
			// emitted-and-continued on the same unusable address.
			//
			// The gate is the MARKER, not a parse of the address: an address that
			// is merely unparseable, with no marker on it, means upstream returned
			// something that is not an address on a lookup that SUCCEEDED. That is
			// an upstream contract violation and still aborts, in both modes.
			if prev := pyStr(subnet["address_preview"]); prev != "" {
				why := pyStr(subnet["reason"])
				if why == "" {
					why = prev
				}
				p.emit(M{"step": fmt.Sprintf("  Cannot preview the reverse zone for %s: %s", sdef.Name, why)})
			} else if pyStr(subnet["address"]) != "" {
				scidr := p.cfg.SubnetSize
				if c, ok := intCoerce(subnet["cidr"]); ok {
					scidr = c
				}
				zone, zoneCreated, err := p.createReverseZone(pyStr(subnet["address"]), scidr)
				if err != nil {
					return nil, err
				}
				id := pyStr(zone["id"])
				if id == "" && zoneCreated {
					// Gated on zoneCreated, not on the blank id alone.
					// createReverseZone's REUSE path returns the customer's
					// existing zone straight off the lookup row, so a blank id
					// there means "theirs, unnameable" — calling that idUnknown
					// would claim this run created a zone it did not, and
					// idUnknown is the one value rollback acts on. A reused
					// blank stays "", which rollback leaves alone.
					id = idUnknown
					p.noteUnknownID(result, "reverse_zone", pyStr(zone["fqdn"]))
				}
				// "created" travels with the entry because rollback works off this
				// list and nothing else. An entry without it is UNKNOWN, and
				// rollback treats unknown as "not ours".
				appendTo(result, "reverse_zones", M{"id": id, "fqdn": pyStr(zone["fqdn"]), "created": zoneCreated})
			}
		}
		created[sdef.Name] = subnet
	}
	return created, nil
}

// provisionHosts is provision_hosts (server.py:1818).
//
// On failure it returns the hosts it ALREADY created alongside the error, and
// the caller is required to record them before it bails. Every other resource
// here appends into `result` the moment it is created (createSubnet,
// createDHCPRange, createSubnets' reverse zones), so a mid-list failure still
// leaves rollback a complete list to undo. Hosts were the one kind collected
// into a local slice and handed over only on the success path, so returning nil
// here dropped hosts 1..k-1 on the floor — they exist upstream, rollback never
// saw them, and they stayed on the customer's network with no record of it.
func (p *SiteProvisioner) provisionHosts(subnets map[string]M) ([]M, error) {
	subnetOffsets := map[string]int{}
	var results []M
	for _, hdef := range p.cfg.Hosts {
		subnet, ok := subnets[hdef.Subnet]
		if !ok {
			p.emit(M{"step": fmt.Sprintf(`Host %s references unknown subnet "%s" — skipping`, hdef.Hostname, hdef.Subnet)})
			continue
		}
		baseAddr := pyStr(subnet["address"])
		cidr := p.cfg.SubnetSize
		if c, ok := intCoerce(subnet["cidr"]); ok {
			cidr = c
		}
		offset := subnetOffsets[hdef.Subnet]
		if offset == 0 {
			offset = 1
		}
		subnetOffsets[hdef.Subnet] = offset + 1
		n, err := ipNet(baseAddr, cidr)
		if err != nil {
			p.emit(M{"step": fmt.Sprintf("Cannot compute IP for host %s: %s — skipping", hdef.Hostname, err.Error())})
			continue
		}
		hostAddr, ok := addOffset(n, offset)
		if !ok {
			p.emit(M{"step": fmt.Sprintf("Cannot compute IP for host %s — skipping", hdef.Hostname)})
			continue
		}
		if !ipInNet(hostAddr, n) {
			p.emit(M{"step": fmt.Sprintf("Host %s offset %d falls outside subnet %s — skipping", hdef.Hostname, offset, cidrStr(n))})
			continue
		}
		hostIP := hostAddr.String()
		fqdn := fmt.Sprintf("%s.%s", hdef.Hostname, p.cfg.DNSZone())
		mode := dryPrefix(p.cfg.DryRun)
		p.emit(M{"step": fmt.Sprintf("%sProvisioning host: %s -> %s  (subnet=%s)", mode, fqdn, hostIP, hdef.Subnet)})
		if p.cfg.DryRun {
			results = append(results, M{"dry_run": true, "fqdn": fqdn, "ip": hostIP, "hostname": hdef.Hostname, "id": "(dry-run)"})
			continue
		}
		comment := hdef.Comment
		if comment == "" {
			comment = fmt.Sprintf("%s - %s", capitalize(p.cfg.Site), hdef.Hostname)
		}
		body := M{
			"name": fqdn, "comment": comment,
			"addresses":             []any{M{"address": hostIP, "space": p.spaceID}},
			"auto_generate_records": true,
			"host_names":            []any{M{"name": hdef.Hostname, "zone": p.zoneID, "primary_name": true}},
		}
		resp, status, _ := p.e.Rest.Write("POST", "/api/ddi/v1/ipam/host", body, nil)
		if status == 409 {
			p.emit(M{"step": fmt.Sprintf("  Host %s already exists — skipping", fqdn)})
			results = append(results, M{"fqdn": fqdn, "ip": hostIP, "hostname": hdef.Hostname, "id": "(exists)"})
			continue
		}
		if (status != 200 && status != 201) || resp == nil {
			// `results`, not nil: the hosts before this one are real objects on
			// the customer's network. Dropping them here is what stranded them.
			return results, perr("Failed to create host %s: status %d %v", hdef.Hostname, status, resp)
		}
		host := asMap(asMap(resp)["result"])
		if host == nil {
			host = M{}
		}
		p.emit(M{"step": fmt.Sprintf("  Created host id=%s", pyStr(host["id"]))})
		hid := pyStr(host["id"])
		if hid == "" {
			// Upstream answered 200/201, so this host is on the customer's
			// network. "(dry-run)" said the opposite and rollback believed it.
			// The matching noteUnknownID call is in Provision's copy loop, the
			// one place here that holds the result map — see noteUnknownID for
			// why it must not be called from both.
			hid = idUnknown
		}
		results = append(results, M{"fqdn": fqdn, "ip": hostIP, "hostname": hdef.Hostname, "id": hid})
	}
	return results, nil
}

// rollback is SiteProvisioner._rollback (server.py:1866): reverse-order compensating
// deletes, tolerating failed deletes into a residual list.
//
// It returns a report of what it did — {outcome, attempted, deleted, residual} —
// because a residual list alone cannot tell "8 objects were deleted successfully"
// apart from "nothing was ever created": both produce an empty list. Cardinality
// is not a status, so the outcome word is explicit and is always present.
//
// It still writes partial["rollback_residual"] as before; that write is the
// in-place side effect existing callers and tests read.
//
// A residual row has TWO shapes now, and they are told apart by `status`:
//
//	status >= 400  a DELETE was sent and upstream refused it. `id` names the
//	               object, and a retry is a sensible next step.
//	status == 0    no DELETE was sent, because there is no id to send one to —
//	               the object was created and the response carried no id (see
//	               idUnknown). `id` is "", `label` is all there is to go on, and
//	               `reason` says so in words. Only a human can clear this one.
func (p *SiteProvisioner) rollback(partial M) M {
	p.emit(M{"step": "Rolling back partial site provisioning…"})
	residual := []any{}
	attempted, deleted := 0, 0

	del := func(objID, kind, label string) {
		// idUnknown is not an id either, but it is the one non-id that must NOT
		// be skipped in silence: the object is LIVE on the customer's network and
		// this run put it there. There is nothing to DELETE, so the honest action
		// is to report it. Without this it left no trace anywhere — no delete, no
		// residual entry, and an "outcome":"complete" over the top of it.
		if objID == idUnknown {
			p.emit(M{"step": fmt.Sprintf("  Rollback: cannot delete %s %s — it was created but the "+
				"response carried no id. It is still there; remove it by hand.", kind, label)})
			residual = append(residual, M{"kind": kind, "id": "", "label": label, "status": 0,
				"reason": "created upstream but the create response carried no id, so rollback could not delete it"})
			return
		}
		// None of these three are ids. "" is a REUSED or legacy entry whose row
		// carried no id, "(dry-run)" is a preview placeholder, and "(exists)" is
		// what provisionHosts records when upstream answered 409 — a host the
		// customer ALREADY had, which this run did not create. Sending any of
		// them upstream produces a DELETE on a nonsense path like
		// /api/ddi/v1/(exists) that is certain to fail, and the failure then
		// appends a residual entry telling the operator a real object could not
		// be deleted. That entry is fabricated: the object was never ours.
		if objID == "" || objID == "(dry-run)" || objID == "(exists)" {
			return
		}
		attempted++
		_, status, _ := p.e.Rest.Write("DELETE", "/api/ddi/v1/"+objID, nil, nil)
		if !(status >= 200 && status < 300) {
			p.emit(M{"step": fmt.Sprintf("  Rollback: failed to delete %s id=%s (status=%d)", kind, objID, status)})
			residual = append(residual, M{"kind": kind, "id": objID, "label": label, "status": status})
			return
		}
		deleted++
	}

	hosts := getList(partial, "hosts")
	for i := len(hosts) - 1; i >= 0; i-- {
		h := asMap(hosts[i])
		label := pyStr(h["fqdn"])
		if label == "" {
			label = pyStr(h["ip"])
		}
		del(pyStr(h["id"]), "host", label)
	}
	if p.zoneCreated {
		zid := pyStr(partial["dns_zone_id"])
		if zid != "" && zid != "(dry-run)" {
			del(zid, "dns_zone", pyStr(partial["dns_zone_fqdn"]))
		}
	}
	// Reverse zones, newest first — but ONLY the ones this run created. The
	// forward zone is gated on p.zoneCreated for exactly this reason; a reverse
	// run makes one zone per subnet, so the flag lives per entry instead of once
	// on the provisioner. An entry with no "created" marker is UNKNOWN and is
	// left alone: a stray zone is recoverable by deleting it later, a deleted
	// live zone shared across a /16 is not.
	rz := getList(partial, "reverse_zones")
	for i := len(rz) - 1; i >= 0; i-- {
		z := asMap(rz[i])
		zid := pyStr(z["id"])
		if !truthy(z["created"], false) {
			if zid != "" && zid != "(dry-run)" {
				p.emit(M{"step": fmt.Sprintf("  Rollback: keeping reverse zone %s id=%s — this run did not create it",
					pyStr(z["fqdn"]), zid)})
			}
			continue
		}
		del(zid, "reverse_zone", pyStr(z["fqdn"]))
	}
	ranges := getList(partial, "dhcp_ranges")
	for i := len(ranges) - 1; i >= 0; i-- {
		rm := asMap(ranges[i])
		// The label was "" until an unnameable range could reach the residual
		// list. A residual row that names neither an id nor an address is not
		// something an operator can act on, and start-end is what createDHCPRange
		// records on every entry in both modes.
		del(pyStr(rm["id"]), "dhcp_range", pyStr(rm["start"])+"-"+pyStr(rm["end"]))
	}
	subnets := getList(partial, "subnets")
	for i := len(subnets) - 1; i >= 0; i-- {
		s := asMap(subnets[i])
		// The label is s["address"] alone: createSubnet records it already
		// carrying the prefix ("10.10.1.0/24"), and these entries have no
		// "cidr" key at all. Appending pyStr(s["cidr"]) rendered every subnet
		// as "10.10.1.0/24/" — harmless while the residual was unreachable,
		// but it is now read by an operator and written into the signed audit
		// log, where it cannot be corrected later.
		del(pyStr(s["id"]), "subnet", pyStr(s["address"]))
	}

	partial["rollback_residual"] = residual
	if len(residual) > 0 {
		p.emit(M{"step": fmt.Sprintf("  Rollback incomplete: %d object(s) could not be deleted", len(residual))})
	}

	// "not_needed" is the honest word for a rollback that ran and found nothing
	// to undo (the run failed before creating anything). The old design wrote an
	// empty residual list for that case, indistinguishable from a rollback that
	// deleted everything successfully — and wrote it into an append-only, signed
	// audit log that can never be amended.
	// A non-empty residual is checked FIRST and outranks the counters.
	//
	// An undeletable object bumps neither `attempted` nor `deleted` — no DELETE
	// was sent for it — so the counters cannot tell "deleted everything I
	// attempted" apart from "deleted everything I attempted AND left something I
	// could not attempt". MEASURED: with this case removed,
	// TestSiteRollback_UnnameableForwardZoneBecomesResidual reports
	// `outcome: "complete"` over a residual row naming a zone that is still up.
	// `not_needed` is the other word the counters can produce here, when nothing
	// else was recorded at all. Both are success words, and this goes into an
	// append-only signed log that cannot be amended later.
	outcome := "not_needed"
	switch {
	case len(residual) > 0:
		outcome = "incomplete"
	case attempted == 0:
		outcome = "not_needed"
	case deleted == attempted:
		outcome = "complete"
	default:
		outcome = "incomplete"
	}
	return M{"outcome": outcome, "attempted": attempted, "deleted": deleted, "residual": residual}
}

// Provision is SiteProvisioner.provision (server.py:1894).
//
// On success it returns the full result map and a nil error, unchanged.
//
// On success the map's `unknown_ids` list is the only place an orphan can be
// reported, because a successful run never calls rollback and so has no residual
// list. It names every object this run created upstream and cannot identify —
// {kind, label} — and each one was also emitted as a "  Warning:" step while the
// run was on screen. It is always present, empty meaning "everything created has
// an id". The successful-site audit entry records {template, site} and has never
// carried the result map; this change does not alter that.
//
// On FAILURE it returns (M{"rollback": report}, err) — both non-nil, and the map
// carries the rollback report and NOTHING else. The internal `result` map is
// deliberately not exported on this path: after rollback it is a mixed bag, not a
// description of live state. `block_id` names a PRE-EXISTING block rollback never
// deletes; a reused forward or reverse zone and any "(exists)" host are live and
// were never ours; the subnets, ranges and hosts this run created are tombstones
// that rollback has just deleted. Returning it would state things that are not
// true, and the next caller would render deleted objects as live ones.
//
// The report is always present on the failure path — {outcome, attempted,
// deleted, residual} — so no meaning is ever carried by a missing key. A record
// with no "rollback" key is a legacy entry, which is honest and permanently
// distinguishable. On a dry-run failure the outcome is "skipped_dry_run":
// rollback deliberately does not run, because a preview created nothing.
func (p *SiteProvisioner) Provision() (M, error) {
	// unknown_ids is initialised here alongside every other list so its ABSENCE
	// never has to be interpreted. An empty list is "every object this run created
	// can be named"; a missing key would be a legacy record, and the two must not
	// look the same.
	result := M{"block_id": "", "block_address": "", "subnets": []any{}, "dhcp_ranges": []any{},
		"dns_zone_id": "", "dns_zone_fqdn": "", "reverse_zones": []any{}, "hosts": []any{},
		"unknown_ids": []any{},
		"dry_run":     p.cfg.DryRun, "skipped": false, "skip_reason": ""}

	runErr := func() error {
		if err := p.resolveIPSpace(); err != nil {
			return err
		}
		existing, err := p.findExistingSite()
		if err != nil {
			return err
		}
		if len(existing) > 0 {
			first := asMap(existing[0])
			msg := fmt.Sprintf("Site '%s' is already provisioned (%d subnet(s), e.g. %s/%s)",
				p.cfg.Site, len(existing), pyStr(first["address"]), pyStr(first["cidr"]))
			if p.cfg.IfNotExists {
				p.emit(M{"step": msg + " — skipping (if_not_exists)"})
				result["skipped"] = true
				result["skip_reason"] = "already provisioned"
			} else {
				return perr("%s — pass if_not_exists to skip", msg)
			}
			return nil
		}
		block, err := p.findAvailableBlock()
		if err != nil {
			return err
		}
		result["block_id"] = pyStr(block["id"])
		result["block_address"] = fmt.Sprintf("%s/%s", pyStr(block["address"]), pyStr(block["cidr"]))
		if err := p.resolveDNSView(); err != nil {
			return err
		}
		subnets, err := p.createSubnets(block, result)
		if err != nil {
			return err
		}
		zone, err := p.createDNSZone()
		if err != nil {
			return err
		}
		zid := pyStr(zone["id"])
		if zid == "" {
			zid = idUnknown
			p.noteUnknownID(result, "dns_zone", p.cfg.DNSZone())
		}
		result["dns_zone_id"] = zid
		zfqdn := pyStr(zone["fqdn"])
		if zfqdn == "" {
			zfqdn = p.cfg.DNSZone()
		}
		result["dns_zone_fqdn"] = zfqdn
		// Recorded FIRST — id AND fqdn — then refused. A response with no `result`
		// object carries no fqdn either, and rollback labels its residual row from
		// result["dns_zone_fqdn"], so refusing before this assignment produced a
		// residual row naming neither an id nor a zone: an operator told to go and
		// delete something by hand, and not told what.
		//
		// p.zoneID is "" in this case and
		// provisionHosts binds every host's host_names[].zone to it, so carrying on
		// writes hosts against an empty zone reference — a wrong write, not a
		// missing one. Stopping is only safe because result already names the zone,
		// so rollback below can report the one object it cannot delete. This is the
		// only unknown id that aborts the run: a host or a reverse zone with no id
		// is a bookkeeping gap, and tearing down a working site to compensate for
		// it would destroy live infrastructure to tidy a record.
		if zid == idUnknown {
			return perr("DNS zone %s was created but the response carried no id; "+
				"every host would be bound to an empty zone reference, so nothing further was created",
				p.cfg.DNSZone())
		}
		hosts, err := p.provisionHosts(subnets)
		// Recorded BEFORE the error check, deliberately. provisionHosts returns
		// what it managed to create even when it fails, and rollback deletes
		// nothing it cannot find in result["hosts"] — so returning early here is
		// what left already-created hosts alive upstream after a mid-list
		// failure.
		//
		// This loop is also the single place hosts with an unknown id are NOTED:
		// provisionHosts has no result map, and appending in both would list the
		// same host twice. Only the marker travels out of provisionHosts.
		outHosts := []any{}
		for _, h := range hosts {
			hid := pyStr(h["id"])
			if hid == "" {
				// Defence in depth. provisionHosts leaves no host entry with an
				// empty id — every branch writes a real id, "(exists)", "(dry-run)"
				// or idUnknown — so this is unreachable today; if it ever fires,
				// falling back to idUnknown is the direction that gets reported.
				hid = idUnknown
			}
			if hid == idUnknown {
				p.noteUnknownID(result, "host", pyStr(h["fqdn"]))
			}
			outHosts = append(outHosts, M{"fqdn": pyStr(h["fqdn"]), "ip": pyStr(h["ip"]),
				"hostname": pyStr(h["hostname"]), "id": hid})
		}
		result["hosts"] = outHosts
		if err != nil {
			return err
		}
		return nil
	}()

	if runErr != nil {
		report := M{"outcome": "skipped_dry_run", "attempted": 0, "deleted": 0, "residual": []any{}}
		if !p.cfg.DryRun {
			p.emit(M{"step": fmt.Sprintf("Provisioning failed (%s) — initiating rollback", runErr.Error())})
			report = p.rollback(result)
		}
		return M{"rollback": report}, runErr
	}
	return result, nil
}

// --- string/number helpers matching Python str/int semantics -----------------

// capitalize is Python str.capitalize(): first char upper, rest lower.
func capitalize(s string) string {
	if s == "" {
		return ""
	}
	return strings.ToUpper(s[:1]) + strings.ToLower(s[1:])
}

// pyBoolStr renders a dhcp field the way Python `str(s.get("dhcp", False))` does
// before .lower(): a real bool -> "True"/"False", a string passes through.
func pyBoolStr(v any) string {
	if v == nil {
		return "False"
	}
	return pyStr(v)
}

// atoi is Python int(str) for the subnet_size resolution (rejects non-ints).
func atoi(s string) (int, bool) {
	return intCoerce(strings.TrimSpace(s))
}

// firstRow extracts the first row from a nextavailablesubnet POST response:
// resp["results"] or [resp["result"]] or {}.
func firstRow(resp any) M {
	m := asMap(resp)
	if m == nil {
		return M{}
	}
	if rows := asList(m["results"]); len(rows) > 0 {
		if r := asMap(rows[0]); r != nil {
			return r
		}
		return M{}
	}
	if !isFalsy(m["result"]) {
		if r := asMap(m["result"]); r != nil {
			return r
		}
	}
	return M{}
}

// minByBlockSortKey is min(results, key=_block_sort_key) (server.py:1682).
func minByBlockSortKey(results []any) M {
	best := asMap(results[0])
	bestKey := blockSortKey(best)
	for _, r := range results[1:] {
		rm := asMap(r)
		k := blockSortKey(rm)
		if less(k, bestKey) {
			best, bestKey = rm, k
		}
	}
	return best
}

type sortKey struct {
	addr []byte
	cidr int
}

func blockSortKey(b M) sortKey {
	c, _ := intCoerce(b["cidr"])
	return sortKey{addr: ipKey(pyStr(b["address"])), cidr: c}
}

func less(a, b sortKey) bool {
	for i := range a.addr {
		if a.addr[i] != b.addr[i] {
			return a.addr[i] < b.addr[i]
		}
	}
	return a.cidr < b.cidr
}
