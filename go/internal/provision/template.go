package provision

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Hardcoded fallbacks (server.py:1020) substituting for the toolkit's uddi.ini
// [DEFAULTS] tier, which this port drops.
const (
	defaultIPSpace   = "default"
	defaultDNSParent = "internal.example.com"
)

// TemplatesInstalled reports whether the templates directory exists on disk.
// Templates are third-party (fetched by scripts/fetch_templates.py, bundled by
// goreleaser); a bare `go build` dev tree legitimately lacks them.
func (e *Engine) TemplatesInstalled() bool {
	info, err := os.Stat(e.TemplatesDir)
	return err == nil && info.IsDir()
}

// LoadTemplate is load_template (server.py:1024): YAML load by path relative to
// TemplatesDir, rejecting paths that escape it, raising *Error not sys.exit.
func (e *Engine) LoadTemplate(name string) (M, error) {
	safe := strings.TrimSpace(name)
	if safe == "" {
		return nil, perr("template name is required")
	}
	// When the whole templates dir is absent, EvalSymlinks below zeroes `base`
	// and every name trips the path-escape guard ("invalid template name") —
	// misleading. Report the real cause up front.
	if !e.TemplatesInstalled() {
		return nil, perr("templates not installed — run scripts/fetch_templates.py, or use the release archive / container image, which bundle them")
	}
	base, err := filepath.Abs(e.TemplatesDir)
	if err != nil {
		return nil, perr("invalid templates dir")
	}
	base, _ = filepath.EvalSymlinks(base)
	path := filepath.Join(base, safe)
	if rp, err := filepath.EvalSymlinks(path); err == nil {
		path = rp
	}
	if path != base && !strings.HasPrefix(path, base+string(os.PathSeparator)) {
		return nil, perr("invalid template name: %s", name)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if !e.TemplatesInstalled() {
			return nil, perr("templates not installed — run scripts/fetch_templates.py, or use the release archive / container image, which bundle them")
		}
		return nil, perr("template not found: %s", name)
	}
	var data any
	if err := yaml.Unmarshal(raw, &data); err != nil {
		return nil, perr("invalid YAML in %s: %s", name, err.Error())
	}
	m := asMap(normalizeYAML(data))
	if m == nil {
		return nil, perr("template must be a mapping at the top level: %s", name)
	}
	return m, nil
}

// normalizeYAML converts yaml.v3's map[string]interface{} tree into the same
// M/[]any shapes the rest of the code (and the JSON body path) expects. yaml.v3
// already uses string keys, so this is mostly identity, but it guarantees the
// M alias type-asserts cleanly.
func normalizeYAML(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := M{}
		for k, val := range t {
			out[k] = normalizeYAML(val)
		}
		return out
	case []any:
		for i := range t {
			t[i] = normalizeYAML(t[i])
		}
		return t
	default:
		return v
	}
}

var templateTypes = map[string]bool{"site": true, "address-block": true, "dns": true}

// TemplateType is template_type (server.py:1054).
func TemplateType(t M) string {
	explicit := strings.ToLower(strings.TrimSpace(pyStr(t["type"])))
	if templateTypes[explicit] {
		return explicit
	}
	if t["address_blocks"] != nil {
		return "address-block"
	}
	if t["zones"] != nil {
		return "dns"
	}
	if t["site"] != nil || t["network"] != nil {
		return "site"
	}
	return "unknown"
}

var supportedRecordTypes = map[string]bool{
	"A": true, "AAAA": true, "CNAME": true, "MX": true, "TXT": true, "PTR": true}

// buildRecordBody is build_record_body (server.py:1073): a POST body from a
// template record, returning an error (ValueError analogue) on a bad record.
func buildRecordBody(zoneID string, record M) (M, error) {
	rtype := strings.ToUpper(strings.TrimSpace(pyStr(record["type"])))
	if !supportedRecordTypes[rtype] {
		return nil, fmt.Errorf("Unsupported record type '%s'; supported: A, AAAA, CNAME, MX, TXT, PTR", rtype)
	}
	raw := record["rdata"]
	var rdata M
	switch rtype {
	case "A", "AAAA":
		rdata = M{"address": pyStr(raw)}
	case "CNAME":
		rdata = M{"cname": pyStr(raw)}
	case "TXT":
		rdata = M{"text": pyStr(raw)}
	case "PTR":
		rdata = M{"dname": pyStr(raw)}
	default: // MX
		mx := asMap(raw)
		if mx == nil {
			return nil, fmt.Errorf("MX rdata must be a mapping with preference and exchange")
		}
		pref := mx["preference"]
		if pref == nil {
			pref = mx["pref"]
		}
		exchange := pyStr(mx["exchange"])
		if pref == nil || exchange == "" {
			return nil, fmt.Errorf("MX rdata requires both preference and exchange")
		}
		p, ok := intCoerce(pref)
		if !ok {
			return nil, fmt.Errorf("MX preference must be an integer")
		}
		rdata = M{"preference": p, "exchange": exchange}
	}
	name := strings.TrimSpace(pyStr(record["name"]))
	if name == "@" {
		name = ""
	}
	body := M{"name_in_zone": name, "zone": zoneID, "type": rtype, "rdata": rdata}
	if record["ttl"] != nil {
		ttl, ok := intCoerce(record["ttl"])
		if !ok {
			return nil, fmt.Errorf("ttl must be an integer")
		}
		body["ttl"] = ttl
	}
	return body, nil
}

// CidrToReverseZone is _cidr_to_reverse_zone (server.py:569), deferred from 1f
// to here: the in-addr.arpa reverse zone FQDN for an IPv4 network. /8,/16,/24
// natural boundaries; other lengths fall back to the enclosing /8. Returns the
// FQDN WITH a trailing dot, matching Python.
func CidrToReverseZone(address string, prefixLen int) (string, error) {
	n, err := ipNet(address, prefixLen)
	if err != nil {
		return "", err
	}
	v4 := n.IP.To4()
	if v4 == nil {
		return "", fmt.Errorf("reverse zone requires an IPv4 network")
	}
	octets := strings.Split(v4.String(), ".")
	var significant []string
	switch {
	case prefixLen >= 24:
		significant = octets[:3]
	case prefixLen >= 16:
		significant = octets[:2]
	default:
		significant = octets[:1]
	}
	// reversed(significant)
	rev := make([]string, len(significant))
	for i, o := range significant {
		rev[len(significant)-1-i] = o
	}
	return strings.Join(rev, ".") + ".in-addr.arpa.", nil
}

// --- validation (pure, no API calls) -----------------------------------------

type vErr struct{ Field, Message string }

type validator struct{ errors, warnings []M }

func (v *validator) err(f, m string)  { v.errors = append(v.errors, M{"field": f, "message": m}) }
func (v *validator) warn(f, m string) { v.warnings = append(v.warnings, M{"field": f, "message": m}) }

// ValidateTemplate is validate_template (server.py:1292): structural validation
// dispatched by type. Never contacts the API.
func ValidateTemplate(t M, name string) M {
	v := &validator{}
	ttype := TemplateType(t)
	switch ttype {
	case "address-block":
		validateBlock(t, v)
	case "dns":
		validateDNS(t, v)
	default:
		validateSite(t, v)
	}
	if v.errors == nil {
		v.errors = []M{}
	}
	if v.warnings == nil {
		v.warnings = []M{}
	}
	return M{"valid": len(v.errors) == 0, "template": name, "type": ttype,
		"errors": v.errors, "warnings": v.warnings}
}

// validateSite is _validate_site (server.py:1105).
func validateSite(t M, v *validator) {
	site := getMap(t, "site")
	name := strings.TrimSpace(pyStr(site["name"]))
	if name == "" {
		v.err("site.name", "Required and must be non-empty")
	} else if strings.Contains(name, " ") {
		v.warn("site.name", "Contains spaces — consider hyphens for DNS compatibility")
	}
	if isFalsy(site["region"]) {
		v.warn("site.region", "Not specified — useful for block-selection filtering")
	}
	if isFalsy(site["environment"]) {
		v.warn("site.environment", "Not specified")
	}

	net := getMap(t, "network")
	if isFalsy(net["ip_space"]) {
		v.warn("network.ip_space", fmt.Sprintf("Not set — falls back to '%s'", defaultIPSpace))
	}
	if net["subnet_size"] != nil {
		if sz, ok := intCoerce(net["subnet_size"]); ok {
			if sz < 8 || sz > 30 {
				v.err("network.subnet_size", fmt.Sprintf("CIDR prefix %d is outside valid range 8-30", sz))
			}
		} else {
			v.err("network.subnet_size", fmt.Sprintf("Must be an integer, got %s", pyRepr(net["subnet_size"])))
		}
	}

	subnetNames := map[string]bool{}
	for i, s := range getList(net, "subnets") {
		pfx := fmt.Sprintf("network.subnets[%d]", i)
		sm := asMap(s)
		if sm == nil {
			v.err(pfx, "Each subnet must be a mapping")
			continue
		}
		sname := strings.TrimSpace(pyStr(sm["name"]))
		if sname == "" {
			v.warn(pfx+".name", "Subnet name is empty")
		} else {
			if subnetNames[sname] {
				v.err(pfx+".name", fmt.Sprintf("Duplicate subnet name '%s'", sname))
			}
			subnetNames[sname] = true
		}
		if isFalsy(sm["purpose"]) {
			v.warn(pfx+".purpose", "No purpose specified")
		}
		if sm["cidr"] != nil {
			if c, ok := intCoerce(sm["cidr"]); ok {
				if c < 8 || c > 30 {
					v.err(pfx+".cidr", fmt.Sprintf("CIDR prefix %d is outside valid range 8-30", c))
				}
			} else {
				v.err(pfx+".cidr", fmt.Sprintf("Must be an integer, got %s", pyRepr(sm["cidr"])))
			}
		}
		if !isFalsy(sm["dhcp"]) {
			for _, offKey := range []string{"dhcp_start", "dhcp_end"} {
				if sm[offKey] != nil {
					if val, ok := intCoerce(sm[offKey]); ok {
						if val < 1 || val > 254 {
							v.err(pfx+"."+offKey, fmt.Sprintf("Host offset %d outside 1-254", val))
						}
					} else {
						v.err(pfx+"."+offKey, fmt.Sprintf("Must be an integer, got %s", pyRepr(sm[offKey])))
					}
				}
			}
		}
	}

	dns := getMap(t, "dns")
	if isFalsy(dns["parent"]) {
		v.warn("dns.parent", fmt.Sprintf("Not set — falls back to '%s'", defaultDNSParent))
	}
	for _, boolKey := range []string{"create_zone", "create_reverse_zone"} {
		if val := dns[boolKey]; val != nil {
			if _, ok := val.(bool); !ok {
				v.err("dns."+boolKey, fmt.Sprintf("Must be true or false, got %s", pyRepr(val)))
			}
		}
	}

	for i, h := range getList(t, "hosts") {
		pfx := fmt.Sprintf("hosts[%d]", i)
		hm := asMap(h)
		if hm == nil {
			v.err(pfx, "Each host must be a mapping")
			continue
		}
		if isFalsy(hm["hostname"]) {
			v.err(pfx+".hostname", "hostname is required")
		}
		ref := strings.TrimSpace(pyStr(hm["subnet"]))
		if ref != "" && len(subnetNames) > 0 && !subnetNames[ref] {
			v.err(pfx+".subnet", fmt.Sprintf("References unknown subnet '%s'; defined: %s", ref, sortedNames(subnetNames)))
		}
	}

	tags := getMap(t, "tags")
	for k, val := range tags {
		if val != nil {
			switch val.(type) {
			case string, int, int64, float64, bool:
			default:
				v.warn("tags."+k, fmt.Sprintf("Value %s is not a scalar", pyRepr(val)))
			}
		}
	}
}

// validateBlock is _validate_block (server.py:1208), recursive over children.
func validateBlock(t M, v *validator) {
	if strings.TrimSpace(pyStr(t["name"])) == "" {
		v.warn("name", "No template name — used to tag and later find created blocks")
	}
	blocks := getList(t, "address_blocks")
	if len(blocks) == 0 {
		if t["address_blocks"] != nil {
			if asList(t["address_blocks"]) == nil {
				v.err("address_blocks", "Must be a list")
			} else {
				v.err("address_blocks", "Required and must be a non-empty list")
			}
		} else {
			v.err("address_blocks", "Required and must be a non-empty list")
		}
	}
	var check func(block any, pfx string, parent *net.IPNet)
	check = func(block any, pfx string, parent *net.IPNet) {
		bm := asMap(block)
		if bm == nil {
			v.err(pfx, "Each block must be a mapping")
			return
		}
		addr := strings.TrimSpace(pyStr(bm["address"]))
		var nn *net.IPNet
		if addr == "" {
			v.err(pfx+".address", "Required")
		}
		if bm["cidr"] == nil {
			v.err(pfx+".cidr", "Required")
		} else if c, ok := intCoerce(bm["cidr"]); !ok {
			v.err(pfx+".cidr", fmt.Sprintf("Invalid address/cidr: %s", pyRepr(bm["cidr"])))
		} else if c < 8 || c > 30 {
			v.err(pfx+".cidr", fmt.Sprintf("CIDR prefix %d is outside valid range 8-30", c))
		} else if addr != "" {
			if n, err := ipNet(addr, c); err == nil {
				nn = n
			} else {
				v.err(pfx+".cidr", fmt.Sprintf("Invalid address/cidr: %s", err.Error()))
			}
		}
		if nn != nil && parent != nil {
			if !isProperSubnet(nn, parent) {
				v.err(pfx, fmt.Sprintf("%s is not contained within parent %s", cidrStr(nn), cidrStr(parent)))
			}
		}
		if parent == nil {
			if isFalsy(bm["region"]) {
				v.warn(pfx+".region", "No region — site discovery filters on Region")
			}
			if isFalsy(bm["environment"]) {
				v.warn(pfx+".environment", "No environment — site discovery filters on Environment")
			}
		}
		for j, child := range getList(bm, "children") {
			check(child, fmt.Sprintf("%s.children[%d]", pfx, j), nn)
		}
	}
	for i, b := range blocks {
		check(b, fmt.Sprintf("address_blocks[%d]", i), nil)
	}
}

// validateDNS is _validate_dns (server.py:1260).
func validateDNS(t M, v *validator) {
	zones := getList(t, "zones")
	if len(zones) == 0 {
		v.err("zones", "Required and must be a non-empty list")
	}
	for i, z := range zones {
		pfx := fmt.Sprintf("zones[%d]", i)
		zm := asMap(z)
		if zm == nil {
			v.err(pfx, "Each zone must be a mapping")
			continue
		}
		if strings.TrimSpace(pyStr(zm["fqdn"])) == "" {
			v.err(pfx+".fqdn", "Required and must be non-empty")
		}
		kind := strings.ToLower(strings.TrimSpace(resolve(nil, zm["kind"], "forward")))
		if kind != "forward" && kind != "reverse" {
			v.err(pfx+".kind", fmt.Sprintf("Must be 'forward' or 'reverse', got '%s'", kind))
		}
		for j, rec := range getList(zm, "records") {
			rpfx := fmt.Sprintf("%s.records[%d]", pfx, j)
			rm := asMap(rec)
			if rm == nil {
				v.err(rpfx, "Each record must be a mapping")
				continue
			}
			if _, err := buildRecordBody("validate", rm); err != nil {
				v.err(rpfx, err.Error())
			}
		}
	}
}

// ListTemplates is list_templates (server.py:1931): recursively scan
// TemplatesDir for YAML templates and summarize each, skipping scaffolding.
func (e *Engine) ListTemplates() ([]M, error) {
	base, err := filepath.Abs(e.TemplatesDir)
	if err != nil {
		return nil, err
	}
	var paths []string
	_ = filepath.Walk(base, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(p))
		if ext == ".yaml" || ext == ".yml" {
			paths = append(paths, p)
		}
		return nil
	})
	sort.Strings(paths)
	out := []M{}
	for _, p := range paths {
		rel, _ := filepath.Rel(base, p)
		baseName := filepath.Base(p)
		if strings.HasPrefix(baseName, "_shared") || strings.Contains(strings.ToUpper(baseName), "SITENAME") {
			continue
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var data any
		if err := yaml.Unmarshal(raw, &data); err != nil {
			continue
		}
		dm := asMap(normalizeYAML(data))
		if dm == nil {
			continue
		}
		siteSec := getMap(dm, "site")
		validation := ValidateTemplate(dm, rel)
		out = append(out, M{
			"name": rel, "type": validation["type"],
			"site":        resolve(nil, siteSec["name"], pyStr(dm["name"])),
			"region":      pyStr(siteSec["region"]),
			"environment": pyStr(siteSec["environment"]),
			"valid":       validation["valid"],
		})
	}
	return out, nil
}

// SiteTemplateRelPaths is the seed-demo template discovery (server.py:5587 /
// 5700): for each region, glob TemplatesDir/<region>/*/site-*.yaml, sorted, and
// return each path relative to TemplatesDir (the form LoadTemplate accepts).
func (e *Engine) SiteTemplateRelPaths(regions []string) []string {
	base, err := filepath.Abs(e.TemplatesDir)
	if err != nil {
		return nil
	}
	var out []string
	for _, region := range regions {
		regionDir := filepath.Join(base, region)
		if info, err := os.Stat(regionDir); err != nil || !info.IsDir() {
			continue
		}
		matches, _ := filepath.Glob(filepath.Join(regionDir, "*", "site-*.yaml"))
		sort.Strings(matches)
		for _, m := range matches {
			if rel, err := filepath.Rel(base, m); err == nil {
				out = append(out, rel)
			}
		}
	}
	return out
}

// --- small formatting helpers mirroring Python repr/str in messages ----------

func pyRepr(v any) string {
	if s, ok := v.(string); ok {
		return "'" + s + "'"
	}
	if b, ok := v.(bool); ok {
		if b {
			return "True"
		}
		return "False"
	}
	return pyStr(v)
}

func cidrStr(n *net.IPNet) string { return fmt.Sprintf("%s/%d", networkAddr(n), prefixLen(n)) }

func sortedNames(m map[string]bool) string {
	names := make([]string, 0, len(m))
	for k := range m {
		names = append(names, k)
	}
	sort.Strings(names)
	quoted := make([]string, len(names))
	for i, n := range names {
		quoted[i] = "'" + n + "'"
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}
