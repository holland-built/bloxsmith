package server

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"bloxsmith/internal/httpx"
)

// nowUnix is Python's _time.time() (float seconds) for the export timestamp.
func nowUnix() float64 { return float64(time.Now().UnixNano()) / 1e9 }

// intOf coerces a JSON body value to an int like Python's int(body.get(k)).
// JSON numbers decode to float64 here (server.body does not UseNumber); a
// numeric string is also accepted. Anything else -> 0 (rejected by the caller).
func intOf(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(t)); err == nil {
			return n
		}
	}
	return 0
}

// registerStateRoutes wires the Phase 1c local-state endpoints: the audit-log
// read/verify + export (server.py:5083/5086), saved views (5057/5277/6085/6384),
// and the alert snooze (6282). first-seen has no route of its own — it is an
// internal store consumed by /api/incidents (a later phase).
func (d *Deps) registerStateRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/audit/log", d.auditLog)
	mux.HandleFunc("GET /api/audit/export", d.auditExport)

	mux.HandleFunc("GET /api/views", d.viewsList)
	mux.HandleFunc("POST /api/views", d.body(d.viewWrite))
	mux.HandleFunc("POST /api/views/import", d.body(d.viewWrite))
	mux.HandleFunc("GET /api/views/{name}", d.viewGet)
	mux.HandleFunc("DELETE /api/views/{name}", d.viewDelete)

	mux.HandleFunc("POST /api/alerts/snooze", d.body(d.snooze))
}

// auditLog is GET /api/audit/log (server.py:5083): the whole chain plus its
// verification verdict.
func (d *Deps) auditLog(w http.ResponseWriter, r *http.Request) {
	chain := d.Audit.Verify()
	d.json(w, r, 200, map[string]any{
		"entries":      d.Audit.Read(),
		"chain_valid":  chain["valid"],
		"broken_index": chain["broken_index"],
	})
}

// auditExport is GET /api/audit/export (server.py:5086): admin-only, adds
// exported_at + app_version. A denial audit-logs rbac_denied (server.py:4998).
func (d *Deps) auditExport(w http.ResponseWriter, r *http.Request) {
	role := d.Guard.ResolveRole(r)
	if !httpx.RoleAtLeast(role, "admin") {
		_, _ = d.Audit.Append("rbac_denied", role,
			map[string]any{"required": "admin", "path": "/api/audit/export"})
		d.json(w, r, 403, map[string]any{"ok": false, "error": "admin required"})
		return
	}
	chain := d.Audit.Verify()
	d.json(w, r, 200, map[string]any{
		"entries":      d.Audit.Read(),
		"chain_valid":  chain["valid"],
		"broken_index": chain["broken_index"],
		"exported_at":  nowUnix(),
		"app_version":  d.Version,
	})
}

// viewsList is GET /api/views (server.py:5057): names/timestamps only.
func (d *Deps) viewsList(w http.ResponseWriter, r *http.Request) {
	d.json(w, r, 200, d.Store.ViewsList())
}

// viewWrite is POST /api/views and /api/views/import (server.py:6085).
func (d *Deps) viewWrite(w http.ResponseWriter, r *http.Request, b map[string]any) {
	payload, status := d.Store.ViewWrite(b)
	d.json(w, r, status, payload)
}

// viewGet is GET /api/views/{name} (server.py:5277).
func (d *Deps) viewGet(w http.ResponseWriter, r *http.Request) {
	v := d.Store.ViewRead(r.PathValue("name"))
	if v == nil {
		d.json(w, r, 404, map[string]any{"error": "not found"})
		return
	}
	d.json(w, r, 200, v)
}

// viewDelete is DELETE /api/views/{name} (server.py:6384).
func (d *Deps) viewDelete(w http.ResponseWriter, r *http.Request) {
	if d.Store.ViewDelete(r.PathValue("name")) {
		d.json(w, r, 200, map[string]any{"ok": true})
		return
	}
	d.json(w, r, 404, map[string]any{"error": "not found"})
}

// snooze is POST /api/alerts/snooze (server.py:6282): operator-gated, persists
// the snooze and writes an explicit "snooze" audit entry (in addition to the
// "write-authorized" entry the write-guard already logged for this mutation).
func (d *Deps) snooze(w http.ResponseWriter, r *http.Request, b map[string]any) {
	role := d.Guard.ResolveRole(r)
	if !httpx.RoleAtLeast(role, "operator") {
		_, _ = d.Audit.Append("rbac_denied", role,
			map[string]any{"required": "operator", "path": "/api/alerts/snooze"})
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	category := strings.TrimSpace(str(b, "category"))
	minutes := intOf(b["minutes"])
	if category == "" || minutes <= 0 {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "category and minutes>0 are required"})
		return
	}
	if err := d.Store.Snooze(category, minutes); err != nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "internal error"})
		return
	}
	_, _ = d.Audit.Append("snooze", httpx.Actor(r),
		map[string]any{"category": category, "minutes": minutes})
	d.json(w, r, 200, map[string]any{"ok": true, "category": category, "minutes": minutes})
}
