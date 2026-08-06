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

	// Host is the interface the server bound (HOST env, default "localhost").
	// It seeds the Host-header allowlist used by HostGuard; a wildcard bind
	// ("", 0.0.0.0, ::) means the legitimate hostnames are unknowable, so the
	// allowlist stands down unless AllowedHosts names them explicitly.
	Host string
	// AllowedHosts is the ALLOWED_HOSTS env list — extra Host values a
	// deployment legitimately serves (a reverse-proxy name, a LAN hostname).
	AllowedHosts []string
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

// --- Fetch Metadata ----------------------------------------------------------
//
// Sec-Fetch-Site is a browser-set request header (Fetch Metadata Request
// Headers, W3C) that page script CANNOT forge: it is on the forbidden-header
// list, so neither fetch() nor XHR nor an <img>/<form> can set or strip it. It
// states the relationship between the initiator and the target:
//
//	same-origin  — our own page (this is what the dashboard's EventSource sends)
//	same-site    — a sibling host under the same registrable domain
//	cross-site   — someone else's page (this is the attacker)
//	none         — user-initiated: typed URL, bookmark, curl-with-the-header
//
// This is the only signal that separates the dashboard's own EventSource GET
// from a hostile page's no-cors GET, because BOTH omit Origin (fetch omits it
// for no-cors/safe-verb requests) and a hostile page can strip Referer with
// referrerPolicy:"no-referrer". Loopback cannot separate them either — the
// victim's browser genuinely runs on the operator's machine.

// fetchSite returns the normalized Sec-Fetch-Site value, "" when absent.
func fetchSite(r *http.Request) string {
	return strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")))
}

// selfInitiated reports that the browser vouched for this request as coming
// from our own origin (or from the user directly).
func selfInitiated(r *http.Request) bool {
	s := fetchSite(r)
	return s == "same-origin" || s == "none"
}

// foreignInitiated reports that the browser explicitly attributed this request
// to another site. Present-and-not-ours is a hard reject, loopback or not.
func foreignInitiated(r *http.Request) bool {
	s := fetchSite(r)
	return s != "" && s != "same-origin" && s != "none"
}

// originOrReferer is Python's `origin or referer` (server.py:4908).
func originOrReferer(r *http.Request) string {
	if o := r.Header.Get("Origin"); o != "" {
		return o
	}
	return r.Header.Get("Referer")
}

// originAllowed matches a stated Origin/Referer against the loopback allowlist.
func (g *Guard) originAllowed(ref string) bool {
	pu, err := url.Parse(ref)
	if err != nil {
		return false
	}
	return g.allowedOrigins()[pu.Scheme+"://"+pu.Host]
}

// SameOrigin is _same_origin (server.py:4907): an Origin/Referer must be
// allowlisted; with neither header, a browser that vouches for itself via
// Sec-Fetch-Site, or a loopback peer, is trusted. A browser that names another
// site is rejected outright — the loopback fallback never gets to run.
func (g *Guard) SameOrigin(r *http.Request) bool {
	if foreignInitiated(r) {
		return false
	}
	if ref := originOrReferer(r); ref != "" {
		return g.originAllowed(ref)
	}
	return selfInitiated(r) || isLoopback(r.RemoteAddr)
}

// WriteOKStrict is the CSRF gate for a state-changing request that arrives on a
// SAFE VERB — the five SSE provision/teardown streams, which the UI must drive
// with EventSource (a GET). It is WriteOK minus the loopback fallback.
//
// The fallback is the vulnerability: a hostile page the operator visits can fire
//
//	fetch("http://127.0.0.1:8080/api/teardown/seed-demo/stream?confirm=DELETE&dry=0",
//	      {mode:"no-cors", referrerPolicy:"no-referrer"})
//
// which sends no Origin (no-cors GET) and no Referer (policy), so the old
// Origin/Referer branches both missed and `isLoopback` returned true — the
// browser really is on the operator's machine. That decommissioned live DNS
// zones, subnets and address blocks with no response read required; an
// <img src=...> works the same way. Non-safe verbs (POST/PATCH/DELETE) are not
// affected — a browser always sends Origin for those — so they keep WriteOK and
// its loopback trust, which is what tokenless CLI scripting relies on.
//
// The rule, tokenless:
//   - Sec-Fetch-Site names another site  -> reject, loopback notwithstanding
//   - Origin/Referer present             -> must match the loopback allowlist
//   - neither, but Sec-Fetch-Site says same-origin/none -> allow (the real UI)
//   - no evidence at all                 -> reject (was: trust loopback)
//
// With a token configured the gate is unchanged: header or ?token= only, which
// is the supported path for curl/scripts and for browsers too old to send Fetch
// Metadata.
func (g *Guard) WriteOKStrict(r *http.Request) bool {
	if g.Token != "" {
		return g.Authed(r) || g.tokenQueryMatches(r)
	}
	if foreignInitiated(r) {
		return false
	}
	if ref := originOrReferer(r); ref != "" {
		return g.originAllowed(ref)
	}
	return selfInitiated(r)
}

// hostOf strips the :port and any IPv6 brackets off an http.Request.RemoteAddr,
// leaving the bare peer address ("127.0.0.1:54321" -> "127.0.0.1",
// "[::1]:54321" -> "::1"). A value with no port at all is returned unchanged.
//
// The one place this is derived, for the three things that key off the peer:
// the loopback check below, the audit actor label, and the unlock throttle's
// per-client counter (unlock_throttle.go). It was two hand-copied
// LastIndex-then-Trim blocks before that third caller; a security decision and
// an audit label disagreeing about who the peer is would be a very quiet bug.
func hostOf(remoteAddr string) string {
	host := remoteAddr
	if i := strings.LastIndex(host, ":"); i >= 0 {
		host = host[:i]
	}
	return strings.Trim(host, "[]")
}

func isLoopback(remoteAddr string) bool {
	host := hostOf(remoteAddr)
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
//
// CSRF hardening: besides the explicit mutating set, every state-changing verb
// on any /api/ route (unsafeAPIWrite) must pass WriteOK — this covers the
// /api/vault/* control routes, which are NOT in the mutating set and whose
// handlers do no Origin/token check. Without this a cross-origin "simple" POST
// (text/plain, no preflight) the victim's browser sends to the loopback server
// could add/activate/destroy vault keys. The gate holds because any cross-origin
// browser request carries an Origin the allowlist rejects, and a token deployment
// requires the token. Audit semantics are unchanged: only mutating paths are
// audit-logged.
func (g *Guard) WriteGuard(w http.ResponseWriter, r *http.Request) bool {
	path := strings.SplitN(r.URL.Path, "?", 2)[0]
	mutating := g.IsMutating(path)
	if mutating || unsafeAPIWrite(r.Method, path) {
		// A mutating route reached on a safe verb (the five SSE streams) gets
		// the strict fetch-metadata gate — the loopback fallback is forgeable
		// by any page the operator visits. See WriteOKStrict.
		ok := false
		if mutating && safeVerb(r.Method) {
			ok = g.WriteOKStrict(r)
		} else {
			ok = g.WriteOK(r)
		}
		if !ok {
			WriteJSON(w, r, http.StatusForbidden, g.Port,
				map[string]any{"error": "forbidden — write not authorized"})
			return true
		}
	}
	if mutating && g.Audit != nil {
		g.Audit("write-authorized", actor(r), r.Method, path)
	}
	return false
}

// unsafeAPIWrite reports whether a request is a state-changing verb targeting an
// /api/ route. GET/HEAD (safe reads) and OPTIONS (handled as CORS preflight
// before the write guard) are excluded, so read routes and the SSE ?token= GET
// fallback keep their existing behavior.
func unsafeAPIWrite(method, path string) bool {
	if safeVerb(method) || method == http.MethodOptions {
		return false
	}
	return strings.HasPrefix(path, "/api/")
}

// safeVerb reports the RFC 9110 safe verbs — the ones a browser will issue
// cross-origin with no Origin header and no preflight.
func safeVerb(method string) bool {
	return method == http.MethodGet || method == http.MethodHead
}

// --- DNS rebinding: Host header allowlist ------------------------------------

// wildcardBind reports a bind address whose legitimate hostnames cannot be
// derived (0.0.0.0 / :: / unset — the Docker image sets HOST=0.0.0.0 and is
// reached through whatever name its published port is fronted by).
func (g *Guard) wildcardBind() bool {
	switch strings.Trim(strings.ToLower(g.Host), "[]") {
	case "", "0.0.0.0", "::", "*":
		return true
	}
	return false
}

// hostAllowlist is the set of Host header values this server answers to, with
// and without the port.
func (g *Guard) hostAllowlist() map[string]bool {
	m := map[string]bool{}
	add := func(h string) {
		h = strings.ToLower(strings.TrimSpace(h))
		if h == "" {
			return
		}
		// A bare IPv6 literal (HOST=::1) is written [::1] in a Host header.
		if strings.Count(h, ":") > 1 && !strings.HasPrefix(h, "[") {
			h = "[" + h + "]"
		}
		m[h] = true
		if g.Port != "" && !hasPort(h) {
			m[h+":"+g.Port] = true
		}
	}
	add("localhost")
	add("127.0.0.1")
	add("[::1]")
	if !g.wildcardBind() {
		add(g.Host)
	}
	for _, h := range g.AllowedHosts {
		add(h)
	}
	return m
}

// hasPort reports whether a host value already carries a :port, handling the
// bracketed IPv6 form ("[::1]" has colons but no port; "[::1]:8080" does).
func hasPort(h string) bool {
	if i := strings.LastIndex(h, "]"); i >= 0 {
		return strings.Contains(h[i:], ":")
	}
	return strings.Contains(h, ":")
}

// HostAllowed is the DNS-rebinding gate. Nothing else in the stack validates
// r.Host, so an attacker domain whose DNS re-resolves to 127.0.0.1 becomes
// same-origin to the dashboard in the browser's eyes — its page then reads
// every tenant response and passes the CSRF checks legitimately, because from
// the browser's point of view it IS the dashboard's origin. Pinning the Host
// header to the names this server actually serves breaks that: the rebound
// request still carries Host: evil.example, which is not one of them.
//
// A wildcard bind with no explicit ALLOWED_HOSTS cannot know its own names, so
// the gate stands down there rather than break Docker/LAN deployments; set
// ALLOWED_HOSTS to re-arm it.
func (g *Guard) HostAllowed(r *http.Request) bool {
	if g.wildcardBind() && len(g.AllowedHosts) == 0 {
		return true
	}
	host := strings.ToLower(strings.TrimSpace(r.Host))
	if host == "" {
		return false
	}
	return g.hostAllowlist()[host]
}

// hostGuardExempt is the set of paths answered BEFORE the Host allowlist, in the
// same shape as vaultGateGETExempt below: an explicit, closed list, not a prefix.
//
// ONE ENTRY, AND IT HAS TO BE JUSTIFIED. /healthz is the container/orchestrator
// health probe (internal/server, GET /healthz). A prober does not know or care
// what name this server answers to; it asks whatever address it holds — a pod
// IP, a container IP on a bridge network, a target-group member address, the
// hostname an uptime monitor was configured with — and the Host header carries
// that. None of those are in hostAllowlist, so without this exemption the gate
// returns 421 to every one of them.
//
// The consequence is worse than a wrong answer, because 421 is not a 5xx and is
// not a timeout: the prober records a non-200, marks the target unhealthy, and
// keeps doing so forever. The server is perfectly healthy the whole time and
// says nothing about why it is being failed. That is the exact silent-and-
// permanent failure this list exists to prevent, and it is the reason the
// exemption is written together with the route rather than after someone
// deploys it. (The compose probe this repo ships would in fact pass the
// allowlist today — it runs `bloxsmith healthcheck` inside the container against
// 127.0.0.1, and loopback is always allowlisted. It is every OTHER prober,
// including the Kubernetes/ALB deployments the standalone binary invites, that
// this covers.)
//
// WHAT IT COSTS. A DNS-rebound page gets a 200 with {"status","version"} where
// it previously got a 421. It does not gain any tenant data, any path, or any
// vault state — see the healthz comment for why the body is the shape it is —
// and it already knew the target existed, because rebinding requires naming it.
// The version string is the whole of the leak, and it is the trade being made.
// Nothing else goes on this list without the same argument.
func hostGuardExempt(path string) bool {
	return path == "/healthz"
}

// HostGuard wraps the whole mux with HostAllowed, 421 Misdirected Request for a
// Host this server does not serve. hostGuardExempt names the routes that answer
// before the allowlist and explains why.
func (g *Guard) HostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.SplitN(r.URL.Path, "?", 2)[0]
		if !hostGuardExempt(path) && !g.HostAllowed(r) {
			WriteJSON(w, r, http.StatusMisdirectedRequest, g.Port,
				map[string]any{"error": "forbidden — unrecognized Host header"})
			return
		}
		next.ServeHTTP(w, r)
	})
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
	return hostOf(r.RemoteAddr)
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
