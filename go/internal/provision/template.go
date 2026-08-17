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

// Hardcoded fallbacks (server.py:1020) substituting for the uddi.ini [DEFAULTS]
// tier in Chris Marrison's uddi_automation_toolkit, which this port drops.
// See NOTICE.md.
const (
	defaultIPSpace   = "default"
	defaultDNSParent = "internal.example.com"
)

// DirState is the three answers a "is the templates directory there?" question
// really has. It used to have two, and the missing one was the expensive one:
// `err == nil && info.IsDir()` folded "I could not read it" into "it is not
// there", so a permission bit on the parent told the operator to re-download the
// release archive — a remedy that cannot fix a permission bit. #134.
//
// Same shape as pathAbsent/dirEntries in go/path_absence.go, which cannot be
// used here because they live in package main.
type DirState int

const (
	DirPresent DirState = iota
	DirAbsent
	DirUnreadable
)

// TemplatesDirState answers which of the three the templates directory is, and
// why when the answer is Unreadable.
//
// A path that exists but is NOT a directory is Unreadable, not Absent: something
// is there, we cannot use it, and telling the operator nothing is installed
// would send them to create what already exists.
func (e *Engine) TemplatesDirState() (DirState, error) {
	info, err := os.Stat(e.TemplatesDir)
	switch {
	case err == nil && info.IsDir():
		return DirPresent, nil
	case err == nil:
		return DirUnreadable, fmt.Errorf("%s is not a directory", e.TemplatesDir)
	case os.IsNotExist(err):
		return DirAbsent, err
	default:
		return DirUnreadable, err
	}
}

// TemplatesInstalled reports whether the templates directory is present AND
// usable. Templates ship with bloxsmith (committed in go/templates, bundled by
// goreleaser); a bare `go build` dev tree legitimately lacks them.
//
// Callers that show the operator a REASON must use TemplatesDirState instead —
// a bool cannot tell absent from unreadable, and those need opposite advice.
func (e *Engine) TemplatesInstalled() bool {
	state, _ := e.TemplatesDirState()
	return state == DirPresent
}

// templatesMissingMsg is the advice for a directory that genuinely is not there:
// get the build that bundles them.
const templatesMissingMsg = "templates not installed — use the release archive or container image (which bundle them), or add YAML templates to the templates directory"

// TemplatesUnavailable returns the operator-facing sentence for a templates
// directory that cannot be used, or "" when it can.
//
// The two branches deliberately give OPPOSITE advice. Re-pulling the image fixes
// an absent directory and does nothing at all for an unreadable one, so the
// unreadable branch must not mention it.
func (e *Engine) TemplatesUnavailable() string {
	switch state, err := e.TemplatesDirState(); state {
	case DirPresent:
		return ""
	case DirAbsent:
		return templatesMissingMsg
	default:
		return fmt.Sprintf("the templates directory at %s exists but could not be read: %s — this is a permission or mount problem on this host, not a missing install",
			e.TemplatesDir, err)
	}
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
	if unavailable := e.TemplatesUnavailable(); unavailable != "" {
		return nil, perr("%s", unavailable)
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
		if unavailable := e.TemplatesUnavailable(); unavailable != "" {
			return nil, perr("%s", unavailable)
		}
		// NOT FOUND IS ONE REASON A READ FAILS, NOT ALL OF THEM. Every failure
		// here used to be reported as "template not found", so a template the
		// operator can see in the directory listing was described as absent and
		// they had nowhere to go. Only os.IsNotExist earns that sentence. #134
		if !os.IsNotExist(err) {
			return nil, perr("template %s exists but could not be read: %s", name, err.Error())
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

// listField answers the question getList cannot. asList returns nil for any
// non-list, and a nil list iterates zero times, so `subnets: web` and no
// `subnets` key at all produced byte-identical validation output: clean, with
// no error and no warning. Only one of those is a template bug, and it was the
// invisible one — TemplateToSiteConfig (site.go:56) reads the same key through
// the same helper, so a mis-typed subnets provisioned a site with zero subnets
// and nothing anywhere said so (#92).
//
// An explicit YAML null is ABSENT, not wrong-shaped. `subnets:` with nothing
// after it is how a person leaves a key out while keeping it visible; calling
// that a type error would start rejecting templates that are fine today.
func listField(t M, key string) (items []any, wrongShape bool) {
	raw, present := t[key]
	if !present || raw == nil {
		return nil, false
	}
	if l := asList(raw); l != nil {
		return l, false
	}
	return nil, true
}

// listOrErr is the shared reporting half: it records "Must be a list" and tells
// the caller to stop looking at that field. Callers must treat wrong-shape and
// empty-or-absent as MUTUALLY EXCLUSIVE — a string `zones` is one error about
// its type, never that plus "Required and must be a non-empty list", which
// would tell an operator to add entries to a key whose problem is that it is
// not a list.
func (v *validator) listOrErr(t M, key, field string) ([]any, bool) {
	items, wrong := listField(t, key)
	if wrong {
		v.err(field, "Must be a list")
		return nil, false
	}
	return items, true
}

// The DHCP offset defaults createDHCPRange (site.go) falls back to when a subnet
// leaves dhcp_start / dhcp_end unset. Named here because validation has to apply
// the SAME values: an omitted offset is not an unchecked offset — it is 10 or
// 250, and on a small subnet 250 is the one that does the damage.
const (
	dhcpStartDefault = 10
	dhcpEndDefault   = 250
)

// maxHostOffset is the largest host offset a /cidr can hold: 2^(32-cidr) - 2,
// excluding the network address at offset 0 and the broadcast address at the
// top. For a /24 that is 254, which is exactly where validation's old hardcoded
// 1-254 came from — the constant was the /24 special case of this rule, applied
// to every subnet size.
//
// Returns false outside 8-30, the range validated elsewhere, so a cidr already
// reported as bad does not also produce a derived offset error on top of it.
func maxHostOffset(cidr int) (int, bool) {
	if cidr < 8 || cidr > 30 {
		return 0, false
	}
	return 1<<(32-cidr) - 2, true
}

// effectiveSubnetSize resolves the subnet size a template implies when a subnet
// carries no cidr of its own: network.subnet_size, else 24. Mirrors
// TemplateToSiteConfig's `resolve(params, netSec["subnet_size"], "24")` and
// createDHCPRange's `scidr := p.cfg.SubnetSize` fallback.
func effectiveSubnetSize(net M) (int, bool) {
	if net["subnet_size"] == nil {
		return 24, true
	}
	return intCoerce(net["subnet_size"])
}

// subnetCidr is the size THIS subnet will be provisioned at: its own cidr, else
// the template's default. Returns false when neither resolves to an integer —
// the caller then checks nothing, because a cidr that is not a number already
// has its own error.
func subnetCidr(sm, net M) func() (int, bool) {
	return func() (int, bool) {
		if sm["cidr"] != nil {
			return intCoerce(sm["cidr"])
		}
		return effectiveSubnetSize(net)
	}
}

// dhcpOffsets checks dhcp_start / dhcp_end against the subnet that will actually
// hold them, rather than against a constant.
//
// ERROR vs WARNING is decided by WHO chose the value. An offset the operator
// wrote and that cannot be honoured is an error — refusing before the first
// write costs nothing and the fix is one line. An offset that is only our
// default is a warning, because failing someone's whole template (and blocking
// its subnets, zone and hosts along with it) over a number we picked is
// disproportionate; createDHCPRange skips and reports that case at runtime.
func (v *validator) dhcpOffsets(sm M, pfx string, cidrOf func() (int, bool)) {
	// Ordering is checked on the RESOLVED pair, so an explicit start above a
	// defaulted end is caught too. Both endpoints can be legal addresses inside
	// the subnet and still describe a backwards range (#132).
	start, startExplicit, startOK := resolvedOffset(sm, "dhcp_start", dhcpStartDefault)
	end, endExplicit, endOK := resolvedOffset(sm, "dhcp_end", dhcpEndDefault)
	for _, k := range []string{"dhcp_start", "dhcp_end"} {
		if sm[k] != nil {
			if _, ok := intCoerce(sm[k]); !ok {
				v.err(pfx+"."+k, fmt.Sprintf("Must be an integer, got %s", pyRepr(sm[k])))
			}
		}
	}
	if !startOK || !endOK {
		return // already reported as a bad type; do not stack a derived error
	}
	if start > end {
		report := v.err
		if !startExplicit && !endExplicit {
			report = v.warn
		}
		report(pfx+".dhcp_start", fmt.Sprintf(
			"Start offset %d is above end offset %d, which describes a backwards range", start, end))
	}
	cidr, cidrOK := cidrOf()
	if !cidrOK {
		return
	}
	max, ok := maxHostOffset(cidr)
	if !ok {
		return // cidr out of range; its own error already says so
	}
	for _, o := range []struct {
		key      string
		val      int
		explicit bool
	}{{"dhcp_start", start, startExplicit}, {"dhcp_end", end, endExplicit}} {
		if o.val >= 1 && o.val <= max {
			continue
		}
		msg := fmt.Sprintf("Host offset %d is outside 1-%d for a /%d subnet", o.val, max, cidr)
		if o.explicit {
			v.err(pfx+"."+o.key, msg)
			continue
		}
		v.warn(pfx+"."+o.key, msg+
			" — it is the default, so no DHCP range will be created; set it explicitly or use a larger subnet")
	}
}

// resolvedOffset returns the offset provisioning will actually use, whether the
// operator wrote it, and whether it resolved at all.
func resolvedOffset(sm M, key string, def int) (val int, explicit, ok bool) {
	if sm[key] == nil {
		return def, false, true
	}
	n, parsed := intCoerce(sm[key])
	if !parsed {
		return 0, true, false
	}
	return n, true, true
}

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
	subnetDefs, subnetsOK := v.listOrErr(net, "subnets", "network.subnets")
	for i, s := range subnetDefs {
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
			v.dhcpOffsets(sm, pfx, subnetCidr(sm, net))
		}
	}
	// The SYNTHESIZED default subnet plan is checked too. With no network.subnets
	// key, TemplateToSiteConfig (site.go:100-108) substitutes three subnets, one
	// of them dhcp:true with no offsets — so the loop above runs zero times while
	// provisioning still creates a DHCP range at offsets 10-250. That is the
	// commonest way into #131 and it used to validate spotlessly.
	//
	// A warning, not an error: 10 and 250 are OUR defaults, not something the
	// operator wrote. valid:false greys the template out of the site dropdown
	// entirely (Provision.jsx), which would block its block, subnets, zone and
	// hosts over a DHCP range that createDHCPRange now skips and reports.
	if subnetsOK && len(subnetDefs) == 0 {
		if cidr, ok := effectiveSubnetSize(net); ok {
			if max, ok := maxHostOffset(cidr); ok && dhcpEndDefault > max {
				v.warn("network.subnet_size", fmt.Sprintf(
					"A /%d subnet cannot hold the default DHCP range (offsets %d-%d), so no DHCP range will be created; define network.subnets with explicit dhcp_start/dhcp_end, or use a larger subnet_size",
					cidr, dhcpStartDefault, dhcpEndDefault))
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

	hostDefs, _ := v.listOrErr(t, "hosts", "hosts")
	for i, h := range hostDefs {
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
		// subnetsOK guards this: when network.subnets was the wrong shape,
		// subnetNames is empty for a reason that has nothing to do with the
		// host, and accusing every host of referencing an unknown subnet would
		// bury the one error that matters under N derived ones.
		if ref != "" && subnetsOK && len(subnetNames) > 0 && !subnetNames[ref] {
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
	// Wrong shape and empty are mutually exclusive: a string address_blocks is
	// one error about its type, never that plus "add some entries".
	blocks, ok := v.listOrErr(t, "address_blocks", "address_blocks")
	if ok && len(blocks) == 0 {
		v.err("address_blocks", "Required and must be a non-empty list")
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
		children, _ := v.listOrErr(bm, "children", pfx+".children")
		for j, child := range children {
			check(child, fmt.Sprintf("%s.children[%d]", pfx, j), nn)
		}
	}
	for i, b := range blocks {
		check(b, fmt.Sprintf("address_blocks[%d]", i), nil)
	}
}

// validateDNS is _validate_dns (server.py:1260).
func validateDNS(t M, v *validator) {
	// "Required and must be a non-empty list" was the message a STRING zones got
	// too, which tells an operator to add entries to a key whose actual problem
	// is that it is not a list. The two are separate answers now.
	zones, ok := v.listOrErr(t, "zones", "zones")
	if ok && len(zones) == 0 {
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
		records, _ := v.listOrErr(zm, "records", pfx+".records")
		for j, rec := range records {
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
// A TEMPLATE THAT CANNOT BE READ IS AN INVALID TEMPLATE, NOT AN ABSENT ONE.
//
// Every failure below used to `continue`: a file with a typo in its YAML, a file
// the process cannot open, a file that parses into something other than a
// mapping, and any directory the walk could not descend into. All four
// disappeared from the list with no error and no trace, so an operator saw a
// shorter list and had nothing to act on. Meanwhile a template that PARSES and
// then fails schema validation was listed with valid:false — the two failures
// got opposite treatment, and the hidden one is the one that needs a person.
//
// The row shape is the fix. GET /api/templates returns this slice DIRECTLY as a
// JSON array (server/provision.go), and the UI reads it as
// `Array.isArray(data) ? data : []`, so turning the response into an object to
// carry a warnings field would break that contract. A scan failure is reported
// as an ordinary row with valid:false instead — which the site dropdown already
// renders disabled — plus a `kind` discriminator so a consumer can tell a broken
// template from a template that is merely invalid, and an `error` saying which.
//
// Returning an error instead was rejected: one unreadable subdirectory would
// then hide every good template behind it. #134
func scanErrorRow(name, why string) M {
	return M{
		"name": name, "kind": "scan-error", "type": "unknown",
		"site": "", "region": "", "environment": "",
		"valid": false, "error": why,
	}
}

// ListTemplates is list_templates (server.py:1931): recursively scan
// TemplatesDir for YAML templates and summarize each, skipping scaffolding.
// Anything it cannot read becomes a scan-error row rather than a silence.
func (e *Engine) ListTemplates() ([]M, error) {
	base, err := filepath.Abs(e.TemplatesDir)
	if err != nil {
		return nil, err
	}
	var paths []string
	var scanErrs []M
	if walkErr := filepath.Walk(base, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			// The walk could not descend here. Name it and keep going: the rest
			// of the tree is still worth listing, and the operator needs to know
			// this part was not searched.
			rel, relErr := filepath.Rel(base, p)
			if relErr != nil {
				rel = p
			}
			scanErrs = append(scanErrs, scanErrorRow(rel, "could not be searched: "+err.Error()))
			return nil
		}
		if info.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(p))
		if ext == ".yaml" || ext == ".yml" {
			paths = append(paths, p)
		}
		return nil
	}); walkErr != nil {
		scanErrs = append(scanErrs, scanErrorRow(".", "could not be searched: "+walkErr.Error()))
	}
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
			out = append(out, scanErrorRow(rel, "could not be read: "+err.Error()))
			continue
		}
		var data any
		if err := yaml.Unmarshal(raw, &data); err != nil {
			out = append(out, scanErrorRow(rel, "is not valid YAML: "+err.Error()))
			continue
		}
		dm := asMap(normalizeYAML(data))
		if dm == nil {
			out = append(out, scanErrorRow(rel, "is valid YAML but not a mapping at the top level, so it cannot be a template"))
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
	return append(out, scanErrs...), nil
}

// SiteTemplateRelPaths is the seed-demo template discovery (server.py:5587 /
// 5700): for each region, find TemplatesDir/<region>/*/site-*.yaml, sorted, and
// return each path relative to TemplatesDir (the form LoadTemplate accepts).
//
// It also returns the regions it could NOT read, which is the whole point of
// the second return value. It had none: seed-demo walked the regions the
// operator ticked, silently found no templates in one, provisioned zero sites
// for it, and streamed a summary saying every template it tried had succeeded.
// An operator got two regions instead of three with no failure to explain it.
//
// WHY os.ReadDir AND NOT os.Stat + filepath.Glob, which is what this used to do
// and what the obvious fix would keep. Measured on this repo's own platform
// against a 0000 directory:
//
//	os.Stat(0000 dir): err=<nil> isDir=true
//	filepath.Glob:     matches=[] err=<nil>
//	os.ReadDir:        err=open ...: permission denied
//
// os.Stat succeeds because it only needs the PARENT traversable, and Glob
// documents that it "ignores file system errors such as I/O errors reading
// directories". A guard built on those two would have reported a clean read of
// a directory it could not open — a guard that never fires. os.ReadDir is the
// only one of the three that tells the truth.
//
// A region that is ABSENT, or present and readable but holding no matching
// templates, is NOT unreadable. Those are real answers; this reports the case
// where there is no answer. #134
func (e *Engine) SiteTemplateRelPaths(regions []string) (paths []string, unreadable []string) {
	base, err := filepath.Abs(e.TemplatesDir)
	if err != nil {
		return nil, regions
	}
	for _, region := range regions {
		regionDir := filepath.Join(base, region)
		subdirs, err := os.ReadDir(regionDir)
		if err != nil {
			if !os.IsNotExist(err) {
				unreadable = append(unreadable, region)
			}
			continue
		}
		var matches []string
		for _, sd := range subdirs {
			if !sd.IsDir() {
				continue
			}
			inner := filepath.Join(regionDir, sd.Name())
			files, err := os.ReadDir(inner)
			if err != nil {
				// One unreadable sub-directory makes the region's answer
				// incomplete, and an incomplete answer is not a shorter one.
				unreadable = append(unreadable, region)
				break
			}
			for _, f := range files {
				if f.IsDir() {
					continue
				}
				if strings.HasPrefix(f.Name(), "site-") && strings.HasSuffix(f.Name(), ".yaml") {
					matches = append(matches, filepath.Join(inner, f.Name()))
				}
			}
		}
		sort.Strings(matches)
		for _, m := range matches {
			if rel, err := filepath.Rel(base, m); err == nil {
				paths = append(paths, rel)
			}
		}
	}
	return paths, unreadable
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
