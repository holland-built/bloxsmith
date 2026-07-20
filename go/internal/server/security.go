package server

import (
	"net/http"
	"strings"

	"bloxsmith/internal/httpx"
)

// registerSecurityWriteRoutes wires the two security-policy writes (server.py
// POST 6110/6127): block-domain / unblock-domain. Neither is in MUTATING_PATHS,
// so the chassis write-guard does not gate them — each handler enforces its own
// X-Auth-Token check (_authed) and appends an audit entry on success, exactly as
// Python does. The block engine also re-validates domain + BLOCK_LIST_ID.
func (d *Deps) registerSecurityWriteRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/block-domain", d.body(d.blockDomain))
	mux.HandleFunc("POST /api/unblock-domain", d.body(d.unblockDomain))
}

func (d *Deps) blockDomain(w http.ResponseWriter, r *http.Request, b map[string]any) {
	defer d.recover500ok(w, r, "/api/block-domain")
	if !d.Guard.Authed(r) {
		d.json(w, r, 401, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	domain := strings.TrimSpace(str(b, "domain"))
	if domain == "" {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "domain required"})
		return
	}
	result := d.Dashboard.BlockDomain(r.Context(), domain, d.Cfg.BlockListID)
	d.json(w, r, 200, result)
	if ok, _ := result["ok"].(bool); ok {
		_, _ = d.Audit.Append("block-domain", httpx.Actor(r), map[string]any{"domain": domain})
	}
}

func (d *Deps) unblockDomain(w http.ResponseWriter, r *http.Request, b map[string]any) {
	defer d.recover500ok(w, r, "/api/unblock-domain")
	if !d.Guard.Authed(r) {
		d.json(w, r, 401, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	domain := strings.TrimSpace(str(b, "domain"))
	if domain == "" {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "domain required"})
		return
	}
	result := d.Dashboard.UnblockDomain(r.Context(), domain, d.Cfg.BlockListID)
	d.json(w, r, 200, result)
	if ok, _ := result["ok"].(bool); ok {
		_, _ = d.Audit.Append("unblock-domain", httpx.Actor(r), map[string]any{"domain": domain})
	}
}

// recover500ok turns a panic into Python's 500 {"ok":false,"error":"internal
// error"} for the write handlers (server.py:6124/6141).
func (d *Deps) recover500ok(w http.ResponseWriter, r *http.Request, label string) {
	if rec := recover(); rec != nil {
		d.logExc(label, rec)
		d.json(w, r, 500, map[string]any{"ok": false, "error": "internal error"})
	}
}
