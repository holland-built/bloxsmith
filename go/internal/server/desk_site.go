package server

import (
	"context"
	"fmt"
	"net/http"
	"net/netip"
	"regexp"
	"strings"
	"sync/atomic"

	"bloxsmith/internal/demo"
	"bloxsmith/internal/edit"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/provision"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/runs"
)

// The two bigger desk jobs: Set up a branch office (a site from a template)
// and Get a demo ready (a site, five sample DNS names and, if asked, a demo
// server). Both run the same builders as the Provision and Demo server pages;
// what is new is that every object they make is recorded by exact ID.

func init() {
	deskJobs["branch"] = deskJobDef{
		check: func(in map[string]any) string {
			if inStr(in, "template") == "" {
				return "Pick a site template first."
			}
			if !siteName.MatchString(inStr(in, "site")) {
				return "Type a site name: lowercase letters, digits and hyphens, 2 to 30 long."
			}
			return ""
		},
		deskJob: deskJob{
			build: func(d *Deps, r *http.Request, in map[string]any, dry bool) (map[string]any, int) {
				return d.buildSite(r, inStr(in, "template"), inStr(in, "site"), inStr(in, "space_name"), dry)
			},
			collect: func(res, _ map[string]any) ([]runs.Object, string) { return siteObjects(res) },
			title:   func(in map[string]any) string { return "Branch office " + inStr(in, "site") },
		},
	}
	deskJobs["demo"] = deskJobDef{
		check: func(in map[string]any) string {
			if kitTemplates[inStr(in, "region")] == "" {
				return "Pick a region."
			}
			if !siteName.MatchString(inStr(in, "customer")) {
				return "Type the customer or call name: lowercase letters, digits and hyphens, 2 to 30 long."
			}
			return ""
		},
		deskJob: deskJob{
			build: func(d *Deps, r *http.Request, in map[string]any, dry bool) (map[string]any, int) {
				return d.buildKit(r, in, dry)
			},
			collect: func(res, _ map[string]any) ([]runs.Object, string) {
				objs, note := siteObjects(res)
				for _, x := range asList(res["sample_names"]) {
					m, _ := x.(map[string]any)
					if id := anyStr(m["id"]); id != "" {
						objs = append(objs, runs.Object{ID: id, Kind: "dns_record", Label: anyStr(m["label"]), State: runs.Created})
					}
				}
				if n := anyStr(res["sample_note"]); n != "" {
					note = strings.TrimSpace(note + " " + n)
				}
				return objs, note
			},
			title: func(in map[string]any) string { return "Demo for " + inStr(in, "customer") },
		},
	}
}

// siteName is what a site or customer name may look like. It becomes a DNS
// label and a tag value, so it stays plain.
var siteName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$`)

// kitTemplates is the lab site template each demo region uses.
var kitTemplates = map[string]string{
	"amer": "amer/lab/site-amer-lab.yaml",
	"emea": "emea/lab/site-emea-lab.yaml",
	"apac": "apac/lab/site-apac-lab.yaml",
}

// sampleNames are the five DNS names a demo kit adds, pointing at .10 to .14
// of the site's first network.
var sampleNames = []string{"www", "mail", "app", "vpn", "files"}

// buildSite runs the site provisioner, the same one the Provision page streams.
// Its own rollback runs when it fails part way; whatever that could not delete
// comes back under rollback.residual and is recorded so Remove can retry it.
func (d *Deps) buildSite(r *http.Request, template, site, spaceName string, dry bool) (map[string]any, int) {
	e := d.prov(r)
	if e == nil {
		return map[string]any{"ok": false, "error": "site provisioning is not available on this install"}, 500
	}
	tpl, err := e.LoadTemplate(template)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}, 400
	}
	if anyStr(tpl["type"]) != "site" {
		return map[string]any{"ok": false, "error": "That template does not describe a site."}, 400
	}
	if v := provision.ValidateTemplate(tpl, template); v["valid"] != true {
		errs, _ := v["errors"].([]provision.M)
		return map[string]any{"ok": false, "error": invalidTemplateMessage(template, errs)}, 400
	}
	params := map[string]any{"site": site, "dry": dry}
	if spaceName != "" {
		params["ip_space"] = spaceName
	}
	cfg, err := provision.TemplateToSiteConfig(tpl, params)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}, 400
	}
	result, err := e.NewSiteProvisioner(cfg, noopEmit).Provision()
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error(), "rollback": result["rollback"]}, 502
	}
	if result == nil {
		result = map[string]any{}
	}
	result["ok"] = result["skipped"] != true
	if result["skipped"] == true {
		result["error"] = "A site named " + site + " already exists, so nothing was made."
	}
	if dry {
		result["dry_run"] = true
	}
	return result, 200
}

// buildKit is Get a demo ready: a site from the region's lab template, then
// five sample DNS names in its zone, then (if asked) a demo server, which
// keeps building after this request returns.
func (d *Deps) buildKit(r *http.Request, in map[string]any, dry bool) (map[string]any, int) {
	customer := inStr(in, "customer")
	res, status := d.buildSite(r, kitTemplates[inStr(in, "region")], customer, inStr(in, "space_name"), dry)
	if !resultOK(res) {
		return res, status
	}
	base := firstSubnetBase(res)
	if dry {
		names := []any{}
		for i, n := range sampleNames {
			names = append(names, map[string]any{"label": sampleLabel(n, res, base, i)})
		}
		res["sample_names"] = names
		if in["include_server"] == true {
			res["server"] = d.kitServerCheck(r)
		}
		return res, status
	}

	zone := anyStr(res["dns_zone_id"])
	if zone == "" || zone == "(unknown-id)" || !base.IsValid() {
		res["sample_note"] = "The sample DNS names were not added, because the zone or a network with room for them did not come back from Infoblox."
		return res, status
	}
	cli := d.editFor(r)
	var made []any
	failed := 0
	for i, n := range sampleNames {
		rec, _ := cli.DNSRecordCreate(map[string]any{"zone_id": zone, "name_in_zone": n, "type": "A",
			"value": sampleIP(base, i), "dry": false})
		m, _ := rec["record"].(map[string]any)
		if id := anyStr(m["id"]); resultOK(rec) && id != "" {
			made = append(made, map[string]any{"id": id, "label": sampleLabel(n, res, base, i)})
		} else {
			failed++
		}
	}
	res["sample_names"] = made
	if failed > 0 {
		res["sample_note"] = fmt.Sprintf("%d of the sample DNS names could not be added.", failed)
	}
	return res, status
}

// firstSubnetBase is the network address of the site's first IPv4 network,
// when the five sample addresses (.10 to .14 above it) fit inside it.
// Otherwise it is the zero address and no sample names are added.
func firstSubnetBase(res map[string]any) netip.Addr {
	for _, s := range asList(res["subnets"]) {
		m, _ := s.(map[string]any)
		p, err := netip.ParsePrefix(anyStr(m["address"]))
		if err != nil || !p.Addr().Is4() {
			continue
		}
		p = p.Masked()
		if p.Bits() > 27 { // fewer than 32 addresses: .14 would be the broadcast or outside
			return netip.Addr{}
		}
		return p.Addr()
	}
	return netip.Addr{}
}

func sampleIP(base netip.Addr, i int) string {
	b := base.As4()
	b[3] += byte(10 + i)
	return netip.AddrFrom4(b).String()
}

func sampleLabel(name string, res map[string]any, base netip.Addr, i int) string {
	fqdn := name
	if z := strings.TrimSuffix(anyStr(res["dns_zone_fqdn"]), "."); z != "" {
		fqdn += "." + z
	}
	if !base.IsValid() {
		return fqdn + " A"
	}
	return fqdn + " A " + sampleIP(base, i)
}

// siteObjects reads what a site result proves this run made, mirroring the
// provisioner's own rollback: hosts, the forward zone only if this run created
// it, reverse zones marked created, DHCP ranges and networks. Placeholder IDs
// are never recorded.
func siteObjects(res map[string]any) ([]runs.Object, string) {
	objs := []runs.Object{}
	var notes []string
	add := func(kind, id, label string) {
		if id == "" || strings.HasPrefix(id, "(") {
			return
		}
		if _, err := edit.ObjectPath(removeKinds[kind], id); err != nil {
			notes = append(notes, "Bloxsmith did not recognise the ID of "+label+", so check it by hand.")
			return
		}
		objs = append(objs, runs.Object{ID: id, Kind: kind, Label: label, State: runs.Created})
	}
	if rb, _ := res["rollback"].(map[string]any); rb != nil {
		// A failed build: its rollback already deleted what it could. What is
		// left is listed here so Remove can retry it.
		for _, x := range asList(rb["residual"]) {
			m, _ := x.(map[string]any)
			kind := anyStr(m["kind"])
			if kind == "reverse_zone" {
				kind = "dns_zone"
			}
			add(kind, anyStr(m["id"]), anyStr(m["label"]))
		}
		return objs, strings.Join(notes, " ")
	}
	if !resultOK(res) {
		return objs, ""
	}
	for _, h := range asList(res["hosts"]) {
		m, _ := h.(map[string]any)
		add("host", anyStr(m["id"]), "host "+firstNonEmpty(anyStr(m["fqdn"]), anyStr(m["ip"])))
	}
	if res["dns_zone_created"] == true {
		add("dns_zone", anyStr(res["dns_zone_id"]), "zone "+strings.TrimSuffix(anyStr(res["dns_zone_fqdn"]), "."))
	}
	for _, z := range asList(res["reverse_zones"]) {
		m, _ := z.(map[string]any)
		if m["created"] == true {
			add("dns_zone", anyStr(m["id"]), "reverse zone "+strings.TrimSuffix(anyStr(m["fqdn"]), "."))
		}
	}
	for _, x := range asList(res["dhcp_ranges"]) {
		m, _ := x.(map[string]any)
		add("dhcp_range", anyStr(m["id"]), "DHCP range "+anyStr(m["start"])+"-"+anyStr(m["end"]))
	}
	for _, x := range asList(res["subnets"]) {
		m, _ := x.(map[string]any)
		label := anyStr(m["address"])
		if n := anyStr(m["name"]); n != "" {
			label += ", " + n
		}
		add("subnet", anyStr(m["id"]), "network "+label)
	}
	for _, u := range asList(res["unknown_ids"]) {
		m, _ := u.(map[string]any)
		notes = append(notes, "Infoblox made "+anyStr(m["label"])+" but did not return its ID, so it cannot be removed from here.")
	}
	return objs, strings.Join(notes, " ")
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}

// zoneBlocker says why a zone must not be deleted, or "" when it is safe.
// Deleting a zone deletes every record in it, so the desk deletes one only
// when nothing but its own SOA and apex NS records is left. When it cannot list every
// record, it does not delete.
func zoneBlocker(cli *edit.Client, id string) string {
	const cantCheck = "Bloxsmith could not check what is left in this zone, so it was not deleted. Try again, or delete it on the DNS page."
	p, err := edit.ObjectPath("dns/auth_zone", id)
	if err != nil {
		return "not a valid Infoblox ID"
	}
	if _, st, _ := cli.Rest.GetEx(p, nil); st == 404 {
		return ""
	} else if st != 200 {
		return cantCheck
	}
	esc, err := rest.CSPQ(id)
	if err != nil {
		return cantCheck
	}
	const limit = 200
	recs, err := cli.Rest.GetStrict("/api/ddi/v1/dns/record", map[string]string{
		"_filter": `zone=="` + esc + `"`, "_fields": "type,name_in_zone", "_limit": fmt.Sprint(limit)})
	if err != nil {
		return cantCheck
	}
	if len(recs) >= limit {
		return fmt.Sprintf("This zone holds %d or more records, more than Bloxsmith checks, so it was not deleted.", limit)
	}
	others := 0
	for _, x := range recs {
		m, _ := x.(map[string]any)
		// The zone's own SOA and NS records sit at its apex. An NS record
		// anywhere else is a delegation someone added, and counts.
		apex := strings.TrimSpace(anyStr(m["name_in_zone"])) == ""
		switch t := strings.ToUpper(anyStr(m["type"])); {
		case t == "SOA", t == "NS" && apex:
		default:
			others++
		}
	}
	if others > 0 {
		return fmt.Sprintf("This zone now holds %d record(s) this change did not make, so it was not deleted. Remove them first.", others)
	}
	return ""
}

// kitServerCheck is the demo server part of a kit preview: whether a build
// could start now, and if not, what to fix.
func (d *Deps) kitServerCheck(r *http.Request) map[string]any {
	dm, why := d.demoFor(r)
	if why != "" {
		return map[string]any{"ready": false, "why": why}
	}
	if p := dm.Cfg.Problems(); len(p) > 0 {
		return map[string]any{"ready": false, "why": "Set up the demo server first: " + strings.Join(p, "; ")}
	}
	return map[string]any{"ready": true}
}

// startKitServer starts a demo server build for a kit run. It keeps going
// after the request returns. The change ID is written into the run before the
// build makes anything (demo.Demo.Started); if that write fails, the build
// stops. Anything that stops it before then is written into the run's note.
func (d *Deps) startKitServer(r *http.Request, l *runs.Ledger, runID string) {
	dm, why := d.demoFor(r)
	if why == "" {
		if p := dm.Cfg.Problems(); len(p) > 0 {
			why = "Set up the demo server first: " + strings.Join(p, "; ")
		}
	}
	note := func(status, msg string) {
		_ = l.Change(runID, func(x *runs.Run) error {
			if status != "" {
				x.Status = status
			}
			x.Note = strings.TrimSpace(x.Note + " The demo server was not started: " + msg)
			return nil
		})
	}
	if why != "" {
		note("", why)
		return
	}
	// The run stays "building" until the server has a change ID, so Remove
	// waits (409) instead of removing the site while its server is still
	// starting. A restart in between marks the run failed; no server started.
	if err := l.Change(runID, func(x *runs.Run) error { x.Status = runs.Building; return nil }); err != nil {
		return
	}
	var started atomic.Bool
	dm.Started = func(dr *demo.Run) error {
		err := l.Change(runID, func(x *runs.Run) error {
			x.Objects = append(x.Objects, runs.Object{ID: dr.Change, Kind: "demo_server", Label: "demo server", State: runs.Created})
			x.Status = runs.Built
			return nil
		})
		started.Store(err == nil)
		return err
	}
	ctx := context.WithoutCancel(r.Context())
	actor := httpx.Actor(r)
	go func() {
		defer func() {
			if v := recover(); v != nil && !started.Load() {
				note(runs.Built, fmt.Sprintf("the build stopped: %v", v))
			}
		}()
		dr, err := dm.Build(ctx, func(demo.Event) {})
		if !started.Load() {
			// Stopped before the server was recorded (another build running, a
			// setting missing, or the record could not be saved). Anything
			// that demo run made is listed under the older demo servers.
			msg := "it stopped before it began"
			if err != nil {
				msg = err.Error()
			}
			note(runs.Built, msg)
		}
		detail := map[string]any{"run": runID}
		if dr != nil {
			detail["change"], detail["status"] = dr.Change, dr.Status
		}
		if err != nil {
			detail["error"] = err.Error()
			d.auditAppend("demo-build-error", actor, detail)
			return
		}
		d.auditAppend("demo-build", actor, detail)
	}()
}

// demoServerPlan is a demo server's line in a Remove preview.
func (d *Deps) demoServerPlan(r *http.Request, o runs.Object) map[string]any {
	row := map[string]any{"id": o.ID, "kind": o.Kind, "label": o.Label}
	dr, err := d.demoStore().Load(o.ID)
	switch {
	case err != nil:
		row["exists"], row["status"] = false, 0
		row["blocked"] = "Bloxsmith has no record of this demo server, so it cannot remove it."
	case dr.Status == "removed":
		row["exists"], row["gone"] = false, true
	default:
		row["exists"], row["status"] = true, 200
		row["label"] = demoLabel(dr)
		if dr.Status == "building" {
			row["blocked"] = "This demo server is still being built. Remove it once the build has finished."
		}
	}
	return row
}

// removeDemoServer tears down one demo server run by its change ID, the same
// teardown the Demo server page uses. "" means it is gone.
func (d *Deps) removeDemoServer(r *http.Request, change string) string {
	if dr, err := d.demoStore().Load(change); err == nil && dr.Status == "building" {
		return "This demo server is still being built. Remove it once the build has finished."
	}
	dm, why := d.demoFor(r)
	if why != "" {
		return why
	}
	dr, err := dm.Teardown(context.WithoutCancel(r.Context()), change, func(demo.Event) {})
	detail := map[string]any{"change": change}
	if err != nil {
		detail["error"] = err.Error()
		d.auditAppend("demo-remove-error", httpx.Actor(r), detail)
		return err.Error()
	}
	d.auditAppend("demo-remove", httpx.Actor(r), detail)
	if dr != nil && dr.Status != "removed" {
		return firstNonEmpty(dr.Error, "The demo server was not fully removed. Remove again to retry.")
	}
	return ""
}

func demoLabel(dr *demo.Run) string {
	if dr.IP != "" {
		return "demo server " + dr.IP
	}
	return "demo server"
}

// deskDemoRuns reads the demo server runs: the live state of each one a desk
// run made (keyed by change ID), and the older ones built on the Demo server
// page that are not removed yet. Older runs are only listed; they are removed
// when someone presses Remove, never by themselves.
func (d *Deps) deskDemoRuns(rs []runs.Run) (map[string]any, []any) {
	demos, older := map[string]any{}, []any{}
	if strings.TrimSpace(d.StateDir) == "" {
		return demos, older
	}
	linked := map[string]bool{}
	for _, r := range rs {
		for _, o := range r.Objects {
			if o.Kind == "demo_server" {
				linked[o.ID] = true
			}
		}
	}
	for _, dr := range d.demoStore().List() {
		row := map[string]any{"change": dr.Change, "created": dr.Created, "status": dr.Status, "error": dr.Error, "ip": dr.IP}
		switch {
		case linked[dr.Change]:
			demos[dr.Change] = row
		case dr.Status != "removed":
			older = append(older, row)
		}
	}
	return demos, older
}

// removeOlderDemo previews or removes a demo server built on the Demo server
// page, by its change ID, with the same teardown that page uses.
func (d *Deps) removeOlderDemo(w http.ResponseWriter, r *http.Request, change string, b map[string]any) {
	dr, err := d.demoStore().Load(change)
	if err != nil {
		d.json(w, r, 404, map[string]any{"ok": false, "error": "No demo server run " + change})
		return
	}
	if dry, ok := b["dry"].(bool); !ok || dry {
		row := d.demoServerPlan(r, runs.Object{ID: change, Kind: "demo_server", Label: demoLabel(dr)})
		row["parts"] = demo.WouldRemove(dr)
		d.json(w, r, 200, map[string]any{"dry_run": true, "would_remove": []any{row}})
		return
	}
	why := d.removeDemoServer(r, change)
	d.auditAppend("desk-remove", httpx.Actor(r), map[string]any{"demo_change": change, "ok": why == ""})
	if why != "" {
		d.json(w, r, 502, map[string]any{"ok": false, "error": why})
		return
	}
	d.json(w, r, 200, map[string]any{"ok": true})
}
