package provision

import (
	"fmt"
	"strings"
)

// DecommissionConfig is server.py's DecommissionConfig dataclass (1975).
type DecommissionConfig struct {
	Site      string
	IPSpace   string
	DNSParent string
	DNSView   string
	KeepZone  bool
	DryRun    bool
}

// DNSZone mirrors the DecommissionConfig.dns_zone property (server.py:1988) —
// identical derivation to SiteConfig so teardown finds what provisioning made.
func (c *DecommissionConfig) DNSZone() string { return fmt.Sprintf("site-%s.%s", c.Site, c.DNSParent) }

// TemplateToDecommissionConfig is template_to_decommission_config (server.py:1992).
func TemplateToDecommissionConfig(template, params M) (*DecommissionConfig, error) {
	siteSec := getMap(template, "site")
	netSec := getMap(template, "network")
	dnsSec := getMap(template, "dns")

	site := resolve(params["site"], siteSec["name"], "")
	if site == "" {
		return nil, perr("site is required")
	}
	site = strings.ToLower(site)
	return &DecommissionConfig{
		Site:      site,
		IPSpace:   resolve(params["ip_space"], netSec["ip_space"], defaultIPSpace),
		DNSParent: resolve(params["dns_parent"], dnsSec["parent"], defaultDNSParent),
		DNSView:   resolve(params["dns_view"], dnsSec["view"], "default"),
		KeepZone:  truthy(params["keep_zone"], false),
		DryRun:    truthyDry(params["dry"]),
	}, nil
}

// SiteDecommissioner is server.py's SiteDecommissioner (2111). FAIL-FORWARD: no
// rollback — every step is a delete; a mid-sequence error propagates and stops.
// Ordering is LOAD-BEARING (see server.py:2123 docstring); do not reorder.
type SiteDecommissioner struct {
	e       *Engine
	cfg     *DecommissionConfig
	emit    Emitter
	spaceID string
	viewID  string
}

func (e *Engine) NewSiteDecommissioner(cfg *DecommissionConfig, emit Emitter) *SiteDecommissioner {
	return &SiteDecommissioner{e: e, cfg: cfg, emit: emit}
}

func (d *SiteDecommissioner) resolveIPSpace() error {
	space, err := cspq(d.cfg.IPSpace)
	if err != nil {
		return err
	}
	results := d.e.Rest.Get("/api/ddi/v1/ipam/ip_space", map[string]string{"_filter": fmt.Sprintf(`name=="%s"`, space)})
	if len(results) == 0 {
		return perr("IP space not found: %s", d.cfg.IPSpace)
	}
	d.spaceID = pyStr(asMap(results[0])["id"])
	return nil
}

func (d *SiteDecommissioner) resolveDNSView() error {
	view, err := cspq(d.cfg.DNSView)
	if err != nil {
		return err
	}
	results := d.e.Rest.Get("/api/ddi/v1/dns/view", map[string]string{"_filter": fmt.Sprintf(`name=="%s"`, view)})
	if len(results) == 0 {
		return perr("DNS view not found: %s", d.cfg.DNSView)
	}
	d.viewID = pyStr(asMap(results[0])["id"])
	return nil
}

func (d *SiteDecommissioner) findSubnets() ([]any, error) {
	space, err := cspq(d.spaceID)
	if err != nil {
		return nil, err
	}
	site, err := cspq(d.cfg.Site)
	if err != nil {
		return nil, err
	}
	return d.e.Rest.Get("/api/ddi/v1/ipam/subnet", map[string]string{
		"_filter": fmt.Sprintf(`space=="%s"`, space), "_tfilter": fmt.Sprintf(`Site=="%s"`, site)}), nil
}

func (d *SiteDecommissioner) deleteDNSZone() (bool, error) {
	fqdn := d.cfg.DNSZone()
	if d.cfg.KeepZone {
		d.emit(M{"step": fmt.Sprintf("keep_zone set — skipping forward zone: %s", fqdn)})
		return false, nil
	}
	mode := dryPrefix(d.cfg.DryRun)
	d.emit(M{"step": fmt.Sprintf("%sLooking up forward DNS zone: %s  view=%s", mode, fqdn, d.cfg.DNSView)})
	fq, err := cspq(fqdn)
	if err != nil {
		return false, err
	}
	vw, err := cspq(d.viewID)
	if err != nil {
		return false, err
	}
	existing := d.e.Rest.Get("/api/ddi/v1/dns/auth_zone", map[string]string{
		"_filter": fmt.Sprintf(`fqdn=="%s." and view=="%s"`, fq, vw)})
	if len(existing) == 0 {
		d.emit(M{"step": fmt.Sprintf("  Zone not found — nothing to delete: %s", fqdn)})
		return false, nil
	}
	zoneID := pyStr(asMap(existing[0])["id"])
	d.emit(M{"step": fmt.Sprintf("%sDeleting forward DNS zone: %s  id=%s", mode, fqdn, zoneID)})
	if !d.cfg.DryRun {
		_, status, _ := d.e.Rest.Write("DELETE", "/api/ddi/v1/"+zoneID, nil, nil)
		if !(status >= 200 && status < 300) {
			return false, perr("Failed to delete DNS zone %s: status %d", fqdn, status)
		}
	}
	return true, nil
}

func (d *SiteDecommissioner) deleteDHCPRanges() ([]any, error) {
	space, err := cspq(d.spaceID)
	if err != nil {
		return nil, err
	}
	site, err := cspq(d.cfg.Site)
	if err != nil {
		return nil, err
	}
	ranges := d.e.Rest.Get("/api/ddi/v1/ipam/range", map[string]string{
		"_filter": fmt.Sprintf(`space=="%s"`, space), "_tfilter": fmt.Sprintf(`Site=="%s"`, site)})
	deleted := []any{}
	mode := dryPrefix(d.cfg.DryRun)
	for _, r := range ranges {
		rm := asMap(r)
		rangeID := pyStr(rm["id"])
		d.emit(M{"step": fmt.Sprintf("%sDeleting DHCP range %s-%s  id=%s", mode, pyStr(rm["start"]), pyStr(rm["end"]), rangeID)})
		if !d.cfg.DryRun {
			_, status, _ := d.e.Rest.Write("DELETE", "/api/ddi/v1/"+rangeID, nil, nil)
			if !(status >= 200 && status < 300) {
				return nil, perr("Failed to delete DHCP range %s: status %d", rangeID, status)
			}
		}
		deleted = append(deleted, M{"id": rangeID, "start": pyStr(rm["start"]), "end": pyStr(rm["end"])})
	}
	return deleted, nil
}

func (d *SiteDecommissioner) deleteReverseZones(subnets []any) ([]any, error) {
	deleted := []any{}
	mode := dryPrefix(d.cfg.DryRun)
	for _, s := range subnets {
		sm := asMap(s)
		cidr, ok := intCoerce(sm["cidr"])
		if !ok || sm["address"] == nil {
			continue
		}
		fqdn, err := CidrToReverseZone(pyStr(sm["address"]), cidr)
		if err != nil {
			continue
		}
		fq, err := cspq(fqdn)
		if err != nil {
			return nil, err
		}
		vw, err := cspq(d.viewID)
		if err != nil {
			return nil, err
		}
		existing := d.e.Rest.Get("/api/ddi/v1/dns/auth_zone", map[string]string{
			"_filter": fmt.Sprintf(`fqdn=="%s" and view=="%s"`, fq, vw)})
		if len(existing) == 0 {
			continue
		}
		zoneID := pyStr(asMap(existing[0])["id"])
		d.emit(M{"step": fmt.Sprintf("%sDeleting reverse DNS zone: %s  id=%s", mode, fqdn, zoneID)})
		if !d.cfg.DryRun {
			_, status, _ := d.e.Rest.Write("DELETE", "/api/ddi/v1/"+zoneID, nil, nil)
			if !(status >= 200 && status < 300) {
				return nil, perr("Failed to delete reverse zone %s: status %d", fqdn, status)
			}
		}
		deleted = append(deleted, M{"id": zoneID, "fqdn": fqdn})
	}
	return deleted, nil
}

func (d *SiteDecommissioner) deleteSubnets(subnets []any) ([]any, error) {
	deleted := []any{}
	mode := dryPrefix(d.cfg.DryRun)
	for _, s := range subnets {
		sm := asMap(s)
		subnetID := pyStr(sm["id"])
		addr := fmt.Sprintf("%s/%s", pyStr(sm["address"]), pyStr(sm["cidr"]))
		d.emit(M{"step": fmt.Sprintf("%sDeleting subnet: %s  name=%s  id=%s", mode, addr, pyStr(sm["name"]), subnetID)})
		if !d.cfg.DryRun {
			_, status, _ := d.e.Rest.Write("DELETE", "/api/ddi/v1/"+subnetID, nil, nil)
			if !(status >= 200 && status < 300) {
				return nil, perr("Failed to delete subnet %s: status %d", addr, status)
			}
		}
		deleted = append(deleted, M{"address": addr, "name": pyStr(sm["name"]), "id": subnetID})
	}
	return deleted, nil
}

// deleteHosts is delete_hosts (server.py:2232): hosts LAST, matched by FQDN
// suffix (a DHCP-bound host address is "in use" until its subnet is deleted).
func (d *SiteDecommissioner) deleteHosts() ([]any, error) {
	suffix := "." + d.cfg.DNSZone()
	allHosts := d.e.Rest.Get("/api/ddi/v1/ipam/host", map[string]string{"_limit": "1000"})
	deleted := []any{}
	mode := dryPrefix(d.cfg.DryRun)
	for _, h := range allHosts {
		hm := asMap(h)
		if !strings.HasSuffix(pyStr(hm["name"]), suffix) {
			continue
		}
		hostID := pyStr(hm["id"])
		fqdn := pyStr(hm["name"])
		if fqdn == "" {
			fqdn = hostID
		}
		d.emit(M{"step": fmt.Sprintf("%sDeleting host: %s  id=%s", mode, fqdn, hostID)})
		if !d.cfg.DryRun {
			_, status, _ := d.e.Rest.Write("DELETE", "/api/ddi/v1/"+hostID, nil, nil)
			if !(status >= 200 && status < 300) {
				return nil, perr("Failed to delete host %s: status %d", fqdn, status)
			}
		}
		deleted = append(deleted, M{"fqdn": fqdn, "id": hostID})
	}
	return deleted, nil
}

// Decommission is SiteDecommissioner.decommission (server.py:2252).
func (d *SiteDecommissioner) Decommission() (M, error) {
	result := M{"site": d.cfg.Site, "ip_space": d.cfg.IPSpace, "dry_run": d.cfg.DryRun,
		"dns_zone_fqdn": d.cfg.DNSZone(), "dns_zone_deleted": false,
		"dhcp_ranges_deleted": []any{}, "reverse_zones_deleted": []any{},
		"subnets_deleted": []any{}, "hosts_deleted": []any{}}

	if err := d.resolveIPSpace(); err != nil {
		return nil, err
	}
	if err := d.resolveDNSView(); err != nil {
		return nil, err
	}
	subnets, err := d.findSubnets()
	if err != nil {
		return nil, err
	}
	if len(subnets) == 0 {
		d.emit(M{"step": fmt.Sprintf("No subnets tagged Site=%s found — will still check zone/hosts", d.cfg.Site)})
	}
	zoneDeleted, err := d.deleteDNSZone()
	if err != nil {
		return nil, err
	}
	result["dns_zone_deleted"] = zoneDeleted
	if result["dhcp_ranges_deleted"], err = d.deleteDHCPRanges(); err != nil {
		return nil, err
	}
	if result["reverse_zones_deleted"], err = d.deleteReverseZones(subnets); err != nil {
		return nil, err
	}
	if result["subnets_deleted"], err = d.deleteSubnets(subnets); err != nil {
		return nil, err
	}
	if result["hosts_deleted"], err = d.deleteHosts(); err != nil {
		return nil, err
	}
	return result, nil
}
