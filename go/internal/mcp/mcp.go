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
	"errors"
	"fmt"
	"io"
	"log"
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

// maxRows bounds how many rows queryAllRows will ever page through. Verified
// 2026-07-26: query_stored_data is broken upstream (every read, by
// table_name, resource_id, or read_resource, returns "No stored data found in
// this session"), so any page loop against it is dead weight — but this cap
// also guards the day it's fixed, so one huge stored table can't turn a
// single dashboard load into thousands of tool calls.
const maxRows = 5000

// ErrTooManyRows is returned by queryAllRows when row_count exceeds maxRows.
// No query_stored_data call is issued in this case.
var ErrTooManyRows = errors.New("mcp: row_count exceeds maxRows cap")

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

// extractSSEData pulls the JSON-RPC RESPONSE event out of an SSE reply.
// Verified 2026-07-26 live: the CSP endpoint sends TWO SSE events for any
// tool call carrying a task_description — a `notifications/message` progress
// event first, then the actual result — separated by a blank line per the
// SSE spec. The previous implementation joined every `data:` line across the
// whole stream with "", which mashed both events into one invalid JSON blob
// (`{...}{...}`) and made CallTool fail with "invalid character '{' after
// top-level value" on every task_description call — the real root cause
// behind dns-analytics/host-metrics/get_subnets all coming back empty.
//
// Events are split on blank lines; within one event, `data:` lines are
// joined with "\n" (SSE spec). The last event that decodes as a JSON-RPC
// response (has "id" and "result" or "error" — not a bare notification) is
// returned. If none qualifies, falls back to the old join-everything
// behavior so nothing regresses on a single-event stream.
func extractSSEData(raw []byte) []byte {
	var events [][]byte
	var cur []string
	flush := func() {
		if len(cur) > 0 {
			events = append(events, []byte(strings.Join(cur, "\n")))
			cur = nil
		}
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "data:") {
			cur = append(cur, strings.TrimSpace(line[5:]))
		}
	}
	flush()

	for i := len(events) - 1; i >= 0; i-- {
		var probe struct {
			ID     *int            `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
			Method string          `json:"method"`
		}
		if err := json.Unmarshal(events[i], &probe); err != nil {
			continue
		}
		if probe.ID != nil && (probe.Result != nil || probe.Error != nil) {
			return events[i]
		}
	}

	// Fallback: no response event found (e.g. malformed/empty stream) —
	// preserve the pre-fix behavior rather than erroring outright.
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
//
// FUTURE: result also carries `structuredContent`, the same payload already
// decoded (no text-blob parsing / Python-repr wrangling needed). Once we
// don't need byte-for-byte parity with the old text-block path, switching
// callers to structuredContent directly would let parseInline go away. Left
// alone here to keep this change surgical.
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

// parseInline extracts rows from a measure-only cube/REST response that
// carries its result INLINE instead of stashing it for query_stored_data.
// Verified 2026-07-26 live: query_stored_data is broken upstream (every read
// fails), but a dimensionless cube query still returns its data inline in
// `message`, e.g.:
//
//	{"table_name":"...","row_count":1,"message":"Query Result: [{'AssetDiscoveryStatus.count': '319397'}]. If necessary, ..."}
//
// The payload after "Query Result: " is Python dict-repr (single-quoted),
// not JSON, so it needs its own defensive parse — never query_stored_data.
func parseInline(text string) (rows []map[string]any, ok bool) {
	defer func() {
		if recover() != nil {
			rows, ok = nil, false
		}
	}()

	var msg struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal([]byte(text), &msg); err != nil {
		return nil, false
	}
	const marker = "Query Result: "
	idx := strings.Index(msg.Message, marker)
	if idx == -1 {
		return nil, false
	}
	rest := msg.Message[idx+len(marker):]
	start := strings.Index(rest, "[")
	if start == -1 {
		return nil, false
	}
	end := strings.LastIndex(rest, "]")
	if end == -1 || end < start {
		return nil, false
	}
	list := rest[start : end+1]

	// Split top-level dicts by brace depth (not regex) so a nested dict/list
	// value can be detected instead of silently mis-split by a flat regex.
	// Nesting means the payload shape isn't the flat row we know how to
	// parse — bail on the WHOLE result (see rationale below) rather than
	// guess at hand-parsing it.
	var items []string
	depth := 0
	itemStart := -1
	nested := false
	for i, ch := range list {
		switch ch {
		case '{':
			depth++
			if depth == 1 {
				itemStart = i
			} else {
				nested = true
			}
		case '[':
			if depth >= 1 {
				nested = true
			}
		case '}':
			depth--
			if depth == 0 && itemStart != -1 {
				items = append(items, list[itemStart:i+1])
				itemStart = -1
			}
		}
	}
	if nested || len(items) == 0 {
		return nil, false
	}

	// pairRE captures a key plus one of: a quoted string, a number, or a
	// bare token (only None/True/False are legal Python literals there —
	// anything else is an unrecognized shape).
	pairRE := regexp.MustCompile(`'([^']*)':\s*(?:'([^']*)'|([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)|([A-Za-z_][A-Za-z0-9_]*))`)

	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		locs := pairRE.FindAllStringSubmatchIndex(item, -1)
		if len(locs) == 0 {
			return nil, false
		}
		row := map[string]any{}
		for _, loc := range locs {
			key := item[loc[2]:loc[3]]
			switch {
			case loc[4] != -1: // quoted string
				row[key] = item[loc[4]:loc[5]]
			case loc[6] != -1: // number
				row[key] = item[loc[6]:loc[7]]
			case loc[8] != -1: // bare token
				switch item[loc[8]:loc[9]] {
				case "None":
					row[key] = nil
				case "True":
					row[key] = true
				case "False":
					row[key] = false
				default:
					// An unquoted token we don't recognize (not a Python
					// literal we handle) means we don't understand this
					// value's shape. Returning ok=false for the WHOLE parse
					// sends the caller down its normal degrade path (empty/
					// unavailable state) instead of rendering a row that's
					// silently missing a key as if it were complete data —
					// a partial row is indistinguishable from real data to
					// an operator, so it must not reach them.
					return nil, false
				}
			default:
				continue
			}
		}
		out = append(out, row)
	}
	return out, true
}

// Get is _mcp_get (server.py:3107): make_get_request stores the feed as a
// parquet, then query_stored_data pages 100 rows at a time (the MCP inline
// cap). Returns the assembled rows. Since query_stored_data is broken
// upstream (see parseInline), inline results are tried first and returned
// immediately when present.
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
	if rows, ok := parseInline(text); ok {
		return rows
	}
	table, rowCount, ok := storedMeta(text)
	if !ok {
		return nil
	}
	rows, err := c.queryAllRows(ctx, table, rowCount, service+"/"+endpoint)
	if err != nil {
		log.Printf("mcp: Get %s/%s: %v", service, endpoint, err)
		return nil
	}
	return rows
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
// Returns ErrTooManyRows (before issuing any request) when rowCount exceeds
// maxRows.
func (c *Client) queryAllRows(ctx context.Context, table string, rowCount int, label string) ([]map[string]any, error) {
	if rowCount > maxRows {
		return nil, ErrTooManyRows
	}
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
	return rows, nil
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
	var rows []map[string]any
	if inline, ok := parseInline(text); ok {
		rows = inline
	} else {
		table, rowCount, ok := storedMeta(text)
		if !ok {
			return nil
		}
		var qerr error
		rows, qerr = c.queryAllRows(ctx, table, rowCount, cube+" cube")
		if qerr != nil {
			log.Printf("mcp: QueryCube %s: %v", cube, qerr)
			return nil
		}
	}
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
