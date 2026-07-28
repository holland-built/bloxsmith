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
		DryRun:    TruthyDry(params["dry"]),
	}, nil
}

// upstreamPublic (helpers.go) extracts the user-safe sentence from a
// GetStrict failure — reused here rather than duplicated.

// SiteDecommissioner is server.py's SiteDecommissioner (2111). FAIL-FORWARD: no
// rollback — every step is a delete; a mid-sequence error propagates and stops.
// Ordering is LOAD-BEARING (see server.py:2123 docstring); do not reorder.
//
// Decommission runs in two phases: PLAN gathers every read needed to decide
// what to delete (space, view, subnets, forward zone, ranges, reverse zones,
// hosts) before any delete executes, so a failed read can never leave the site
// half torn down. EXECUTE then deletes purely from that plan, in the same
// order Python uses. If a delete itself fails after earlier deletes already
// ran, emitIncomplete tells the operator what is already gone before the
// error propagates — see Decommission below.
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

// --- PLAN phase: reads only, no deletes -------------------------------------

func (d *SiteDecommissioner) resolveIPSpace() error {
	space, err := cspq(d.cfg.IPSpace)
	if err != nil {
		return err
	}
	results, err := d.e.Rest.GetStrict("/api/ddi/v1/ipam/ip_space", map[string]string{"_filter": fmt.Sprintf(`name=="%s"`, space)})
	if err != nil {
		return perrWrap(err, "failed to read IP space %q: %s", d.cfg.IPSpace, upstreamPublic(err))
	}
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
	results, err := d.e.Rest.GetStrict("/api/ddi/v1/dns/view", map[string]string{"_filter": fmt.Sprintf(`name=="%s"`, view)})
	if err != nil {
		return perrWrap(err, "failed to read DNS view %q: %s", d.cfg.DNSView, upstreamPublic(err))
	}
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
	subnets, err := d.e.Rest.GetStrict("/api/ddi/v1/ipam/subnet", map[string]string{
		"_filter": fmt.Sprintf(`space=="%s"`, space), "_tfilter": fmt.Sprintf(`Site=="%s"`, site)})
	if err != nil {
		return nil, perrWrap(err, "failed to read subnets for site %s: %s", d.cfg.Site, upstreamPublic(err))
	}
	return subnets, nil
}

// planDNSZone is the read half of the forward-zone step: look up whether it
// exists. zoneID == "" means either keep_zone is set or no matching zone
// exists — both legitimate "nothing to delete" outcomes, never an error.
func (d *SiteDecommissioner) planDNSZone() (fqdn string, zoneID string, err error) {
	fqdn = d.cfg.DNSZone()
	if d.cfg.KeepZone {
		d.emit(M{"step": fmt.Sprintf("keep_zone set — skipping forward zone: %s", fqdn)})
		return fqdn, "", nil
	}
	d.emit(M{"step": fmt.Sprintf("%sLooking up forward DNS zone: %s  view=%s", dryPrefix(d.cfg.DryRun), fqdn, d.cfg.DNSView)})
	fq, err := cspq(fqdn)
	if err != nil {
		return fqdn, "", err
	}
	vw, err := cspq(d.viewID)
	if err != nil {
		return fqdn, "", err
	}
	existing, err := d.e.Rest.GetStrict("/api/ddi/v1/dns/auth_zone", map[string]string{
		"_filter": fmt.Sprintf(`fqdn=="%s." and view=="%s"`, fq, vw)})
	if err != nil {
		return fqdn, "", perrWrap(err, "failed to read forward DNS zone %s: %s", fqdn, upstreamPublic(err))
	}
	if len(existing) == 0 {
		d.emit(M{"step": fmt.Sprintf("  Zone not found — nothing to delete: %s", fqdn)})
		return fqdn, "", nil
	}
	return fqdn, pyStr(asMap(existing[0])["id"]), nil
}

// planRanges is the read half of the DHCP-range step.
func (d *SiteDecommissioner) planRanges() ([]any, error) {
	space, err := cspq(d.spaceID)
	if err != nil {
		return nil, err
	}
	site, err := cspq(d.cfg.Site)
	if err != nil {
		return nil, err
	}
	ranges, err := d.e.Rest.GetStrict("/api/ddi/v1/ipam/range", map[string]string{
		"_filter": fmt.Sprintf(`space=="%s"`, space), "_tfilter": fmt.Sprintf(`Site=="%s"`, site)})
	if err != nil {
		return nil, perrWrap(err, "failed to read DHCP ranges for site %s: %s", d.cfg.Site, upstreamPublic(err))
	}
	return ranges, nil
}

// reverseZonePlan is one subnet's resolved reverse zone, once confirmed to
// exist — only entries with a non-empty zoneID reach the execute phase.
type reverseZonePlan struct {
	fqdn   string
	zoneID string
}

// planReverseZones is the read half of the reverse-zone step: for each
// subnet, look up whether its reverse zone exists. Depends on subnets, which
// is itself a read (findSubnets), so this still runs entirely within the
// PLAN phase — it does not depend on any delete.
func (d *SiteDecommissioner) planReverseZones(subnets []any) ([]reverseZonePlan, error) {
	var planned []reverseZonePlan
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
		existing, err := d.e.Rest.GetStrict("/api/ddi/v1/dns/auth_zone", map[string]string{
			"_filter": fmt.Sprintf(`fqdn=="%s" and view=="%s"`, fq, vw)})
		if err != nil {
			return nil, perrWrap(err, "failed to read reverse DNS zone %s: %s", fqdn, upstreamPublic(err))
		}
		if len(existing) == 0 {
			continue
		}
		planned = append(planned, reverseZonePlan{fqdn: fqdn, zoneID: pyStr(asMap(existing[0])["id"])})
	}
	return planned, nil
}

// planHosts is the read half of the host step: read every host (bounded to
// 1000, matching Python) and filter locally to the ones this site owns. The
// filter is pure computation over an already-fetched list, not a delete, so
// it belongs in the PLAN phase.
func (d *SiteDecommissioner) planHosts() ([]any, error) {
	allHosts, err := d.e.Rest.GetStrict("/api/ddi/v1/ipam/host", map[string]string{"_limit": "1000"})
	if err != nil {
		return nil, perrWrap(err, "failed to read hosts: %s", upstreamPublic(err))
	}
	suffix := "." + d.cfg.DNSZone()
	matched := []any{}
	for _, h := range allHosts {
		if strings.HasSuffix(pyStr(asMap(h)["name"]), suffix) {
			matched = append(matched, h)
		}
	}
	return matched, nil
}

// --- EXECUTE phase: deletes only, driven entirely by the plan above --------

// execDeleteDNSZone deletes the forward zone found by planDNSZone. zoneID==""
// covers both keep_zone and not-found — nothing to do, matching the original
// deleteDNSZone's false-return branches.
func (d *SiteDecommissioner) execDeleteDNSZone(fqdn, zoneID string) (bool, error) {
	if zoneID == "" {
		return false, nil
	}
	mode := dryPrefix(d.cfg.DryRun)
	d.emit(M{"step": fmt.Sprintf("%sDeleting forward DNS zone: %s  id=%s", mode, fqdn, zoneID)})
	if !d.cfg.DryRun {
		_, status, _ := d.e.Rest.Write("DELETE", "/api/ddi/v1/"+zoneID, nil, nil)
		if !(status >= 200 && status < 300) {
			return false, perr("Failed to delete DNS zone %s: status %d", fqdn, status)
		}
	}
	return true, nil
}

// execDeleteRanges returns the ranges deleted so far even on error, so a mid-
// loop failure can still be reported accurately by emitIncomplete.
func (d *SiteDecommissioner) execDeleteRanges(ranges []any) ([]any, error) {
	deleted := []any{}
	mode := dryPrefix(d.cfg.DryRun)
	for _, r := range ranges {
		rm := asMap(r)
		rangeID := pyStr(rm["id"])
		d.emit(M{"step": fmt.Sprintf("%sDeleting DHCP range %s-%s  id=%s", mode, pyStr(rm["start"]), pyStr(rm["end"]), rangeID)})
		if !d.cfg.DryRun {
			_, status, _ := d.e.Rest.Write("DELETE", "/api/ddi/v1/"+rangeID, nil, nil)
			if !(status >= 200 && status < 300) {
				return deleted, perr("Failed to delete DHCP range %s: status %d", rangeID, status)
			}
		}
		deleted = append(deleted, M{"id": rangeID, "start": pyStr(rm["start"]), "end": pyStr(rm["end"])})
	}
	return deleted, nil
}

// execDeleteReverseZones returns the zones deleted so far even on error.
func (d *SiteDecommissioner) execDeleteReverseZones(planned []reverseZonePlan) ([]any, error) {
	deleted := []any{}
	mode := dryPrefix(d.cfg.DryRun)
	for _, p := range planned {
		d.emit(M{"step": fmt.Sprintf("%sDeleting reverse DNS zone: %s  id=%s", mode, p.fqdn, p.zoneID)})
		if !d.cfg.DryRun {
			_, status, _ := d.e.Rest.Write("DELETE", "/api/ddi/v1/"+p.zoneID, nil, nil)
			if !(status >= 200 && status < 300) {
				return deleted, perr("Failed to delete reverse zone %s: status %d", p.fqdn, status)
			}
		}
		deleted = append(deleted, M{"id": p.zoneID, "fqdn": p.fqdn})
	}
	return deleted, nil
}

// execDeleteSubnets returns the subnets deleted so far even on error.
func (d *SiteDecommissioner) execDeleteSubnets(subnets []any) ([]any, error) {
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
				return deleted, perr("Failed to delete subnet %s: status %d", addr, status)
			}
		}
		deleted = append(deleted, M{"address": addr, "name": pyStr(sm["name"]), "id": subnetID})
	}
	return deleted, nil
}

// execDeleteHosts is delete_hosts (server.py:2232), execute half: hosts LAST,
// already matched by planHosts (a DHCP-bound host address is "in use" until
// its subnet is deleted). Returns the hosts deleted so far even on error.
func (d *SiteDecommissioner) execDeleteHosts(hosts []any) ([]any, error) {
	deleted := []any{}
	mode := dryPrefix(d.cfg.DryRun)
	for _, h := range hosts {
		hm := asMap(h)
		hostID := pyStr(hm["id"])
		fqdn := pyStr(hm["name"])
		if fqdn == "" {
			fqdn = hostID
		}
		d.emit(M{"step": fmt.Sprintf("%sDeleting host: %s  id=%s", mode, fqdn, hostID)})
		if !d.cfg.DryRun {
			_, status, _ := d.e.Rest.Write("DELETE", "/api/ddi/v1/"+hostID, nil, nil)
			if !(status >= 200 && status < 300) {
				return deleted, perr("Failed to delete host %s: status %d", fqdn, status)
			}
		}
		deleted = append(deleted, M{"fqdn": fqdn, "id": hostID})
	}
	return deleted, nil
}

// emitIncomplete tells the operator what already happened before an abort.
// Deletions are irreversible (no rollback — see the SiteDecommissioner doc
// comment); if one step fails, everything earlier steps already deleted
// stays deleted, so the operator must be told which resources are already
// gone rather than being left thinking the site is untouched. Follows the
// same M{...} shape every other d.emit call in this file uses — no parallel
// event channel.
func (d *SiteDecommissioner) emitIncomplete(result M, failedStep string, err error) {
	d.emit(M{
		"operation":   "decommission",
		"site":        d.cfg.Site,
		"incomplete":  true,
		"failed_step": failedStep,
		"error":       err.Error(),
		"deleted": M{
			"dns_zone_deleted":      result["dns_zone_deleted"],
			"dhcp_ranges_deleted":   result["dhcp_ranges_deleted"],
			"reverse_zones_deleted": result["reverse_zones_deleted"],
			"subnets_deleted":       result["subnets_deleted"],
			"hosts_deleted":         result["hosts_deleted"],
		},
	})
}

// Decommission is SiteDecommissioner.decommission (server.py:2252).
func (d *SiteDecommissioner) Decommission() (M, error) {
	result := M{"site": d.cfg.Site, "ip_space": d.cfg.IPSpace, "dry_run": d.cfg.DryRun,
		"dns_zone_fqdn": d.cfg.DNSZone(), "dns_zone_deleted": false,
		"dhcp_ranges_deleted": []any{}, "reverse_zones_deleted": []any{},
		"subnets_deleted": []any{}, "hosts_deleted": []any{}}

	// --- PLAN: every read needed to decide what to delete happens before any
	// delete runs. All seven reads (space, view, subnets, forward zone,
	// ranges, reverse zones, hosts) depend only on cfg/spaceID/viewID/subnets
	// — none depend on a delete result — so all of them hoist here with
	// nothing left behind in EXECUTE.
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
	zoneFQDN, zoneID, err := d.planDNSZone()
	if err != nil {
		return nil, err
	}
	ranges, err := d.planRanges()
	if err != nil {
		return nil, err
	}
	reverseZones, err := d.planReverseZones(subnets)
	if err != nil {
		return nil, err
	}
	hosts, err := d.planHosts()
	if err != nil {
		return nil, err
	}

	// --- EXECUTE: deletions run only from the plan above, in the original
	// order (forward zone, ranges, reverse zones, subnets, hosts). Any
	// failure here emits an incomplete-teardown event naming what was already
	// deleted before the error propagates.
	zoneDeleted, err := d.execDeleteDNSZone(zoneFQDN, zoneID)
	result["dns_zone_deleted"] = zoneDeleted
	if err != nil {
		d.emitIncomplete(result, "delete forward DNS zone", err)
		return nil, err
	}

	rangesDeleted, err := d.execDeleteRanges(ranges)
	result["dhcp_ranges_deleted"] = rangesDeleted
	if err != nil {
		d.emitIncomplete(result, "delete DHCP ranges", err)
		return nil, err
	}

	reverseDeleted, err := d.execDeleteReverseZones(reverseZones)
	result["reverse_zones_deleted"] = reverseDeleted
	if err != nil {
		d.emitIncomplete(result, "delete reverse DNS zones", err)
		return nil, err
	}

	subnetsDeleted, err := d.execDeleteSubnets(subnets)
	result["subnets_deleted"] = subnetsDeleted
	if err != nil {
		d.emitIncomplete(result, "delete subnets", err)
		return nil, err
	}

	hostsDeleted, err := d.execDeleteHosts(hosts)
	result["hosts_deleted"] = hostsDeleted
	if err != nil {
		d.emitIncomplete(result, "delete hosts", err)
		return nil, err
	}

	return result, nil
}
