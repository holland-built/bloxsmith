package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"bloxsmith/internal/mcp"
)

// TestUpdateActionValidatesStatus locks the status guard: only "active" and
// "resolved" are accepted, matching the upstream iq-actions_update_action
// contract (no other value, no version/etag field).
func TestUpdateActionValidatesStatus(t *testing.T) {
	cases := []struct {
		name    string
		status  string
		wantErr bool
	}{
		{"active is valid", "active", false},
		{"resolved is valid", "resolved", false},
		{"empty is rejected", "", true},
		{"arbitrary string is rejected", "closed", true},
		{"case-sensitive Active is rejected", "Active", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &Service{} // s.Mcp is nil; status validation must run before any nil deref.
			_, err := s.UpdateAction(context.Background(), "abc123", tc.status)
			if err == nil {
				t.Fatalf("expected error for status %q (nil Mcp), got nil", tc.status)
			}
			isInvalidStatusErr := strings.Contains(err.Error(), "invalid status")
			if tc.wantErr && !isInvalidStatusErr {
				t.Fatalf("status %q: expected invalid-status error, got %q", tc.status, err.Error())
			}
			if !tc.wantErr && isInvalidStatusErr {
				t.Fatalf("status %q: should pass validation, got invalid-status error %q", tc.status, err.Error())
			}
		})
	}
}

// mcpCall is one tools/call as it actually arrived over the wire: the tool
// name AND the arguments object. Recording only the name (what this double
// used to do) makes every "did we send the right thing?" assertion
// impossible, so a test can pass while the code sends garbage to the wrong
// endpoint.
type mcpCall struct {
	Name string
	Args map[string]any
}

// arg returns a top-level string argument ("" when absent or not a string).
func (c mcpCall) arg(key string) string {
	s, _ := c.Args[key].(string)
	return s
}

// argsJSON re-marshals the whole arguments object, for asserting a value
// nested anywhere inside it (e.g. the domain buried in body.items_described).
func (c mcpCall) argsJSON() string {
	b, err := json.Marshal(c.Args)
	if err != nil {
		return ""
	}
	return string(b)
}

// bodyJSON is the "body" argument alone, re-marshalled. It must be asserted
// separately from the rest of the arguments: task_description also happens to
// mention the domain, so a whole-arguments substring check would happily pass
// on a completely garbage body.
func (c mcpCall) bodyJSON() string {
	b, err := json.Marshal(c.Args["body"])
	if err != nil {
		return ""
	}
	return string(b)
}

// callRecorder is the shared wire log for this package's MCP fakes: every
// tools/call, in order, with its arguments. fakeMCP embeds it, and
// newSecurityTestService's fake uses one, so both can assert what actually
// went upstream instead of merely that something was called.
type callRecorder struct {
	mu    sync.Mutex
	calls []mcpCall
}

func (r *callRecorder) record(name string, args map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, mcpCall{Name: name, Args: args})
}

// toolNames lists the recorded tool names in call order.
func (r *callRecorder) toolNames() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	names := make([]string, len(r.calls))
	for i, c := range r.calls {
		names[i] = c.Name
	}
	return names
}

// callsTo returns every recorded call to the named tool, in order.
func (r *callRecorder) callsTo(name string) []mcpCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []mcpCall
	for _, c := range r.calls {
		if c.Name == name {
			out = append(out, c)
		}
	}
	return out
}

// onlyCallTo returns the single recorded call to the named tool, failing the
// test when there is not exactly one. "the write never happened" and "it
// happened twice" are both defects a wire assertion has to catch.
func (r *callRecorder) onlyCallTo(t *testing.T, name string) mcpCall {
	t.Helper()
	got := r.callsTo(name)
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 upstream call to %q, got %d (all calls: %v)", name, len(got), r.toolNames())
	}
	return got[0]
}

// rpcHandler builds a fake MCP streamable-HTTP endpoint. get/update act as the
// two tools UpdateAction depends on; list serves paginated iq-actions_list_actions
// responses keyed by offset. Every call is recorded with its arguments via the
// embedded callRecorder.
type fakeMCP struct {
	callRecorder
	listPages     map[float64]map[string]any // offset -> response body
	getBody       map[string]any
	updateBody    map[string]any
	updateRawText string // when set, overrides updateBody with this literal (possibly-invalid) text
	searchRawText string // raw text served for infoblox-portal_network_entity_search
}

func (f *fakeMCP) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
			ID     *int   `json:"id"`
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		body, _ := json.Marshal(nil)
		_ = body
		dec := json.NewDecoder(r.Body)
		if err := dec.Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Mcp-Session-Id", "test-session")
		w.Header().Set("Content-Type", "application/json")

		if req.Method == "initialize" {
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
			return
		}
		if req.Method == "notifications/initialized" {
			w.WriteHeader(200)
			return
		}
		if req.Method != "tools/call" {
			t.Fatalf("unexpected method %q", req.Method)
		}

		f.record(req.Params.Name, req.Params.Arguments)

		var text []byte
		switch req.Params.Name {
		case "iq-actions_get_action":
			text, _ = json.Marshal(f.getBody)
		case "iq-actions_update_action":
			if f.updateRawText != "" {
				text = []byte(f.updateRawText)
			} else {
				text, _ = json.Marshal(f.updateBody)
			}
		case "iq-actions_list_actions":
			offset, _ := req.Params.Arguments["offset"].(float64)
			text, _ = json.Marshal(f.listPages[offset])
		case "infoblox-portal_network_entity_search":
			text = []byte(f.searchRawText)
		default:
			t.Fatalf("unexpected tool %q", req.Params.Name)
		}
		resultObj := map[string]any{
			"content": []map[string]any{{"type": "text", "text": string(text)}},
		}
		resp := map[string]any{"jsonrpc": "2.0", "id": *req.ID, "result": resultObj}
		_ = json.NewEncoder(w).Encode(resp)
	}
}

func newTestService(t *testing.T, f *fakeMCP) *Service {
	srv := httptest.NewServer(f.handler(t))
	t.Cleanup(srv.Close)
	client := mcp.New(srv.URL, func() string { return "Bearer test" })
	return &Service{Mcp: client}
}

// assertUpdateWire pins what actually reached iq-actions_update_action. The
// result map's "id"/"new_status" are built from the caller's own arguments, so
// they stay correct even when the code sends something else entirely
// upstream — only the recorded call proves the write carried the caller's id
// and the caller's status.
func assertUpdateWire(t *testing.T, f *fakeMCP, wantID, wantStatus string) {
	t.Helper()
	c := f.onlyCallTo(t, "iq-actions_update_action")
	if got := c.arg("id"); got != wantID {
		t.Fatalf("iq-actions_update_action sent id %q, want the caller's id %q (args: %s)", got, wantID, c.argsJSON())
	}
	if got := c.arg("status"); got != wantStatus {
		t.Fatalf("iq-actions_update_action sent status %q, want the caller's status %q (args: %s)", got, wantStatus, c.argsJSON())
	}
}

// assertGetActionWire pins the pre-read: old_status only means anything if the
// get was for the caller's own action.
func assertGetActionWire(t *testing.T, f *fakeMCP, wantID string) {
	t.Helper()
	c := f.onlyCallTo(t, "iq-actions_get_action")
	if got := c.arg("id"); got != wantID {
		t.Fatalf("iq-actions_get_action sent id %q, want the caller's id %q (args: %s)", got, wantID, c.argsJSON())
	}
}

// TestUpdateActionCapturesOldStatus verifies the get-before-update sequencing:
// old_status comes from iq-actions_get_action, new_status from the caller.
func TestUpdateActionCapturesOldStatus(t *testing.T) {
	f := &fakeMCP{
		getBody:    map[string]any{"action": map[string]any{"id": "abc", "status": "active"}},
		updateBody: map[string]any{"success": true},
	}
	s := newTestService(t, f)
	res, err := s.UpdateAction(context.Background(), "abc", "resolved")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res["old_status"] != "active" {
		t.Fatalf("old_status: got %v want active", res["old_status"])
	}
	if res["new_status"] != "resolved" {
		t.Fatalf("new_status: got %v want resolved", res["new_status"])
	}
	if res["ok"] != true {
		t.Fatalf("ok: got %v want true", res["ok"])
	}
	assertGetActionWire(t, f, "abc")
	assertUpdateWire(t, f, "abc", "resolved")
}

// TestUpdateActionDegradesOldStatusOnGetFailure: when the pre-read fails, the
// write must still proceed with old_status "unknown" rather than blocking.
func TestUpdateActionDegradesOldStatusOnGetFailure(t *testing.T) {
	f := &fakeMCP{
		getBody:    map[string]any{"error": "not found"}, // decodes fine but has no action/status
		updateBody: map[string]any{"success": true},
	}
	s := newTestService(t, f)
	res, err := s.UpdateAction(context.Background(), "missing", "active")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res["old_status"] != "unknown" {
		t.Fatalf("old_status: got %v want unknown", res["old_status"])
	}
	// A failed pre-read must not change WHAT gets written: the write still
	// has to carry the caller's own id and status.
	assertGetActionWire(t, f, "missing")
	assertUpdateWire(t, f, "missing", "active")
}

// TestActionsAsyncPagesUntilHasMoreFalse locks the truncation fix: two pages
// of 50 must merge into 100, stopping once pagination.has_more is false.
func TestActionsAsyncPagesUntilHasMoreFalse(t *testing.T) {
	page1 := make([]any, actionsPageSize)
	for i := range page1 {
		page1[i] = map[string]any{"id": float64(i)}
	}
	page2 := make([]any, 20)
	for i := range page2 {
		page2[i] = map[string]any{"id": float64(actionsPageSize + i)}
	}
	f := &fakeMCP{
		listPages: map[float64]map[string]any{
			0: {"success": true, "actions": page1, "total_count": float64(70),
				"pagination": map[string]any{"limit": float64(actionsPageSize), "offset": float64(0), "has_more": true}},
			float64(actionsPageSize): {"success": true, "actions": page2, "total_count": float64(70),
				"pagination": map[string]any{"limit": float64(actionsPageSize), "offset": float64(actionsPageSize), "has_more": false}},
		},
	}
	s := newTestService(t, f)
	raw, ok := s.actionsAsync(context.Background())
	if !ok {
		t.Fatalf("expected ok=true")
	}
	m, isMap := raw.(map[string]any)
	if !isMap {
		t.Fatalf("expected map result, got %T", raw)
	}
	actions, _ := m["actions"].([]any)
	if len(actions) != 70 {
		t.Fatalf("merged actions: got %d want 70", len(actions))
	}
}

// TestUpdateActionRejectsEmptyID locks the empty-id guard (mirrors the noc.go
// handler's 400 "id is required"): an empty/whitespace id must be rejected
// before any upstream tool call, not passed through as id:"".
func TestUpdateActionRejectsEmptyID(t *testing.T) {
	cases := []string{"", "   "}
	for _, id := range cases {
		f := &fakeMCP{
			getBody:    map[string]any{"action": map[string]any{"id": id, "status": "active"}},
			updateBody: map[string]any{"success": true},
		}
		s := newTestService(t, f)
		_, err := s.UpdateAction(context.Background(), id, "resolved")
		if err == nil {
			t.Fatalf("id %q: expected error, got nil", id)
		}
		if !strings.Contains(err.Error(), "id is required") {
			t.Fatalf("id %q: expected \"id is required\" error, got %q", id, err.Error())
		}
		if names := f.toolNames(); len(names) != 0 {
			t.Fatalf("id %q: expected no upstream calls, got %v", id, names)
		}
	}
}

// TestUpdateActionUnparseableResponseIsNotSuccess locks the "report success
// you did not verify" fix: an HTTP-OK but JSON-unparseable
// iq-actions_update_action reply must yield ok:false with the raw text
// captured, never ok:true with a nil result.
func TestUpdateActionUnparseableResponseIsNotSuccess(t *testing.T) {
	f := &fakeMCP{
		getBody:       map[string]any{"action": map[string]any{"id": "abc", "status": "active"}},
		updateRawText: "not valid json {{{",
	}
	s := newTestService(t, f)
	res, err := s.UpdateAction(context.Background(), "abc", "resolved")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok, _ := res["ok"].(bool); ok {
		t.Fatalf("ok: got true, want false for an unparseable upstream response")
	}
	if _, has := res["result_raw"]; !has {
		t.Fatalf("expected result_raw to carry the raw unparseable text")
	}
	if res["old_status"] != "active" || res["new_status"] != "resolved" {
		t.Fatalf("old/new status should still be reported: got %v/%v", res["old_status"], res["new_status"])
	}
	// The reported old/new status above are echoes of the caller's own
	// arguments; only this proves the unparseable reply came from a write
	// that actually carried them.
	assertUpdateWire(t, f, "abc", "resolved")
}

// TestUpdateActionSuccessFieldTrueYieldsOk locks the real observed success
// fixture: a payload carrying success:true must yield ok:true, with the
// upstream result attached.
func TestUpdateActionSuccessFieldTrueYieldsOk(t *testing.T) {
	f := &fakeMCP{
		getBody: map[string]any{"action": map[string]any{"id": "427de4b8-9b32-4ce8-9492-ad88a70662cd", "status": "resolved"}},
		updateBody: map[string]any{
			"action_id":  "427de4b8-9b32-4ce8-9492-ad88a70662cd",
			"message":    "Action status updated successfully to: resolved",
			"new_status": "resolved",
			"old_status": "resolved",
			"success":    true,
		},
	}
	s := newTestService(t, f)
	res, err := s.UpdateAction(context.Background(), "427de4b8-9b32-4ce8-9492-ad88a70662cd", "resolved")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok, _ := res["ok"].(bool); !ok {
		t.Fatalf("ok: got %v, want true for success:true payload", res["ok"])
	}
	assertUpdateWire(t, f, "427de4b8-9b32-4ce8-9492-ad88a70662cd", "resolved")
}

// TestUpdateActionForbiddenIsNotSuccess is the core fix under test: an
// upstream 403 rejection ("Request forbidden: not authorized") parses fine
// as JSON but carries no success:true field. It must yield ok:false with the
// upstream detail surfaced, never ok:true — a rejected status change must
// never be reported to the operator (or the audit log) as accepted.
func TestUpdateActionForbiddenIsNotSuccess(t *testing.T) {
	f := &fakeMCP{
		getBody: map[string]any{"action": map[string]any{"id": "abc", "status": "active"}},
		updateBody: map[string]any{
			"error":       []any{map[string]any{"message": "Request forbidden: not authorized"}},
			"status_code": float64(403),
		},
	}
	s := newTestService(t, f)
	res, err := s.UpdateAction(context.Background(), "abc", "resolved")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok, _ := res["ok"].(bool); ok {
		t.Fatalf("ok: got true, want false for a 403 forbidden payload")
	}
	errMsg, _ := res["error"].(string)
	if !strings.Contains(errMsg, "forbidden") && !strings.Contains(errMsg, "403") {
		t.Fatalf("expected upstream detail (forbidden/403) in error, got %q", errMsg)
	}
	if _, has := res["result_raw"]; !has {
		t.Fatalf("expected result_raw to carry the raw rejected payload")
	}
	if res["old_status"] != "active" || res["new_status"] != "resolved" {
		t.Fatalf("old/new status should still be reported: got %v/%v", res["old_status"], res["new_status"])
	}
	// A 403 is only evidence about THIS action's write if the write carried
	// this action's id and status.
	assertUpdateWire(t, f, "abc", "resolved")
}

// TestUpdateActionUnrecognisedShapeFailsClosed verifies the fail-closed
// contract: a well-formed but unrecognised payload (no success:true, no
// known error shape) must NOT be treated as success just because it parsed.
func TestUpdateActionUnrecognisedShapeFailsClosed(t *testing.T) {
	f := &fakeMCP{
		getBody:    map[string]any{"action": map[string]any{"id": "abc", "status": "active"}},
		updateBody: map[string]any{"weird": "shape"},
	}
	s := newTestService(t, f)
	res, err := s.UpdateAction(context.Background(), "abc", "resolved")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok, _ := res["ok"].(bool); ok {
		t.Fatalf("ok: got true, want false for an unrecognised payload shape")
	}
	assertUpdateWire(t, f, "abc", "resolved")
}
