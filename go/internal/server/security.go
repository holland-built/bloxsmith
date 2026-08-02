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
func (d *Deps) registerSecurityWriteRoutes(mux router) {
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
	d.auditOutcome("block-domain", r, domain, result)
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
	d.auditOutcome("unblock-domain", r, domain, result)
}

// auditOutcome records a block/unblock attempt whenever the write actually
// reached the customer's live block list, and carries the outcome word itself
// into the detail so a reader can tell the two recordable cases apart.
//
// Keyed to the outcomeStatus contract above (dashboard/security.go's four
// outcomes):
//   - "verified"   — read-back confirms the desired state. Recorded.
//   - "unverified" — SUBMITTED, but read-back didn't confirm within budget.
//     Recorded, because the mutation may well have landed on the live block
//     list; only the confirmation is missing. Recording only "verified" left
//     a real change to DNS blocking with no trace anywhere — these two routes
//     are absent from DefaultMutatingPaths, so there is no "write-authorized"
//     row either.
//   - "invalid"    — a local fault; nothing was ever sent upstream. Not
//     recorded: there is no change to account for.
//   - "rejected"   — reached upstream and upstream refused it; nothing was
//     applied. Not recorded, same reason.
//
// The outcome goes in the detail rather than being folded into one word, so
// "we confirmed it" is never mistaken for "we could not confirm it".
func (d *Deps) auditOutcome(event string, r *http.Request, domain string, result map[string]any) {
	outcome, _ := result["outcome"].(string)
	if outcome != "verified" && outcome != "unverified" {
		return
	}
	d.auditAppend(event, httpx.Actor(r), map[string]any{"domain": domain, "outcome": outcome})
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
