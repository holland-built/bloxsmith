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
		SubnetSize: subnetSize, DryRun: truthyDry(params["dry"]),
		CreateZone:        resolveBool(params["create_zone"], dnsSec["create_zone"]),
		CreateReverseZone: resolveBool(params["create_reverse_zone"], dnsSec["create_reverse_zone"]),
		IfNotExists:       resolveBool(params["if_not_exists"], false),
		ExtraTags:         extraTags, SubnetPlan: subnetPlan, Hosts: hostList,
	}, nil
}

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

func (p *SiteProvisioner) resolveIPSpace() error {
	space, err := cspq(p.cfg.IPSpace)
	if err != nil {
		return err
	}
	results := p.e.Rest.Get("/api/ddi/v1/ipam/ip_space", map[string]string{"_filter": fmt.Sprintf(`name=="%s"`, space)})
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
	return p.e.Rest.Get("/api/ddi/v1/ipam/subnet", map[string]string{
		"_filter": fmt.Sprintf(`space=="%s"`, space), "_tfilter": fmt.Sprintf(`Site=="%s"`, site)}), nil
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
	results := p.e.Rest.Get("/api/ddi/v1/ipam/address_block", map[string]string{
		"_filter":  fmt.Sprintf(`space=="%s"`, space),
		"_tfilter": fmt.Sprintf(`Region=="%s" and Environment=="%s" and Status=="available"`, region, env)})
	if len(results) == 0 {
		// Fallback: region + available, ignoring Environment (server.py:1672).
		results = p.e.Rest.Get("/api/ddi/v1/ipam/address_block", map[string]string{
			"_filter":  fmt.Sprintf(`space=="%s"`, space),
			"_tfilter": fmt.Sprintf(`Region=="%s" and Status=="available"`, region)})
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
	results := p.e.Rest.Get("/api/ddi/v1/dns/view", map[string]string{"_filter": fmt.Sprintf(`name=="%s"`, view)})
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
		preview := p.e.Rest.Get("/api/ddi/v1/"+blockID+"/nextavailablesubnet",
			map[string]string{"cidr": itoa(cidr), "count": "1"})
		subnetAddr := ""
		if len(preview) > 0 {
			subnetAddr = pyStr(asMap(preview[0])["address"])
		}
		appendTo(result, "subnets", M{"address": fmt.Sprintf("%s/%d", subnetAddr, cidr), "name": sdef.Name, "id": "(dry-run)"})
		return M{"dry_run": true, "address": subnetAddr, "cidr": cidr, "name": sdef.Name, "tags": tags}, nil
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
	scidr := cidr
	if c, ok := intCoerce(subnet["cidr"]); ok {
		scidr = c
	}
	appendTo(result, "subnets", M{"address": fmt.Sprintf("%s/%d", pyStr(subnet["address"]), scidr),
		"name": sdef.Name, "id": pyStr(subnet["id"])})
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
	appendTo(result, "dhcp_ranges", M{"id": pyStr(rng["id"]), "start": start, "end": end, "name": sdef.Name + "-dhcp"})
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
	existing := p.e.Rest.Get("/api/ddi/v1/dns/auth_zone", map[string]string{
		"_filter": fmt.Sprintf(`fqdn=="%s." and view=="%s"`, fq, vw)})
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
func (p *SiteProvisioner) createReverseZone(subnetAddr string, cidr int) (M, error) {
	fqdn, err := CidrToReverseZone(subnetAddr, cidr)
	if err != nil {
		return nil, err
	}
	if cidr != 8 && cidr != 16 && cidr != 24 && cidr < 24 {
		p.emit(M{"step": fmt.Sprintf("  Warning: /%d spans multiple reverse zones; only %s will be created", cidr, fqdn)})
	}
	mode := dryPrefix(p.cfg.DryRun)
	p.emit(M{"step": fmt.Sprintf("%sEnsuring reverse DNS zone: %s  view=%s", mode, fqdn, p.cfg.DNSView)})
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
	existing := p.e.Rest.Get("/api/ddi/v1/dns/auth_zone", map[string]string{
		"_filter": fmt.Sprintf(`fqdn=="%s" and view=="%s"`, fq, vw)})
	if len(existing) > 0 {
		zone := asMap(existing[0])
		p.emit(M{"step": fmt.Sprintf("  Reverse zone already exists: %s  id=%s", fqdn, pyStr(zone["id"]))})
		return zone, nil
	}
	resp, status, _ := p.e.Rest.Write("POST", "/api/ddi/v1/dns/auth_zone",
		M{"fqdn": fqdn, "view": p.viewID, "primary_type": "cloud"}, nil)
	if (status != 200 && status != 201) || resp == nil {
		return nil, perr("Failed to create reverse zone %s: status %d %v", fqdn, status, resp)
	}
	zone := asMap(asMap(resp)["result"])
	if zone == nil {
		zone = M{}
	}
	p.emit(M{"step": fmt.Sprintf("  Created reverse zone id=%s", pyStr(zone["id"]))})
	return zone, nil
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
		if p.cfg.CreateReverseZone && pyStr(subnet["address"]) != "" {
			scidr := p.cfg.SubnetSize
			if c, ok := intCoerce(subnet["cidr"]); ok {
				scidr = c
			}
			zone, err := p.createReverseZone(pyStr(subnet["address"]), scidr)
			if err != nil {
				return nil, err
			}
			id := pyStr(zone["id"])
			if id == "" {
				id = "(dry-run)"
			}
			appendTo(result, "reverse_zones", M{"id": id, "fqdn": pyStr(zone["fqdn"])})
		}
		created[sdef.Name] = subnet
	}
	return created, nil
}

// provisionHosts is provision_hosts (server.py:1818).
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
			return nil, perr("Failed to create host %s: status %d %v", hdef.Hostname, status, resp)
		}
		host := asMap(asMap(resp)["result"])
		if host == nil {
			host = M{}
		}
		p.emit(M{"step": fmt.Sprintf("  Created host id=%s", pyStr(host["id"]))})
		hid := pyStr(host["id"])
		if hid == "" {
			hid = "(dry-run)"
		}
		results = append(results, M{"fqdn": fqdn, "ip": hostIP, "hostname": hdef.Hostname, "id": hid})
	}
	return results, nil
}

// rollback is SiteProvisioner._rollback (server.py:1866): reverse-order compensating
// deletes, tolerating failed deletes into a residual list.
func (p *SiteProvisioner) rollback(partial M) {
	p.emit(M{"step": "Rolling back partial site provisioning…"})
	residual := []any{}

	del := func(objID, kind, label string) {
		if objID == "" || objID == "(dry-run)" {
			return
		}
		_, status, _ := p.e.Rest.Write("DELETE", "/api/ddi/v1/"+objID, nil, nil)
		if !(status >= 200 && status < 300) {
			p.emit(M{"step": fmt.Sprintf("  Rollback: failed to delete %s id=%s (status=%d)", kind, objID, status)})
			residual = append(residual, M{"kind": kind, "id": objID, "label": label, "status": status})
		}
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
	rz := getList(partial, "reverse_zones")
	for i := len(rz) - 1; i >= 0; i-- {
		z := asMap(rz[i])
		del(pyStr(z["id"]), "reverse_zone", pyStr(z["fqdn"]))
	}
	ranges := getList(partial, "dhcp_ranges")
	for i := len(ranges) - 1; i >= 0; i-- {
		del(pyStr(asMap(ranges[i])["id"]), "dhcp_range", "")
	}
	subnets := getList(partial, "subnets")
	for i := len(subnets) - 1; i >= 0; i-- {
		s := asMap(subnets[i])
		del(pyStr(s["id"]), "subnet", fmt.Sprintf("%s/%s", pyStr(s["address"]), pyStr(s["cidr"])))
	}

	partial["rollback_residual"] = residual
	if len(residual) > 0 {
		p.emit(M{"step": fmt.Sprintf("  Rollback incomplete: %d object(s) could not be deleted", len(residual))})
	}
}

// Provision is SiteProvisioner.provision (server.py:1894).
func (p *SiteProvisioner) Provision() (M, error) {
	result := M{"block_id": "", "block_address": "", "subnets": []any{}, "dhcp_ranges": []any{},
		"dns_zone_id": "", "dns_zone_fqdn": "", "reverse_zones": []any{}, "hosts": []any{},
		"dry_run": p.cfg.DryRun, "skipped": false, "skip_reason": ""}

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
			zid = "(dry-run)"
		}
		result["dns_zone_id"] = zid
		zfqdn := pyStr(zone["fqdn"])
		if zfqdn == "" {
			zfqdn = p.cfg.DNSZone()
		}
		result["dns_zone_fqdn"] = zfqdn
		hosts, err := p.provisionHosts(subnets)
		if err != nil {
			return err
		}
		outHosts := []any{}
		for _, h := range hosts {
			hid := pyStr(h["id"])
			if hid == "" {
				hid = "(dry-run)"
			}
			outHosts = append(outHosts, M{"fqdn": pyStr(h["fqdn"]), "ip": pyStr(h["ip"]),
				"hostname": pyStr(h["hostname"]), "id": hid})
		}
		result["hosts"] = outHosts
		return nil
	}()

	if runErr != nil {
		if !p.cfg.DryRun {
			p.emit(M{"step": fmt.Sprintf("Provisioning failed (%s) — initiating rollback", runErr.Error())})
			p.rollback(result)
		}
		return nil, runErr
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
