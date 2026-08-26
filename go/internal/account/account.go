// Package account ports server.py's multi-account (portal-tenant) switching:
// list_accounts (295), switch_account (312), and the _csp_json identity helper
// (262). CSP identity calls always authenticate with the original long-lived
// API_KEY (never the switched account JWT) so an expired JWT can't lock us out
// — Python keeps this in a global; here it is a mutex-guarded Manager.
package account

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

const cspTimeout = 15 * time.Second

// Manager owns the account-switch state (server.py globals _HOME_ACCOUNT_ID /
// _active_account_id / _jwt_issued_at). It rebinds the active auth by writing
// the shared rest.Auth override slot (consulted before the vault active key),
// exactly as Python overwrites MCP_HEADERS["Authorization"].
type Manager struct {
	mu      sync.Mutex
	baseURL string
	auth    *rest.Auth
	cache   *cache.Cache
	http    *http.Client
	home    string
	// homeVerified is true only once /v2/current_user has actually resolved an
	// account_id. Until then, m.home may hold nothing more than the alphabetically
	// first account (a display guess) and must never be trusted as the home
	// account for SwitchAccount's home-branch — see cspJSON and listAccountsLocked.
	homeVerified bool
	active       string
	jwtIssue     time.Time
}

// New builds the Manager from the shared auth slot + cache. baseURL is
// INFOBLOX_URL. The identity credential is resolved live from auth rather than
// captured here: in vault mode there IS no env API_KEY, so a captured copy was
// always the empty string and every identity call 401'd.
func New(baseURL string, auth *rest.Auth, c *cache.Cache) *Manager {
	return &Manager{
		baseURL: strings.TrimRight(baseURL, "/"),
		auth:    auth,
		cache:   c,
		http:    &http.Client{Timeout: cspTimeout},
	}
}

// cspJSON is _csp_json (server.py:262): a small sync call to a CSP identity
// endpoint, always signed with the caller's own identity credential — the env
// API_KEY when there is one, else the active vault tenant's key. Never the
// switched-account JWT; see rest.Auth.IdentityValue.
func (m *Manager) cspJSON(path string, body any) (map[string]any, int, error) {
	var rdr *bytes.Reader
	var req *http.Request
	var err error
	if body != nil {
		data, e := json.Marshal(body)
		if e != nil {
			return nil, 0, e
		}
		rdr = bytes.NewReader(data)
		req, err = http.NewRequest("POST", m.baseURL+path, rdr)
	} else {
		req, err = http.NewRequest("GET", m.baseURL+path, nil)
	}
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", m.auth.IdentityValue())
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, resp.StatusCode, &HTTPError{Code: resp.StatusCode}
	}
	var parsed any
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		// A 2xx with an undecodable body is a failed read, not an empty success —
		// callers (esp. the home-account resolver) must be able to tell the
		// difference and retry rather than memoizing a wrong fallback forever.
		return nil, resp.StatusCode, fmt.Errorf("csp %s: decode response: %w", path, err)
	}
	if m, ok := parsed.(map[string]any); ok {
		return m, resp.StatusCode, nil
	}
	return map[string]any{}, resp.StatusCode, nil
}

// HTTPError mirrors Python's urllib HTTPError.code so the switch-account handler
// can branch on 403 (not entitled) vs other CSP errors.
type HTTPError struct{ Code int }

func (e *HTTPError) Error() string { return "CSP HTTP " + strconv.Itoa(e.Code) }

// ListAccounts is list_accounts (server.py:295): the active accounts the key's
// user belongs to, sorted by name, plus the resolved active id.
func (m *Manager) ListAccounts() (map[string]any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.listAccountsLocked()
}

func (m *Manager) listAccountsLocked() (map[string]any, error) {
	body, _, err := m.cspJSON("/v2/current_user/accounts", nil)
	if err != nil {
		return nil, err
	}
	accounts := []map[string]any{}
	for _, ai := range asSlice(body["results"]) {
		a, ok := ai.(map[string]any)
		if !ok {
			continue
		}
		state, has := a["state"]
		if has && str(state) != "active" {
			continue
		}
		accounts = append(accounts, map[string]any{"id": str(a["id"]), "name": str(a["name"])})
	}
	sort.SliceStable(accounts, func(i, j int) bool {
		return strings.ToLower(str(accounts[i]["name"])) < strings.ToLower(str(accounts[j]["name"]))
	})
	if !m.homeVerified {
		home := ""
		verified := false
		if cu, _, e := m.cspJSON("/v2/current_user", nil); e == nil {
			if hid := str(asMap(cu["result"])["account_id"]); hid != "" {
				home = hid
				verified = true
			}
		}
		// /v2/current_user failed or came back unparseable: fall back to the
		// alphabetically-first account ONLY as a display guess. Do not mark it
		// verified, so the next call retries the real identity check instead of
		// entrenching a possibly-wrong home forever.
		if home == "" && len(accounts) > 0 {
			home = str(accounts[0]["id"])
		}
		m.home = home
		m.homeVerified = verified
		if m.active == "" {
			m.active = m.home
		}
	}
	out := make([]any, len(accounts))
	for i, a := range accounts {
		out[i] = a
	}
	return map[string]any{"accounts": out, "active": m.active}, nil
}

// SwitchAccount is switch_account (server.py:312): rebind the proxy to another
// account the user belongs to. The home account uses the long-lived key; any
// other account mints a Bearer JWT via /v2/session/account_switch.
func (m *Manager) SwitchAccount(accountID string) (map[string]any, error) {
	accountID = strings.TrimSpace(accountID)
	m.mu.Lock()
	defer m.mu.Unlock()
	lst, err := m.listAccountsLocked()
	if err != nil {
		return nil, err
	}
	known := map[string]string{}
	for _, ai := range lst["accounts"].([]any) {
		a := ai.(map[string]any)
		known[str(a["id"])] = str(a["name"])
	}
	if _, ok := known[accountID]; !ok {
		return map[string]any{"ok": false, "error": "unknown account"}, nil
	}
	if accountID == m.home {
		// Home account: clear the override so the resolver falls back to the
		// normal active-tenant/env key (the long-lived key), undoing any prior
		// switch. Clearing (not SetFallback) is what makes the switch actually
		// take effect in vault mode, where active() would otherwise shadow it.
		//
		// m.home may only be an unverified display guess (see listAccountsLocked)
		// when /v2/current_user has never successfully resolved an account_id. In
		// that case we do NOT know accountID is actually the home account — take
		// the branch anyway and we clear the override + report ok:true for a
		// switch that may not have happened at all. Fail loudly instead.
		if !m.homeVerified {
			return map[string]any{"ok": false, "error": "could not verify home account identity (CSP /v2/current_user unavailable); retry the switch"}, nil
		}
		m.auth.SetOverride("")
	} else {
		// Read BEFORE the round trip, so a tenant transition that lands while it
		// is in flight is detectable when the JWT comes back.
		epoch := m.auth.OverrideEpoch()
		resp, _, err := m.cspJSON("/v2/session/account_switch", map[string]any{"id": accountID})
		if err != nil {
			return nil, err
		}
		jwt := str(resp["jwt"])
		if jwt == "" {
			jwt = str(asMap(resp["result"])["jwt"])
		}
		if jwt == "" {
			return map[string]any{"ok": false, "error": "switch failed (no jwt in response)"}, nil
		}
		// Override wins over the vault active key, so the proxy uses THIS tenant's
		// JWT immediately (no cross-tenant leak).
		//
		// Refused outright if the vault changed tenant while the switch was in
		// flight. This JWT was minted for an account reached through the PREVIOUS
		// tenant's key, so publishing it now would point every proxy call at the
		// tenant the operator just left — and clearing it afterwards is too late,
		// because a request can pin it in between. Not retried with a fresh
		// epoch either: the credential is wrong, not merely late.
		if !m.auth.SetOverrideAt("Bearer "+jwt, epoch) {
			return map[string]any{
				"ok":    false,
				"error": "the active tenant changed during the account switch; nothing was applied — switch again",
			}, nil
		}
		m.jwtIssue = time.Now()
	}
	m.active = accountID
	m.cache.Rotate() // rotate: bump gen (fence in-flight fetches) + drop prior-tenant rows
	return map[string]any{"ok": true, "active": accountID, "name": known[accountID]}, nil
}

// ResetActive clears the portal account-switch state on a vault-tenant mutation,
// so the account context cannot outlive the tenant it belonged to. That includes
// THE AUTH OVERRIDE, and clearing it here rather than only in the caller is the
// whole point of this function taking m.mu.
//
// It used to say "It does NOT touch the auth override or the cache — the
// coordinated caller (main's authReset) clears the override and rotates the
// cache", and that split had a race in it. SwitchAccount holds m.mu across its
// entire body, including the m.auth.SetOverride("Bearer "+jwt) at the end. A
// caller clearing the override OUTSIDE m.mu can therefore land in the middle of
// an in-flight switch: clear, then the switch sets its JWT, and that JWT — minted
// for an account belonging to the tenant being switched AWAY from — stays live
// against the new tenant's dashboard with nothing left to clear it.
//
// Clearing under m.mu makes the two mutually exclusive, so a reset either
// happens entirely before a switch (and the switch that follows is a deliberate
// one against the new tenant) or entirely after it (and the JWT is cleared).
// There is no third interleaving.
//
// The lock order is m.mu then a.mu, which is the order SwitchAccount already
// takes them in. Nothing takes them the other way round: rest.Auth releases its
// own lock before calling the resolver, so no path holds a.mu and then wants
// m.mu. See vault.rotateAuth for what happens when that stops being true.
//
// main's authReset still clears the override before calling this, and that is
// not redundant: this function can wait a long time for m.mu, because
// account.Manager holds it across an outbound CSP request. The early clear
// shortens the window; this one closes the race.
//
// home and homeVerified MUST be cleared with active. They identify the CSP
// account belonging to the OLD tenant's key; the new tenant is a different
// credential for, in general, a different person. Keeping them would let
// SwitchAccount take its home-branch — clear the override, report ok:true — for
// an account the new key may not even belong to, and would pin the switcher's
// default to the previous tenant. Clearing them makes the next listAccountsLocked
// re-resolve identity via /v2/current_user, which is the only source of truth.
//
// This was unreachable until now for a single reason: in vault mode every
// identity call authenticated with an empty header and 401'd, so home was never
// populated in the first place. Fixing that (cspJSON now uses
// auth.IdentityValue) is exactly what makes this path live.
func (m *Manager) ResetActive() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.home = ""
	m.homeVerified = false
	m.active = ""
	m.jwtIssue = time.Time{}
	// Authoritative clear: mutually exclusive with SwitchAccount's own
	// SetOverride, which is what the caller's early clear cannot be.
	m.auth.SetOverride("")
}

// Active returns the currently active account id (lock-guarded).
func (m *Manager) Active() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.active
}

// --- Python-semantics helpers -----------------------------------------------

func asSlice(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func str(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case nil:
		return ""
	case float64:
		if t == float64(int64(t)) {
			return strconv.Itoa(int(int64(t)))
		}
	}
	return ""
}
