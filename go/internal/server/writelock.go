package server

import (
	"log"
	"net/http"
	"strings"

	"bloxsmith/internal/httpx"
	"bloxsmith/internal/vault"
)

// PER-TENANT WRITE LOCK — the route side. The model, the identity scheme and the
// honest scope of what this protects are all documented in
// internal/vault/writelock.go; read that first.
//
// Short version: provisioning, teardown and every route that changes data in the
// customer's tenant refuse unless THIS tenant has been explicitly marked
// writable. Default read-only, no global override, fail closed.

// router is the slice of *http.ServeMux the register*Routes functions use. It
// exists so a test can enumerate every route this server declares: ServeMux
// offers no way to read back what was registered on it, so the only way to
// assert "every write route is classified below" is to hand the registration
// functions a recorder instead. See writelock_routes_test.go.
type router interface {
	HandleFunc(pattern string, handler func(http.ResponseWriter, *http.Request))
}

// tenantWritePaths are the routes that change data in the CUSTOMER'S TENANT.
// These are what the write lock gates.
//
// This is a deliberate list and not httpx.DefaultMutatingPaths, which is a
// different question (which routes need a CSRF check) and gets a different
// answer in both directions: it includes /api/alerts/snooze, which writes only
// this machine's local store, and it omits /api/block-domain,
// /api/unblock-domain and /api/actions/{id}/status, which all reach into the
// tenant. writelock_routes_test.go asserts every registered non-GET route lands
// in exactly one of this set or localWritePaths, so adding a route without
// classifying it fails the build rather than silently escaping the lock.
var tenantWritePaths = map[string]bool{
	// Provisioning and teardown. These are SSE streams driven by EventSource, so
	// they arrive as GETs — the reason IsMutating exists as a concept separate
	// from the HTTP verb, and the reason this map is keyed by path not method.
	"/api/provision/stream":           true,
	"/api/provision/site/stream":      true,
	"/api/provision/seed-demo/stream": true,
	"/api/teardown/site/stream":       true,
	"/api/teardown/seed-demo/stream":  true,

	// Address-block provisioning / teardown / retag.
	"/api/provision/block": true,
	"/api/teardown/block":  true,
	"/api/retag/block":     true,

	// DNS + IPAM edits.
	"/api/selfservice/allocate": true,
	"/api/dns/records":          true,

	// Security policy: adds and removes entries on a live block list.
	"/api/block-domain":   true,
	"/api/unblock-domain": true,
}

// tenantWritePrefixes are the subtree write routes (Python's path.startswith
// checks). Kept separate from the exact-match set because "/api/edit/" with an
// empty id must be gated too, not fall through as a route miss.
var tenantWritePrefixes = []string{
	"/api/dns/records/",
	"/api/ipam/addresses/",
	"/api/edit/",
}

// nonTenantWritePaths are the state-changing-verb routes that do NOT change data
// in the customer's tenant, each with the reason it is out of scope. Gating these
// would mean an operator could not save a view, snooze an alert, validate a
// template or ask a question about a tenant they are only reading — none of which
// is the risk this control exists for.
//
// Every entry here is a claim that had to be checked, not assumed:
//
//	/api/views, /api/views/import, /api/views/{name}
//	                     store.Store — a JSON file on this machine
//	/api/alerts/snooze   store.Store — snooze state on this machine
//	/api/brand           brand.json + logo.png on this machine
//	/api/vault/*         the local credential store, including the write-lock
//	                     opt-in itself (locking that would make the permission
//	                     ungrantable — the lock would lock its own key away)
//	/api/update/apply    replaces THIS binary; touches no tenant
//	/api/cache-bust      drops this process's cache
//	/api/switch-account  changes which tenant is active locally. Deliberately NOT
//	                     gated: switching is how you get TO a writable tenant, and
//	                     the identity is re-resolved per request anyway, so a
//	                     switch cannot carry permission with it
//	/api/templates/validate
//	                     read-only. Verified: loads a template off disk and runs
//	                     provision.ValidateTemplate. No rest.Write anywhere
//	/api/drift/check     read-only. Verified: LoadTemplate +
//	                     TemplateToSiteConfig + QuerySiteLive, all reads. It
//	                     reports what differs; applying the difference is
//	                     /api/provision/*, which IS gated
//	/api/query           the AI assistant. All 11 of its tools are read-only, so
//	                     it cannot write here. Its real exposure is tenant text
//	                     reaching a model and tenant data leaving the machine,
//	                     which is a different control and not this one
var nonTenantWritePaths = map[string]bool{
	"/api/views":              true,
	"/api/views/import":       true,
	"/api/alerts/snooze":      true,
	"/api/brand":              true,
	"/api/update/apply":       true,
	"/api/cache-bust":         true,
	"/api/switch-account":     true,
	"/api/templates/validate": true,
	"/api/drift/check":        true,
	"/api/query":              true,
}

var nonTenantWritePrefixes = []string{
	"/api/views/",
	"/api/vault/",
}

// isTenantWrite reports whether this request would change data in the tenant.
func isTenantWrite(path string) bool {
	if tenantWritePaths[path] {
		return true
	}
	for _, p := range tenantWritePrefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	// POST /api/actions/{id}/status resolves or reopens an IQ Action upstream.
	// Matched by shape because the id is in the path.
	if strings.HasPrefix(path, "/api/actions/") && strings.HasSuffix(path, "/status") {
		return true
	}
	return false
}

// writeIdentity resolves WHERE a write from this request would land, as the
// opaque identity vault.WriteID builds. The second return is non-empty when the
// answer is genuinely unknown, which is a refusal reason and never an empty
// identity treated as "fine".
//
// Resolved fresh per request rather than carried on the pinned context: the
// pinned rest.Client holds the credential VALUE, not which tenant it belongs to,
// and adding the identity to it would mean two places that have to agree about
// the same thing. The window this leaves is the same one Pin() already accepts —
// a switch landing mid-request — and the lock is checked before any outbound
// call, so a request that passes the lock is pinned to the tenant it passed for.
func (d *Deps) writeIdentity() (id string, unknown string) {
	tenant := ""
	if d.Vault != nil {
		tenant = d.Vault.ActiveTenantID()
	}
	if tenant == "" {
		// No vault tenant active: the process is running from an env API_KEY.
		// That is a real, nameable identity that can be marked writable — not a
		// hole to fall through.
		tenant = vault.EnvTenant
	}

	account := vault.NoSwitch
	if d.Auth != nil && d.Auth.OverrideActive() {
		// A portal account switch is in force, so the write lands in a DIFFERENT
		// CSP account than the stored key's own. If we cannot say which, we
		// cannot say whether it was opted in.
		if d.Account == nil {
			return "", "a portal account switch is in force but this server has no account manager to say which account it switched to"
		}
		account = d.Account.Active()
		if strings.TrimSpace(account) == "" {
			return "", "a portal account switch is in force but which CSP account it switched to could not be determined"
		}
	}
	return vault.WriteID(tenant, account), ""
}

// writeLockRefusal is the body for a refused write. It names the identity so an
// operator can mark exactly that one writable, and it never implies the write
// partially happened.
func (d *Deps) writeLockRefusal(id, unknown, path string) map[string]any {
	if unknown != "" {
		return map[string]any{
			"ok":       false,
			"error":    "refused: cannot determine which tenant this would change — " + unknown,
			"writable": false,
			"reason":   "tenant-unknown",
		}
	}
	label := ""
	if d.Vault != nil {
		label = d.Vault.LabelForTenantID(strings.SplitN(id, "/", 2)[0])
	}
	who := id
	if label != "" {
		who = label + " (" + id + ")"
	}
	return map[string]any{
		"ok": false,
		"error": "refused: " + who + " is read-only. Nothing was changed. " +
			"Mark this tenant writable in Settings to allow " + path + ".",
		"writable": false,
		"reason":   "tenant-read-only",
		"tenant":   id,
	}
}

// withWriteLock refuses a tenant-changing request unless that exact tenant has
// been marked writable. 403, nothing attempted, and the refusal is audited.
//
// ORDERING NOTE, because the audit trail shows both. The chassis write-guard
// (httpx.WriteGuard) runs first and records "write-authorized" for a mutating
// path once the CSRF/token check passes. A request refused here therefore leaves
// TWO entries: the caller was authorized, and the tenant was not writable. Both
// are true and they answer different questions; collapsing them would lose the
// fact that a real, authorized operator asked.
func (d *Deps) withWriteLock(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.SplitN(r.URL.Path, "?", 2)[0]
		if !isTenantWrite(path) {
			next.ServeHTTP(w, r)
			return
		}
		id, unknown := d.writeIdentity()
		if unknown == "" && d.Vault != nil && d.Vault.WriteAllowed(id) {
			next.ServeHTTP(w, r)
			return
		}
		detail := map[string]any{"path": path, "method": r.Method, "tenant": id}
		if unknown != "" {
			detail["reason"] = "tenant-unknown"
			detail["detail"] = unknown
		} else {
			detail["reason"] = "tenant-read-only"
		}
		if d.Audit != nil {
			d.auditAppend("write-refused-read-only", httpx.Actor(r), detail)
		} else {
			// A Deps wired without an audit log (a handler-level test) must not
			// swallow the refusal silently.
			log.Printf("[writelock] refused %s %s for tenant %q (%s)", r.Method, path, id, detail["reason"])
		}
		d.json(w, r, http.StatusForbidden, d.writeLockRefusal(id, unknown, path))
	})
}

// --- POST /api/vault/tenant-writable ----------------------------------------

// registerWriteLockRoutes wires the opt-in control. It is admin-gated and
// audited in both directions: granting write access to a live customer tenant
// and taking it away are both things an operator needs to be able to prove
// afterwards.
//
// It sits under /api/vault/ deliberately — the permission lives in the encrypted
// vault payload, and that prefix is already exempt from the vault-mode gate and
// covered by the CSRF check for non-GET verbs.
func (d *Deps) registerWriteLockRoutes(mux router) {
	mux.HandleFunc("POST /api/vault/tenant-writable", d.body(func(w http.ResponseWriter, r *http.Request, b map[string]any) {
		if !d.roleGate(r, "admin") {
			d.json(w, r, http.StatusForbidden, map[string]any{"ok": false, "error": "admin required"})
			return
		}
		id := strings.TrimSpace(str(b, "id"))
		if id == "" {
			// Default to the tenant this request would write to, so the UI can
			// offer "make the current tenant writable" without having to build
			// the identity itself.
			resolved, unknown := d.writeIdentity()
			if unknown != "" {
				d.json(w, r, http.StatusConflict, map[string]any{"ok": false, "error": "cannot determine the current tenant — " + unknown})
				return
			}
			id = resolved
		}
		on, ok := b["writable"].(bool)
		if !ok {
			d.json(w, r, http.StatusBadRequest, map[string]any{"ok": false, "error": "writable must be true or false"})
			return
		}
		res := d.Vault.SetWritable(id, on)
		if okv, _ := res["ok"].(bool); okv {
			event := "tenant-write-revoked"
			if on {
				event = "tenant-write-granted"
			}
			d.auditAppend(event, httpx.Actor(r), map[string]any{"tenant": id})
		}
		d.json(w, r, code(res, http.StatusBadRequest), res)
	}))

	// The current identity, so the UI can show which tenant a write would land
	// in and whether it is writable, instead of guessing from the tenant list.
	mux.HandleFunc("GET /api/vault/write-target", func(w http.ResponseWriter, r *http.Request) {
		id, unknown := d.writeIdentity()
		if unknown != "" {
			// A failed read and a successful read that found nothing must not
			// render the same way: this says "unknown", never writable:false
			// with a blank tenant.
			d.json(w, r, http.StatusOK, map[string]any{
				"known":  false,
				"reason": unknown,
			})
			return
		}
		label := ""
		if d.Vault != nil {
			label = d.Vault.LabelForTenantID(strings.SplitN(id, "/", 2)[0])
		}
		d.json(w, r, http.StatusOK, map[string]any{
			"known":    true,
			"tenant":   id,
			"label":    label,
			"writable": d.Vault != nil && d.Vault.WriteAllowed(id),
		})
	})
}
