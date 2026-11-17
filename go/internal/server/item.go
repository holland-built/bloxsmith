package server

import (
	"net/http"
	"net/netip"
	"strconv"
	"strings"

	"bloxsmith/internal/edit"
	"bloxsmith/internal/rest"
)

// GET /api/item/{kind}?q=&space=&id=&view= — one network, IP space, DNS zone
// or site, for the item page (#dossier?kind=...). Read-only, like the search
// routes beside it, and it answers the same way: always 200, with
// availability ok | empty | unsupported | error in the body (search.go).
//
// An item is named by its value AND its scope, because the same CIDR can sit
// in two IP spaces and the same zone name in two DNS views. With id, the one
// object is read by id. Without it, the value is looked up inside the scope
// given, and every match comes back: the page shows a short chooser when there
// is more than one, rather than guessing.
//
// space and view each take an id ("ipam/ip_space/…", "dns/view/…") or a name.
// A name is turned into ids with one more read first.
//
// A site is not an object in Infoblox: it is the site (or location) tag the
// Network tables show, so a site's page lists the subnets tagged with it.
type itemSpec struct {
	path   string                          // collection read
	fields []string                        // what each row carries
	filter func(q string) (string, string) // value -> _filter, or why q cannot be one
	scope  string                          // "space", "view" or "" for none
}

var itemSpecs = map[string]itemSpec{
	"network": {
		path:   "/api/ddi/v1/ipam/subnet",
		fields: []string{"id", "address", "cidr", "name", "comment", "space", "tags", "utilization", "parent"},
		filter: func(q string) (string, string) {
			p, err := netip.ParsePrefix(q)
			if err != nil {
				return "", "a network is written as an address and a size, like 10.0.0.0/24"
			}
			return `address=="` + p.Addr().String() + `" and cidr==` + strconv.Itoa(p.Bits()), ""
		},
		scope: "space",
	},
	"space": {
		path:   "/api/ddi/v1/ipam/ip_space",
		fields: []string{"id", "name", "comment", "tags", "utilization"},
		filter: func(q string) (string, string) { return `name=="` + q + `"`, "" },
	},
	"zone": {
		path:   "/api/ddi/v1/dns/auth_zone",
		fields: []string{"id", "fqdn", "view", "comment", "tags", "primary_type", "disabled"},
		// fqdn is stored with its root dot ("acme.corp."); nobody types it.
		filter: func(q string) (string, string) {
			bare := strings.TrimSuffix(q, ".")
			return `fqdn=="` + bare + `." or fqdn=="` + bare + `"`, ""
		},
		scope: "view",
	},
	"site": {
		path:   "/api/ddi/v1/ipam/subnet",
		fields: []string{"id", "address", "cidr", "name", "space", "utilization"},
		scope:  "space", // filtered by tag, in itemGet
	},
}

// itemIDPrefix is the object kind an id must carry for each item kind.
var itemIDPrefix = map[string]string{
	"network": "ipam/subnet",
	"space":   "ipam/ip_space",
	"zone":    "dns/auth_zone",
}

func (d *Deps) registerItemRoutes(mux router) {
	mux.HandleFunc("GET /api/item/{kind}", d.itemGet)
}

func itemEmpty(reason string) map[string]any {
	return map[string]any{"availability": "empty", "reason": reason, "rows": []any{}}
}

func (d *Deps) itemGet(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/item")
	kind := r.PathValue("kind")
	spec, ok := itemSpecs[kind]
	if !ok {
		d.json(w, r, 404, map[string]any{"error": "unknown kind"})
		return
	}
	qs := r.URL.Query()
	params := map[string]string{"_fields": strings.Join(spec.fields, ",")}

	if id := strings.TrimSpace(qs.Get("id")); id != "" && itemIDPrefix[kind] != "" {
		prefix := itemIDPrefix[kind]
		_, err := edit.ObjectPath(prefix, id)
		esc, qerr := rest.CSPQ(id)
		if err != nil || qerr != nil || !strings.HasPrefix(id, prefix+"/") {
			d.json(w, r, 200, itemEmpty("that is not the id of a "+kind))
			return
		}
		params["_filter"] = `id=="` + esc + `"`
	} else {
		esc, bad := searchQuery(r)
		if bad != nil {
			d.json(w, r, 200, bad)
			return
		}
		if kind == "site" {
			params["_tfilter"] = `site=="` + esc + `" or Site=="` + esc + `" or location=="` + esc + `"`
		} else {
			f, why := spec.filter(esc)
			if why != "" {
				d.json(w, r, 200, itemEmpty(why))
				return
			}
			params["_filter"] = "(" + f + ")"
		}
		if spec.scope != "" {
			scope, found, ue := d.itemScope(r, spec.scope, qs.Get(spec.scope))
			if ue != nil {
				d.json(w, r, 200, searchUnavailable(ue))
				return
			}
			if !found {
				d.json(w, r, 200, searchResponse([]any{}, nil))
				return
			}
			if scope != "" {
				if params["_filter"] == "" {
					params["_filter"] = scope
				} else {
					params["_filter"] += " and " + scope
				}
			}
		}
	}

	rows, extra, ue := d.searchFetch(r, spec.path, params)
	if ue != nil {
		d.json(w, r, 200, searchUnavailable(ue))
		return
	}
	rows = pick(rows, spec.fields...)
	switch spec.scope {
	case "space":
		d.itemNames(r, rows, "space", "space_name", "/api/ddi/v1/ipam/ip_space")
	case "view":
		d.itemNames(r, rows, "view", "view_name", "/api/ddi/v1/dns/view")
	}
	d.json(w, r, 200, searchResponse(rows, extra))
}

// itemScope turns ?space= or ?view= into a filter clause. An id is used as
// given; a name is read first and becomes its ids. found is false when a name
// was given and nothing carries it, so the answer is a true "no match". A
// failed read comes back as ue, so it is reported as "could not read", never
// as "no such item".
func (d *Deps) itemScope(r *http.Request, field, v string) (clause string, found bool, ue *rest.UpstreamError) {
	v = strings.TrimSpace(v)
	if v == "" {
		return "", true, nil
	}
	esc, err := rest.CSPQ(v)
	if err != nil {
		return "", false, nil
	}
	prefix := map[string]string{"space": "ipam/ip_space/", "view": "dns/view/"}[field]
	if strings.HasPrefix(v, prefix) {
		return field + `=="` + esc + `"`, true, nil
	}
	path := map[string]string{"space": "/api/ddi/v1/ipam/ip_space", "view": "/api/ddi/v1/dns/view"}[field]
	rows, err := d.restFor(r).GetStrict(path, map[string]string{"_filter": `name=="` + esc + `"`, "_fields": "id"})
	if err != nil {
		e, isUE := err.(*rest.UpstreamError)
		if !isUE {
			e = &rest.UpstreamError{Path: path}
		}
		return "", false, e
	}
	if len(rows) == 0 {
		return "", false, nil
	}
	var parts []string
	for _, ri := range rows {
		if id := str(getMap(ri), "id"); id != "" {
			idEsc, _ := rest.CSPQ(id)
			parts = append(parts, field+`=="`+idEsc+`"`)
		}
	}
	return "(" + strings.Join(parts, " or ") + ")", true, nil
}

// itemNames adds the space's or view's name beside its id, so the page and
// the chooser can say "in Corp" rather than print an id. A failed read leaves
// the names out; the ids are still there.
func (d *Deps) itemNames(r *http.Request, rows []any, field, nameField, path string) {
	ids := map[string]bool{}
	var parts []string
	for _, ri := range rows {
		id := str(getMap(ri), field)
		if id == "" || ids[id] {
			continue
		}
		ids[id] = true
		esc, err := rest.CSPQ(id)
		if err == nil {
			parts = append(parts, `id=="`+esc+`"`)
		}
	}
	if len(parts) == 0 {
		return
	}
	got, err := d.restFor(r).GetStrict(path, map[string]string{"_filter": strings.Join(parts, " or "), "_fields": "id,name"})
	if err != nil {
		return
	}
	names := map[string]string{}
	for _, gi := range got {
		m := getMap(gi)
		names[str(m, "id")] = str(m, "name")
	}
	for _, ri := range rows {
		m := getMap(ri)
		if n := names[str(m, field)]; n != "" {
			m[nameField] = n
		}
	}
}
