// Package httpx ports Bloxsmith's HTTP chassis helpers from server.py: the
// _json gzip/CORS/Content-Length responder (6464), _send_cors_origin (6450),
// _cors preflight (6458), and the auth/RBAC middleware (_authed 4885,
// _same_origin 4907, _write_ok 4919, _is_mutating 4929, _write_guard 4956,
// _resolve_role 4977).
package httpx

import (
	"bytes"
	"compress/gzip"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// AuditFn is the hook _write_guard uses to record an authorized write
// (server.py:4968 audit_append). The audit store lands in Phase 1c; until then
// the server passes a no-op. Signature: event, actor, method, path.
type AuditFn func(event, actor, method, path string)

// DefaultMutatingPaths is MUTATING_PATHS (server.py:145): the exact write paths
// that must pass _write_ok before running. Prefix-matched routes
// (/api/dns/records/, /api/ipam/addresses/, /api/edit/) are handled in
// IsMutating, not listed here.
func DefaultMutatingPaths() map[string]bool {
	return map[string]bool{
		"/api/provision/stream":           true,
		"/api/provision/site/stream":      true,
		"/api/provision/seed-demo/stream": true,
		"/api/teardown/site/stream":       true,
		"/api/teardown/seed-demo/stream":  true,
		"/api/selfservice/allocate":       true,
		"/api/dns/records":                true,
		"/api/provision/block":            true,
		"/api/teardown/block":             true,
		"/api/retag/block":                true,
		"/api/alerts/snooze":              true,
		"/api/edit":                       true,
	}
}

// Guard holds the process-wide auth configuration (DASHBOARD_TOKEN + the port
// used to build the same-origin allowlist) and the mutating-path set.
type Guard struct {
	Token         string          // DASHBOARD_TOKEN (server.py:141)
	Port          string          // PORT — builds the same-origin allowlist
	MutatingPaths map[string]bool // MUTATING_PATHS (server.py:145)
	Audit         AuditFn         // write-authorized audit hook (1c)
}

// allowedOrigins is _allowed_origins (server.py:4892): the same-host loopback
// allowlist shared by CORS reflection and the CSRF gate.
func (g *Guard) allowedOrigins() map[string]bool {
	return map[string]bool{
		"http://localhost:" + g.Port: true,
		"http://127.0.0.1:" + g.Port: true,
	}
}

// Authed is _authed (server.py:4885): constant-time X-Auth-Token compare.
func (g *Guard) Authed(r *http.Request) bool {
	if g.Token == "" {
		return false
	}
	supplied := r.Header.Get("X-Auth-Token")
	return subtle.ConstantTimeCompare([]byte(supplied), []byte(g.Token)) == 1
}

// tokenQueryMatches is _token_query_matches (server.py:4897): the SSE GET
// fallback — EventSource can't set headers, so accept a matching ?token= query.
func (g *Guard) tokenQueryMatches(r *http.Request) bool {
	if g.Token == "" {
		return false
	}
	supplied := r.URL.Query().Get("token")
	return subtle.ConstantTimeCompare([]byte(supplied), []byte(g.Token)) == 1
}

// SameOrigin is _same_origin (server.py:4907): an Origin/Referer must be
// allowlisted; with neither header, only a loopback peer is trusted.
func (g *Guard) SameOrigin(r *http.Request) bool {
	ref := r.Header.Get("Origin")
	if ref == "" {
		ref = r.Header.Get("Referer")
	}
	if ref != "" {
		if pu, err := url.Parse(ref); err == nil {
			return g.allowedOrigins()[pu.Scheme+"://"+pu.Host]
		}
		return false
	}
	return isLoopback(r.RemoteAddr)
}

func isLoopback(remoteAddr string) bool {
	host := remoteAddr
	if i := strings.LastIndex(host, ":"); i >= 0 {
		host = host[:i]
	}
	host = strings.Trim(host, "[]")
	return host == "127.0.0.1" || host == "::1"
}

// WriteOK is _write_ok (server.py:4919): token configured -> require it (header
// or ?token=); tokenless -> allow only same-origin/loopback.
func (g *Guard) WriteOK(r *http.Request) bool {
	if g.Token != "" {
		return g.Authed(r) || g.tokenQueryMatches(r)
	}
	return g.SameOrigin(r)
}

// IsMutating is _is_mutating (server.py:4929).
func (g *Guard) IsMutating(path string) bool {
	return g.MutatingPaths[path] ||
		strings.HasPrefix(path, "/api/dns/records/") ||
		strings.HasPrefix(path, "/api/ipam/addresses/") ||
		strings.HasPrefix(path, "/api/edit/")
}

// WriteGuard is _write_guard (server.py:4956): for a mutating path, 403 the
// unauthorized caller (returns true, caller must stop); otherwise audit-log the
// authorized write and return false. Read-only routes never match.
func (g *Guard) WriteGuard(w http.ResponseWriter, r *http.Request) bool {
	path := strings.SplitN(r.URL.Path, "?", 2)[0]
	if g.IsMutating(path) {
		if !g.WriteOK(r) {
			WriteJSON(w, r, http.StatusForbidden, g.Port,
				map[string]any{"error": "forbidden — write not authorized"})
			return true
		}
		if g.Audit != nil {
			g.Audit("write-authorized", actor(r), r.Method, path)
		}
	}
	return false
}

// vaultGateGETExempt is the set of GET routes Python answers BEFORE the vault
// gate (server.py 5009-5063): logo, brand, vault status, update check, sources,
// views — registry/meta only, no tenant data leaks.
var vaultGateGETExempt = map[string]bool{
	"/api/logo": true, "/api/brand": true, "/api/vault/status": true,
	"/api/update/check": true, "/api/sources": true, "/api/views": true,
}

// VaultGate is the VAULT_MODE lock (server.py GET 5065 / POST 6071): when the
// server booted without an env API_KEY and no tenant key is active, no tenant
// data may leave until the vault is unlocked — every /api/ path except the
// registry/meta pre-gate routes returns 503 {"error":"vault locked","locked":
// true}. authed reports whether an active Authorization is bound (Auth.Value()
// != "" — the Go analogue of MCP_HEADERS.get("Authorization")). This is a no-op
// when the server has an env API_KEY (vaultMode=false).
func (g *Guard) VaultGate(vaultMode bool, authed func() bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if vaultMode && !authed() {
				path := strings.SplitN(r.URL.Path, "?", 2)[0]
				if strings.HasPrefix(path, "/api/") && !g.vaultExempt(r.Method, path) {
					WriteJSON(w, r, http.StatusServiceUnavailable, g.Port,
						map[string]any{"error": "vault locked", "locked": true})
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// vaultExempt mirrors Python's method-specific pre-gate ordering: GET exempts
// the six registry routes; every non-GET verb exempts only /api/brand and the
// /api/vault/* control routes (which run before the do_POST gate at 6071).
func (g *Guard) vaultExempt(method, path string) bool {
	if method == http.MethodGet {
		return vaultGateGETExempt[path]
	}
	return path == "/api/brand" || strings.HasPrefix(path, "/api/vault/")
}

// ResolveRole ports _resolve_role (server.py:4977): the three ordered roles.
// With a token configured, a valid token is admin, any other write-authorized
// caller is operator, else viewer. Tokenless (dev) trusts same-origin/loopback
// as admin. The full CSP-identity nuance lands with the fetchers (1d).
func (g *Guard) ResolveRole(r *http.Request) string {
	if g.Token != "" {
		if g.Authed(r) {
			return "admin"
		}
		if g.WriteOK(r) {
			return "operator"
		}
		return "viewer"
	}
	if g.SameOrigin(r) {
		return "admin"
	}
	if g.WriteOK(r) {
		return "operator"
	}
	return "viewer"
}

// roleOrder is _ROLE_ORDER (server.py:4975).
var roleOrder = map[string]int{"viewer": 0, "operator": 1, "admin": 2}

// RoleAtLeast reports whether have satisfies the need threshold (server.py:4993
// _role_at_least, minus the audit side effect — the caller logs rbac_denied).
func RoleAtLeast(have, need string) bool { return roleOrder[have] >= roleOrder[need] }

// Actor exports the best-effort actor label (server.py:4935 _actor) for
// handlers that audit-log outside the write-guard.
func Actor(r *http.Request) string { return actor(r) }

// actor is a best-effort actor label (server.py:4935 _actor). The full CSP
// identity lookup lands with the fetchers (1d); for 1b use loopback vs. IP.
func actor(r *http.Request) string {
	if isLoopback(r.RemoteAddr) {
		return "loopback"
	}
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i >= 0 {
		host = host[:i]
	}
	return host
}

// --- _json responder --------------------------------------------------------

// SendCORSOrigin is _send_cors_origin (server.py:6450): reflect only an
// allowlisted same-host Origin, never wildcard.
func (g *Guard) SendCORSOrigin(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if g.allowedOrigins()[origin] {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Add("Vary", "Origin")
	}
}

// CORSPreflight is _cors + do_OPTIONS (server.py:6458/5002).
func (g *Guard) CORSPreflight(w http.ResponseWriter, r *http.Request) {
	g.SendCORSOrigin(w, r)
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Auth-Token")
	w.WriteHeader(http.StatusOK)
}

// WriteJSON is _json (server.py:6464): JSON body with reflected CORS origin,
// gzip only when body >1KB and the client accepts it, explicit Content-Length.
// port is used to build the same-origin allowlist for the CORS reflection.
func WriteJSON(w http.ResponseWriter, r *http.Request, status int, port string, data any) {
	body, err := json.Marshal(data)
	if err != nil {
		body = []byte(`{"error":"internal error"}`)
		status = http.StatusInternalServerError
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	// CORS origin reflection (matches _send_cors_origin, inlined so WriteJSON
	// needs no Guard receiver — the allowlist is derived from port).
	if origin := r.Header.Get("Origin"); origin != "" {
		if origin == "http://localhost:"+port || origin == "http://127.0.0.1:"+port {
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
		}
	}
	if len(body) > 1024 && strings.Contains(strings.ToLower(r.Header.Get("Accept-Encoding")), "gzip") {
		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		_, _ = gz.Write(body)
		_ = gz.Close()
		body = buf.Bytes()
		h.Set("Content-Encoding", "gzip")
		h.Add("Vary", "Accept-Encoding")
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
