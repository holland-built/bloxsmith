// Package mcp is a hand-rolled JSON-RPC 2.0 client for the Infoblox CSP
// streamable-HTTP MCP endpoint (server.py:3059 streamablehttp_client +
// ClientSession). The plan's risk R1 sanctions this over the Go MCP SDK: the
// app calls only `initialize` plus four `tools/call` tools
// (make_get_request, query_stored_data, query_cube, network_entity_search), so
// a bounded hand-rolled client over one POST-per-call transport is the safer,
// well-understood path.
//
// NOTE: /api/data and the hub routes do NOT use this client — the parquet path
// is broken server-side, so they go through internal/rest (see
// dashboard.FetchDashboardData). This client backs the later search (1e) and AI
// (1h) phases; it is wired here so the transport is ported and unit-tested now.
package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// tableRE is _TABLE_RE (server.py:173): validates a stored-parquet table name
// before it is interpolated into a SELECT.
var tableRE = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.\-]{0,127}$`)

// pageSize is the 100-row inline cap MCP enforces (server.py:3086, memory note
// mcp_inline_row_cap). query_stored_data pages through the parquet in blocks.
const pageSize = 100

// Client is a streamable-HTTP MCP session. Auth mirrors MCP_HEADERS: a func so
// the active tenant key (post account-switch) is always read live.
type Client struct {
	url  string
	auth func() string
	http *http.Client

	mu        sync.Mutex
	sessionID string // Mcp-Session-Id issued by initialize
	nextID    int

	initMu      sync.Mutex
	initialized bool
}

// callTimeout bounds any call whose incoming ctx carries no deadline (e.g. a
// request context that never cancels). Package var so tests can shrink it.
var callTimeout = 12 * time.Second

// New builds a client. url is MCP_URL (BASE_URL + "/mcp"); auth returns the
// current Authorization header value (rest.Auth.Value).
func New(url string, auth func() string) *Client {
	return &Client{url: url, auth: auth, http: &http.Client{Timeout: 40 * time.Second}}
}

type rpcReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      *int   `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcResp struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// post sends one JSON-RPC message and returns the decoded response. Handles
// both an application/json body and a text/event-stream (SSE) body — the CSP
// endpoint may reply with either. A nil id makes it a notification (no reply
// expected), returning a nil rpcResp.
func (c *Client) post(ctx context.Context, method string, params any, notify bool) (*rpcResp, error) {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, callTimeout)
		defer cancel()
	}

	c.mu.Lock()
	c.nextID++
	id := c.nextID
	sid := c.sessionID
	c.mu.Unlock()

	body := rpcReq{JSONRPC: "2.0", Method: method, Params: params}
	if !notify {
		body.ID = &id
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", c.auth())
	req.Header.Set("MCP-Protocol-Version", "2025-06-18")
	if sid != "" {
		req.Header.Set("Mcp-Session-Id", sid)
	}
	// Verified 2026-07-22: Auth is read into a plain header value above and the
	// call site never holds a lock across Do — the historical /api/data stall
	// was upstream CSP-side serialization behind a hung /mcp initialize, not
	// contention on this client.
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// Capture a freshly issued session id (initialize).
	if v := resp.Header.Get("Mcp-Session-Id"); v != "" {
		c.mu.Lock()
		c.sessionID = v
		c.mu.Unlock()
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("mcp %s: http %d", method, resp.StatusCode)
	}
	if notify {
		return nil, nil
	}

	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		payload = extractSSEData(payload)
	}
	var out rpcResp
	if err := json.Unmarshal(payload, &out); err != nil {
		return nil, err
	}
	if out.Error != nil {
		return nil, fmt.Errorf("mcp %s: %s", method, out.Error.Message)
	}
	return &out, nil
}

// extractSSEData pulls the JSON body from the last `data:` line of an SSE reply.
func extractSSEData(raw []byte) []byte {
	var data []string
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimSpace(line[5:]))
		}
	}
	if len(data) == 0 {
		return raw
	}
	return []byte(strings.Join(data, ""))
}

// Initialize is session.initialize (server.py:3062): the MCP handshake, then
// the required notifications/initialized. Idempotent: concurrent and repeat
// calls after a successful handshake are no-ops (ensureInit semantics). A
// failed handshake is NOT cached — the next call retries the full handshake,
// since a transient CSP/network error shouldn't wedge the client forever.
func (c *Client) Initialize(ctx context.Context) error {
	c.initMu.Lock()
	defer c.initMu.Unlock()

	c.mu.Lock()
	sid := c.sessionID
	c.mu.Unlock()
	if c.initialized && sid != "" {
		return nil
	}

	_, err := c.post(ctx, "initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "bloxsmith-go", "version": "1"},
	}, false)
	if err != nil {
		// Session expired/rejected (e.g. http 404) or any other handshake
		// failure: leave initialized=false so the next call retries.
		c.initialized = false
		return err
	}
	_, _ = c.post(ctx, "notifications/initialized", map[string]any{}, true)
	c.initialized = true
	return nil
}

// toolText is _tool_text (server.py:3064): the first content block's text, or
// "{}" when the tool returned no content.
func toolText(result json.RawMessage) string {
	var r struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(result, &r); err != nil || len(r.Content) == 0 {
		return "{}"
	}
	return r.Content[0].Text
}

// CallTool is session.call_tool: invoke a tool by name with its args, returning
// the text payload of the first content block.
func (c *Client) CallTool(ctx context.Context, name string, args map[string]any) (string, error) {
	resp, err := c.post(ctx, "tools/call", map[string]any{
		"name": name, "arguments": args,
	}, false)
	if err != nil {
		return "", err
	}
	return toolText(resp.Result), nil
}

// columnarToDicts is _columnar_to_dicts (server.py:3068): DuckDB
// {columns, data} → list of row objects.
func columnarToDicts(raw map[string]any) []map[string]any {
	inner := raw
	if r, ok := raw["results"].(map[string]any); ok {
		inner = r
	}
	cols, _ := inner["columns"].([]any)
	rows, _ := inner["data"].([]any)
	out := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		vals, _ := row.([]any)
		m := map[string]any{}
		for i, col := range cols {
			name, _ := col.(string)
			if i < len(vals) {
				m[name] = vals[i]
			}
		}
		out = append(out, m)
	}
	return out
}

// Get is _mcp_get (server.py:3107): make_get_request stores the feed as a
// parquet, then query_stored_data pages 100 rows at a time (the MCP inline
// cap). Returns the assembled rows.
func (c *Client) Get(ctx context.Context, service, endpoint string, params map[string]any, fetchAll bool) []map[string]any {
	args := map[string]any{
		"task_description": fmt.Sprintf("Fetch %s %s for NOC dashboard", service, endpoint),
		"service_name":     service,
		"endpoint":         endpoint,
		"fetch_all":        fetchAll,
	}
	if len(params) > 0 {
		args["query_params"] = params
	}
	text, err := c.CallTool(ctx, "infoblox-portal_make_get_request", args)
	if err != nil {
		return nil
	}
	table, rowCount, ok := storedMeta(text)
	if !ok {
		return nil
	}
	return c.queryAllRows(ctx, table, rowCount, service+"/"+endpoint)
}

// storedMeta validates a make_get_request / query_cube response and returns its
// (table_name, row_count) when usable (server.py:3134-3136,3173-3175).
func storedMeta(text string) (string, int, bool) {
	var meta map[string]any
	if err := json.Unmarshal([]byte(text), &meta); err != nil {
		return "", 0, false
	}
	table, _ := meta["table_name"].(string)
	rc := 0
	if f, ok := meta["row_count"].(float64); ok {
		rc = int(f)
	}
	if table == "" || !tableRE.MatchString(table) || rc == 0 {
		return "", 0, false
	}
	return table, rc, true
}

// queryAllRows is _query_all_rows (server.py:3085): page the stored parquet.
func (c *Client) queryAllRows(ctx context.Context, table string, rowCount int, label string) []map[string]any {
	var rows []map[string]any
	for offset := 0; offset < rowCount; offset += pageSize {
		text, err := c.CallTool(ctx, "infoblox-portal_query_stored_data", map[string]any{
			"task_description": fmt.Sprintf("Read rows %d–%d from %s", offset, offset+pageSize, label),
			"sql_query":        fmt.Sprintf(`SELECT * FROM "%s" LIMIT %d OFFSET %d`, table, pageSize, offset),
		})
		if err != nil {
			break
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(text), &raw); err != nil {
			break
		}
		batch := columnarToDicts(raw)
		if len(batch) == 0 {
			break
		}
		rows = append(rows, batch...)
	}
	return rows
}

// QueryCube is _mcp_query_cube (server.py:3147): a Cube.js query; column names
// use "__" which is converted back to "." for caller consistency.
func (c *Client) QueryCube(ctx context.Context, cube string, measures []string, opts map[string]any) []map[string]any {
	args := map[string]any{
		"task_description": fmt.Sprintf("Query %s for NOC dashboard analytics", cube),
		"cube_name":        cube,
		"measures":         measures,
	}
	for k, v := range opts {
		args[k] = v
	}
	text, err := c.CallTool(ctx, "infoblox-portal_query_cube", args)
	if err != nil {
		return nil
	}
	table, rowCount, ok := storedMeta(text)
	if !ok {
		return nil
	}
	rows := c.queryAllRows(ctx, table, rowCount, cube+" cube")
	for _, r := range rows {
		for k, v := range r {
			if strings.Contains(k, "__") {
				delete(r, k)
				r[strings.Replace(k, "__", ".", 1)] = v
			}
		}
	}
	return rows
}

// Search is _mcp_search (server.py:3184): network entity search, 256-char cap
// on the user filter.
func (c *Client) Search(ctx context.Context, query string) []any {
	if len(query) > 256 {
		query = query[:256]
	}
	text, err := c.CallTool(ctx, "infoblox-portal_network_entity_search", map[string]any{"query": query})
	if err != nil {
		return nil
	}
	var data any
	if err := json.Unmarshal([]byte(text), &data); err != nil {
		return nil
	}
	if lst, ok := data.([]any); ok {
		return lst
	}
	if m, ok := data.(map[string]any); ok {
		for _, key := range []string{"data", "results", "items"} {
			if v, ok := m[key].([]any); ok {
				return v
			}
		}
	}
	return nil
}
