package server

import (
	"net/http"
	"net/url"
	"strings"

	"bloxsmith/internal/edit"
	"bloxsmith/internal/httpx"
)

// registerEditRoutes wires the Phase 1f DNS + Cloud-Resource-Editor write path
// (server.py do_POST 6144-6319 / do_PATCH 6339-6378 / do_DELETE 6395-6446). The
// central write-guard (server.New) already gated the mutation and logged the
// "write-authorized" audit entry; these handlers add the per-route RBAC gate,
// the builder call, and the explicit action audit entry, exactly as Python does.
func (d *Deps) registerEditRoutes(mux router) {
	mux.HandleFunc("POST /api/selfservice/allocate", d.body(d.selfserviceAllocate))
	mux.HandleFunc("POST /api/dns/records", d.body(d.dnsRecordCreate))
	mux.HandleFunc("PATCH /api/dns/records", d.body(d.dnsRecordUpdate))
	// Subtree (trailing-slash) registrations mirror Python's path.startswith
	// checks, so an empty id yields the same "id is required" 400 rather than a
	// route miss.
	mux.HandleFunc("DELETE /api/dns/records/", d.dnsRecordDelete)
	mux.HandleFunc("DELETE /api/ipam/addresses/", d.ipamAddressDelete)
	mux.HandleFunc("POST /api/edit/", d.body(d.editCreate))
	mux.HandleFunc("PATCH /api/edit/", d.body(d.editUpdate))
	mux.HandleFunc("DELETE /api/edit/", d.editDelete)
}

// roleGate is _role_at_least (server.py:4993): resolve the caller's role and, if
// it is below need, audit rbac_denied and return false. The caller then writes
// the route-specific 403 body (Python's message text differs per route).
func (d *Deps) roleGate(r *http.Request, need string) bool {
	role := d.Guard.ResolveRole(r)
	if !httpx.RoleAtLeast(role, need) {
		d.auditAppend("rbac_denied", role,
			map[string]any{"required": need, "path": strings.SplitN(r.URL.Path, "?", 2)[0]})
		return false
	}
	return true
}

// isDry reports whether a builder result was a dry-run preview (skip audit).
func isDry(res map[string]any) bool { b, _ := res["dry_run"].(bool); return b }

// resultOK reports the builder's ok flag.
func resultOK(res map[string]any) bool { b, _ := res["ok"].(bool); return b }

// taggingFailed reports the single ok:false shape that still left a live object
// behind: edit.SubnetCreate's "subnet created but tagging failed" arm. Every
// other create failure means nothing was written, so it correctly gets no audit
// row; this one means a real subnet exists on the tenant that no teardown tag
// filter can see, so its id has to be recorded (see editCreate).
func taggingFailed(res map[string]any) bool { b, _ := res["tagging_failed"].(bool); return b }

// --- POST /api/selfservice/allocate (server.py:6144) -------------------------

func (d *Deps) selfserviceAllocate(w http.ResponseWriter, r *http.Request, b map[string]any) {
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/selfservice/allocate")
	res, status := d.editFor(r).SelfserviceAllocate(b)
	d.json(w, r, status, res)
	if resultOK(res) && !isDry(res) {
		d.auditAppend("selfservice-allocate", httpx.Actor(r), map[string]any{
			"subnet_id": b["subnet_id"], "tag_key": b["tag_key"],
			"tag_value": b["tag_value"], "count": b["count"]})
	}
}

// --- POST /api/dns/records (server.py:6159) -----------------------------------

func (d *Deps) dnsRecordCreate(w http.ResponseWriter, r *http.Request, b map[string]any) {
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/dns/records")
	res, status := d.editFor(r).DNSRecordCreate(b)
	d.json(w, r, status, res)
	if resultOK(res) && !isDry(res) {
		d.auditAppend("dns-record-create", httpx.Actor(r), map[string]any{
			"zone_id": b["zone_id"], "name_in_zone": b["name_in_zone"], "type": b["type"]})
	}
}

// --- PATCH /api/dns/records (server.py:6339) ----------------------------------

func (d *Deps) dnsRecordUpdate(w http.ResponseWriter, r *http.Request, b map[string]any) {
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/dns/records PATCH")
	res, status := d.editFor(r).DNSRecordUpdate(b)
	d.json(w, r, status, res)
	if resultOK(res) && !isDry(res) {
		fields := []string{}
		for _, k := range []string{"value", "ttl", "comment", "disabled"} {
			if v, ok := b[k]; ok && v != nil {
				fields = append(fields, k)
			}
		}
		// fields is a []string, which canonicalJSON rejects and auditAppend only
		// logs — that cost this entry every single time until audit.Append began
		// widening every detail value first (audit/widen.go). No local conversion.
		d.auditAppend("dns-record-update", httpx.Actor(r),
			map[string]any{"id": b["id"], "fields": fields})
	}
}

// --- DELETE /api/dns/records/<id> (server.py:6395) ----------------------------
// No RBAC gate beyond the central write-guard, matching Python. Delete-by-id
// only — never delete-by-filter.

func (d *Deps) dnsRecordDelete(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/dns/records/"), "/")
	if id == "" {
		d.json(w, r, 400, map[string]any{"error": "id is required"})
		return
	}
	objPath, err := edit.ObjectPath("dns/record", id)
	if err != nil {
		d.json(w, r, 400, map[string]any{"error": "invalid object id"})
		return
	}
	defer d.recoverEdit(w, r, "/api/dns/records DELETE")
	res, status := d.editFor(r).Delete(objPath)
	d.json(w, r, status, res)
}

// --- DELETE /api/ipam/addresses/<id> (server.py:6409) -------------------------

func (d *Deps) ipamAddressDelete(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/ipam/addresses/"), "/")
	if id == "" {
		d.json(w, r, 400, map[string]any{"error": "id is required"})
		return
	}
	objPath, err := edit.ObjectPath("ipam/address", id)
	if err != nil {
		d.json(w, r, 400, map[string]any{"error": "invalid object id"})
		return
	}
	defer d.recoverEdit(w, r, "/api/ipam/addresses DELETE")
	res, status := d.editFor(r).Delete(objPath)
	d.json(w, r, status, res)
}

// --- POST /api/edit/<resource> (server.py:6300) -------------------------------

func (d *Deps) editCreate(w http.ResponseWriter, r *http.Request, b map[string]any) {
	resource := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/edit/"), "/")
	res, ok := d.editFor(r).Resources()[resource]
	if !ok || res.Create == nil {
		d.json(w, r, 404, map[string]any{"ok": false, "error": "unknown resource: " + resource})
		return
	}
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator role required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/edit/"+resource)
	result, status := res.Create(b)
	d.json(w, r, status, result)
	switch {
	case resultOK(result) && !isDry(result):
		d.auditAppend("edit-"+resource+"-create", httpx.Actor(r),
			map[string]any{"id": editResultID(result, res.ResultKey)})
	case taggingFailed(result):
		// The audit-only-when-ok rule leaves exactly one hole: SubnetCreate can
		// fail AFTER the subnet exists upstream, when only its teardown tags
		// failed to attach. That used to write no row at all, so a live subnet
		// existed with nothing recording that this system created it AND no tag
		// for teardown to find it by — invisible twice over. This row makes the
		// orphan recoverable. It does not claim success: the outcome stayed
		// ok:false in the response, and the row carries tagging_failed so it can
		// never be read as a clean create.
		d.auditAppend("edit-"+resource+"-create", httpx.Actor(r),
			map[string]any{"id": result["id"], "tagging_failed": true})
	}
}

// --- PATCH /api/edit/<resource>/<id> (server.py:6355) -------------------------

func (d *Deps) editUpdate(w http.ResponseWriter, r *http.Request, b map[string]any) {
	resource, objID := splitEditPath(r.URL.Path)
	res, ok := d.editFor(r).Resources()[resource]
	if !ok || res.Update == nil {
		d.json(w, r, 404, map[string]any{"ok": false, "error": "unknown resource: " + resource})
		return
	}
	if objID == "" {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "id is required"})
		return
	}
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator role required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/edit/"+resource+" PATCH")
	b["id"] = objID // path id always wins over any id in the body
	result, status := res.Update(b)
	d.json(w, r, status, result)
	if resultOK(result) && !isDry(result) {
		d.auditAppend("edit-"+resource+"-update", httpx.Actor(r),
			map[string]any{"id": objID})
	}
}

// --- DELETE /api/edit/<resource>/<id> (server.py:6423) ------------------------

func (d *Deps) editDelete(w http.ResponseWriter, r *http.Request) {
	resource, objID := splitEditPath(r.URL.Path)
	resDef, ok := d.editFor(r).Resources()[resource]
	if !ok {
		d.json(w, r, 404, map[string]any{"ok": false, "error": "unknown resource: " + resource})
		return
	}
	if objID == "" {
		d.json(w, r, 400, map[string]any{"error": "id is required"})
		return
	}
	// objID came from the URL path via splitEditPath, which URL-decodes it —
	// Go's HTTP transport does not normalize ".." out of an outgoing request
	// path, so building "/api/ddi/v1/"+objID directly (the bug this closes)
	// let a caller escape the resource allowlist entirely, e.g.
	// DELETE /api/edit/dns_record/..%2f..%2f..%2fatlas%2fv1%2f<id> reaching an
	// arbitrary CSP API path under the server's own tenant key. ObjectPath
	// rejects "..", encoded/literal slashes, control characters, and any id
	// that doesn't match this resource's kind — the same validator
	// dnsRecordDelete/ipamAddressDelete already use.
	objPath, err := edit.ObjectPath(resDef.Kind, objID)
	if err != nil {
		d.json(w, r, 400, map[string]any{"error": "invalid object id"})
		return
	}
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator role required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/edit/"+resource+" DELETE")
	res, status := d.editFor(r).Delete(objPath)
	d.json(w, r, status, res)
	if resultOK(res) {
		// edit.Delete maps upstream 404 -> ok (deliberate idempotency, unchanged
		// here). Without this field both arms wrote a byte-identical row, so
		// "we deleted X" and "X was already gone" were indistinguishable to
		// anyone reading the Audit tab — an existence claim the log never
		// checked. Copied only when the builder actually stated it: if it is
		// ever missing, the row omits it, and an absent field honestly means
		// UNKNOWN. Rows written before this change have no already_gone at all
		// and stay ambiguous forever — this fix is not retroactive.
		detail := map[string]any{"id": objID}
		if gone, stated := res["already_gone"].(bool); stated {
			detail["already_gone"] = gone
		}
		d.auditAppend("edit-"+resource+"-delete", httpx.Actor(r), detail)
	}
}

// splitEditPath parses /api/edit/<resource>/<id> -> (resource, id). The id is
// URL-decoded, matching Python's urllib.parse.unquote (a CSP object id contains
// slashes, so only the first segment is the resource).
func splitEditPath(path string) (string, string) {
	rest := strings.Trim(strings.TrimPrefix(path, "/api/edit/"), "/")
	resource, id, _ := strings.Cut(rest, "/")
	if dec, err := url.PathUnescape(id); err == nil {
		id = dec
	}
	return resource, id
}

// editResultID pulls the written object's id for the create audit entry
// (server.py:6314): result[resultKey].id, or nil.
func editResultID(result map[string]any, resultKey string) any {
	if obj, ok := result[resultKey].(map[string]any); ok {
		return obj["id"]
	}
	return nil
}

// recoverEdit turns a builder panic into Python's logged 500. The builders
// return errors as values, so this only catches genuine bugs — but Python wraps
// every one of these routes in try/except -> {"ok": false, "error": "internal
// error"}, 500, so we match that shape.
func (d *Deps) recoverEdit(w http.ResponseWriter, r *http.Request, label string) {
	if rec := recover(); rec != nil {
		d.logExc(label, rec)
		d.json(w, r, 500, map[string]any{"ok": false, "error": "internal error"})
	}
}
