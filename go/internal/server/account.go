package server

import (
	"net/http"
	"strings"

	"bloxsmith/internal/account"
	"bloxsmith/internal/httpx"
)

// registerAccountRoutes wires the multi-account (portal-tenant) surface:
// /api/whoami (server.py:5092), /api/accounts (5267), and POST
// /api/switch-account (6094). whoami + accounts are reads; switch-account is a
// state-changing POST, so switchAccount enforces its own CSRF gate
// (same-origin + JSON content type) — CORS alone only blocks reading the
// response, not sending a cross-origin simple POST.
func (d *Deps) registerAccountRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/whoami", d.whoami)
	mux.HandleFunc("GET /api/accounts", d.accounts)
	mux.HandleFunc("POST /api/switch-account", d.body(d.switchAccount))
}

// whoami is GET /api/whoami (server.py:5092): the caller's resolved role/actor
// plus the active vault tenant label.
func (d *Deps) whoami(w http.ResponseWriter, r *http.Request) {
	var tenant any // null when no active tenant (Python's _tenant = None)
	if lbl := d.Vault.ActiveLabel(); lbl != "" {
		tenant = lbl
	}
	d.json(w, r, 200, map[string]any{
		"role":       d.Guard.ResolveRole(r),
		"token_auth": d.Cfg.DashboardToken != "",
		"actor":      httpx.Actor(r),
		"tenant":     tenant,
	})
}

// accounts is GET /api/accounts (server.py:5267): the accounts the key's user
// belongs to. On a CSP failure it surfaces the real reason at HTTP 200 with an
// empty list, exactly as Python does, so the UI can explain "no access".
func (d *Deps) accounts(w http.ResponseWriter, r *http.Request) {
	res, err := d.Account.ListAccounts()
	if err != nil {
		d.logExc("/api/accounts", err)
		msg := "Infoblox CSP unreachable"
		var status any
		if he, ok := err.(*account.HTTPError); ok {
			status = he.Code
			msg = "CSP rejected this key (" + itoaStatus(he.Code) + ")"
		}
		d.json(w, r, 200, map[string]any{"accounts": []any{}, "active": "", "error": msg, "status": status})
		return
	}
	d.json(w, r, 200, res)
}

// switchAccount is POST /api/switch-account (server.py:6094): switch to an
// account the user belongs to. 403 -> not-entitled message; other CSP errors ->
// 502; unknown/failed -> 400 via the {"ok":false} result.
func (d *Deps) switchAccount(w http.ResponseWriter, r *http.Request, b map[string]any) {
	// CSRF gate: this POST mints a Bearer JWT and rebinds every later REST call
	// to the target account (auth.SetOverride), so a forged cross-origin request
	// must not reach SwitchAccount. Require an allowlisted same-origin caller and
	// a JSON content type — a CSRF "simple request" can set neither, and CORS
	// does not stop the send, only the response read.
	if !d.Guard.SameOrigin(r) || !isJSONContent(r.Header.Get("Content-Type")) {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "forbidden — write not authorized"})
		return
	}
	res, err := d.Account.SwitchAccount(str(b, "id"))
	if err != nil {
		d.logExc("/api/switch-account", err)
		if he, ok := err.(*account.HTTPError); ok {
			if he.Code == 403 {
				d.json(w, r, 403, map[string]any{"ok": false,
					"error": "Account switching requires an interactive User API key with multi-account access (CSP returned 403)"})
				return
			}
			d.json(w, r, 502, map[string]any{"ok": false, "error": "CSP error " + itoaStatus(he.Code)})
			return
		}
		d.json(w, r, 500, map[string]any{"ok": false, "error": "internal error"})
		return
	}
	d.json(w, r, code(res, 400), res)
}

// isJSONContent reports whether a Content-Type header names application/json
// (tolerating a charset/boundary parameter, e.g. "application/json; charset=utf-8").
func isJSONContent(ct string) bool {
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	return strings.EqualFold(strings.TrimSpace(ct), "application/json")
}

// itoaStatus renders an HTTP status for the account error messages.
func itoaStatus(n int) string {
	if n == 0 {
		return ""
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
