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
	"math"
	"net/http"
	"regexp"
	"strconv"
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

// maxRows bounds how many rows queryAllRows will ever page through.
//
// CORRECTION, 2026-08-06. This comment used to read: "Verified 2026-07-26:
// query_stored_data is broken upstream (every read, by table_name,
// resource_id, or read_resource, returns 'No stored data found in this
// session'), so any page loop against it is dead weight — but this cap also
// guards the day it's fixed."
//
// WHAT IS TRUE: the readback is not broken. Every dimensioned cube query
// issued in the 2026-08-06 session stored its result and read it back
// successfully, 100 rows per query_stored_data call (the pageSize cap above),
// paging cleanly to the end of the table.
//
// HOW IT WAS MEASURED: live, against the real tenant, via
// infoblox-portal_query_cube on the AssetDetails_ch_agg cube — dimensioned
// queries (name / taxonomy_type_label / providers_label / vendor / last_seen
// keyed on cqid), read back in full, with cube-side limit/offset paging
// confirmed non-overlapping (offset 2500 returned 50 rows, offset 2600
// returned 20, against a real total of 2,620 assets).
//
// WHY THE 2026-07-26 READING WAS PLAUSIBLE ANYWAY: a measures-only cube query
// carries its answer inline in `message` and stores nothing, so a
// query_stored_data call chasing it genuinely does answer "No stored data
// found in this session" — correctly. Generalising that to "every read" is
// what was wrong.
//
// So this cap is not dead weight guarding a hypothetical: it is live, and it
// is the only thing stopping one large stored table from turning a single
// dashboard load into thousands of tool calls. Do not remove it.
const maxRows = 5000

// ErrTooManyRows is returned by queryAllRows when row_count exceeds maxRows.
// No query_stored_data call is issued in this case.
var ErrTooManyRows = errors.New("mcp: row_count exceeds maxRows cap")

// ErrIncompleteRows is returned by queryAllRows when a transport or decode
// failure aborts pagination AFTER at least one page has already been read
// successfully. A short or empty page is a legitimate end of data and is
// never wrapped in this error — only an outright failure mid-pagination is,
// because in that case the true row count is unknown and the rows gathered
// so far must never be presented as the complete set. Match with errors.Is.
var ErrIncompleteRows = errors.New("mcp: pagination aborted before all rows were read")

// ErrTransport is wrapped into CallToolChecked's returned error whenever the
// call failed at the transport layer (network, HTTP status, response body or
// JSON-RPC framing) rather than being answered by the tool.
//
// IT DOES NOT MEAN THE WRITE WAS NEVER SENT, AND IT IS NOT ALWAYS SAFE TO
// RETRY. It used to say both, and both were wrong. CallToolChecked wraps EVERY
// error out of CallTool as this sentinel, which covers the call timeout
// expiring after the tool already ran, a gateway status >= 400 raised once it
// may already have run, and a body-read or decode failure after it ran. At this
// layer "never sent" and "sent, outcome unknown" are indistinguishable, so a
// match here means UNKNOWN. TestErrTransportCanFollowAToolThatRan proves it
// with a server that executes the call and then fails the reply.
//
// So: retry only a write you know to be idempotent, and never report a match
// here as "nothing was applied" — see internal/dashboard/security.go's
// isMcpTransportError for the same rule stated where it is acted on.
//
// ErrRejected below is the other half and has always been right: the call
// reached the tool, and the write may or may not have landed. Neither sentinel
// can tell a caller the tenant is unchanged.
//
// Callers should match with errors.Is rather than inspecting the error's
// message text, which is free to change without notice.
var ErrTransport = errors.New("mcp: transport error")

// ErrRejected is wrapped into CallToolChecked's returned error whenever the
// tool replied but the reply did not satisfy the SuccessPredicate (including
// the case where no predicate exists at all — see CallToolChecked). The call
// reached the tool; the write may or may not have landed upstream.
var ErrRejected = errors.New("mcp: rejected")

// ErrIDMismatch is returned by post when a reply carries a JSON-RPC id that is
// not the id we asked with — i.e. the answer belongs to a different question.
//
// It is deliberately NOT an ErrTransport. ErrTransport promises the caller
// nothing was applied, and that promise is false here: the request was written
// to the wire and the server answered something, so a mutation may well have
// landed. CallToolChecked therefore maps this to ErrRejected instead.
//
// Filed against issue #138, where the Assets tab rendered one identity-less
// asset over a header claiming 2,355. The list read had come back holding the
// COUNT read's single aggregate row. Whether that was a mis-addressed reply has
// never been established, because nothing in this client compared the two ids —
// so the one thing that could tell "wrong answer delivered" apart from "server
// answered this question wrongly" was not being looked at.
var ErrIDMismatch = errors.New("mcp: response id did not match the request")

// Client is a streamable-HTTP MCP session. Auth mirrors MCP_HEADERS: a func so
// the active tenant key (post account-switch) is always read live.
type Client struct {
	url  string
	auth func() string
	http *http.Client

	mu        sync.Mutex
	sessionID string // Mcp-Session-Id issued by initialize
	nextID    int

	// uncorrelatedWarn fires at most one log line per client for a server that
	// answers without echoing an id at all. That is a correlation blind spot
	// worth knowing about — it means the ErrIDMismatch check below can never
	// fire — but it is not itself a failure, and repeating it on every call
	// would bury the log.
	uncorrelatedWarn sync.Once

	initMu      sync.Mutex
	initialized bool
	// lastInitErr is the last handshake failure already written to the log,
	// so a sustained outage does not repeat it on every call. See Initialize.
	lastInitErr string
}

// WHY THIS FILE LOGS ITS FAILURES, AND WHAT IT WILL NOT PUT IN THE LOG.
//
// Get, QueryCube and Search all report failure the same way: a NIL slice. Every
// dashboard assembler is built on that (see assembleAssetInventory,
// assembleAssetsResult, scalarCubeTotal), and it is the right contract — but a
// nil carries no reason, so the panel says "the query failed upstream" and the
// server used to record nothing at all. An intermittent failure that discards
// its own reason cannot be reproduced, which is exactly where issue #136
// started. Every failure path below therefore writes one line before returning
// nil, in the shape `mcp: <Func> <subject>: <reason>`.
//
// The rule about WHAT goes in that line:
//
//   - An upstream JSON-RPC error message IS logged, verbatim. "cube quota
//     exceeded", "session expired", "the tenant is not entitled to X" — that is
//     the diagnosis, and sanitising it would leave the log saying only that
//     something failed, which is the bug.
//
//   - A data-bearing RESPONSE BODY is NEVER logged, not in part and not in
//     summary. On a real tenant it carries device names, IP and MAC addresses.
//     So storedMeta returns a FIXED CLASSIFICATION for an unusable payload and
//     no caller interpolates any substring of the reply — not even the rejected
//     table_name, which is upstream-controlled.
//
// TestFailureLogsNeverEchoAResponseBody and TestTransportFailuresLogTheUpstream
// Reason are the two halves of that rule, and they must both keep passing.

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
	// ID is held as RawMessage, not *int, for two reasons. JSON-RPC 2.0 allows
	// a string or a number id, so *int silently drops a conforming string id on
	// the floor and reads as "absent". And *int cannot tell an absent id from an
	// explicit JSON null, which are different things: absent means the server
	// never echoes ids, null means it could not attribute this reply to any
	// request. Only the first is worth a warning.
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// idMatchesRequest compares a reply's JSON-RPC id against the int id this
// client sent. comparable is false when the reply carries no usable id at all
// (absent, or an explicit null) — that is a blind spot, not a mismatch, and the
// caller must not fail the call over it.
//
// Both the number form (`"id":7`) and the string form (`"id":"7"`) count as a
// match, because a server is free to echo either and rejecting a conforming
// reply would be a worse bug than the one this guards.
func idMatchesRequest(want int, got json.RawMessage) (match, comparable bool) {
	raw := bytes.TrimSpace(got)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return false, false
	}
	wantStr := strconv.Itoa(want)
	if string(raw) == wantStr {
		return true, true
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s == wantStr, true
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String() == wantStr, true
	}
	// Some other JSON shape entirely (object, array, bool). Not our id, but we
	// can see that it is not, so it counts as comparable and mismatched.
	return false, true
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
		payload = extractSSEData(payload, id)
	}
	var out rpcResp
	if err := json.Unmarshal(payload, &out); err != nil {
		return nil, err
	}

	// CORRELATE THE ANSWER WITH THE QUESTION. Every request above is stamped
	// with a unique id and, until issue #138, nothing ever looked at the id that
	// came back — rpcResp did not even parse the field. A reply belonging to a
	// different request would have been accepted as this one's answer in
	// silence, which is precisely the failure mode that leaves no trace in a
	// log: nothing errors, a well-formed result is returned, and the caller
	// renders it. This check runs BEFORE the Error branch on purpose — an error
	// addressed to someone else's request is not this call's failure to report.
	//
	// Deliberately fail-closed with no retry. post also carries the mutating
	// CallToolChecked calls, and re-sending a request whose outcome is unknown
	// could apply it twice; any retry policy belongs in an idempotent read
	// caller that can reason about it, not here.
	if match, comparable := idMatchesRequest(id, out.ID); comparable && !match {
		// The received id is NOT interpolated. It is upstream-controlled, and
		// this file's standing rule is that no substring of a reply reaches the
		// log (see the block comment above callTimeout). Our own id is enough:
		// the fact of a mismatch is the whole diagnosis.
		log.Printf("mcp: %s: reply carries a JSON-RPC id that is not the one this request asked with (id %d) — answer discarded, not rendered", method, id)
		return nil, fmt.Errorf("mcp %s: %w (asked id %d)", method, ErrIDMismatch, id)
	} else if !comparable {
		c.uncorrelatedWarn.Do(func() {
			log.Printf("mcp: %s: reply carries no JSON-RPC id, so replies cannot be matched to requests on this endpoint — a mis-addressed answer would go undetected", method)
		})
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
// joined with "\n" (SSE spec). If none qualifies, falls back to the old
// join-everything behavior so nothing regresses on a single-event stream.
//
// WHICH response event is returned, and why that changed. This used to take
// the LAST event decoding as a JSON-RPC response. That is the wrong rule the
// moment a stream carries more than one response, because "last" is a position
// and what the caller needs is a match: if the reply to request 7 arrives ahead
// of some other response on the same stream, position picks the wrong one while
// the id picks the right one. wantID > 0 therefore selects the event whose id
// is wantID, and only falls back to last-response-event when no event matches
// (which keeps post's own id check as the thing that decides, rather than
// silently returning an unrelated answer here). wantID <= 0 means "no
// preference" — ids issued by this client start at 1.
//
// Whether the CSP endpoint can in fact put a sibling request's response on this
// POST's stream is NOT established; MCP streamable HTTP says it should not.
// This is the cheap correct rule either way, and it costs one id comparison.
func extractSSEData(raw []byte, wantID int) []byte {
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

	lastResponse := -1
	for i := len(events) - 1; i >= 0; i-- {
		var probe struct {
			ID     json.RawMessage `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
			Method string          `json:"method"`
		}
		if err := json.Unmarshal(events[i], &probe); err != nil {
			continue
		}
		// A bare notification has no id and is never a response. An explicit
		// null id is not one either — it is what a server sends when it could
		// not attribute the reply to any request, and the old *int probe
		// already excluded it by decoding null as a nil pointer.
		if len(bytes.TrimSpace(probe.ID)) == 0 || bytes.Equal(bytes.TrimSpace(probe.ID), []byte("null")) {
			continue
		}
		if probe.Result == nil && probe.Error == nil {
			continue
		}
		if wantID > 0 {
			if match, _ := idMatchesRequest(wantID, probe.ID); match {
				return events[i]
			}
		}
		if lastResponse < 0 {
			lastResponse = i
		}
	}
	if lastResponse >= 0 {
		return events[lastResponse]
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
		// LOGGED HERE RATHER THAN LEFT TO THE CALLERS, because ten of the
		// eleven throw the error away — security.go:215,249,
		// threatintel.go:467, assets.go:302,523,623, assetcounts.go:75 and
		// analytics.go:72,125,186,527 are all spelled
		// `s.Mcp.Initialize(ctx) != nil` and turn it into an "unavailable"
		// panel with no reason attached. Only ai_tools.go:52 reads it.
		//
		// SUPPRESSED WHEN IT REPEATS. A failed handshake is deliberately not
		// cached (see the doc comment above), and those four files call
		// Initialize on every dashboard request, so an outage would otherwise
		// write the same line thousands of times and bury everything else.
		// Only a CHANGE is news: a different failure logs, and a success
		// clears the memo so the next failure is heard again. This runs under
		// initMu, already held for the whole function, so it needs no lock of
		// its own.
		if msg := err.Error(); msg != c.lastInitErr {
			c.lastInitErr = msg
			log.Printf("mcp: Initialize: %v", err)
		}
		return err
	}
	// A refused notifications/initialized does NOT fail the handshake: the
	// session was established by the initialize response that just succeeded,
	// and this is a notification with no reply expected, so failing closed here
	// could wedge a client that is actually fine. It is still worth a line —
	// it was `_, _ =` before, which meant a half-completed handshake looked
	// identical to a clean one.
	if _, nerr := c.post(ctx, "notifications/initialized", map[string]any{}, true); nerr != nil {
		log.Printf("mcp: Initialize: notifications/initialized failed, session continues: %v", nerr)
	}
	c.initialized = true
	c.lastInitErr = ""
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
//
// WARNING: the returned error is TRANSPORT-only (network/HTTP/JSON-RPC
// failure). Every upstream TOOL rejection (bad auth, bad request, unknown
// arg, no stored data, ...) arrives as an ordinary text payload with
// err == nil — this has produced a live false-success on a security control
// (domain blocking). Any call site that MUTATES state must use
// CallToolChecked instead, which fails closed on an unrecognised payload.
func (c *Client) CallTool(ctx context.Context, name string, args map[string]any) (string, error) {
	resp, err := c.post(ctx, "tools/call", map[string]any{
		"name": name, "arguments": args,
	}, false)
	if err != nil {
		return "", err
	}
	return toolText(resp.Result), nil
}

// SuccessPredicate decides whether a decoded tool payload is a recognised
// success for one specific tool. payload is the result of json.Unmarshal-ing
// text into a map[string]any; it is nil when text did not decode as a JSON
// object (e.g. plain-text validation errors). Implementations should inspect
// only fields that tool is documented to return on success.
type SuccessPredicate func(text string, payload map[string]any) bool

// SuccessFieldTrue is a ready-made SuccessPredicate for tools that report
// success via a boolean "success" field, matching the iq-actions_update_action
// fixture: {"success":true,"new_status":"resolved",...}. Reusable across any
// tool with that same convention, but never applied implicitly — each
// mutation call site must name its predicate explicitly.
func SuccessFieldTrue(text string, payload map[string]any) bool {
	ok, _ := payload["success"].(bool)
	return ok
}

// CallToolChecked wraps CallTool for tools that MUTATE state. It is
// FAIL-CLOSED by design: it returns a non-nil error unless ok affirmatively
// recognises the payload as success. An unparseable payload, an empty
// payload, a payload matching none of the known shapes, and a payload
// matching a KNOWN ERROR shape are all treated as failure — the known error
// shapes below are used only to build a readable message, never to decide
// success, because an allowlist of failures fails open the moment upstream
// invents a new error shape, which is exactly the bug this function exists
// to fix (a live false-success on domain blocking). Returns the raw text
// alongside any error so callers can keep it as diagnostic context.
// If ok is nil, no recognised success shape exists for this tool: the reply
// can never confirm success, and every call falls into the rejected branch
// below with a message saying so plainly — the caller must verify success
// out-of-band (e.g. a read-back of the mutated resource).
func (c *Client) CallToolChecked(ctx context.Context, name string, args map[string]any, ok SuccessPredicate) (string, error) {
	text, err := c.CallTool(ctx, name, args)
	if err != nil {
		// An id mismatch is NOT a transport error. ErrTransport tells the caller
		// nothing was applied — the wire never carried the call — and here the
		// wire did carry it and the server did answer something. Reporting a
		// possibly-applied mutation as "nothing happened" is the false-success
		// this function exists to prevent, so it degrades to ErrRejected: the
		// call reached the tool, and the write may or may not have landed.
		if errors.Is(err, ErrIDMismatch) {
			return text, fmt.Errorf("mcp %s: %w: %w", name, ErrRejected, err)
		}
		return text, fmt.Errorf("mcp %s: transport error: %w: %w", name, ErrTransport, err)
	}

	var payload map[string]any
	_ = json.Unmarshal([]byte(text), &payload) // payload stays nil on decode failure

	if ok == nil {
		return text, fmt.Errorf("mcp %s: rejected: %w: no success predicate is defined for this tool, so its reply can never confirm success — verify out-of-band", name, ErrRejected)
	}
	if ok(text, payload) {
		return text, nil
	}

	return text, fmt.Errorf("mcp %s: rejected: %w: %s", name, ErrRejected, describeFailure(text, payload))
}

// describeFailure builds a human-readable detail string from a rejected
// tool payload. It recognises the known error shapes (message/error/
// status_code fields, or a plain-text detail) purely for MESSAGE quality —
// see the fail-closed rationale on CallToolChecked for why this must never
// feed back into the success decision.
func describeFailure(text string, payload map[string]any) string {
	if payload == nil {
		trimmed := strings.TrimSpace(text)
		if trimmed == "" {
			return "empty response"
		}
		if len(trimmed) > 200 {
			trimmed = trimmed[:200]
		}
		return trimmed
	}

	var parts []string
	if sc, ok := payload["status_code"]; ok {
		parts = append(parts, fmt.Sprintf("status_code=%v", sc))
	}
	if msg, ok := payload["message"].(string); ok && msg != "" {
		parts = append(parts, msg)
	}
	switch e := payload["error"].(type) {
	case string:
		if e != "" {
			parts = append(parts, e)
		}
	case []any:
		for _, item := range e {
			if m, ok := item.(map[string]any); ok {
				if s, ok := m["message"].(string); ok && s != "" {
					parts = append(parts, s)
				}
			}
		}
	}
	if len(parts) == 0 {
		trimmed := strings.TrimSpace(text)
		if len(trimmed) > 200 {
			trimmed = trimmed[:200]
		}
		if trimmed == "" {
			trimmed = "unrecognised payload"
		}
		return trimmed
	}
	return strings.Join(parts, "; ")
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
// This used to say "query_stored_data is broken upstream (every read fails)";
// it is not, see the maxRows correction above. The fact that actually
// justifies this function is narrower and still holds: a measures-only
// (dimensionless) cube query never stores anything at all, and instead
// returns its data inline in `message`, e.g.:
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
// cap). Returns the assembled rows. Inline results are tried FIRST — this
// used to be justified as "query_stored_data is broken upstream", which is
// wrong (see the maxRows correction). The real reason: a response that
// already carries its rows inline stored nothing, so paging it would be a
// call that must fail.
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
		log.Printf("mcp: Get %s/%s: %v", service, endpoint, err)
		return nil
	}
	if rows, ok := parseInline(text); ok {
		return rows
	}
	table, rowCount, why := storedMeta(text)
	if why != "" {
		log.Printf("mcp: Get %s/%s: unusable stored result: %s", service, endpoint, why)
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
//
// The third return value is the REASON the payload was unusable; empty means
// usable. It is always one of the fixed strings below and never quotes any part
// of text — text is a tenant data payload (see the file-level note above), and
// a rejected table_name is upstream-controlled too. The reasons are distinct so
// an operator reading the log can tell a refused query from a malformed one
// without ever seeing the reply.
//
// Two of them are new, and each closed a way to fail silently:
//
//   - A NEGATIVE row_count used to pass, because the guard rejected only 0.
//     queryAllRows would then run `for offset := 0; offset < rowCount` zero
//     times and return (nil, nil) — a failure wearing the shape of no data.
//   - A FRACTIONAL row_count truncates through int(f) and silently under-reads,
//     so 10.5 rows becomes a confident claim of 10.
//
// row_count == 0 remains unusable, exactly as before. It is tempting to read it
// as a legitimate empty result and return an empty slice, but nothing verifies
// that is the upstream's zero-row shape, and guessing wrong turns a real failure
// into "this tenant has nothing" — the precise mistake assembleAssetInventory
// exists to prevent. It gets its own reason string instead, so if it ever shows
// up in a log the question can be settled with evidence.
func storedMeta(text string) (string, int, string) {
	var meta map[string]any
	if err := json.Unmarshal([]byte(text), &meta); err != nil {
		return "", 0, "response is not JSON"
	}
	table, _ := meta["table_name"].(string)
	if table == "" {
		return "", 0, "no table_name in response"
	}
	if !tableRE.MatchString(table) {
		return "", 0, "table_name failed validation"
	}
	f, ok := meta["row_count"].(float64)
	if !ok {
		return "", 0, "no row_count in response"
	}
	switch {
	case f < 0:
		return "", 0, "row_count is negative"
	case f != math.Trunc(f):
		return "", 0, "row_count is not a whole number"
	case f == 0:
		return "", 0, "row_count is 0"
	}
	return table, int(f), ""
}

// queryAllRows is _query_all_rows (server.py:3085): page the stored parquet.
// Returns ErrTooManyRows (before issuing any request) when rowCount exceeds
// maxRows.
//
// A transport or decode failure on the very FIRST page (offset 0) preserves
// prior behavior: it breaks the loop and returns (nil, nil), i.e. the same
// shape as "no data" — nothing was ever successfully read, so there is no
// partial set to mislabel. A failure on any LATER page is different: at
// least one page already succeeded, rows is non-empty, and the row_count the
// caller was told to expect has not been reached — returning that partial
// slice with a nil error would present it as the complete set. That case
// returns the rows gathered so far together with ErrIncompleteRows so the
// caller cannot mistake truncated data for whole data. A short or empty page
// remains a legitimate end of pagination in both cases and never produces an
// error.
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
			if offset == 0 {
				// The (nil, nil) return below is the contract, unchanged and
				// locked in by TestQueryAllRowsPage0FailureReturnsEmptyNoError.
				// That is precisely why this line has to be here: to both
				// callers the result is byte-identical to "the tenant has no
				// rows", so the log is the ONLY thing that can tell a dead read
				// from an empty one. Load-bearing, not decorative.
				log.Printf("mcp: queryAllRows %s: first page failed, reporting no data: %v", label, err)
				break
			}
			return rows, fmt.Errorf("%w: %s: got %d of %d rows before offset %d failed: %v", ErrIncompleteRows, label, len(rows), rowCount, offset, err)
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(text), &raw); err != nil {
			if offset == 0 {
				// Same as above, and no part of the undecodable reply goes in
				// the line — it is a data payload.
				log.Printf("mcp: queryAllRows %s: first page did not decode, reporting no data", label)
				break
			}
			return rows, fmt.Errorf("%w: %s: got %d of %d rows before offset %d failed to decode: %v", ErrIncompleteRows, label, len(rows), rowCount, offset, err)
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
		log.Printf("mcp: QueryCube %s: %v", cube, err)
		return nil
	}
	var rows []map[string]any
	if inline, ok := parseInline(text); ok {
		rows = inline
	} else {
		table, rowCount, why := storedMeta(text)
		if why != "" {
			log.Printf("mcp: QueryCube %s: unusable stored result: %s", cube, why)
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
		log.Printf("mcp: Search: %v", err)
		return nil
	}
	var data any
	if err := json.Unmarshal([]byte(text), &data); err != nil {
		log.Printf("mcp: Search: response is not JSON")
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
	// Every nil out of this function means the search DIED, and ai_tools.go:55
	// documents at length why that must never be collapsed into "No entities
	// found." A shape carrying none of the keys above is that case: the reply
	// arrived and nothing in it could be read as results. It gets a line like
	// the other two, with no part of the reply in it.
	log.Printf("mcp: Search: response shape not recognised")
	return nil
}
