package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// toolServer builds an httptest server that answers tools/call with the given
// raw text as the first content block's text, regardless of tool name.
func toolServer(t *testing.T, text string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
		}
		body, _ := decodeBody(r)
		_ = json.Unmarshal(body, &req)
		if req.Method != "tools/call" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		resp := map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{
				"content": []map[string]any{{"text": text}},
			},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
}

// TestCallToolCheckedForbidden verifies the 403 "Request forbidden" error
// shape yields an error whose message contains the upstream detail.
func TestCallToolCheckedForbidden(t *testing.T) {
	text := `{"error":[{"message":"Request forbidden: not authorized"}],"status_code":403}`
	srv := toolServer(t, text)
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	_, err := c.CallToolChecked(context.Background(), "iq-actions_update_action", nil, SuccessFieldTrue)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "not authorized") {
		t.Fatalf("expected error to contain upstream detail, got: %v", err)
	}
}

// TestCallToolCheckedBadRequest verifies the 400 "unable to process query"
// error shape yields an error whose message contains the upstream detail.
func TestCallToolCheckedBadRequest(t *testing.T) {
	text := `{"status_code":400,"error":"unable to process query (bad request)","message":"Failed to query cube"}`
	srv := toolServer(t, text)
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	_, err := c.CallToolChecked(context.Background(), "iq-actions_update_action", nil, SuccessFieldTrue)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "Failed to query cube") {
		t.Fatalf("expected error to contain upstream detail, got: %v", err)
	}
}

// TestCallToolCheckedPlainTextValidationError verifies a plain-text (not
// JSON) validation error yields an error containing the upstream detail.
func TestCallToolCheckedPlainTextValidationError(t *testing.T) {
	text := "1 validation error for call[list_all_available_services]\nservice_name\n  Unexpected keyword argument ..."
	srv := toolServer(t, text)
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	_, err := c.CallToolChecked(context.Background(), "iq-actions_update_action", nil, SuccessFieldTrue)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "validation error") {
		t.Fatalf("expected error to contain upstream detail, got: %v", err)
	}
}

// TestCallToolCheckedNoStoredData verifies the "No stored data found" error
// shape yields an error containing the upstream detail.
func TestCallToolCheckedNoStoredData(t *testing.T) {
	text := `{"error":"No stored data found in this session. Store data first before querying."}`
	srv := toolServer(t, text)
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	_, err := c.CallToolChecked(context.Background(), "iq-actions_update_action", nil, SuccessFieldTrue)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "No stored data found") {
		t.Fatalf("expected error to contain upstream detail, got: %v", err)
	}
}

// TestCallToolCheckedIQSuccess verifies the known iq-actions_update_action
// success fixture yields no error under SuccessFieldTrue.
func TestCallToolCheckedIQSuccess(t *testing.T) {
	text := `{"action_id":"abc123","message":"Action status updated successfully to: resolved","new_status":"resolved","old_status":"resolved","success":true}`
	srv := toolServer(t, text)
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	got, err := c.CallToolChecked(context.Background(), "iq-actions_update_action", nil, SuccessFieldTrue)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if got != text {
		t.Fatalf("expected raw text to be returned, got: %q", got)
	}
}

// TestCallToolCheckedUnrecognisedShapeFailsClosed is the important case: a
// well-formed JSON object that matches none of the known error shapes and
// does not satisfy the predicate must still be treated as a failure. Fail-
// closed means "recognised success or bust" — never "no known error, so
// assume it worked."
func TestCallToolCheckedUnrecognisedShapeFailsClosed(t *testing.T) {
	text := `{"weird":"shape"}`
	srv := toolServer(t, text)
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	_, err := c.CallToolChecked(context.Background(), "iq-actions_update_action", nil, SuccessFieldTrue)
	if err == nil {
		t.Fatal("expected error for unrecognised payload shape, got nil (fail-closed violated)")
	}
}

// TestCallToolCheckedEmptyTextFailsClosed verifies an empty text payload
// yields an error.
func TestCallToolCheckedEmptyTextFailsClosed(t *testing.T) {
	srv := toolServer(t, "")
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	_, err := c.CallToolChecked(context.Background(), "iq-actions_update_action", nil, SuccessFieldTrue)
	if err == nil {
		t.Fatal("expected error for empty payload, got nil")
	}
}

// TestCallToolCheckedTransportError verifies a transport-level failure (HTTP
// 500) still yields an error through CallToolChecked.
func TestCallToolCheckedTransportError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	_, err := c.CallToolChecked(context.Background(), "iq-actions_update_action", nil, SuccessFieldTrue)
	if err == nil {
		t.Fatal("expected transport error, got nil")
	}
}

// TestCallToolCheckedSentinelErrors verifies errors.Is holds for ErrTransport
// on a transport failure and for ErrRejected on a rejected payload, so
// callers can match outcomes without depending on error message text.
func TestCallToolCheckedSentinelErrors(t *testing.T) {
	transportSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer transportSrv.Close()

	c := New(transportSrv.URL, func() string { return "Bearer test" })
	_, err := c.CallToolChecked(context.Background(), "iq-actions_update_action", nil, SuccessFieldTrue)
	if !errors.Is(err, ErrTransport) {
		t.Fatalf("expected errors.Is(err, ErrTransport), got: %v", err)
	}
	if errors.Is(err, ErrRejected) {
		t.Fatalf("transport error should not also match ErrRejected: %v", err)
	}

	rejectedSrv := toolServer(t, `{"weird":"shape"}`)
	defer rejectedSrv.Close()

	c2 := New(rejectedSrv.URL, func() string { return "Bearer test" })
	_, err = c2.CallToolChecked(context.Background(), "iq-actions_update_action", nil, SuccessFieldTrue)
	if !errors.Is(err, ErrRejected) {
		t.Fatalf("expected errors.Is(err, ErrRejected), got: %v", err)
	}
	if errors.Is(err, ErrTransport) {
		t.Fatalf("rejected error should not also match ErrTransport: %v", err)
	}
}

// TestCallToolUnchangedByErrorPayload round-trips one of the error payloads
// through the plain CallTool and confirms it is untouched by this change:
// it still returns (text, nil) — the transport-only contract this function
// warns about in its doc comment.
func TestCallToolUnchangedByErrorPayload(t *testing.T) {
	text := `{"error":[{"message":"Request forbidden: not authorized"}],"status_code":403}`
	srv := toolServer(t, text)
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	got, err := c.CallTool(context.Background(), "infoblox-portal_make_get_request", nil)
	if err != nil {
		t.Fatalf("expected CallTool to return nil error on a tool-level rejection, got: %v", err)
	}
	if got != text {
		t.Fatalf("expected raw text unchanged, got: %q", got)
	}
}
