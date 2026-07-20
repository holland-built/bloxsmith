// Package edit ports server.py's non-provisioning DNS + Cloud-Resource-Editor
// write builders: _dns_rdata (417), _dns_record_create/update (466/516),
// _selfservice_allocate (584, incl. plan 016's orphan-IP compensation), and the
// nine _edit_* create/update builders (697-1030). Each function validates its
// input, honours the dry-run preview, then goes through the shared rest.Client
// (the single outbound write path), returning (result, http_status) exactly like
// its Python counterpart. The HTTP routing, RBAC gate, and audit logging live in
// internal/server; this package is pure request→REST→response logic.
package edit

import (
	"fmt"
	"strconv"
	"strings"

	"bloxsmith/internal/rest"
)

// Client wraps the shared REST proxy. One per process (built in main.go).
type Client struct{ Rest *rest.Client }

// New binds the builders to the shared rest.Client.
func New(r *rest.Client) *Client { return &Client{Rest: r} }

// M is the (result, status) response shape every builder returns.
type M = map[string]any

// --- body coercion helpers (server.body decodes JSON with float64 numbers) ---

// strOr is Python `str(body.get(k) or "").strip()`: a falsy value (nil, "", 0,
// false) collapses to "", anything else is stringified and trimmed.
func strOr(b M, k string) string {
	v := b[k]
	if v == nil || isFalsy(v) {
		return ""
	}
	return strings.TrimSpace(pyStr(v))
}

// has is Python `body.get(k) is not None`: the key is present and non-null.
func has(b M, k string) bool { v, ok := b[k]; return ok && v != nil }

// pyStr mirrors Python str() for the scalar types a JSON body yields.
func pyStr(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case bool:
		if t {
			return "True"
		}
		return "False"
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'g', -1, 64)
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", t)
	}
}

// isFalsy mirrors Python truthiness for the value collapsing in strOr's `or ""`.
func isFalsy(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return t == ""
	case bool:
		return !t
	case float64:
		return t == 0
	case []any:
		return len(t) == 0
	case M:
		return len(t) == 0
	default:
		return false
	}
}

// boolPy is Python bool(x): a real bool passes through; a non-empty string /
// non-zero number / non-empty collection is truthy. Used by the two DNS-record
// paths, whose dry flag defaults to False (live) — unlike the _edit_*/allocate
// paths, which default to dry via truthyDry.
func boolPy(v any) bool { return !isFalsy(v) }

// truthy is _truthy (server.py:_truthy): nil -> default; real bool -> itself;
// otherwise str(v).strip().lower() not in {"0","false","no",""}.
func truthy(v any, def bool) bool {
	if v == nil {
		return def
	}
	if b, ok := v.(bool); ok {
		return b
	}
	s := strings.ToLower(strings.TrimSpace(pyStr(v)))
	switch s {
	case "0", "false", "no", "":
		return false
	}
	return true
}

// truthyDry is _truthy_dry: dry preview unless explicitly disabled (default true).
func truthyDry(v any) bool { return truthy(v, true) }

// intCoerce is Python int(x) for JSON scalars: (n, ok). float64/int strings ok;
// a fractional float truncates toward zero, matching int(3.9)==3 is NOT Python —
// Python int(3.9)==3 (truncates) so this matches. A bad string -> ok=false.
func intCoerce(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		return int(t), true
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(t)); err == nil {
			return n, true
		}
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// asMap type-asserts a REST response to a JSON object, else nil.
func asMap(v any) M {
	if m, ok := v.(M); ok {
		return m
	}
	return nil
}

// resultOrSelf is Python `resp.get("result") or resp`: prefer the "result"
// object, fall back to the whole body.
func resultOrSelf(resp any) any {
	if m := asMap(resp); m != nil {
		if r := m["result"]; !isFalsy(r) {
			return r
		}
	}
	return resp
}

// statusOr is Python `status or 502`: 0 (no HTTP response) -> fallback.
func statusOr(status, fallback int) int {
	if status == 0 {
		return fallback
	}
	return status
}

// --- _dns_rdata (server.py:417) ----------------------------------------------

// Rdata is _dns_rdata: presentation-format value -> API rdata dict, covering
// A/AAAA/CNAME/PTR/NS/DNAME/TXT/MX/SRV/CAA with a PRESENTATION fallback. Returns
// an error (mapped to 400 by callers) on a missing/malformed value.
func Rdata(rtype, value string) (M, error) {
	rt := strings.ToUpper(strings.TrimSpace(rtype))
	v := strings.TrimSpace(value)
	if v == "" {
		return nil, fmt.Errorf("rdata is required for %s records", rt)
	}
	switch rt {
	case "A", "AAAA":
		return M{"address": v}, nil
	case "CNAME":
		return M{"cname": v}, nil
	case "PTR", "NS":
		return M{"dname": v}, nil
	case "DNAME":
		return M{"target": v}, nil
	case "TXT":
		if len(v) >= 2 && strings.HasPrefix(v, `"`) && strings.HasSuffix(v, `"`) {
			v = v[1 : len(v)-1]
		}
		return M{"text": v}, nil
	case "MX":
		parts := fields(v, 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf(`MX rdata must be "preference exchange" (e.g. "10 mail.example.com."), got: '%s'`, v)
		}
		pref, err := strconv.Atoi(parts[0])
		if err != nil {
			return nil, fmt.Errorf("MX preference must be an integer, got: '%s'", parts[0])
		}
		return M{"preference": pref, "exchange": parts[1]}, nil
	case "SRV":
		parts := fields(v, 4)
		if len(parts) != 4 {
			return nil, fmt.Errorf(`SRV rdata must be "priority weight port target" (e.g. "10 0 443 host.example.com."), got: '%s'`, v)
		}
		pri, e1 := strconv.Atoi(parts[0])
		wt, e2 := strconv.Atoi(parts[1])
		port, e3 := strconv.Atoi(parts[2])
		if e1 != nil || e2 != nil || e3 != nil {
			return nil, fmt.Errorf("SRV rdata contains non-integer field")
		}
		return M{"priority": pri, "weight": wt, "port": port, "target": parts[3]}, nil
	case "CAA":
		parts := fields(v, 3)
		if len(parts) != 3 {
			return nil, fmt.Errorf(`CAA rdata must be "flags tag value" (e.g. "0 issue letsencrypt.org"), got: '%s'`, v)
		}
		flags, err := strconv.Atoi(parts[0])
		if err != nil {
			return nil, fmt.Errorf("CAA flags must be an integer, got: '%s'", parts[0])
		}
		return M{"flags": flags, "tag": parts[1], "value": parts[2]}, nil
	}
	return M{"subfields": []any{M{"type": "PRESENTATION", "value": v}}}, nil
}

// fields mirrors Python str.split(None, maxsplit): split on runs of whitespace,
// at most maxsplit+1 pieces, no empty leading/trailing tokens.
func fields(s string, max int) []string {
	all := strings.Fields(s)
	if max <= 0 || len(all) <= max {
		return all
	}
	head := all[:max-1]
	// rejoin the remainder as the final field, preserving its internal spacing
	// the way Python's maxsplit does (only relevant for TXT-like tails).
	rest := strings.TrimLeft(s, " \t\n")
	for _, f := range head {
		rest = strings.TrimPrefix(rest, f)
		rest = strings.TrimLeft(rest, " \t\n")
	}
	return append(append([]string{}, head...), rest)
}

// --- _dns_record_create (server.py:466) --------------------------------------

func (c *Client) DNSRecordCreate(body M) (M, int) {
	zoneID := strOr(body, "zone_id")
	rtype := strings.ToUpper(strOr(body, "type"))
	value := strOr(body, "value")
	dry := boolPy(body["dry"])

	nameRaw, nameSet := body["name_in_zone"]
	if rtype == "" {
		return M{"ok": false, "error": "type is required"}, 400
	}
	if zoneID == "" {
		return M{"ok": false, "error": "zone_id is required"}, 400
	}
	if !nameSet || nameRaw == nil || strings.TrimSpace(pyStr(nameRaw)) == "" {
		return M{"ok": false, "error": `name_in_zone is required (use "@" for the zone apex)`}, 400
	}
	if value == "" {
		return M{"ok": false, "error": fmt.Sprintf("value is required for %s records", rtype)}, 400
	}

	nameInZone := strings.TrimSpace(pyStr(nameRaw))
	if nameInZone == "@" {
		nameInZone = ""
	}

	rdata, err := Rdata(rtype, value)
	if err != nil {
		return M{"ok": false, "error": err.Error()}, 400
	}

	recordBody := M{"name_in_zone": nameInZone, "zone": zoneID, "type": rtype, "rdata": rdata}
	if has(body, "ttl") {
		ttl, ok := intCoerce(body["ttl"])
		if !ok {
			return M{"ok": false, "error": "ttl must be an integer"}, 400
		}
		recordBody["ttl"] = ttl
	}
	if !isFalsy(body["comment"]) {
		recordBody["comment"] = pyStr(body["comment"])
	}

	if dry {
		return M{"ok": true, "dry_run": true, "record": recordBody}, 200
	}

	resp, status, _ := c.Rest.Write("POST", "/api/ddi/v1/dns/record", recordBody, nil)
	if (status != 200 && status != 201) || resp == nil {
		return M{"ok": false, "error": fmt.Sprintf("create failed (status %d)", status), "detail": resp}, statusOr(status, 502)
	}
	return M{"ok": true, "record": resultOrSelf(resp)}, status
}

// --- _dns_record_update (server.py:516) --------------------------------------

func (c *Client) DNSRecordUpdate(body M) (M, int) {
	recordID := strOr(body, "id")
	if recordID == "" {
		return M{"ok": false, "error": "id is required"}, 400
	}
	dry := boolPy(body["dry"])

	current, curStatus, _ := c.Rest.GetEx("/api/ddi/v1/dns/record/"+recordID, nil)
	curMap := asMap(current)
	if curStatus != 200 || curMap == nil {
		return M{"ok": false, "error": fmt.Sprintf("record not found (status %d)", curStatus)}, statusOr(curStatus, 502)
	}
	curRecord := asMap(curMap["result"])
	if curRecord == nil {
		curRecord = curMap
	}
	curType := strings.ToUpper(pyStr(curRecord["type"]))

	updateBody := M{}
	if has(body, "value") {
		rdata, err := Rdata(curType, pyStr(body["value"]))
		if err != nil {
			return M{"ok": false, "error": err.Error()}, 400
		}
		updateBody["rdata"] = rdata
	}
	if has(body, "ttl") {
		ttl, ok := intCoerce(body["ttl"])
		if !ok {
			return M{"ok": false, "error": "ttl must be an integer"}, 400
		}
		updateBody["ttl"] = ttl
	}
	if has(body, "comment") {
		updateBody["comment"] = pyStr(body["comment"])
	}
	if has(body, "disabled") {
		updateBody["disabled"] = boolPy(body["disabled"])
	}
	if len(updateBody) == 0 {
		return M{"ok": false, "error": "no fields to update (value/ttl/comment/disabled)"}, 400
	}

	if dry {
		return M{"ok": true, "dry_run": true, "id": recordID, "would_update": updateBody}, 200
	}

	resp, status, method := c.patchThenPut("/api/ddi/v1/dns/record/"+recordID, updateBody)
	if (status != 200 && status != 201) || resp == nil {
		return M{"ok": false, "error": fmt.Sprintf("update failed (status %d)", status), "detail": resp, "method": method}, statusOr(status, 502)
	}
	return M{"ok": true, "method": method, "record": resultOrSelf(resp)}, 200
}

// patchThenPut is the shared PATCH->PUT-on-405 fallback used by every update
// builder (server.py's `if status == 405: retry with PUT`). Returns the final
// (resp, status, method_used).
func (c *Client) patchThenPut(path string, body M) (any, int, string) {
	resp, status, _ := c.Rest.Write("PATCH", path, body, nil)
	method := "PATCH"
	if status == 405 {
		resp, status, _ = c.Rest.Write("PUT", path, body, nil)
		method = "PUT"
	}
	return resp, status, method
}

// --- _selfservice_allocate (server.py:584) -----------------------------------

func (c *Client) SelfserviceAllocate(body M) (M, int) {
	subnetID := strOr(body, "subnet_id")
	tagKey := strOr(body, "tag_key")
	tagValue := strOr(body, "tag_value")
	count := 1
	if n, ok := intCoerce(body["count"]); ok {
		count = n
	}
	name := strOr(body, "name")
	dry := truthyDry(body["dry"])
	dns := asMap(body["dns"])

	if subnetID == "" {
		if tagKey == "" || tagValue == "" {
			return M{"ok": false, "error": "subnet_id or tag_key/tag_value required"}, 400
		}
		field, err := rest.CSPQField(tagKey)
		if err != nil {
			return M{"ok": false, "error": err.Error()}, 400
		}
		esc, err := rest.CSPQ(tagValue)
		if err != nil {
			return M{"ok": false, "error": err.Error()}, 400
		}
		tagFilter := fmt.Sprintf(`%s=="%s"`, field, esc)
		subnets := c.Rest.Get("/api/ddi/v1/ipam/subnet", map[string]string{"_tfilter": tagFilter})
		if len(subnets) == 0 {
			return M{"ok": false, "error": fmt.Sprintf("No subnet found with tag %s==%s", tagKey, tagValue)}, 404
		}
		subnetID = pyStr(asMap(subnets[0])["id"])
	}

	if dry {
		result := M{"ok": true, "dry_run": true, "subnet_id": subnetID, "would_allocate": count, "addresses": []any{}}
		if name != "" {
			result["name"] = name
		}
		if dns != nil {
			rec := M{"dry_run": true}
			for k, v := range dns {
				rec[k] = v
			}
			result["record"] = rec
		}
		return result, 200
	}

	// Validate the DNS payload up front so a malformed type/value fails 400
	// BEFORE any IP is reserved (else the reservation is orphaned).
	if dns != nil {
		rtype := strings.ToUpper(pyStrOr(dns, "type", "A"))
		rval := strings.TrimSpace(pyStr(dns["value"]))
		if rval != "" || (rtype != "A" && rtype != "AAAA") {
			if _, err := Rdata(rtype, rval); err != nil {
				return M{"ok": false, "error": fmt.Sprintf("invalid dns payload: %s", err.Error())}, 400
			}
		}
	}

	var bodyExtra any
	if name != "" {
		bodyExtra = M{"name": name}
	}
	resp, status, _ := c.Rest.Write("POST",
		"/api/ddi/v1/ipam/subnet/"+subnetID+"/nextavailableip",
		bodyExtra, map[string]string{"count": strconv.Itoa(count)})
	if (status != 200 && status != 201) || resp == nil {
		return M{"ok": false, "error": fmt.Sprintf("allocation failed (status %d)", status), "detail": resp}, statusOr(status, 502)
	}

	addresses := respAddresses(resp)
	out := M{"ok": true, "addresses": addressSummaries(addresses)}

	if dns != nil && len(addresses) > 0 {
		zoneID := pyStr(dns["zone_id"])
		rname := pyStr(dns["name"])
		rtype := strings.ToUpper(pyStrOr(dns, "type", "A"))
		rvalue := pyStr(dns["value"])
		if rvalue == "" {
			rvalue = pyStr(asMap(addresses[0])["address"])
		}
		var rresp any
		var rstatus int
		if rdata, err := Rdata(rtype, rvalue); err != nil {
			rresp, rstatus = M{"error": err.Error()}, 400
		} else {
			recordBody := M{"name_in_zone": rname, "zone": zoneID, "type": rtype, "rdata": rdata}
			rresp, rstatus, _ = c.Rest.Write("POST", "/api/ddi/v1/dns/record", recordBody, nil)
		}

		if (rstatus == 200 || rstatus == 201) && asMap(rresp) != nil {
			rm := asMap(rresp)
			rec := asMap(rm["result"])
			if rec == nil {
				if results, ok := rm["results"].([]any); ok && len(results) > 0 {
					rec = asMap(results[0])
				}
			}
			var recID any
			if rec != nil {
				recID = rec["id"]
			}
			out["record"] = M{"ok": true, "id": recID, "status": rstatus}
		} else {
			// Compensating release (plan 016): the DNS step failed, so roll back
			// the reservation(s) we just made — otherwise they exhaust the subnet.
			released := []any{}
			orphaned := []any{}
			for _, a := range addresses {
				aid := asMap(a)["id"]
				if isFalsy(aid) {
					continue
				}
				_, dstatus, _ := c.Rest.Write("DELETE", "/api/ddi/v1/ipam/address/"+pyStr(aid), nil, nil)
				if dstatus == 200 || dstatus == 204 || dstatus == 404 {
					released = append(released, aid)
				} else {
					orphaned = append(orphaned, aid)
				}
			}
			out["ok"] = false
			out["record"] = M{"ok": false, "status": rstatus, "detail": rresp}
			out["released"] = released
			if len(orphaned) > 0 {
				out["orphaned"] = orphaned
			}
			out["error"] = "dns record creation failed; reserved address(es) released"
			return out, 502
		}
	}

	return out, 200
}

// pyStrOr is Python `str(d.get(k) or default)`.
func pyStrOr(d M, k, def string) string {
	if isFalsy(d[k]) {
		return def
	}
	return pyStr(d[k])
}

// respAddresses mirrors the allocate result extraction: prefer "results", else
// wrap a single "result", else empty.
func respAddresses(resp any) []any {
	m := asMap(resp)
	if m == nil {
		return nil
	}
	if r, ok := m["results"].([]any); ok && len(r) > 0 {
		return r
	}
	if !isFalsy(m["result"]) {
		return []any{m["result"]}
	}
	return nil
}

func addressSummaries(addresses []any) []any {
	out := make([]any, 0, len(addresses))
	for _, a := range addresses {
		am := asMap(a)
		out = append(out, M{"id": am["id"], "address": am["address"]})
	}
	return out
}
