package server

import (
	"fmt"
	"net/http"
	"net/netip"
	"sort"
	"strings"
)

// GET /api/edit/{type}/find?q= lists up to 25 existing items of one Editor
// type, each with the form's own field values, so Editor can offer "find the
// one to change" instead of asking for a pasted ID.
//
// Each type searches the fields CSP lets it filter on. CSP's ~ is a regular
// expression and answers 500 for ~ on some address fields (checked live on
// 2026-11-06: subnet address, range start), so a full IP is matched exactly
// there instead.
type editFindSpec struct {
	path   string
	text   []string // fields searched with ~
	ipEq   []string // fields matched exactly when q is a full IP
	label  func(m map[string]any) string
	fields func(m map[string]any) map[string]any
}

var editFindSpecs = map[string]editFindSpec{
	"dns_zone": {
		path: "/api/ddi/v1/dns/auth_zone", text: []string{"fqdn", "comment"},
		label: func(m map[string]any) string { return str(m, "fqdn") },
		fields: func(m map[string]any) map[string]any {
			return map[string]any{"fqdn": str(m, "fqdn"), "view": str(m, "view"), "comment": str(m, "comment"), "tags": tagsText(m["tags"])}
		},
	},
	"subnet": {
		path: "/api/ddi/v1/ipam/subnet", text: []string{"name", "comment"}, ipEq: []string{"address"},
		label: func(m map[string]any) string { return cidrLabel(m, str(m, "name")) },
		fields: func(m map[string]any) map[string]any {
			return map[string]any{"block_id": str(m, "parent"), "cidr": m["cidr"], "name": str(m, "name"), "comment": str(m, "comment"), "tags": tagsText(m["tags"])}
		},
	},
	"address_block": {
		path: "/api/ddi/v1/ipam/address_block", text: []string{"address", "comment"},
		label: func(m map[string]any) string { return cidrLabel(m, str(m, "comment")) },
		// Editor can only delete a block, so picking one needs just its ID.
		fields: func(map[string]any) map[string]any { return map[string]any{} },
	},
	"dhcp_range": {
		path: "/api/ddi/v1/ipam/range", text: []string{"comment"}, ipEq: []string{"start", "end"},
		label: func(m map[string]any) string { return str(m, "start") + " – " + str(m, "end") },
		fields: func(m map[string]any) map[string]any {
			return map[string]any{"start": str(m, "start"), "end": str(m, "end"), "space": str(m, "space"), "tags": tagsText(m["tags"])}
		},
	},
	"host": {
		path: "/api/ddi/v1/ipam/host", text: []string{"name", "comment"},
		label: func(m map[string]any) string { return str(m, "name") },
		fields: func(m map[string]any) map[string]any {
			var addrs []string
			if list, ok := m["addresses"].([]any); ok {
				for _, a := range list {
					if s := str(getMap(a), "address"); s != "" {
						addrs = append(addrs, s)
					}
				}
			}
			return map[string]any{"name": str(m, "name"), "addresses": strings.Join(addrs, ", "), "comment": str(m, "comment")}
		},
	},
}

func (d *Deps) editFind(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/edit/find")
	spec, ok := editFindSpecs[r.PathValue("type")]
	if !ok {
		d.json(w, r, 404, map[string]any{"error": "unknown type"})
		return
	}
	params := map[string]string{"_limit": "25"}
	if f := editFindFilter(spec, searchTerm(r.URL.Query().Get("q"))); f != "" {
		params["_filter"] = f
	}
	rows, ok := d.getStrictOrErr(w, r, spec.path, params)
	if !ok {
		return
	}
	items := []any{}
	for _, ri := range rows {
		m := getMap(ri)
		items = append(items, map[string]any{"id": str(m, "id"), "label": spec.label(m), "fields": spec.fields(m)})
	}
	d.json(w, r, 200, map[string]any{"items": items})
}

func editFindFilter(spec editFindSpec, q string) string {
	if q == "" {
		return ""
	}
	var parts []string
	if ip, err := netip.ParseAddr(q); err == nil && len(spec.ipEq) > 0 {
		for _, f := range spec.ipEq {
			parts = append(parts, f+`=="`+ip.String()+`"`)
		}
	} else {
		for _, f := range spec.text {
			parts = append(parts, f+`~"`+q+`"`)
		}
	}
	return strings.Join(parts, " or ")
}

func cidrLabel(m map[string]any, extra string) string {
	s := str(m, "address")
	if c, ok := numFromAny(m["cidr"]); ok {
		s = fmt.Sprintf("%s/%d", s, c)
	}
	if extra != "" {
		s += " — " + extra
	}
	return s
}

// tagsText writes tags the way the form takes them: "k=v, k2=v2", sorted.
func tagsText(v any) string {
	m, ok := v.(map[string]any)
	if !ok || len(m) == 0 {
		return ""
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, fmt.Sprintf("%s=%v", k, m[k]))
	}
	return strings.Join(out, ", ")
}
