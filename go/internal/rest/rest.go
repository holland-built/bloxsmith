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
	"fmt"
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

// maxIdleConnsPerHost raises http.DefaultTransport's default of 2. Every call
// in this process goes to ONE host (the CSP API), so the default meant a
// fan-out wider than 2 opened fresh TCP+TLS connections that were then thrown
// away instead of pooled — a handshake tax on every burst. /api/data's
// aggregate now issues up to dashboardFanOut concurrent calls and the hub
// endpoints add more alongside it, so the pool is sized to hold all of them
// idle between the 5-minute TTL refreshes rather than churning.
//
// 12 = dashboardFanOut, the widest CONCURRENT burst /api/data can put in
// flight. It is NOT the aggregate's call count — that used to be 12 too, which
// made the old justification ("the aggregate's full call count") look right by
// coincidence; the count is now 21 since the subnet first page was split into
// 10 concurrent offset pages. The pool must be sized to what is in flight at
// once, which the fan-out bound caps, not to how many calls happen in total.
// The value is therefore still exactly right, but the two constants are tied:
// if dashboardFanOut rises, raise this with it. The tie can only be
// documentary — dashboard imports rest, so a cross-package const reference
// would be an import cycle.
//
// The caveat stands: hub endpoints stack on top of that 12-wide burst, so the
// pool has zero headroom. Cost is bounded: idle sockets still expire on the
// inherited IdleConnTimeout (90s), so a quiet process drains back to zero.
const maxIdleConnsPerHost = 12

// sharedTransport is the single connection pool for every Client in the
// process. It MUST be shared: a per-Client transport would fragment the pool so
// each Client (and every Pin-derived copy) kept its own connections, defeating
// the point. Cloned from http.DefaultTransport so proxy/TLS/timeout defaults
// are unchanged — only the idle-conn cap differs.
var sharedTransport = newTransport()

func newTransport() http.RoundTripper {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return http.DefaultTransport // stdlib changed shape; keep working, unpooled
	}
	t := base.Clone()
	t.MaxIdleConnsPerHost = maxIdleConnsPerHost
	return t
}

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

// OverrideActive reports whether a portal account switch is currently in force.
// The per-tenant write lock needs this to know whether the outbound credential
// belongs to the stored key's own account or to a switched-in one — the value
// itself is a secret and is never returned.
func (a *Auth) OverrideActive() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.override != ""
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

// Client is the Infoblox REST proxy. One process-wide Client resolves auth
// live on every outbound call; Pin() derives a request-scoped copy that does
// not.
type Client struct {
	baseURL string
	auth    *Auth
	http    *http.Client

	// pinned freezes the Authorization value for the life of one inbound
	// request. Empty means "resolve live", which is right for background work
	// and wrong for anything serving a request — see Pin.
	pinned string
}

// New builds a Client. baseURL is INFOBLOX_URL (default handled by config);
// auth is the shared mutable slot.
func New(baseURL string, auth *Auth) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		auth:    auth,
		http:    &http.Client{Timeout: timeout, Transport: sharedTransport},
	}
}

// Pin resolves the Authorization value ONCE and returns a Client that uses that
// value for every call made through it, whatever happens to the shared slot
// afterwards.
//
// WHY. The auth slot is process-global and was read afresh on every outbound
// call. A single inbound request usually makes many: /api/data fans out across
// a dozen fetchers, and a provisioning or teardown stream makes dozens over
// minutes. If an account switch landed midway, the first half of the request
// ran against tenant A and the rest against tenant B, silently. The worst case
// is not a confusing dashboard — it is a teardown that starts deleting subnets
// and DNS zones in tenant A and finishes deleting them in tenant B.
//
// Pinning to the value resolved at the START of the request is the correct
// semantics, not merely the safe one: a teardown of tenant A should finish on
// tenant A, and a read that began on tenant A should return tenant A's rows or
// nothing. The switch takes effect on the NEXT request, which is what a user
// clicking "switch account" actually expects.
//
// Background work (pollers, the account manager's own calls) deliberately keeps
// using the unpinned Client: it belongs to no request and must see live state.
func (c *Client) Pin() *Client {
	cp := *c
	cp.pinned = c.auth.Value()
	return &cp
}

// Pinned reports whether this Client is request-scoped.
func (c *Client) Pinned() bool { return c.pinned != "" }

// authValue is the single place an outbound call resolves its Authorization:
// the pinned value when this Client belongs to a request, else the live slot.
func (c *Client) authValue() string {
	if c.pinned != "" {
		return c.pinned
	}
	return c.auth.Value()
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
// (parsed_body, http_status, error). status is 0 on a network error (Python
// returns None — Go uses 0 as the no-response sentinel). Body is nil on an
// HTTP error, a decode error, or a shape error.
//
// A 200 whose body is not valid JSON (a proxy/gateway interstitial) or whose
// decoded JSON is neither an object nor an array (a bare scalar) used to be
// silently swallowed here — `_ = json.Unmarshal(...)` — so callers saw
// (nil, 200, nil): a successful-looking empty read indistinguishable from a
// genuine empty body. That is now surfaced as a non-nil error, mirroring
// GetStrict's decode/shape categorization (getStrict below) without changing
// GetEx's signature. A 204/empty body is NOT a decode failure — it is
// checked for and passed through as (nil, status, nil) before the JSON
// parse is even attempted.
func (c *Client) GetEx(path string, params map[string]string) (any, int, error) {
	req, err := http.NewRequest("GET", c.url(path, params), nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", c.authValue())
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
	if len(raw) == 0 {
		// A genuinely empty body (204, or a 200 with no content) is a
		// legitimate no-op result, not a decode failure.
		return nil, resp.StatusCode, nil
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, resp.StatusCode, fmt.Errorf("rest: decode response body for %s: %w", path, err)
	}
	switch parsed.(type) {
	case map[string]any, []any:
		return parsed, resp.StatusCode, nil
	default:
		return nil, resp.StatusCode, fmt.Errorf("rest: unexpected response shape %T for %s", parsed, path)
	}
}

// snippetCap bounds how much of an upstream body GetStrict retains in an
// UpstreamError. It is enforced at read time via io.LimitReader, never by
// slicing an already fully-read body, so an oversized error page can't blow
// up memory before we know we're about to discard most of it.
const snippetCap = 8 << 10 // 8KiB

// UpstreamError is a failed upstream read that a caller must not mistake for
// an empty result. Category distinguishes the failure modes that all
// previously collapsed to an empty slice via Get/GetEx.
type UpstreamError struct {
	Path      string
	Status    int    // 0 on a transport failure
	Category  string // "network" | "status" | "decode" | "shape"
	Snippet   string // bounded copy of the upstream body, for logs only
	Truncated bool   // Snippet was cut
}

// Error is short and safe for general logs: category, status, path. It NEVER
// includes Snippet, which may carry sensitive upstream response content.
func (e *UpstreamError) Error() string {
	if e.Status > 0 {
		return fmt.Sprintf("upstream %s error (status %d) on %s", e.Category, e.Status, e.Path)
	}
	return fmt.Sprintf("upstream %s error on %s", e.Category, e.Path)
}

// Public is one sanitized sentence fit to show a user — no path, no snippet.
func (e *UpstreamError) Public() string {
	switch e.Category {
	case "network":
		return "Could not reach the upstream server."
	case "status":
		return fmt.Sprintf("The upstream server returned an error (status %d).", e.Status)
	case "decode":
		return "The upstream server's response could not be parsed."
	case "shape":
		return "The upstream server returned an unexpected response format."
	default:
		return "The upstream request failed."
	}
}

// GetStrict is Get with the failures surfaced. Empty is still a legitimate
// result — only a non-nil error means the read failed. Unlike Get, it does
// not call GetEx: GetEx throws the error body away, and GetStrict needs to
// keep a bounded copy of it for UpstreamError.Snippet. It delegates to
// getStrict, discarding the envelope that GetPageStrict needs.
func (c *Client) GetStrict(path string, params map[string]string) ([]any, error) {
	rows, _, err := c.getStrict(path, params)
	return rows, err
}

// GetPageStrict is GetStrict plus the raw envelope: callers that need both
// pagination metadata and a categorized failure must not have to fetch twice.
// It shares getStrict's single request/read/decode routine with GetStrict —
// there is exactly one copy of that logic.
func (c *Client) GetPageStrict(path string, params map[string]string) (rows []any, body map[string]any, err error) {
	return c.getStrict(path, params)
}

// getStrict is the one request/read/decode routine behind both GetStrict and
// GetPageStrict. body is the decoded top-level object when the response is a
// JSON object, else nil (a bare top-level array still populates rows via
// Unwrap, but has no envelope to expose). On error, rows and body are nil.
func (c *Client) getStrict(path string, params map[string]string) ([]any, map[string]any, error) {
	req, err := http.NewRequest("GET", c.url(path, params), nil)
	if err != nil {
		return nil, nil, &UpstreamError{Path: path, Category: "network"}
	}
	req.Header.Set("Authorization", c.authValue())
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, nil, &UpstreamError{Path: path, Category: "network"}
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		// The snippet cap bounds only what we KEEP for logs on a failure — it
		// is never applied to a successful body. Read one byte past the cap
		// so we can tell a cap-hit apart from a body that just happens to be
		// exactly snippetCap bytes long.
		raw, err := io.ReadAll(io.LimitReader(resp.Body, snippetCap+1))
		if err != nil {
			return nil, nil, &UpstreamError{Path: path, Category: "network"}
		}
		truncated := len(raw) > snippetCap
		if truncated {
			raw = raw[:snippetCap]
		}
		return nil, nil, &UpstreamError{
			Path:      path,
			Status:    resp.StatusCode,
			Category:  "status",
			Snippet:   string(raw),
			Truncated: truncated,
		}
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, &UpstreamError{Path: path, Category: "network"}
	}

	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, nil, &UpstreamError{
			Path:     path,
			Status:   resp.StatusCode,
			Category: "decode",
		}
	}

	switch p := parsed.(type) {
	case map[string]any:
		return Unwrap(parsed), p, nil
	case []any:
		return Unwrap(parsed), nil, nil
	default:
		return nil, nil, &UpstreamError{
			Path:     path,
			Status:   resp.StatusCode,
			Category: "shape",
		}
	}
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
	req.Header.Set("Authorization", c.authValue())
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
