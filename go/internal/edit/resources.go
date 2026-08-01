package edit

import (
	"fmt"
	"strconv"

	"bloxsmith/internal/rest"
)

// The Cloud Resource Editor create/update builders (server.py:697-1004). Thin
// single-resource writes for the five types not covered by /api/dns/records or
// /api/selfservice/allocate. Delete is uniform (DELETE /api/ddi/v1/{id}) and
// lives in the route layer, not here.

// tagsOf returns body["tags"] as a JSON object (nil-safe), matching Python's
// `body.get("tags") or {}`.
func tagsOf(v any) M {
	if m := asMap(v); m != nil {
		return m
	}
	return M{}
}

// --- dns_zone ----------------------------------------------------------------

func (c *Client) ZoneCreate(body M) (M, int) {
	fqdn := strOr(body, "fqdn")
	view := strOr(body, "view")
	if fqdn == "" {
		return M{"ok": false, "error": "fqdn is required"}, 400
	}
	if view == "" {
		return M{"ok": false, "error": "view is required"}, 400
	}
	zoneBody := M{"fqdn": fqdn, "view": view, "primary_type": "cloud"}
	if !isFalsy(body["comment"]) {
		zoneBody["comment"] = pyStr(body["comment"])
	}
	if !isFalsy(body["tags"]) {
		zoneBody["tags"] = body["tags"]
	}
	if truthyDry(body["dry"]) {
		return M{"ok": true, "dry_run": true, "would_create": zoneBody}, 200
	}
	resp, status, _ := c.Rest.Write("POST", "/api/ddi/v1/dns/auth_zone", zoneBody, nil)
	if (status != 200 && status != 201) || resp == nil {
		return M{"ok": false, "error": fmt.Sprintf("create failed (%s)", statusPhrase(status)), "detail": resp}, statusOr(status, 502)
	}
	return M{"ok": true, "zone": resultOrSelf(resp)}, status
}

func (c *Client) ZoneUpdate(body M) (M, int) {
	id := strOr(body, "id")
	if id == "" {
		return M{"ok": false, "error": "id is required"}, 400
	}
	// The id here can arrive from the generic /api/edit/<resource>/<id> PATCH
	// route (server/edit.go's editUpdate), which URL-decodes the path segment
	// and previously passed it straight through to "/api/ddi/v1/"+id — the
	// same traversal-escapes-the-allowlist gap fixed for editDelete. Route
	// through ObjectPath so a ".."/encoded-slash id is rejected here too.
	objPath, err := ObjectPath("dns/auth_zone", id)
	if err != nil {
		return M{"ok": false, "error": "invalid object id"}, 400
	}
	up := M{}
	if has(body, "comment") {
		up["comment"] = pyStr(body["comment"])
	}
	if has(body, "tags") {
		up["tags"] = body["tags"]
	}
	if has(body, "disabled") {
		up["disabled"] = boolPy(body["disabled"])
	}
	if len(up) == 0 {
		return M{"ok": false, "error": "no fields to update (comment/tags/disabled)"}, 400
	}
	if truthyDry(body["dry"]) {
		return M{"ok": true, "dry_run": true, "id": id, "would_update": up}, 200
	}
	resp, status, method := c.patchThenPut(objPath, up)
	if (status != 200 && status != 201) || resp == nil {
		return M{"ok": false, "error": fmt.Sprintf("update failed (%s)", statusPhrase(status)), "detail": resp, "method": method}, statusOr(status, 502)
	}
	return M{"ok": true, "method": method, "zone": resultOrSelf(resp)}, 200
}

// --- subnet ------------------------------------------------------------------

func (c *Client) SubnetCreate(body M) (M, int) {
	blockID := strOr(body, "block_id")
	if blockID == "" {
		return M{"ok": false, "error": "block_id is required"}, 400
	}
	if body["cidr"] == nil {
		return M{"ok": false, "error": "cidr is required"}, 400
	}
	cidr, ok := intCoerce(body["cidr"])
	if !ok {
		return M{"ok": false, "error": "cidr must be an integer"}, 400
	}
	name := strOr(body, "name")
	tags := tagsOf(body["tags"])
	if name != "" {
		if _, exists := tags["Name"]; !exists {
			tags["Name"] = name
		}
	}
	comment := strOr(body, "comment")

	if truthyDry(body["dry"]) {
		// GetStrict so a failed preview is DETECTABLE — but it must still
		// never abort the dry run: the real creation path below uses
		// Rest.Write with its own status check, so nothing here can create a
		// false duplicate. What changes is that a failed preview is now
		// reported as "unavailable" (with an operator-safe reason) instead of
		// leaving subnetAddr blank, which used to be indistinguishable from a
		// genuine "no address available in this block" result.
		preview, err := c.Rest.GetStrict("/api/ddi/v1/"+blockID+"/nextavailablesubnet",
			map[string]string{"cidr": strconv.Itoa(cidr), "count": "1"})
		subnetAddr := ""
		would := M{"cidr": cidr, "name": name, "comment": comment, "tags": tags}
		switch {
		case err != nil:
			// Case 3: the lookup failed outright — "address" gets an
			// obviously-not-real placeholder, never a blank value that could
			// be mistaken for a genuine (if empty) result.
			subnetAddr = "(unavailable)"
			reason := err.Error()
			if ue, ok := err.(*rest.UpstreamError); ok {
				reason = ue.Public()
			}
			would["address_preview"] = "unavailable"
			would["reason"] = reason
		case len(preview) == 0:
			// Case 2: the lookup succeeded but found nothing — a legitimate
			// "block is full", kept distinct from a broken lookup.
			would["address_preview"] = "none-available"
		default:
			// Case 1: unchanged behavior, unchanged fields.
			subnetAddr = pyStr(asMap(preview[0])["address"])
		}
		would["address"] = subnetAddr
		return M{"ok": true, "dry_run": true, "would_create": would}, 200
	}

	resp, status, _ := c.Rest.Write("POST", "/api/ddi/v1/"+blockID+"/nextavailablesubnet",
		nil, map[string]string{"cidr": strconv.Itoa(cidr), "count": "1"})
	if (status != 200 && status != 201) || resp == nil {
		return M{"ok": false, "error": fmt.Sprintf("create failed (%s)", statusPhrase(status)), "detail": resp}, statusOr(status, 502)
	}
	rows := respAddresses(resp) // same results/result unwrap shape
	var subnet M
	if len(rows) > 0 {
		subnet = asMap(rows[0])
	}
	sid := ""
	if subnet != nil {
		sid = pyStr(subnet["id"])
	}
	if sid == "" {
		return M{"ok": false, "error": "no free subnet available in block"}, 502
	}

	patchBody := M{"tags": tags}
	if name != "" {
		patchBody["name"] = name
	}
	if comment != "" {
		patchBody["comment"] = comment
	}
	// The subnet now EXISTS on the live tenant. This PATCH is what makes it
	// findable again: site teardown selects subnets by tag filter
	// (_tfilter Site=="<site>", provision/decommission.go), so a subnet that
	// never gets its tags matches no teardown query, ever.
	//
	// Exactly ONE extra attempt, no loop and no backoff. Why one: the PATCH is
	// idempotent (writing the same tags twice ends in the same state), and the
	// most plausible failure here is a transient upstream blip, which a single
	// immediate retry clears. Why not more: this runs inside an operator's
	// synchronous HTTP request, so a loop or a sleep would hold that request
	// open against a tenant that is already misbehaving; if two consecutive
	// writes fail, the fault is not transient and further attempts only delay
	// the honest error. Note the real failure rate of this path is UNKNOWN — no
	// occurrence has been observed in production, so the retry is bounded to
	// the cheapest useful size rather than tuned to evidence we do not have.
	//
	// Deliberately NOT done: deleting the just-created subnet. A code-fired
	// destructive DELETE at the exact moment the tenant is already failing is
	// the wrong reflex — and the same compensating-delete pattern in
	// SelfserviceAllocate was broken for its entire life before being fixed.
	presp, pstatus, _ := c.Rest.Write("PATCH", "/api/ddi/v1/"+sid, patchBody, nil)
	if pstatus != 200 && pstatus != 201 {
		presp, pstatus, _ = c.Rest.Write("PATCH", "/api/ddi/v1/"+sid, patchBody, nil)
	}
	if pstatus != 200 && pstatus != 201 {
		// Still ok:false — a subnet that teardown cannot see is not a success.
		// tagging_failed marks the one failure shape that nonetheless left a
		// live object behind, so the route layer can audit the id instead of
		// writing nothing at all (an orphan with no record it was created).
		return M{"ok": false, "error": fmt.Sprintf("subnet created but tagging failed (needed for teardown): %s", statusPhrase(pstatus)),
			"detail": presp, "id": sid, "tagging_failed": true}, statusOr(pstatus, 502)
	}
	if r := asMap(presp); r != nil && asMap(r["result"]) != nil {
		subnet = asMap(r["result"])
	}
	return M{"ok": true, "subnet": subnet}, 200
}

func (c *Client) SubnetUpdate(body M) (M, int) {
	id := strOr(body, "id")
	if id == "" {
		return M{"ok": false, "error": "id is required"}, 400
	}
	objPath, err := ObjectPath("ipam/subnet", id)
	if err != nil {
		return M{"ok": false, "error": "invalid object id"}, 400
	}
	up := M{}
	if has(body, "name") {
		up["name"] = pyStr(body["name"])
	}
	if has(body, "comment") {
		up["comment"] = pyStr(body["comment"])
	}
	if has(body, "tags") {
		up["tags"] = body["tags"]
	}
	if has(body, "disabled") {
		up["disabled"] = boolPy(body["disabled"])
	}
	if len(up) == 0 {
		return M{"ok": false, "error": "no fields to update (name/comment/tags/disabled)"}, 400
	}
	if truthyDry(body["dry"]) {
		return M{"ok": true, "dry_run": true, "id": id, "would_update": up}, 200
	}
	resp, status, method := c.patchThenPut(objPath, up)
	if (status != 200 && status != 201) || resp == nil {
		return M{"ok": false, "error": fmt.Sprintf("update failed (%s)", statusPhrase(status)), "detail": resp, "method": method}, statusOr(status, 502)
	}
	return M{"ok": true, "method": method, "subnet": resultOrSelf(resp)}, 200
}

// --- address_block (create only) ---------------------------------------------

func (c *Client) BlockCreate(body M) (M, int) {
	address := strOr(body, "address")
	space := strOr(body, "space")
	if address == "" {
		return M{"ok": false, "error": "address is required"}, 400
	}
	if body["cidr"] == nil {
		return M{"ok": false, "error": "cidr is required"}, 400
	}
	cidr, ok := intCoerce(body["cidr"])
	if !ok {
		return M{"ok": false, "error": "cidr must be an integer"}, 400
	}
	if space == "" {
		return M{"ok": false, "error": "space is required"}, 400
	}
	blockBody := M{"address": address, "cidr": cidr, "space": space,
		"comment": strOr(body, "comment"), "tags": tagsOf(body["tags"])}
	if truthyDry(body["dry"]) {
		return M{"ok": true, "dry_run": true, "would_create": blockBody}, 200
	}
	resp, status, _ := c.Rest.Write("POST", "/api/ddi/v1/ipam/address_block", blockBody, nil)
	if (status != 200 && status != 201) || resp == nil {
		return M{"ok": false, "error": fmt.Sprintf("create failed (%s)", statusPhrase(status)), "detail": resp}, statusOr(status, 502)
	}
	return M{"ok": true, "block": resultOrSelf(resp)}, status
}

// --- dhcp_range --------------------------------------------------------------

func (c *Client) RangeCreate(body M) (M, int) {
	start := strOr(body, "start")
	end := strOr(body, "end")
	space := strOr(body, "space")
	if start == "" {
		return M{"ok": false, "error": "start is required"}, 400
	}
	if end == "" {
		return M{"ok": false, "error": "end is required"}, 400
	}
	if space == "" {
		return M{"ok": false, "error": "space is required"}, 400
	}
	rangeBody := M{"start": start, "end": end, "space": space,
		"comment": strOr(body, "comment"), "tags": tagsOf(body["tags"])}
	if truthyDry(body["dry"]) {
		return M{"ok": true, "dry_run": true, "would_create": rangeBody}, 200
	}
	resp, status, _ := c.Rest.Write("POST", "/api/ddi/v1/ipam/range", rangeBody, nil)
	if (status != 200 && status != 201) || resp == nil {
		return M{"ok": false, "error": fmt.Sprintf("create failed (%s)", statusPhrase(status)), "detail": resp}, statusOr(status, 502)
	}
	return M{"ok": true, "range": resultOrSelf(resp)}, status
}

func (c *Client) RangeUpdate(body M) (M, int) {
	id := strOr(body, "id")
	if id == "" {
		return M{"ok": false, "error": "id is required"}, 400
	}
	objPath, err := ObjectPath("ipam/range", id)
	if err != nil {
		return M{"ok": false, "error": "invalid object id"}, 400
	}
	up := M{}
	if has(body, "start") {
		up["start"] = pyStr(body["start"])
	}
	if has(body, "end") {
		up["end"] = pyStr(body["end"])
	}
	if has(body, "comment") {
		up["comment"] = pyStr(body["comment"])
	}
	if has(body, "tags") {
		up["tags"] = body["tags"]
	}
	if has(body, "disabled") {
		up["disabled"] = boolPy(body["disabled"])
	}
	if len(up) == 0 {
		return M{"ok": false, "error": "no fields to update (start/end/comment/tags/disabled)"}, 400
	}
	if truthyDry(body["dry"]) {
		return M{"ok": true, "dry_run": true, "id": id, "would_update": up}, 200
	}
	resp, status, method := c.patchThenPut(objPath, up)
	if (status != 200 && status != 201) || resp == nil {
		return M{"ok": false, "error": fmt.Sprintf("update failed (%s)", statusPhrase(status)), "detail": resp, "method": method}, statusOr(status, 502)
	}
	return M{"ok": true, "method": method, "range": resultOrSelf(resp)}, 200
}

// --- host --------------------------------------------------------------------

func (c *Client) HostCreate(body M) (M, int) {
	name := strOr(body, "name")
	if name == "" {
		return M{"ok": false, "error": "name is required"}, 400
	}
	addresses, ok := body["addresses"].([]any)
	if !ok || len(addresses) == 0 {
		return M{"ok": false, "error": "addresses is required (list of {address, space})"}, 400
	}
	autoGen := true
	if v, present := body["auto_generate_records"]; present {
		autoGen = boolPy(v)
	}
	hostBody := M{"name": name, "comment": strOr(body, "comment"),
		"addresses": addresses, "auto_generate_records": autoGen}
	if !isFalsy(body["tags"]) {
		hostBody["tags"] = body["tags"]
	}
	if !isFalsy(body["host_names"]) {
		hostBody["host_names"] = body["host_names"]
	}
	if truthyDry(body["dry"]) {
		return M{"ok": true, "dry_run": true, "would_create": hostBody}, 200
	}
	resp, status, _ := c.Rest.Write("POST", "/api/ddi/v1/ipam/host", hostBody, nil)
	if (status != 200 && status != 201) || resp == nil {
		return M{"ok": false, "error": fmt.Sprintf("create failed (%s)", statusPhrase(status)), "detail": resp}, statusOr(status, 502)
	}
	return M{"ok": true, "host": resultOrSelf(resp)}, status
}

func (c *Client) HostUpdate(body M) (M, int) {
	id := strOr(body, "id")
	if id == "" {
		return M{"ok": false, "error": "id is required"}, 400
	}
	objPath, err := ObjectPath("ipam/host", id)
	if err != nil {
		return M{"ok": false, "error": "invalid object id"}, 400
	}
	up := M{}
	if has(body, "name") {
		up["name"] = pyStr(body["name"])
	}
	if has(body, "comment") {
		up["comment"] = pyStr(body["comment"])
	}
	if has(body, "addresses") {
		up["addresses"] = body["addresses"]
	}
	if has(body, "tags") {
		up["tags"] = body["tags"]
	}
	if len(up) == 0 {
		return M{"ok": false, "error": "no fields to update (name/comment/addresses/tags)"}, 400
	}
	if truthyDry(body["dry"]) {
		return M{"ok": true, "dry_run": true, "id": id, "would_update": up}, 200
	}
	resp, status, method := c.patchThenPut(objPath, up)
	if (status != 200 && status != 201) || resp == nil {
		return M{"ok": false, "error": fmt.Sprintf("update failed (%s)", statusPhrase(status)), "detail": resp, "method": method}, statusOr(status, 502)
	}
	return M{"ok": true, "method": method, "host": resultOrSelf(resp)}, 200
}

// --- dispatch (server.py:_EDIT_RESOURCES / _EDIT_RESULT_KEY) ------------------

// Resource pairs each /api/edit/<resource> with its create/update builders.
// address_block has no update (create/delete only). A nil field means the verb
// is unsupported for that resource -> 404.
type Resource struct {
	Create    func(M) (M, int)
	Update    func(M) (M, int)
	ResultKey string // top-level key the written object lands under (audit id)
	// Kind is the CSP object-path prefix for this resource (e.g. "ipam/host"),
	// used by edit.ObjectPath to validate a DELETE route's id. It must match
	// the kind each Update builder above validates its own "id" field against.
	Kind string
}

// Resources returns the dispatch table bound to this client.
func (c *Client) Resources() map[string]Resource {
	return map[string]Resource{
		"dns_zone":      {Create: c.ZoneCreate, Update: c.ZoneUpdate, ResultKey: "zone", Kind: "dns/auth_zone"},
		"subnet":        {Create: c.SubnetCreate, Update: c.SubnetUpdate, ResultKey: "subnet", Kind: "ipam/subnet"},
		"address_block": {Create: c.BlockCreate, ResultKey: "block", Kind: "ipam/address_block"},
		"dhcp_range":    {Create: c.RangeCreate, Update: c.RangeUpdate, ResultKey: "range", Kind: "ipam/range"},
		"host":          {Create: c.HostCreate, Update: c.HostUpdate, ResultKey: "host", Kind: "ipam/host"},
	}
}

// Delete is the uniform DELETE /api/ddi/v1/{id} used by all five resource types
// plus the /api/dns/records/{id} and /api/ipam/addresses/{id} routes. Returns
// (result, status) ready for the route layer.
//
// UNCHANGED and not up for decision: upstream 404 still maps to ok:true, 200.
// That is deliberate idempotency — for a DELETE, "no such object" means the
// requested end state already holds, so re-running a teardown must not fail on
// what the first run removed.
//
// What is new is that the two success shapes are no longer indistinguishable.
// already_gone is set EXPLICITLY on both arms — true for the 404 arm, false for
// a real 200/204 — because the route layer records this delete in the audit
// log, and "this system deleted it" must not read identically to "it was
// already gone". The chain proves nobody edited the row; it can never prove the
// object existed, so the row must not imply it did.
//
// Honest scope: this cannot be retroactive. Every audit row written before this
// change carries no already_gone field at all, and its absence there means
// UNKNOWN — it must never be read as false.
func (c *Client) Delete(fullPath string) (M, int) {
	resp, status, _ := c.Rest.Write("DELETE", fullPath, nil, nil)
	if status == 404 {
		return M{"ok": true, "already_gone": true}, 200
	}
	if status == 200 || status == 204 {
		return M{"ok": true, "already_gone": false}, 200
	}
	return M{"ok": false, "error": fmt.Sprintf("delete failed (%s)", statusPhrase(status)), "detail": resp}, statusOr(status, 502)
}
