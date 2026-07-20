package server

import (
	"net/http"
	"strings"

	"bloxsmith/internal/rest"
)

// registerIPAMReadRoutes wires the IPAM/DNS read helpers the resource editor +
// self-service wizard use (server.py 5296-5430): ipam/spaces, ipam/blocks,
// dns/zones, dns/records (GET), ipam/addresses (GET), ipam/availability,
// ipam/subnets. Each is a thin, shaped REST passthrough. A bad filter value
// (rest.CSPQ / CSPQField) maps to Python's ValueError -> HTTP 400.
func (d *Deps) registerIPAMReadRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/ipam/spaces", d.ipamSpaces)
	mux.HandleFunc("GET /api/ipam/blocks", d.ipamBlocks)
	mux.HandleFunc("GET /api/dns/zones", d.dnsZones)
	mux.HandleFunc("GET /api/dns/records", d.dnsRecordsGet)
	mux.HandleFunc("GET /api/ipam/addresses", d.ipamAddressesGet)
	mux.HandleFunc("GET /api/ipam/availability", d.ipamAvailability)
	mux.HandleFunc("GET /api/ipam/subnets", d.ipamSubnets)
}

// getMap coerces a decoded JSON element to an object (Python row dict).
func getMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// pick projects the named keys of every row into a new list (Python's list
// comprehension over r.get(k)).
func pick(rows []any, keys ...string) []any {
	out := []any{}
	for _, ri := range rows {
		r := getMap(ri)
		row := map[string]any{}
		for _, k := range keys {
			row[k] = r[k]
		}
		out = append(out, row)
	}
	return out
}

func (d *Deps) ipamSpaces(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/ipam/spaces")
	spaces := d.Rest.Get("/api/ddi/v1/ipam/ip_space", nil)
	d.json(w, r, 200, map[string]any{"spaces": pick(spaces, "id", "name")})
}

func (d *Deps) ipamBlocks(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/ipam/blocks")
	q := r.URL.Query()
	params := map[string]string{}
	var filt []string
	if v := q.Get("space"); v != "" {
		esc, err := rest.CSPQ(v)
		if err != nil {
			d.json(w, r, 400, map[string]any{"error": err.Error()})
			return
		}
		filt = append(filt, `space=="`+esc+`"`)
	}
	if len(filt) > 0 {
		params["_filter"] = strings.Join(filt, " and ")
	}
	if q.Get("tag_key") != "" && q.Get("tag_value") != "" {
		field, err := rest.CSPQField(q.Get("tag_key"))
		if err != nil {
			d.json(w, r, 400, map[string]any{"error": err.Error()})
			return
		}
		val, err := rest.CSPQ(q.Get("tag_value"))
		if err != nil {
			d.json(w, r, 400, map[string]any{"error": err.Error()})
			return
		}
		params["_tfilter"] = field + `=="` + val + `"`
	}
	blocks := d.Rest.Get("/api/ddi/v1/ipam/address_block", params)
	d.json(w, r, 200, map[string]any{"blocks": pick(blocks, "id", "address", "cidr", "name", "tags")})
}

func (d *Deps) dnsZones(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/dns/zones")
	view := r.URL.Query().Get("view")
	views := d.Rest.Get("/api/ddi/v1/dns/view", nil)
	var zoneParams map[string]string
	if view != "" {
		esc, err := rest.CSPQ(view)
		if err != nil {
			d.json(w, r, 400, map[string]any{"error": err.Error()})
			return
		}
		zoneParams = map[string]string{"_filter": `view=="` + esc + `"`}
	}
	zones := d.Rest.Get("/api/ddi/v1/dns/auth_zone", zoneParams)
	d.json(w, r, 200, map[string]any{
		"views": pick(views, "id", "name"),
		"zones": pick(zones, "id", "fqdn", "view"),
	})
}

func (d *Deps) dnsRecordsGet(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/dns/records")
	q := r.URL.Query()
	zone := strings.TrimSpace(q.Get("zone"))
	if zone == "" {
		d.json(w, r, 400, map[string]any{"error": "zone is required"})
		return
	}
	zoneEsc, err := rest.CSPQ(zone)
	if err != nil {
		d.json(w, r, 400, map[string]any{"error": err.Error()})
		return
	}
	filt := []string{`zone=="` + zoneEsc + `"`}
	if t := q.Get("type"); t != "" {
		esc, err := rest.CSPQ(strings.ToUpper(strings.TrimSpace(t)))
		if err != nil {
			d.json(w, r, 400, map[string]any{"error": err.Error()})
			return
		}
		filt = append(filt, `type=="`+esc+`"`)
	}
	if n := q.Get("name"); n != "" {
		esc, err := rest.CSPQ(n)
		if err != nil {
			d.json(w, r, 400, map[string]any{"error": err.Error()})
			return
		}
		filt = append(filt, `name_in_zone=="`+esc+`"`)
	}
	records := d.Rest.Get("/api/ddi/v1/dns/record", map[string]string{"_filter": strings.Join(filt, " and ")})
	d.json(w, r, 200, map[string]any{
		"records": pick(records, "id", "name_in_zone", "type", "ttl", "dns_rdata", "comment", "disabled"),
	})
}

func (d *Deps) ipamAddressesGet(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/ipam/addresses")
	subnet := strings.TrimSpace(r.URL.Query().Get("subnet"))
	if subnet == "" {
		d.json(w, r, 400, map[string]any{"error": "subnet is required"})
		return
	}
	esc, err := rest.CSPQ(subnet)
	if err != nil {
		d.json(w, r, 400, map[string]any{"error": err.Error()})
		return
	}
	addrs := d.Rest.Get("/api/ddi/v1/ipam/address", map[string]string{"_filter": `subnet=="` + esc + `"`})
	d.json(w, r, 200, map[string]any{
		"addresses": pick(addrs, "id", "address", "name", "comment", "state"),
	})
}

func (d *Deps) ipamAvailability(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/ipam/availability")
	subnet := strings.TrimSpace(r.URL.Query().Get("subnet"))
	if subnet == "" {
		d.json(w, r, 400, map[string]any{"error": "subnet is required"})
		return
	}
	body, status, _ := d.Rest.GetEx("/api/ddi/v1/ipam/subnet/"+subnet,
		map[string]string{"_fields": "id,address,cidr,utilization"})
	m, ok := body.(map[string]any)
	if status != 200 || !ok {
		st := status
		if st == 0 {
			st = 502
		}
		d.json(w, r, st, map[string]any{"error": "subnet lookup failed (status " + itoaStatus(status) + ")"})
		return
	}
	s := m
	if res, ok := m["result"].(map[string]any); ok {
		s = res
	}
	util := getMap(s["utilization"])
	used := util["used"]
	total := firstTruthy(util["total"], util["dhcp_total"], util["static_total"])
	free := util["free"]
	if free == nil && used != nil && total != nil {
		free = toIntAny(total) - toIntAny(used)
	}
	pct := firstTruthy(util["utilization"], util["percent"], util["pct"])
	d.json(w, r, 200, map[string]any{
		"id": s["id"], "address": s["address"], "cidr": s["cidr"],
		"utilization": map[string]any{"used": used, "total": total, "free": free, "pct": pct},
	})
}

func (d *Deps) ipamSubnets(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/ipam/subnets")
	q := r.URL.Query()
	var filt []string
	if v := q.Get("space"); v != "" {
		esc, err := rest.CSPQ(v)
		if err != nil {
			d.json(w, r, 400, map[string]any{"error": err.Error()})
			return
		}
		filt = append(filt, `space=="`+esc+`"`)
	}
	if v := q.Get("block"); v != "" {
		esc, err := rest.CSPQ(v)
		if err != nil {
			d.json(w, r, 400, map[string]any{"error": err.Error()})
			return
		}
		filt = append(filt, `parent=="`+esc+`"`)
	}
	var params map[string]string
	if len(filt) > 0 {
		params = map[string]string{"_filter": strings.Join(filt, " and ")}
	}
	subnets := d.Rest.Get("/api/ddi/v1/ipam/subnet", params)
	d.json(w, r, 200, map[string]any{
		"subnets": pick(subnets, "id", "address", "cidr", "name", "utilization"),
	})
}

// firstTruthy is Python's `a or b or c`: the first non-empty value, else the last.
func firstTruthy(vals ...any) any {
	for _, v := range vals {
		switch t := v.(type) {
		case nil:
		case string:
			if t != "" {
				return v
			}
		case float64:
			if t != 0 {
				return v
			}
		case bool:
			if t {
				return v
			}
		default:
			return v
		}
	}
	if len(vals) > 0 {
		return vals[len(vals)-1]
	}
	return nil
}

// toIntAny is Python int(x) for the free = total - used fallback.
func toIntAny(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	}
	return 0
}
