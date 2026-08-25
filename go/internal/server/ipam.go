package server

import (
	"encoding/json"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"

	"bloxsmith/internal/edit"
	"bloxsmith/internal/rest"
)

// registerIPAMReadRoutes wires the IPAM/DNS read helpers the resource editor +
// self-service wizard use (server.py 5296-5430): ipam/spaces, ipam/blocks,
// dns/zones, dns/records (GET), ipam/addresses (GET), ipam/availability,
// ipam/subnets. Each is a thin, shaped REST passthrough. A bad filter value
// (rest.CSPQ / CSPQField) maps to Python's ValueError -> HTTP 400.
func (d *Deps) registerIPAMReadRoutes(mux router) {
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
	spaces, ok := d.getStrictOrErr(w, r, "/api/ddi/v1/ipam/ip_space", nil)
	if !ok {
		return
	}
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
	blocks, ok := d.getStrictOrErr(w, r, "/api/ddi/v1/ipam/address_block", params)
	if !ok {
		return
	}
	d.json(w, r, 200, map[string]any{"blocks": pick(blocks, "id", "address", "cidr", "name", "tags")})
}

// parseListLimit validates the shared `_limit` query param used by the
// paginated list handlers below. Absent -> default 200. Present -> must be an
// integer in 1..999 (capped below 1000 so limit+1 is always a genuine
// truncation probe upstream, never clamped back down). On an invalid value
// it writes the 400 itself and returns ok=false so the caller returns
// immediately.
func (d *Deps) parseListLimit(w http.ResponseWriter, r *http.Request) (limit int, ok bool) {
	raw := r.URL.Query().Get("_limit")
	if raw == "" {
		return 200, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > 999 {
		d.json(w, r, 400, map[string]any{"error": "_limit must be an integer between 1 and 999"})
		return 0, false
	}
	return n, true
}

// numFromAny coerces a decoded JSON number (float64) or json.Number to an int,
// used when reading a total out of an upstream envelope of unknown shape.
func numFromAny(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		return int(t), true
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return int(i), true
		}
	case int:
		return t, true
	}
	return 0, false
}

// findTotal hunts an upstream response body for a pagination total. The
// authoritative shape, confirmed by fetchCount/pageTotalSize in
// internal/dashboard (dashboard.go:93-105, ai_tools.go:275-289), is
// body.page.total_size — a STRING that CSP only populates when the request
// carries _is_total_size_needed=true (which pagedFetch now sends). That
// string is parsed with strconv.Atoi (surrounding whitespace trimmed) and
// rejected if it's negative or unparseable — a genuine 0 (an empty subnet)
// is a valid, authoritative total. As a secondary path (kept so
// nothing regresses if CSP ever answers with a differently-shaped or
// numeric total) we also check total_size/total_count at the top level and
// inside a nested page/page_info object, accepting either a numeric or
// string value there too. "count" is deliberately excluded throughout: in
// many list envelopes it means "rows in this page", not the collection
// total. A candidate is also rejected if it's less than rowCount (the
// number of rows the upstream actually returned) — that's definitionally
// not a collection total. Never emit a total we can't stand behind.
func findTotal(body map[string]any, rowCount int) (int, bool) {
	if page, ok := body["page"].(map[string]any); ok {
		if s, ok := page["total_size"].(string); ok {
			if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && n >= 0 && n >= rowCount {
				return n, true
			}
		}
	}

	keys := []string{"total_size", "total_count"}
	numOrStr := func(v any) (int, bool) {
		if n, ok := numFromAny(v); ok {
			return n, true
		}
		if s, ok := v.(string); ok {
			if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
				return n, true
			}
		}
		return 0, false
	}
	for _, k := range keys {
		if n, ok := numOrStr(body[k]); ok && n >= rowCount {
			return n, true
		}
	}
	for _, nestKey := range []string{"page", "page_info"} {
		if nested, ok := body[nestKey].(map[string]any); ok {
			for _, k := range keys {
				if n, ok := numOrStr(nested[k]); ok && n >= rowCount {
					return n, true
				}
			}
		}
	}
	return 0, false
}

// upstreamMsgKeys are the only upstream error-body fields ever surfaced to a
// client. This IS the security boundary: allowlisting specific fields, never
// regex-scrubbing and forwarding arbitrary upstream text.
var upstreamMsgKeys = []string{"error", "message", "detail"}

// upstreamArrayKeys are the top-level keys whose value, when a JSON array, is
// treated as a list of error objects (CSP's actual shape for a bad filter:
// {"error":[{"message":"Unknown field: subnet"}]}). Only the first element is
// consulted.
var upstreamArrayKeys = []string{"error", "errors"}

// upstreamArrayElemKeys is the field-priority used inside an array element:
// message first (CSP's actual field for this shape), then error, then detail.
var upstreamArrayElemKeys = []string{"message", "error", "detail"}

// upstreamMsgMaxLen bounds the extracted message before it reaches a client.
const upstreamMsgMaxLen = 200

// stringField returns the first of keys present in m with a non-empty string
// value. A non-string value (nested object, number, etc.) is not a match —
// only a plain string is ever considered "recognised".
func stringField(m map[string]any, keys []string) (string, bool) {
	for _, k := range keys {
		if s, ok := m[k].(string); ok && s != "" {
			return s, true
		}
	}
	return "", false
}

// truncateRunes bounds s to at most n runes (not bytes), so a multi-byte
// character is never split.
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// extractUpstreamMessage pulls an allowlisted, human-readable message out of
// an upstream JSON error body (a bounded rest.UpstreamError.Snippet). It tries
// error/message/detail at the top level, then one level down inside a nested
// "status" or "error" object (CSP sometimes wraps its real message there,
// e.g. {"status":{"message":"..."}}), then — CSP's actual shape for a bad
// filter — an "error"/"errors" key whose value is an ARRAY of objects, e.g.
// {"error":[{"message":"Unknown field: subnet"}]}: only the first element is
// consulted, and only if it is itself an object. Anything else — unparsable
// JSON, a non-object body, an array whose first element isn't an object, none
// of the recognised keys — is reported as not found, and the caller must omit
// the field entirely rather than fall back to dumping the raw snippet. The
// returned message is truncated to upstreamMsgMaxLen characters.
func extractUpstreamMessage(snippet string) (string, bool) {
	var parsed any
	if err := json.Unmarshal([]byte(snippet), &parsed); err != nil {
		return "", false
	}
	m, ok := parsed.(map[string]any)
	if !ok {
		return "", false
	}
	if msg, found := stringField(m, upstreamMsgKeys); found {
		return truncateRunes(msg, upstreamMsgMaxLen), true
	}
	for _, container := range []string{"status", "error"} {
		nested, ok := m[container].(map[string]any)
		if !ok {
			continue
		}
		if msg, found := stringField(nested, upstreamMsgKeys); found {
			return truncateRunes(msg, upstreamMsgMaxLen), true
		}
	}
	for _, arrKey := range upstreamArrayKeys {
		arr, ok := m[arrKey].([]any)
		if !ok || len(arr) == 0 {
			continue
		}
		first, ok := arr[0].(map[string]any)
		if !ok {
			continue
		}
		if msg, found := stringField(first, upstreamArrayElemKeys); found {
			return truncateRunes(msg, upstreamMsgMaxLen), true
		}
	}
	return "", false
}

// redactSnippet and logUpstreamError moved to internal/rest, beside the
// UpstreamError they describe, when the dashboard needed the same safe logging
// for its Axur probes. These stay as the names this file already uses.
func redactSnippet(s string) string { return rest.RedactSnippet(s) }

func logUpstreamError(ue *rest.UpstreamError) { rest.LogUpstreamError(ue) }

// writeUpstreamError answers a failed upstream fetch with a 502 that carries
// an allowlisted, size-bounded summary of WHY (never the raw body), and logs
// the full redacted, bounded snippet server-side. It takes the
// *rest.UpstreamError already produced by pagedFetch's single GetPageStrict
// call — it must NEVER re-issue the request to recover this information; that
// would double load on an already-failing upstream and risk reporting a
// different failure than the one that actually occurred.
func (d *Deps) writeUpstreamError(w http.ResponseWriter, r *http.Request, ue *rest.UpstreamError) {
	resp := map[string]any{"error": "upstream request failed", "status": ue.Status}
	logUpstreamError(ue)
	if msg, found := extractUpstreamMessage(ue.Snippet); found {
		resp["upstream"] = msg
	}
	d.json(w, r, 502, resp)
}

// getStrictOrErr issues path via GetStrict for the un-paginated dropdown
// handlers (spaces/blocks/zones/views/subnets). On a non-nil error it writes
// the shared 502 (via writeUpstreamError — the same error shape and log line
// every migrated handler in this file uses) and returns ok=false so the
// caller returns immediately without re-issuing the request. A genuinely
// empty upstream result is NOT an error — GetStrict only errors on a
// transport failure, non-2xx status, or undecodable/unshaped body — so it
// still flows through here as ok=true with a zero-length rows slice.
func (d *Deps) getStrictOrErr(w http.ResponseWriter, r *http.Request, path string, params map[string]string) (rows []any, ok bool) {
	rows, err := d.restFor(r).GetStrict(path, params)
	if err != nil {
		ue, isUE := err.(*rest.UpstreamError)
		if !isUE {
			// GetStrict only ever returns *rest.UpstreamError; this fallback
			// is defensive, not a path exercised in practice.
			ue = &rest.UpstreamError{Path: path}
		}
		d.writeUpstreamError(w, r, ue)
		return nil, false
	}
	return rows, true
}

// pagedFetch runs the shared upstream-fetch + truncation-metadata logic used
// by dnsRecordsGet and ipamAddressesGet. It issues a SINGLE upstream request
// for limit+1 rows (limit is capped at 999 by parseListLimit, so limit+1
// never exceeds 1000), asking CSP for the authoritative total via
// _is_total_size_needed=true (the same param fetchCount uses in
// internal/dashboard/dashboard.go), and derives both the total (if a
// trustworthy candidate is present in that one response — see findTotal)
// and truncated (true iff more than `limit` rows came back, used only when
// no total was found) from it — never a second fetch. On an upstream
// failure it writes the 502 itself and returns ok=false.
func (d *Deps) pagedFetch(w http.ResponseWriter, r *http.Request, path string, params map[string]string, limit int) (rows []any, extra map[string]any, ok bool) {
	// Copy params so we don't mutate the caller's map when adding _limit.
	p := map[string]string{}
	for k, v := range params {
		p[k] = v
	}

	p["_limit"] = strconv.Itoa(limit + 1)
	p["_is_total_size_needed"] = "true"
	fetchRows, body, err := d.restFor(r).GetPageStrict(path, p)
	if err != nil {
		ue, ok := err.(*rest.UpstreamError)
		if !ok {
			// GetPageStrict only ever returns *rest.UpstreamError; this
			// fallback is defensive, not a path exercised in practice.
			ue = &rest.UpstreamError{Path: path}
		}
		d.writeUpstreamError(w, r, ue)
		return nil, nil, false
	}

	rowCount := len(fetchRows)
	truncated := rowCount > limit
	if truncated {
		fetchRows = fetchRows[:limit]
	}

	if body != nil {
		if total, found := findTotal(body, rowCount); found {
			return fetchRows, map[string]any{"total": total, "limit": limit}, true
		}
	}
	return fetchRows, map[string]any{"truncated": truncated, "limit": limit}, true
}

func (d *Deps) dnsZones(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/dns/zones")
	view := r.URL.Query().Get("view")
	views, ok := d.getStrictOrErr(w, r, "/api/ddi/v1/dns/view", nil)
	if !ok {
		return
	}
	var zoneParams map[string]string
	if view != "" {
		esc, err := rest.CSPQ(view)
		if err != nil {
			d.json(w, r, 400, map[string]any{"error": err.Error()})
			return
		}
		zoneParams = map[string]string{"_filter": `view=="` + esc + `"`}
	}
	zones, ok := d.getStrictOrErr(w, r, "/api/ddi/v1/dns/auth_zone", zoneParams)
	if !ok {
		return
	}
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
	limit, ok := d.parseListLimit(w, r)
	if !ok {
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
	records, extra, ok := d.pagedFetch(w, r, "/api/ddi/v1/dns/record",
		map[string]string{"_filter": strings.Join(filt, " and ")}, limit)
	if !ok {
		return
	}
	resp := map[string]any{
		"records": pick(records, "id", "name_in_zone", "type", "ttl", "dns_rdata", "comment", "disabled"),
	}
	for k, v := range extra {
		resp[k] = v
	}
	d.json(w, r, 200, resp)
}

func (d *Deps) ipamAddressesGet(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/ipam/addresses")
	subnet := strings.TrimSpace(r.URL.Query().Get("subnet"))
	if subnet == "" {
		d.json(w, r, 400, map[string]any{"error": "subnet is required"})
		return
	}
	limit, ok := d.parseListLimit(w, r)
	if !ok {
		return
	}
	esc, err := rest.CSPQ(subnet)
	if err != nil {
		d.json(w, r, 400, map[string]any{"error": err.Error()})
		return
	}
	addrs, extra, ok := d.pagedFetch(w, r, "/api/ddi/v1/ipam/address",
		map[string]string{"_filter": `parent=="` + esc + `"`}, limit)
	if !ok {
		return
	}
	resp := map[string]any{
		"addresses": pick(addrs, "id", "address", "name", "comment", "state"),
	}
	for k, v := range extra {
		resp[k] = v
	}
	d.json(w, r, 200, resp)
}

// utilInt coerces one CSP utilization value to an address COUNT. It is stricter
// than this file's numFromAny on purpose, because its output is subtracted:
// a value that is not a whole, non-negative number is not a count, and guessing
// one produces a number the operator has no way to tell from a measurement.
//
// The string case is not defensive padding. CSP returns numerics as JSON strings
// elsewhere in this very file — findTotal's doc records page.total_size arriving
// as "a STRING" — and the old code accepted a string `total` through firstTruthy
// and then silently read it as 0 one line later.
func utilInt(v any) (int, bool) {
	switch t := v.(type) {
	case int:
		return t, t >= 0
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) || t != math.Trunc(t) || t < 0 || t > math.MaxInt32 {
			return 0, false
		}
		return int(t), true
	case json.Number:
		n, err := strconv.Atoi(strings.TrimSpace(t.String()))
		return n, err == nil && n >= 0
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(t))
		return n, err == nil && n >= 0
	}
	return 0, false
}

// firstReported returns the first of keys whose value is PRESENT and non-nil.
//
// Not firstTruthy, which is what this handler used: truthiness discards a
// REPORTED capacity of zero and moves on to the next field, turning a real
// measurement into a different subnet's number. internal/dashboard/norm.go
// records this exact trap for this exact data and fixed it the same way —
// "key PRESENCE is the test, not truthiness".
func firstReported(m map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return v
		}
	}
	return nil
}

func (d *Deps) ipamAvailability(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/ipam/availability")
	subnet := strings.TrimSpace(r.URL.Query().Get("subnet"))
	if subnet == "" {
		d.json(w, r, 400, map[string]any{"error": "subnet is required"})
		return
	}
	// This used to be a bare-id regex plus a hardcoded "ipam/subnet/" prefix,
	// so it refused the FULL-FORM id every list endpoint hands out (400 on the
	// only id a caller could realistically hold) and doubled the prefix on the
	// bare one. ObjectPath is the validator the rest of the codebase uses: it
	// takes both shapes, refuses traversal, and builds the path once.
	objPath, err := edit.ObjectPath("ipam/subnet", subnet)
	if err != nil {
		d.json(w, r, 400, map[string]any{"error": "invalid subnet id"})
		return
	}
	body, status, getErr := d.restFor(r).GetEx(objPath,
		map[string]string{"_fields": "id,address,cidr,utilization"})
	m, ok := body.(map[string]any)
	if status != 200 || !ok {
		// A 200 whose body is not an object used to be answered with HTTP 200
		// and an error message inside it — a reply that contradicts itself, the
		// same shape removed from the update builders. Any outcome that is not a
		// readable 200 object is now a 502.
		//
		// API BEHAVIOUR CHANGE, stated rather than slipped in: a caller that saw
		// 200-with-an-error now sees 502. Nothing in this repo calls this route,
		// but an outside consumer could.
		//
		// The GetEx error is LOGGED, never returned: this file's error path is an
		// allowlist boundary (see extractUpstreamMessage) and a raw Go error can
		// carry the upstream URL and decoder internals.
		st := status
		if st == 0 || st == 200 {
			st = 502
		}
		if getErr != nil {
			log.Printf("[upstream] path=%s status=%d category=availability err=%v", objPath, status, getErr)
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
	total := firstReported(util, "total", "dhcp_total", "static_total")
	utilization := map[string]any{"used": used, "total": total,
		"pct": firstReported(util, "utilization", "percent", "pct")}

	// free is REPORTED, or DERIVED from two values that both parse, or ABSENT.
	// It is never 0 by accident: the old arithmetic read a string "254" as 0 and
	// answered free:0 for a subnet with 244 addresses left, which reads exactly
	// like a measured full subnet. An over-subscribed range (used > total) is
	// also left absent rather than reported as a negative count.
	if free, reported := util["free"]; reported && free != nil {
		utilization["free"] = free
	} else if u, uOK := utilInt(used); uOK {
		if t, tOK := utilInt(total); tOK && u <= t {
			utilization["free"] = t - u
		}
	}

	d.json(w, r, 200, map[string]any{
		"id": s["id"], "address": s["address"], "cidr": s["cidr"],
		"utilization": utilization,
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
	subnets, ok := d.getStrictOrErr(w, r, "/api/ddi/v1/ipam/subnet", params)
	if !ok {
		return
	}
	d.json(w, r, 200, map[string]any{
		"subnets": pick(subnets, "id", "address", "cidr", "name", "utilization"),
	})
}
