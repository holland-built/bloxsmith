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
	result := d.dash(r).BlockDomain(r.Context(), domain, d.Cfg.BlockListID)
	d.json(w, r, outcomeStatus(result), result)
	if outcome, _ := result["outcome"].(string); outcome == "verified" {
		d.auditAppend("block-domain", httpx.Actor(r), map[string]any{"domain": domain})
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
	result := d.dash(r).UnblockDomain(r.Context(), domain, d.Cfg.BlockListID)
	d.json(w, r, outcomeStatus(result), result)
	if outcome, _ := result["outcome"].(string); outcome == "verified" {
		d.auditAppend("unblock-domain", httpx.Actor(r), map[string]any{"domain": domain})
	}
}

// outcomeStatus maps a block/unblock result to an HTTP status so the status
// line agrees with the body instead of always reporting 200
// (dashboard/security.go contract, four outcomes): "verified" -> 200 (read-back
// confirms desired state); "invalid" -> 400 (a local fault — invalid domain,
// block list not configured/malformed, nil MCP client — nothing was ever sent
// upstream); "rejected" -> 502 (the call reached upstream and upstream
// refused it, via CallToolChecked's transport-error branch, safe to retry);
// "unverified" -> 504 (submitted, but read-back didn't confirm within budget).
// Anything with no recognised "outcome" falls back to 500.
func outcomeStatus(result map[string]any) int {
	switch result["outcome"] {
	case "verified":
		return 200
	case "invalid":
		return 400
	case "rejected":
		return 502
	case "unverified":
		return 504
	default:
		return 500
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
