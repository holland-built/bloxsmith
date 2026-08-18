package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// requestID reads the JSON-RPC id off a request body a fake server just
// received, so its reply can echo the id it was actually asked with.
//
// WHY EVERY FAKE IN THIS PACKAGE NEEDS THIS. Before issue #138 they all replied
// with a hardcoded `"id":1`, which is right only for the first call on a client
// and wrong for every one after it — the doubles were mis-addressing their own
// replies and nothing noticed, because the client did not compare ids either.
// A double that cannot answer the question it was asked cannot prove the client
// handles a real server.
func requestID(body []byte) int {
	var req struct {
		ID *int `json:"id"`
	}
	if json.Unmarshal(body, &req) != nil || req.ID == nil {
		return 0
	}
	return *req.ID
}

// idRE matches the id member of a JSON-RPC envelope written as a literal.
var idRE = regexp.MustCompile(`"id"\s*:\s*\d+`)

// reID rewrites ONLY the JSON-RPC id of a canned response so it answers the
// request that arrived. Everything else in raw is left byte-for-byte alone,
// which matters where raw is a payload captured from the live CSP endpoint.
func reID(raw string, body []byte) string {
	return idRE.ReplaceAllString(raw, `"id":`+strconv.Itoa(requestID(body)))
}

// idEchoWriter is how the older fake servers in this package were taught to
// answer the question they were asked without rewriting every one of their
// response builders. It rewrites ONLY the JSON-RPC id of whatever the handler
// writes, to the id that arrived on the request.
//
// Wrapping the writer rather than threading an id through a dozen closures
// keeps each test's response shape exactly as it was, so what those tests pin
// is unchanged — the id was never the thing any of them was asserting.
type idEchoWriter struct {
	http.ResponseWriter
	id int
}

func (w idEchoWriter) Write(p []byte) (int, error) {
	if _, err := w.ResponseWriter.Write([]byte(idRE.ReplaceAllString(string(p), `"id":`+strconv.Itoa(w.id)))); err != nil {
		return 0, err
	}
	// Report the caller's own length: the rewritten body may differ in size and
	// an encoder that sees a short write treats it as an error.
	return len(p), nil
}

// idServer answers tools/call with a fixed result, stamping the reply with
// whatever id the caller names. id < 0 means "echo the request's id".
func idServer(t *testing.T, id int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := decodeBody(r)
		use := any(id)
		switch {
		case id < 0:
			use = requestID(body)
		case id == 0:
			use = nil // emitted as JSON null
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": use,
			"result": map[string]any{
				"content": []map[string]any{{"text": `{"success":true}`}},
			},
		})
	}))
}

// TestPostRejectsAMisaddressedReply is the core of issue #138's diagnosis. A
// reply carrying someone else's id must not be handed to the caller as this
// call's answer — that is how a count row arrived where a list of assets was
// asked for, rendered as one asset with no identity.
//
// Mutation that must turn this RED: delete the idMatchesRequest branch in post.
func TestPostRejectsAMisaddressedReply(t *testing.T) {
	srv := idServer(t, 99)
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	_, err := c.CallTool(context.Background(), "infoblox-portal_query_cube", nil)
	if err == nil {
		t.Fatal("a reply addressed to request 99 was accepted as the answer to request 1")
	}
	if !errors.Is(err, ErrIDMismatch) {
		t.Fatalf("expected ErrIDMismatch, got: %v", err)
	}
}

// TestPostAcceptsAMatchingReply is the other half: the guard must not reject
// the ordinary case. Without this, "reject everything" would pass the test
// above.
func TestPostAcceptsAMatchingReply(t *testing.T) {
	srv := idServer(t, -1) // echo whatever was asked
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	for i := 1; i <= 3; i++ {
		text, err := c.CallTool(context.Background(), "infoblox-portal_query_cube", nil)
		if err != nil {
			t.Fatalf("call %d: expected success, got: %v", i, err)
		}
		if !strings.Contains(text, "success") {
			t.Fatalf("call %d: unexpected payload: %q", i, text)
		}
	}
}

// TestPostAcceptsAStringID pins that a conforming server which echoes the id as
// a JSON string is not rejected. JSON-RPC 2.0 allows a string or a number, and
// failing a compliant reply would be a worse bug than the one being guarded.
func TestPostAcceptsAStringID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := decodeBody(r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":"%d","result":{"content":[{"text":"{}"}]}}`, requestID(body))
	}))
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	if _, err := c.CallTool(context.Background(), "infoblox-portal_query_cube", nil); err != nil {
		t.Fatalf("a string-form id is conforming and must be accepted, got: %v", err)
	}
}

// TestPostAcceptsAnUncorrelatableReply pins the deliberate blind spot. A server
// that echoes no id at all cannot be checked, and refusing to talk to it would
// break a working product over a spec nicety. The call succeeds; the operator
// gets one log line saying correlation is impossible here.
//
// This is the difference between "cannot check" and "checked and it was wrong",
// and conflating them is why the id is decoded as RawMessage and not *int.
func TestPostAcceptsAnUncorrelatableReply(t *testing.T) {
	for _, tc := range []struct {
		name string
		id   int
	}{{"explicit null id", 0}} {
		t.Run(tc.name, func(t *testing.T) {
			srv := idServer(t, tc.id)
			defer srv.Close()

			c := New(srv.URL, func() string { return "Bearer test" })
			if _, err := c.CallTool(context.Background(), "infoblox-portal_query_cube", nil); err != nil {
				t.Fatalf("an uncheckable reply must not fail the call, got: %v", err)
			}
		})
	}
}

// TestPostAcceptsAReplyWithNoIDField covers the absent-id case, which is
// distinct from an explicit null and is the one that earns the one-off warning.
func TestPostAcceptsAReplyWithNoIDField(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","result":{"content":[{"text":"{}"}]}}`))
	}))
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	if _, err := c.CallTool(context.Background(), "infoblox-portal_query_cube", nil); err != nil {
		t.Fatalf("a reply with no id field must not fail the call, got: %v", err)
	}
}

// TestMisaddressedMutationIsNotReportedAsNothingApplied is the mutation-safety
// half. ErrTransport promises the caller nothing was applied. A mis-addressed
// reply cannot promise that — the request went out and the server answered
// something — so CallToolChecked must degrade it to ErrRejected instead.
//
// Mutation that must turn this RED: drop the ErrIDMismatch branch in
// CallToolChecked so every post error becomes ErrTransport again.
func TestMisaddressedMutationIsNotReportedAsNothingApplied(t *testing.T) {
	srv := idServer(t, 99)
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	_, err := c.CallToolChecked(context.Background(), "iq-actions_update_action", nil, SuccessFieldTrue)
	if err == nil {
		t.Fatal("expected an error")
	}
	if errors.Is(err, ErrTransport) {
		t.Fatal("a mis-addressed reply was reported as ErrTransport — that tells the caller the write never left, which is not known")
	}
	if !errors.Is(err, ErrRejected) {
		t.Fatalf("expected ErrRejected, got: %v", err)
	}
}

// TestExtractSSEDataPrefersTheMatchingResponse pins the selection rule. The old
// code took the LAST response event in the stream; with two responses present
// that is a coin flip on position, and the id is the only thing that identifies
// the right one.
//
// Mutation that must turn this RED: revert extractSSEData to returning the last
// response event regardless of wantID.
func TestExtractSSEDataPrefersTheMatchingResponse(t *testing.T) {
	raw := []byte(
		"data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{}}\n" +
			"\n" +
			"data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"wanted\":true}}\n" +
			"\n" +
			"data: {\"jsonrpc\":\"2.0\",\"id\":8,\"result\":{\"wanted\":false}}\n")

	got := string(extractSSEData(raw, 7))
	if !strings.Contains(got, `"wanted":true`) {
		t.Fatalf("expected the event answering id 7, got: %s", got)
	}

	// With no preference, the documented last-response-event rule still holds,
	// so nothing regresses for callers that cannot name an id.
	got = string(extractSSEData(raw, 0))
	if !strings.Contains(got, `"wanted":false`) {
		t.Fatalf("expected the last response event with no id preference, got: %s", got)
	}
}

// TestExtractSSEDataIgnoresANullIDEvent pins that an explicit null id is not
// treated as a response event, matching the behaviour of the *int probe this
// replaced. A null id is what a server sends when it could not attribute the
// reply to any request.
func TestExtractSSEDataIgnoresANullIDEvent(t *testing.T) {
	raw := []byte(
		"data: {\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"real\":true}}\n" +
			"\n" +
			"data: {\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32700,\"message\":\"parse error\"}}\n")

	got := string(extractSSEData(raw, 0))
	if !strings.Contains(got, `"real":true`) {
		t.Fatalf("a null-id event must not be selected as the response, got: %s", got)
	}
}

// TestMismatchLogNeverEchoesTheReceivedID guards the same rule the rest of this
// package's logging follows: no substring of an upstream reply reaches the log.
// The received id is upstream-controlled and is deliberately not interpolated.
func TestMismatchLogNeverEchoesTheReceivedID(t *testing.T) {
	const marker = "SENSITIVE-UPSTREAM-VALUE"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":"%s","result":{}}`, marker)
	}))
	defer srv.Close()

	buf := captureLog(t)

	c := New(srv.URL, func() string { return "Bearer test" })
	if _, err := c.CallTool(context.Background(), "infoblox-portal_query_cube", nil); err == nil {
		t.Fatal("expected the mismatched reply to be rejected")
	}
	if strings.Contains(buf.String(), marker) {
		t.Fatalf("the log echoed an upstream-controlled id: %s", buf.String())
	}
	if !strings.Contains(buf.String(), "not the one this request asked with") {
		t.Fatalf("expected a mismatch line in the log, got: %s", buf.String())
	}
}
