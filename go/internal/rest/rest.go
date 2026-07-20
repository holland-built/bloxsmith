// Package rest ports Bloxsmith's Infoblox REST proxy from server.py
// (_rest_get 354, _rest_get_ex 371, _rest_write 390, _cspq/_cspq_field 334/345,
// _lit 5159). It is the single outbound path to the Infoblox CSP API: every
// tile, fetcher, and write goes through one Client so auth, timeout, and error
// handling stay identical to the Python reference.
package rest

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// timeout matches server.py's 35-second urlopen timeout on every REST call.
const timeout = 35 * time.Second

// Auth is the single mutable Authorization slot, replacing Python's global
// MCP_HEADERS["Authorization"] (set by _apply_active). Value() returns the
// active tenant key with the static API_KEY as fallback, mirroring
// `MCP_HEADERS.get("Authorization") or API_KEY` (server.py:359/379/398). It is
// RWMutex-guarded, which closes the long-known _apply_active read/write race
// (plans/README.md session-2) without changing behavior.
type Auth struct {
	mu       sync.RWMutex
	override string        // portal account-switch key; consulted FIRST when set
	fallback string        // API_KEY from the environment (server.py:41)
	active   func() string // active tenant key, e.g. vault.ActiveKey
}

// NewAuth builds the slot from the env API_KEY and an active-key resolver.
func NewAuth(fallback string, active func() string) *Auth {
	return &Auth{fallback: fallback, active: active}
}

// Value resolves the current Authorization header: active tenant key, else the
// env fallback. Matches `MCP_HEADERS.get("Authorization") or API_KEY`.
func (a *Auth) Value() string {
	a.mu.RLock()
	defer a.mu.RUnlock()
	// A portal account switch takes precedence over everything: in vault mode
	// active() is non-empty, so without this the switched-in JWT would be
	// shadowed and REST calls would keep hitting the PRIOR tenant (cross-tenant
	// leak). The override is set by account.SwitchAccount and cleared when
	// switching back to the home account.
	if a.override != "" {
		return a.override
	}
	if a.active != nil {
		if k := a.active(); k != "" {
			return k
		}
	}
	return a.fallback
}

// SetFallback replaces the env fallback key. Guarded so concurrent reads are safe.
func (a *Auth) SetFallback(k string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.fallback = k
}

// SetOverride sets (or, with "", clears) the account-switch Authorization slot
// that Value() consults BEFORE the active-tenant key and the env fallback. This
// is how a portal account switch actually takes effect through the same resolver
// the REST proxy reads — matching Python's last-writer-wins auth slot where the
// switch wins. Guarded so a concurrent request reads either the old or the new
// value, never a torn one.
func (a *Auth) SetOverride(k string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.override = k
}

// Client is the Infoblox REST proxy. Construct one per process.
type Client struct {
	baseURL string
	auth    *Auth
	http    *http.Client
}

// New builds a Client. baseURL is INFOBLOX_URL (default handled by config);
// auth is the shared mutable slot.
func New(baseURL string, auth *Auth) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		auth:    auth,
		http:    &http.Client{Timeout: timeout},
	}
}

func (c *Client) url(path string, params map[string]string) string {
	u := c.baseURL + path
	if len(params) > 0 {
		q := url.Values{}
		for k, v := range params {
			q.Set(k, v)
		}
		u += "?" + q.Encode()
	}
	return u
}

// GetEx is _rest_get_ex (server.py:371): status-surfacing REST GET returning
// (parsed_body, http_status). status is 0 on a network error (Python returns
// None — Go uses 0 as the no-response sentinel). Body is nil on an HTTP error.
func (c *Client) GetEx(path string, params map[string]string) (any, int, error) {
	req, err := http.NewRequest("GET", c.url(path, params), nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", c.auth.Value())
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, resp.StatusCode, nil
	}
	var parsed any
	_ = json.Unmarshal(raw, &parsed)
	return parsed, resp.StatusCode, nil
}

// Get is _rest_get (server.py:354): unwraps results/result to a list, swallowing
// errors to an empty slice (Python prints a warning and returns []).
func (c *Client) Get(path string, params map[string]string) []any {
	body, status, err := c.GetEx(path, params)
	if err != nil || status == 0 || status >= 400 {
		return []any{}
	}
	return Unwrap(body)
}

// Write is _rest_write (server.py:390): POST/PATCH/DELETE returning
// (parsed_body, http_status). On an HTTP error it captures the parsed error body
// (Python's e.read() -> json). status is 0 on a network error.
func (c *Client) Write(method, path string, body any, params map[string]string) (any, int, error) {
	var rdr io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		rdr = bytes.NewReader(data)
	}
	req, err := http.NewRequest(strings.ToUpper(method), c.url(path, params), rdr)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", c.auth.Value())
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		var errBody any
		_ = json.Unmarshal(raw, &errBody) // nil if unparseable — matches Python
		return errBody, resp.StatusCode, nil
	}
	if len(raw) == 0 {
		return nil, resp.StatusCode, nil
	}
	var parsed any
	_ = json.Unmarshal(raw, &parsed)
	return parsed, resp.StatusCode, nil
}

// Unwrap mirrors _rest_get's body handling (server.py:364-366): a dict yields
// its "results" (else "result") list; a bare list passes through; anything else
// is empty.
func Unwrap(body any) []any {
	switch b := body.(type) {
	case map[string]any:
		if v, ok := b["results"].([]any); ok {
			return v
		}
		if v, ok := b["result"].([]any); ok {
			return v
		}
		return []any{}
	case []any:
		return b
	default:
		return []any{}
	}
}

// --- filter injection guards ------------------------------------------------

var (
	cspCtrl  = regexp.MustCompile(`[\x00-\x1f\x7f]`)      // control chars (server.py _CSP_CTRL)
	cspField = regexp.MustCompile(`^[A-Za-z0-9_.\-]+$`)   // identifier-safe field name
)

// ErrBadFilter maps to HTTP 400 (Python raises ValueError).
var ErrBadFilter = errors.New("invalid character in filter value")

// CSPQ is _cspq (server.py:334): escape a value for a double-quoted CSP
// _filter/_tfilter clause. Backslash-escapes \ and "; rejects control chars.
func CSPQ(v string) (string, error) {
	if cspCtrl.MatchString(v) {
		return "", ErrBadFilter
	}
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(v), nil
}

// CSPQField is _cspq_field (server.py:345): validate an unquoted field name
// (left of ==); only [A-Za-z0-9_.-] is allowed.
func CSPQField(v string) (string, error) {
	if !cspField.MatchString(v) {
		return "", errors.New("invalid filter field name")
	}
	return v, nil
}

// Lit is _lit (server.py:5159): the incidents/audit _filter injection guard.
// User text goes inside a double-quoted _filter literal, so every backslash and
// double-quote is STRIPPED (not escaped) so it cannot break out of the quoted
// clause. Returns the value already wrapped in double quotes, exactly as Python.
func Lit(v string) string {
	s := strings.NewReplacer(`\`, "", `"`, "").Replace(v)
	return `"` + s + `"`
}
