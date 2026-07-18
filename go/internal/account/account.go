// Package account ports server.py's multi-account (portal-tenant) switching:
// list_accounts (295), switch_account (312), and the _csp_json identity helper
// (262). CSP identity calls always authenticate with the original long-lived
// API_KEY (never the switched account JWT) so an expired JWT can't lock us out
// — Python keeps this in a global; here it is a mutex-guarded Manager.
package account

import (
	"bytes"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

const cspTimeout = 15 * time.Second

// Manager owns the account-switch state (server.py globals _HOME_ACCOUNT_ID /
// _active_account_id / _jwt_issued_at). It rebinds the active auth by writing
// the shared rest.Auth fallback slot, exactly as Python overwrites
// MCP_HEADERS["Authorization"].
type Manager struct {
	mu       sync.Mutex
	baseURL  string
	apiKey   string // original env API_KEY (never overwritten)
	auth     *rest.Auth
	cache    *cache.Cache
	http     *http.Client
	home     string
	active   string
	jwtIssue time.Time
}

// New builds the Manager from the immutable env API_KEY plus the shared auth +
// cache. baseURL is INFOBLOX_URL.
func New(baseURL, apiKey string, auth *rest.Auth, c *cache.Cache) *Manager {
	return &Manager{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		auth:    auth,
		cache:   c,
		http:    &http.Client{Timeout: cspTimeout},
	}
}

// cspJSON is _csp_json (server.py:262): a small sync call to a CSP identity
// endpoint, always signed with the original API_KEY.
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
	req.Header.Set("Authorization", m.apiKey)
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
		return map[string]any{}, resp.StatusCode, nil
	}
	if m, ok := parsed.(map[string]any); ok {
		return m, resp.StatusCode, nil
	}
	return map[string]any{}, resp.StatusCode, nil
}

// HTTPError mirrors Python's urllib HTTPError.code so the switch-account handler
// can branch on 403 (not entitled) vs other CSP errors.
type HTTPError struct{ Code int }

func (e *HTTPError) Error() string { return "CSP HTTP " + itoa(e.Code) }

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
	if m.home == "" {
		home := ""
		if cu, _, e := m.cspJSON("/v2/current_user", nil); e == nil {
			home = str(asMap(cu["result"])["account_id"])
		}
		if home == "" && len(accounts) > 0 {
			home = str(accounts[0]["id"])
		}
		m.home = home
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
		m.auth.SetFallback(m.apiKey) // long-lived key beats a JWT
	} else {
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
		m.auth.SetFallback("Bearer " + jwt)
		m.jwtIssue = time.Now()
	}
	m.active = accountID
	m.cache.Invalidate() // cached rows belong to the previous tenant
	return map[string]any{"ok": true, "active": accountID, "name": known[accountID]}, nil
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
			return itoa(int(int64(t)))
		}
	}
	return ""
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
