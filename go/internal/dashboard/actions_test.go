package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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

// rpcHandler builds a fake MCP streamable-HTTP endpoint. get/update act as the
// two tools UpdateAction depends on; list serves paginated iq-actions_list_actions
// responses keyed by offset.
type fakeMCP struct {
	listPages     map[float64]map[string]any // offset -> response body
	getBody       map[string]any
	updateBody    map[string]any
	updateRawText string // when set, overrides updateBody with this literal (possibly-invalid) text
	calledTools   []string
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

		f.calledTools = append(f.calledTools, req.Params.Name)

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
		if len(f.calledTools) != 0 {
			t.Fatalf("id %q: expected no upstream calls, got %v", id, f.calledTools)
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
}
