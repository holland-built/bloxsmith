package provision

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// BlockConfig is server.py's BlockConfig dataclass (1311).
type BlockConfig struct {
	Name      string
	IPSpace   string
	DryRun    bool
	ExtraTags M
	Blocks    []any // parsed block dicts (from parseBlocks)
}

// parseBlocks is _parse_blocks (server.py:1320): recursively normalize raw YAML
// block mappings, filling defaults.
func parseBlocks(raw []any) []any {
	parsed := []any{}
	for _, r := range raw {
		rm := asMap(r)
		if rm == nil {
			continue
		}
		tags := M{}
		for k, v := range getMap(rm, "tags") {
			tags[k] = pyStr(v)
		}
		parsed = append(parsed, M{
			"address":     strings.TrimSpace(pyStr(rm["address"])),
			"cidr":        rm["cidr"],
			"region":      pyStr(rm["region"]),
			"environment": pyStr(rm["environment"]),
			"status":      resolve(nil, rm["status"], "available"),
			"location":    pyStr(rm["location"]),
			"comment":     pyStr(rm["comment"]),
			"tags":        tags,
			"children":    parseBlocks(getList(rm, "children")),
		})
	}
	return parsed
}

// TemplateToBlockConfig is template_to_block_config (server.py:1369).
func TemplateToBlockConfig(template, params M) (*BlockConfig, error) {
	name := resolve(params["name"], template["name"], "")
	ipSpace := resolve(params["ip_space"], template["ip_space"], defaultIPSpace)
	blocks := parseBlocks(getList(template, "address_blocks"))
	if len(blocks) == 0 {
		return nil, perr("address_blocks (non-empty list) is required")
	}
	extraTags := M{}
	for k, v := range getMap(template, "tags") {
		extraTags[k] = pyStr(v)
	}
	return &BlockConfig{
		Name: name, IPSpace: ipSpace, DryRun: TruthyDry(params["dry"]),
		ExtraTags: extraTags, Blocks: blocks,
	}, nil
}

// BlockProvisioner is server.py's BlockProvisioner (1385).
type BlockProvisioner struct {
	e         *Engine
	cfg       *BlockConfig
	emit      Emitter
	spaceID   string
	resilient bool
}

func (e *Engine) NewBlockProvisioner(cfg *BlockConfig, emit Emitter) *BlockProvisioner {
	return &BlockProvisioner{e: e, cfg: cfg, emit: emit}
}

func (p *BlockProvisioner) blockTags(bdef M) M {
	tags := M{}
	for k, v := range p.cfg.ExtraTags {
		tags[k] = v
	}
	if p.cfg.Name != "" {
		tags["Template"] = p.cfg.Name
	}
	if !isFalsy(bdef["region"]) {
		tags["Region"] = pyStr(bdef["region"])
	}
	if !isFalsy(bdef["environment"]) {
		tags["Environment"] = pyStr(bdef["environment"])
	}
	if !isFalsy(bdef["status"]) {
		tags["Status"] = pyStr(bdef["status"])
	}
	if !isFalsy(bdef["location"]) {
		tags["Location"] = pyStr(bdef["location"])
	}
	for k, v := range getMap(bdef, "tags") {
		tags[k] = v
	}
	return tags
}

func (p *BlockProvisioner) exists(bdef M) (bool, error) {
	space, err := cspq(p.spaceID)
	if err != nil {
		return false, err
	}
	addr, err := cspq(pyStr(bdef["address"]))
	if err != nil {
		return false, err
	}
	cidr, _ := intCoerce(bdef["cidr"])
	results := p.e.Rest.Get("/api/ddi/v1/ipam/address_block", map[string]string{
		"_filter": fmt.Sprintf(`space=="%s" and address=="%s" and cidr==%d`, space, addr, cidr)})
	return len(results) > 0, nil
}

func (p *BlockProvisioner) createBlock(bdef M, parent *ipNetT, result M) error {
	cidr, ok := intCoerce(bdef["cidr"])
	if !ok {
		return perr("Invalid block %s/%s: cidr is not an integer", pyStr(bdef["address"]), pyStr(bdef["cidr"]))
	}
	n, err := ipNet(pyStr(bdef["address"]), cidr)
	if err != nil {
		return perr("Invalid block %s/%s: %s", pyStr(bdef["address"]), pyStr(bdef["cidr"]), err.Error())
	}
	if parent != nil && !isProperSubnet(n, parent) {
		return perr("Child %s is not contained within parent %s", cidrStr(n), cidrStr(parent))
	}

	tags := p.blockTags(bdef)
	mode := dryPrefix(p.cfg.DryRun)
	p.emit(M{"step": fmt.Sprintf("%sCreating address block %s  status=%s", mode, cidrStr(n), pyStr(bdef["status"]))})

	if p.cfg.DryRun {
		appendTo(result, "blocks_created", M{"address": networkAddr(n), "cidr": cidr,
			"id": "(dry-run)", "status": pyStr(bdef["status"])})
	} else {
		ex, err := p.exists(bdef)
		if err != nil {
			return err
		}
		if ex {
			p.emit(M{"step": fmt.Sprintf("  Already exists — skipping: %s", cidrStr(n))})
		} else {
			body := M{"address": networkAddr(n), "cidr": cidr, "space": p.spaceID,
				"comment": pyStr(bdef["comment"]), "tags": tags}
			resp, status, _ := p.e.Rest.Write("POST", "/api/ddi/v1/ipam/address_block", body, nil)
			if (status != 200 && status != 201) || resp == nil {
				return perr("Failed to create block %s: status %d %v", cidrStr(n), status, resp)
			}
			block := asMap(asMap(resp)["result"])
			if block == nil {
				block = M{}
			}
			p.emit(M{"step": fmt.Sprintf("  Created block id=%s", pyStr(block["id"]))})
			appendTo(result, "blocks_created", M{"address": networkAddr(n), "cidr": cidr,
				"id": pyStr(block["id"]), "status": pyStr(bdef["status"])})
		}
	}

	for _, child := range getList(bdef, "children") {
		if p.resilient {
			if err := p.createBlock(asMap(child), n, result); err != nil {
				p.emit(M{"step": fmt.Sprintf("  Skipping failed child block (%s) — continuing", err.Error())})
				appendTo(result, "failed", err.Error())
			}
		} else if err := p.createBlock(asMap(child), n, result); err != nil {
			return err
		}
	}
	return nil
}

func (p *BlockProvisioner) rollback(result M) {
	p.emit(M{"step": "Rolling back created address blocks…"})
	created := getList(result, "blocks_created")
	for i := len(created) - 1; i >= 0; i-- {
		block := asMap(created[i])
		blockID := pyStr(block["id"])
		if blockID == "" || blockID == "(dry-run)" {
			continue
		}
		_, status, _ := p.e.Rest.Write("DELETE", "/api/ddi/v1/"+blockID, nil, nil)
		if !(status >= 200 && status < 300) {
			p.emit(M{"step": fmt.Sprintf("  Rollback: failed to delete block id=%s", blockID)})
		}
	}
}

// Provision is BlockProvisioner.provision (server.py:1466). resilient=true skips
// a failed subtree and keeps the rest (seed use); default is atomic with
// rollback-on-failure.
func (p *BlockProvisioner) Provision(resilient bool) (M, error) {
	p.resilient = resilient
	result := M{"name": p.cfg.Name, "ip_space": p.cfg.IPSpace,
		"blocks_created": []any{}, "failed": []any{}, "dry_run": p.cfg.DryRun}
	space, err := cspq(p.cfg.IPSpace)
	if err != nil {
		return nil, err
	}
	spaceResults := p.e.Rest.Get("/api/ddi/v1/ipam/ip_space", map[string]string{
		"_filter": fmt.Sprintf(`name=="%s"`, space)})
	if len(spaceResults) == 0 {
		return nil, perr("IP space not found: %s", p.cfg.IPSpace)
	}
	p.spaceID = pyStr(asMap(spaceResults[0])["id"])

	runErr := func() error {
		for _, b := range p.cfg.Blocks {
			if resilient {
				if err := p.createBlock(asMap(b), nil, result); err != nil {
					p.emit(M{"step": fmt.Sprintf("Skipping failed block subtree (%s) — continuing", err.Error())})
					appendTo(result, "failed", err.Error())
				}
			} else if err := p.createBlock(asMap(b), nil, result); err != nil {
				return err
			}
		}
		return nil
	}()
	if runErr != nil {
		if !p.cfg.DryRun {
			p.emit(M{"step": fmt.Sprintf("Block provisioning failed (%s) — initiating rollback", runErr.Error())})
			p.rollback(result)
		}
		return nil, runErr
	}
	return result, nil
}

// --- Block re-tag (server.py:2025) -------------------------------------------

// FindBlocksForRetag is _find_blocks_for_retag (server.py:2025).
func (e *Engine) FindBlocksForRetag(spaceID, template, address string, cidr any, site string) ([]any, error) {
	space, err := cspq(spaceID)
	if err != nil {
		return nil, err
	}
	params := map[string]string{"_filter": fmt.Sprintf(`space=="%s"`, space)}
	switch {
	case template != "":
		t, err := cspq(template)
		if err != nil {
			return nil, err
		}
		params["_tfilter"] = fmt.Sprintf(`Template=="%s"`, t)
	case site != "":
		s, err := cspq(site)
		if err != nil {
			return nil, err
		}
		params["_tfilter"] = fmt.Sprintf(`Site=="%s"`, s)
	case address != "" && cidr != nil && pyStr(cidr) != "":
		a, err := cspq(address)
		if err != nil {
			return nil, err
		}
		c, _ := intCoerce(cidr)
		params["_filter"] += fmt.Sprintf(` and address=="%s" and cidr==%d`, a, c)
	default:
		return nil, perr("template, site, or address+cidr is required")
	}
	return e.Rest.Get("/api/ddi/v1/ipam/address_block", params), nil
}

// RetagBlock is _retag_block (server.py:2041).
func (e *Engine) RetagBlock(block M, status string, dryRun bool) (M, error) {
	tags := M{}
	for k, v := range getMap(block, "tags") {
		tags[k] = v
	}
	tags["Status"] = status
	if status == "available" {
		tags["Site"] = "unassigned"
		tags["Location"] = ""
		tags["Provisioned"] = ""
		tags["Decommissioned"] = ""
	}
	addr := fmt.Sprintf("%s/%s", pyStr(block["address"]), pyStr(block["cidr"]))
	if !dryRun {
		_, httpStatus, _ := e.Rest.Write("PATCH", "/api/ddi/v1/"+pyStr(block["id"]), M{"tags": tags}, nil)
		if !(httpStatus >= 200 && httpStatus < 300) {
			return nil, perr("Failed to retag block %s: status %d", addr, httpStatus)
		}
	}
	return M{"address": addr, "id": pyStr(block["id"]), "status": status}, nil
}

// --- Address-block decommission (server.py:2063) -----------------------------

// BlockDecommissioner is server.py's BlockDecommissioner (2063): deletes blocks
// tagged Template==<name>, deepest-child-first (highest cidr first).
type BlockDecommissioner struct {
	e       *Engine
	name    string
	ipSpace string
	dryRun  bool
	emit    Emitter
	spaceID string
}

func (e *Engine) NewBlockDecommissioner(name, ipSpace string, dryRun bool, emit Emitter) *BlockDecommissioner {
	return &BlockDecommissioner{e: e, name: name, ipSpace: ipSpace, dryRun: dryRun, emit: emit}
}

func (d *BlockDecommissioner) findBlocks() ([]any, error) {
	space, err := cspq(d.spaceID)
	if err != nil {
		return nil, err
	}
	name, err := cspq(d.name)
	if err != nil {
		return nil, err
	}
	return d.e.Rest.Get("/api/ddi/v1/ipam/address_block", map[string]string{
		"_filter": fmt.Sprintf(`space=="%s"`, space), "_tfilter": fmt.Sprintf(`Template=="%s"`, name)}), nil
}

func (d *BlockDecommissioner) deleteBlocks(blocks []any) ([]any, error) {
	ordered := append([]any{}, blocks...)
	sort.SliceStable(ordered, func(i, j int) bool {
		ci, _ := intCoerce(asMap(ordered[i])["cidr"])
		cj, _ := intCoerce(asMap(ordered[j])["cidr"])
		return ci > cj // highest cidr first (reverse)
	})
	deleted := []any{}
	mode := dryPrefix(d.dryRun)
	for _, b := range ordered {
		block := asMap(b)
		blockID := pyStr(block["id"])
		addr := fmt.Sprintf("%s/%s", pyStr(block["address"]), pyStr(block["cidr"]))
		status := pyStr(getMap(block, "tags")["Status"])
		d.emit(M{"step": fmt.Sprintf("%sDeleting block: %s  status=%s  id=%s", mode, addr, status, blockID)})
		if !d.dryRun {
			_, httpStatus, _ := d.e.Rest.Write("DELETE", "/api/ddi/v1/"+blockID, nil, nil)
			if !(httpStatus >= 200 && httpStatus < 300) {
				return nil, perr("Failed to delete block %s: status %d", addr, httpStatus)
			}
		}
		deleted = append(deleted, M{"address": addr, "id": blockID, "status": status})
	}
	return deleted, nil
}

// Decommission is BlockDecommissioner.decommission (server.py:2097).
func (d *BlockDecommissioner) Decommission() (M, error) {
	space, err := cspq(d.ipSpace)
	if err != nil {
		return nil, err
	}
	spaceResults := d.e.Rest.Get("/api/ddi/v1/ipam/ip_space", map[string]string{
		"_filter": fmt.Sprintf(`name=="%s"`, space)})
	if len(spaceResults) == 0 {
		return nil, perr("IP space not found: %s", d.ipSpace)
	}
	d.spaceID = pyStr(asMap(spaceResults[0])["id"])
	blocks, err := d.findBlocks()
	if err != nil {
		return nil, err
	}
	deleted, err := d.deleteBlocks(blocks)
	if err != nil {
		return nil, err
	}
	return M{"name": d.name, "ip_space": d.ipSpace, "blocks_deleted": deleted, "dry_run": d.dryRun}, nil
}

// --- shared small helpers ----------------------------------------------------

func dryPrefix(dry bool) string {
	if dry {
		return "[DRY-RUN] "
	}
	return ""
}

// appendTo appends v to the []any stored at result[key].
func appendTo(result M, key string, v any) {
	result[key] = append(getList(result, key), v)
}

// itoa is used where a query param must be a string.
func itoa(n int) string { return strconv.Itoa(n) }
