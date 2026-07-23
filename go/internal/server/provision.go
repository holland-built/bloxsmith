package server

import (
	"fmt"
	"net/http"
	"strings"

	"bloxsmith/internal/httpx"
	"bloxsmith/internal/provision"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/sse"
)

// registerProvisionRoutes wires the Phase 1g provisioning engines + SSE streams
// (server.py do_GET 5431-5739 for the 5 streams + /api/templates, do_POST
// 6174-6281 for validate/block/teardown/retag/drift). The central write-guard
// (server.New) already gated every mutating path and logged "write-authorized";
// these handlers add the per-route RBAC gate, the engine call, the SSE framing,
// and the explicit action audit entry, exactly as Python does.
func (d *Deps) registerProvisionRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/templates", d.templatesList)
	mux.HandleFunc("GET /api/provision/stream", d.provisionSubnetStream)
	mux.HandleFunc("GET /api/provision/site/stream", d.provisionSiteStream)
	mux.HandleFunc("GET /api/provision/seed-demo/stream", d.provisionSeedDemoStream)
	mux.HandleFunc("GET /api/teardown/site/stream", d.teardownSiteStream)
	mux.HandleFunc("GET /api/teardown/seed-demo/stream", d.teardownSeedDemoStream)

	mux.HandleFunc("POST /api/templates/validate", d.body(d.templatesValidate))
	mux.HandleFunc("POST /api/provision/block", d.body(d.provisionBlock))
	mux.HandleFunc("POST /api/teardown/block", d.body(d.teardownBlock))
	mux.HandleFunc("POST /api/retag/block", d.body(d.retagBlock))
	mux.HandleFunc("POST /api/drift/check", d.body(d.driftCheck))
}

// --- helpers -----------------------------------------------------------------

// queryM flattens the query string to a single-value map, matching Python's
// `{k: v[0] for k, v in parse_qs(qs).items()}` (server.py:5437).
func queryM(r *http.Request) provision.M {
	out := provision.M{}
	for k, v := range r.URL.Query() {
		if len(v) > 0 {
			out[k] = v[0]
		}
	}
	return out
}

// bstr is Python `str(body.get(k, "")).strip()` for scalar body/template values.
func bstr(b map[string]any, k string) string {
	v := b[k]
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s)
	}
	return strings.TrimSpace(provision.PyStr(v))
}

// sseCORS binds the reflected-origin header setter for a stream response.
func (d *Deps) sseCORS(w http.ResponseWriter, r *http.Request) func() {
	return func() { d.Guard.SendCORSOrigin(w, r) }
}

// --- GET /api/templates (server.py:5498) -------------------------------------

func (d *Deps) templatesList(w http.ResponseWriter, r *http.Request) {
	defer d.recoverEdit(w, r, "/api/templates")
	list, err := d.Provision.ListTemplates()
	if err != nil {
		d.logExc("/api/templates", err)
		d.json(w, r, 500, map[string]any{"error": "internal error"})
		return
	}
	d.json(w, r, 200, list)
}

// --- GET /api/provision/stream (server.py:5431) ------------------------------
// Self-service subnet wizard SSE. Operator-gated. Uses the REST client directly
// (a single nextavailablesubnet allocate + optional reverse zone), not the
// template engine.

func (d *Deps) provisionSubnetStream(w http.ResponseWriter, r *http.Request) {
	qp := queryM(r)
	block := strings.TrimSpace(provision.PyStr(qp["block"]))
	cidr := strings.TrimSpace(provision.PyStr(qp["cidr"]))
	if cidr == "" {
		cidr = "24"
	}
	name := strings.TrimSpace(provision.PyStr(qp["name"]))
	comment := strings.TrimSpace(provision.PyStr(qp["comment"]))
	makeZone := provision.PyStr(qp["make_zone"]) == "1"
	dry := truthyDryQ(qp["dry"])

	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	emit, ok := sse.Start(w, d.sseCORS(w, r))
	if !ok {
		return
	}

	err := func() error {
		if block == "" {
			emit(map[string]any{"error": "block is required"})
			return nil
		}
		emit(map[string]any{"step": fmt.Sprintf("Resolving block %s…", block)})
		if dry {
			emit(map[string]any{"step": fmt.Sprintf("[DRY-RUN] Would create /%s in block %s", cidr, block)})
			emit(map[string]any{"done": true, "subnet": map[string]any{"id": nil, "address": nil, "cidr": cidr}})
			return nil
		}
		cidrN, ok := parseIntStr(cidr)
		if !ok {
			return fmt.Errorf("invalid literal for int() with base 10: '%s'", cidr)
		}
		var body any
		if name != "" || comment != "" {
			bm := map[string]any{}
			if name != "" {
				bm["name"] = name
			}
			if comment != "" {
				bm["comment"] = comment
			}
			body = bm
		}
		result, status, _ := d.Rest.Write("POST", "/api/ddi/v1/"+block+"/nextavailablesubnet",
			body, map[string]string{"cidr": itoaLocal(cidrN)})
		emit(map[string]any{"step": "Subnet allocation result", "status": status, "result": result})
		subnet := firstRowLocal(result)
		if makeZone && provision.PyStr(subnet["address"]) != "" {
			emit(map[string]any{"step": "Creating DNS zone…"})
			zc := cidrN
			if c, ok := parseIntStr(provision.PyStr(subnet["cidr"])); ok {
				zc = c
			}
			fqdn, ferr := provision.CidrToReverseZone(provision.PyStr(subnet["address"]), zc)
			if ferr != nil {
				return ferr
			}
			zresult, zstatus, _ := d.Rest.Write("POST", "/api/ddi/v1/dns/auth_zone",
				map[string]any{"fqdn": fqdn}, nil)
			emit(map[string]any{"step": "Zone creation result", "status": zstatus, "result": zresult})
		}
		emit(map[string]any{"done": true, "subnet": map[string]any{
			"id": subnet["id"], "address": subnet["address"], "cidr": subnet["cidr"]}})
		_, _ = d.Audit.Append("provision-subnet", httpx.Actor(r), map[string]any{
			"block": block, "cidr": cidr, "subnet": subnet["address"]})
		return nil
	}()
	if err != nil {
		if !dry {
			_, _ = d.Audit.Append("provision-subnet-error", httpx.Actor(r),
				map[string]any{"block": block, "error": err.Error()})
		}
		emit(map[string]any{"error": err.Error()})
	}
}

// --- GET /api/provision/site/stream (server.py:5503) -------------------------

func (d *Deps) provisionSiteStream(w http.ResponseWriter, r *http.Request) {
	qp := queryM(r)
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	emit, ok := sse.Start(w, d.sseCORS(w, r))
	if !ok {
		return
	}
	name := strings.TrimSpace(provision.PyStr(qp["template"]))
	if name == "" {
		emit(map[string]any{"error": "template is required"})
		return
	}
	template, err := d.Provision.LoadTemplate(name)
	if err != nil {
		emit(map[string]any{"error": err.Error()})
		return
	}
	cfg, err := provision.TemplateToSiteConfig(template, qp)
	if err != nil {
		emit(map[string]any{"error": err.Error()})
		return
	}
	emit(map[string]any{"step": fmt.Sprintf("Provisioning site: %s", cfg.Site)})
	result, err := d.Provision.NewSiteProvisioner(cfg, emitter(emit)).Provision()
	if err != nil {
		if !cfg.DryRun {
			_, _ = d.Audit.Append("provision-site-error", httpx.Actor(r),
				map[string]any{"template": name, "error": err.Error()})
		}
		if !provision.IsError(err) {
			d.logExc("/api/provision/site/stream", err)
		}
		emit(map[string]any{"error": err.Error()})
		return
	}
	emit(map[string]any{"done": true, "result": result})
	if !cfg.DryRun {
		_, _ = d.Audit.Append("provision-site", httpx.Actor(r),
			map[string]any{"template": name, "site": cfg.Site})
	}
}

// --- GET /api/provision/seed-demo/stream (server.py:5545) --------------------

func (d *Deps) provisionSeedDemoStream(w http.ResponseWriter, r *http.Request) {
	qp := queryM(r)
	dry := truthyDryQ(qp["dry"])
	regions := parseRegions(provision.PyStr(qp["regions"]))
	override := ipSpaceOverride(qp)

	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	emit, ok := sse.Start(w, d.sseCORS(w, r))
	if !ok {
		return
	}

	dryParam := "0"
	if dry {
		dryParam = "1"
	}
	summary := map[string]any{"succeeded": []any{}, "failed": []any{}, "skipped": []any{}}

	if !d.Provision.TemplatesInstalled() {
		emit(map[string]any{"error": "templates not installed — use the release archive or container image (which bundle them), or add YAML templates to the templates directory"})
		emit(map[string]any{"done": true, "summary": summary})
		return
	}

	emit(map[string]any{"step": "Seeding blocks…"})
	if bt, err := d.Provision.LoadTemplate("blocks/regional_address_blocks.yaml"); err != nil {
		emit(map[string]any{"template": "blocks/regional_address_blocks.yaml", "error": err.Error()})
	} else if bcfg, err := provision.TemplateToBlockConfig(bt, provision.M{"dry": dryParam, "ip_space": override}); err != nil {
		emit(map[string]any{"template": "blocks/regional_address_blocks.yaml", "error": err.Error()})
	} else if _, err := d.Provision.NewBlockProvisioner(bcfg, emitter(emit)).Provision(true); err != nil {
		if provision.IsError(err) {
			emit(map[string]any{"template": "blocks/regional_address_blocks.yaml", "error": err.Error()})
		} else {
			summaryAppend(summary, "failed", "blocks/regional_address_blocks.yaml")
			emit(map[string]any{"template": "blocks/regional_address_blocks.yaml", "error": err.Error()})
		}
	}

	for _, rel := range d.Provision.SiteTemplateRelPaths(regions) {
		rel := rel
		func() {
			template, err := d.Provision.LoadTemplate(rel)
			if err != nil {
				summaryAppend(summary, "failed", rel)
				emit(map[string]any{"template": rel, "error": err.Error()})
				return
			}
			cfg, err := provision.TemplateToSiteConfig(template,
				provision.M{"dry": dryParam, "if_not_exists": true, "ip_space": override})
			if err != nil {
				summaryAppend(summary, "failed", rel)
				emit(map[string]any{"template": rel, "error": err.Error()})
				return
			}
			forward := func(obj map[string]any) {
				if s, ok := obj["step"]; ok {
					emit(map[string]any{"step": fmt.Sprintf("[%s] %s", rel, provision.PyStr(s))})
				} else {
					emit(obj)
				}
			}
			result, err := d.Provision.NewSiteProvisioner(cfg, forward).Provision()
			if err != nil {
				summaryAppend(summary, "failed", rel)
				emit(map[string]any{"template": rel, "error": err.Error()})
				return
			}
			if b, _ := result["skipped"].(bool); b {
				summaryAppend(summary, "skipped", rel)
			} else {
				summaryAppend(summary, "succeeded", rel)
			}
		}()
	}

	emit(map[string]any{"done": true, "summary": summary})
	if !dry {
		_, _ = d.Audit.Append("provision-seed-demo", httpx.Actor(r), map[string]any{
			"regions":   regions,
			"succeeded": lenOf(summary, "succeeded"),
			"failed":    lenOf(summary, "failed"),
			"skipped":   lenOf(summary, "skipped")})
	}
}

// --- GET /api/teardown/site/stream (server.py:5617) --------------------------

func (d *Deps) teardownSiteStream(w http.ResponseWriter, r *http.Request) {
	qp := queryM(r)
	if !d.roleGate(r, "admin") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "admin required"})
		return
	}
	emit, ok := sse.Start(w, d.sseCORS(w, r))
	if !ok {
		return
	}
	name := strings.TrimSpace(provision.PyStr(qp["template"]))
	if name == "" {
		emit(map[string]any{"error": "template is required"})
		return
	}
	template, err := d.Provision.LoadTemplate(name)
	if err != nil {
		emit(map[string]any{"error": err.Error()})
		return
	}
	cfg, err := provision.TemplateToDecommissionConfig(template, qp)
	if err != nil {
		emit(map[string]any{"error": err.Error()})
		return
	}
	if !cfg.DryRun && provision.PyStr(qp["confirm"]) != cfg.Site {
		emit(map[string]any{"error": "confirmation required"})
		return
	}
	emit(map[string]any{"step": fmt.Sprintf("Decommissioning site: %s", cfg.Site)})
	result, err := d.Provision.NewSiteDecommissioner(cfg, emitter(emit)).Decommission()
	if err != nil {
		if !cfg.DryRun {
			_, _ = d.Audit.Append("teardown-site-error", httpx.Actor(r),
				map[string]any{"template": name, "error": err.Error()})
		}
		if !provision.IsError(err) {
			d.logExc("/api/teardown/site/stream", err)
		}
		emit(map[string]any{"error": err.Error()})
		return
	}
	emit(map[string]any{"done": true, "result": result})
	if !cfg.DryRun {
		_, _ = d.Audit.Append("teardown-site", httpx.Actor(r),
			map[string]any{"template": name, "site": cfg.Site})
	}
}

// --- GET /api/teardown/seed-demo/stream (server.py:5663) ---------------------

func (d *Deps) teardownSeedDemoStream(w http.ResponseWriter, r *http.Request) {
	qp := queryM(r)
	dry := truthyDryQ(qp["dry"])
	regions := parseRegions(provision.PyStr(qp["regions"]))
	override := ipSpaceOverride(qp)
	confirm := provision.PyStr(qp["confirm"])

	if !d.roleGate(r, "admin") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "admin required"})
		return
	}
	emit, ok := sse.Start(w, d.sseCORS(w, r))
	if !ok {
		return
	}
	if !dry && confirm != "DELETE" {
		emit(map[string]any{"error": "confirmation required"})
		return
	}

	dryParam := "0"
	if dry {
		dryParam = "1"
	}
	summary := map[string]any{"succeeded": []any{}, "failed": []any{}, "skipped": []any{}}

	for _, rel := range d.Provision.SiteTemplateRelPaths(regions) {
		rel := rel
		func() {
			template, err := d.Provision.LoadTemplate(rel)
			if err != nil {
				summaryAppend(summary, "failed", rel)
				emit(map[string]any{"template": rel, "error": err.Error()})
				return
			}
			cfg, err := provision.TemplateToDecommissionConfig(template,
				provision.M{"dry": dryParam, "ip_space": override})
			if err != nil {
				summaryAppend(summary, "failed", rel)
				emit(map[string]any{"template": rel, "error": err.Error()})
				return
			}
			forward := func(obj map[string]any) {
				if s, ok := obj["step"]; ok {
					emit(map[string]any{"step": fmt.Sprintf("[%s] %s", rel, provision.PyStr(s))})
				} else {
					emit(obj)
				}
			}
			if _, err := d.Provision.NewSiteDecommissioner(cfg, forward).Decommission(); err != nil {
				summaryAppend(summary, "failed", rel)
				emit(map[string]any{"template": rel, "error": err.Error()})
				return
			}
			summaryAppend(summary, "succeeded", rel)
		}()
	}

	emit(map[string]any{"step": "Decommissioning regional address-block pool…"})
	if bt, err := d.Provision.LoadTemplate("blocks/regional_address_blocks.yaml"); err != nil {
		emit(map[string]any{"template": "blocks/regional_address_blocks.yaml", "error": err.Error()})
	} else {
		blockName := bstr(bt, "name")
		blockIPSpace := override
		if blockIPSpace == nil || provision.PyStr(blockIPSpace) == "" {
			if v := bstr(bt, "ip_space"); v != "" {
				blockIPSpace = v
			} else {
				blockIPSpace = "default"
			}
		}
		if _, err := d.Provision.NewBlockDecommissioner(blockName, provision.PyStr(blockIPSpace), dry, emitter(emit)).Decommission(); err != nil {
			if provision.IsError(err) {
				emit(map[string]any{"template": "blocks/regional_address_blocks.yaml", "error": err.Error()})
			} else {
				emit(map[string]any{"template": "blocks/regional_address_blocks.yaml", "error": err.Error()})
			}
		}
	}

	emit(map[string]any{"done": true, "summary": summary})
	if !dry {
		_, _ = d.Audit.Append("teardown-seed-demo", httpx.Actor(r), map[string]any{
			"regions":   regions,
			"succeeded": lenOf(summary, "succeeded"),
			"failed":    lenOf(summary, "failed"),
			"skipped":   lenOf(summary, "skipped")})
	}
}

// --- POST /api/templates/validate (server.py:6174) ---------------------------

func (d *Deps) templatesValidate(w http.ResponseWriter, r *http.Request, b map[string]any) {
	defer d.recoverEdit(w, r, "/api/templates/validate")
	name := bstr(b, "name")
	template, err := d.Provision.LoadTemplate(name)
	if err != nil {
		if provision.IsError(err) {
			d.json(w, r, 200, map[string]any{"valid": false, "type": "unknown",
				"errors": []any{map[string]any{"field": "template", "message": err.Error()}}, "warnings": []any{}})
			return
		}
		d.logExc("/api/templates/validate", err)
		d.json(w, r, 500, map[string]any{"error": "internal error"})
		return
	}
	v := provision.ValidateTemplate(template, name)
	d.json(w, r, 200, map[string]any{"valid": v["valid"], "type": v["type"],
		"errors": v["errors"], "warnings": v["warnings"]})
}

// --- POST /api/provision/block (server.py:6186) ------------------------------

func (d *Deps) provisionBlock(w http.ResponseWriter, r *http.Request, b map[string]any) {
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/provision/block")
	name := bstr(b, "template")
	if name == "" {
		d.json(w, r, 400, map[string]any{"error": "template is required"})
		return
	}
	template, err := d.Provision.LoadTemplate(name)
	if err != nil {
		d.provErr(w, r, "/api/provision/block", err)
		return
	}
	cfg, err := provision.TemplateToBlockConfig(template, provision.M{"ip_space": b["ip_space"], "dry": b["dry"]})
	if err != nil {
		d.provErr(w, r, "/api/provision/block", err)
		return
	}
	result, err := d.Provision.NewBlockProvisioner(cfg, noopEmit).Provision(false)
	if err != nil {
		d.provErr(w, r, "/api/provision/block", err)
		return
	}
	d.json(w, r, 200, map[string]any{"blocks_created": result["blocks_created"]})
	if b2, _ := result["dry_run"].(bool); !b2 {
		created, _ := result["blocks_created"].([]any)
		_, _ = d.Audit.Append("provision-block", httpx.Actor(r),
			map[string]any{"template": name, "blocks_created": len(created)})
	}
}

// --- POST /api/teardown/block (server.py:6208) -------------------------------

func (d *Deps) teardownBlock(w http.ResponseWriter, r *http.Request, b map[string]any) {
	if !d.roleGate(r, "admin") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "admin required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/teardown/block")
	name := bstr(b, "template")
	if name == "" {
		d.json(w, r, 400, map[string]any{"error": "template is required"})
		return
	}
	template, err := d.Provision.LoadTemplate(name)
	if err != nil {
		d.provErr(w, r, "/api/teardown/block", err)
		return
	}
	ipSpace := bstr(b, "ip_space")
	if ipSpace == "" {
		ipSpace = bstr(template, "ip_space")
	}
	if ipSpace == "" {
		ipSpace = "default"
	}
	dry := truthyDryQ(b["dry"])
	blockName := bstr(template, "name")
	if blockName == "" {
		blockName = name
	}
	if !dry && provision.PyStr(b["confirm"]) != name {
		d.json(w, r, 400, map[string]any{"error": "confirmation required"})
		return
	}
	result, err := d.Provision.NewBlockDecommissioner(blockName, ipSpace, dry, noopEmit).Decommission()
	if err != nil {
		d.provErr(w, r, "/api/teardown/block", err)
		return
	}
	d.json(w, r, 200, map[string]any{"result": result})
	if !dry {
		_, _ = d.Audit.Append("teardown-block", httpx.Actor(r),
			map[string]any{"template": name, "block": blockName})
	}
}

// --- POST /api/retag/block (server.py:6234) ----------------------------------

func (d *Deps) retagBlock(w http.ResponseWriter, r *http.Request, b map[string]any) {
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/retag/block")
	templateName := bstr(b, "template")
	site := bstr(b, "site")
	address := bstr(b, "address")
	cidr := b["cidr"]
	status := bstr(b, "status")
	if status == "" {
		status = "available"
	}
	ipSpace := bstr(b, "ip_space")
	if ipSpace == "" {
		ipSpace = "default"
	}
	dry := truthyDryQ(b["dry"])

	esc, err := rest.CSPQ(ipSpace)
	if err != nil {
		d.logExc("/api/retag/block", err)
		d.json(w, r, 500, map[string]any{"error": "internal error"})
		return
	}
	spaceResults := d.Rest.Get("/api/ddi/v1/ipam/ip_space", map[string]string{"_filter": fmt.Sprintf(`name=="%s"`, esc)})
	if len(spaceResults) == 0 {
		d.json(w, r, 400, map[string]any{"error": "IP space not found: " + ipSpace})
		return
	}
	spaceID := provision.PyStr(mapOf(spaceResults[0])["id"])
	blocks, err := d.Provision.FindBlocksForRetag(spaceID, templateName, address, cidr, site)
	if err != nil {
		d.provErr(w, r, "/api/retag/block", err)
		return
	}
	changed := []any{}
	for _, blk := range blocks {
		res, err := d.Provision.RetagBlock(mapOf(blk), status, dry)
		if err != nil {
			d.provErr(w, r, "/api/retag/block", err)
			return
		}
		changed = append(changed, res)
	}
	d.json(w, r, 200, map[string]any{"status": status, "changed": changed, "dry_run": dry})
	if !dry {
		_, _ = d.Audit.Append("retag-block", httpx.Actor(r),
			map[string]any{"template": templateName, "status": status, "count": len(changed)})
	}
}

// --- POST /api/drift/check (server.py:6264) ----------------------------------

func (d *Deps) driftCheck(w http.ResponseWriter, r *http.Request, b map[string]any) {
	defer d.recoverEdit(w, r, "/api/drift/check")
	name := bstr(b, "template")
	if name == "" {
		d.json(w, r, 400, map[string]any{"error": "template is required"})
		return
	}
	template, err := d.Provision.LoadTemplate(name)
	if err != nil {
		d.provErr(w, r, "/api/drift/check", err)
		return
	}
	cfg, err := provision.TemplateToSiteConfig(template, provision.M{"ip_space": b["ip_space"]})
	if err != nil {
		d.provErr(w, r, "/api/drift/check", err)
		return
	}
	live, err := d.Provision.QuerySiteLive(cfg.Site, cfg.IPSpace, cfg.DNSView, cfg.DNSZone())
	if err != nil {
		d.provErr(w, r, "/api/drift/check", err)
		return
	}
	d.json(w, r, 200, provision.DetectDrift(template, live, cfg.Site))
}

// --- shared small helpers ----------------------------------------------------

// provErr maps an engine error to Python's split handling: a *provision.Error
// (the `except ProvisionError` branch) -> 400 {"error": msg}; any other error
// (the `except Exception` branch) -> logged 500 {"error": "internal error"}.
func (d *Deps) provErr(w http.ResponseWriter, r *http.Request, label string, err error) {
	if provision.IsError(err) {
		d.json(w, r, 400, map[string]any{"error": err.Error()})
		return
	}
	d.logExc(label, err)
	d.json(w, r, 500, map[string]any{"error": "internal error"})
}

// emitter adapts an sse.Emit to a provision.Emitter (identical signature).
func emitter(e sse.Emit) provision.Emitter { return provision.Emitter(e) }

// noopEmit is Python's `lambda _obj: None` for the non-streaming POST routes.
var noopEmit = provision.Emitter(func(map[string]any) {})

// truthyDryQ is _truthy_dry for a query/body value (default dry-run preview).
func truthyDryQ(v any) bool {
	if v == nil {
		return true
	}
	if b, ok := v.(bool); ok {
		return b
	}
	switch strings.ToLower(strings.TrimSpace(provision.PyStr(v))) {
	case "0", "false", "no", "":
		return false
	}
	return true
}

// parseRegions is the seed/teardown region parsing (server.py:5555): split on
// commas, trim+lowercase, drop empties, default to amer,emea,apac.
func parseRegions(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		raw = "amer,emea,apac"
	}
	var out []string
	for _, p := range strings.Split(raw, ",") {
		if s := strings.ToLower(strings.TrimSpace(p)); s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		out = []string{"amer", "emea", "apac"}
	}
	return out
}

// ipSpaceOverride is `qp.get("ip_space","").strip() or None` (server.py:5558):
// an empty override is nil so the template/default value is used downstream.
func ipSpaceOverride(qp provision.M) any {
	if s := strings.TrimSpace(provision.PyStr(qp["ip_space"])); s != "" {
		return s
	}
	return nil
}

func summaryAppend(summary map[string]any, key, val string) {
	cur, _ := summary[key].([]any)
	summary[key] = append(cur, val)
}

func lenOf(summary map[string]any, key string) int {
	cur, _ := summary[key].([]any)
	return len(cur)
}

func mapOf(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func parseIntStr(s string) (int, bool) {
	n := 0
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	for i, c := range s {
		if i == 0 && (c == '-' || c == '+') {
			continue
		}
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	_, err := fmt.Sscanf(s, "%d", &n)
	return n, err == nil
}

func itoaLocal(n int) string { return fmt.Sprintf("%d", n) }

func firstRowLocal(resp any) map[string]any {
	m := mapOf(resp)
	if rows, ok := m["results"].([]any); ok && len(rows) > 0 {
		return mapOf(rows[0])
	}
	if res, ok := m["result"]; ok && res != nil {
		return mapOf(res)
	}
	return map[string]any{}
}
