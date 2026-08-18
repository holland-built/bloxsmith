package dashboard

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// This file exists because of issue #138. internal/mcp's client now refuses a
// reply whose JSON-RPC id is not the id it asked with, and the fake MCP
// endpoints in this package used to stamp every reply `"id":1` — right for the
// first call on a client and wrong for every one after it. A double that
// answers a question nobody asked cannot prove anything about the real client.
//
// echoRPCID wraps a fake's ResponseWriter so it rewrites ONLY the id, leaving
// each test's response shape untouched: the id was never what any of them was
// asserting, and threading one through every closure would have churned tests
// that are not about this change.

var rpcIDRE = regexp.MustCompile(`"id"\s*:\s*\d+`)

// echoRPCID returns w rewritten to answer with the id carried on reqBody.
func echoRPCID(w http.ResponseWriter, reqBody []byte) http.ResponseWriter {
	var req struct {
		ID *int `json:"id"`
	}
	id := 0
	if json.Unmarshal(reqBody, &req) == nil && req.ID != nil {
		id = *req.ID
	}
	return rpcIDEcho{ResponseWriter: w, id: id}
}

type rpcIDEcho struct {
	http.ResponseWriter
	id int
}

func (w rpcIDEcho) Write(p []byte) (int, error) {
	if _, err := w.ResponseWriter.Write([]byte(rpcIDRE.ReplaceAllString(string(p), `"id":`+strconv.Itoa(w.id)))); err != nil {
		return 0, err
	}
	// Report the caller's length: the rewritten body can differ in size, and an
	// encoder that sees a short write treats it as a failure.
	return len(p), nil
}

// TestEchoRPCIDAnswersTheIDItWasAsked proves the wrapper actually rewrites the
// id, rather than being a no-op nobody notices. Every fake MCP endpoint in this
// package depends on it, and none of them would fail today if it silently did
// nothing — they each make a single call, where the old hardcoded "id":1 is
// accidentally correct. This is the guard for the day one of them makes two.
//
// Mutation that must turn this RED: make rpcIDEcho.Write pass p through
// unchanged.
func TestEchoRPCIDAnswersTheIDItWasAsked(t *testing.T) {
	rec := httptest.NewRecorder()
	w := echoRPCID(rec, []byte(`{"jsonrpc":"2.0","id":7,"method":"tools/call"}`))

	canned := []byte(`{"jsonrpc":"2.0","id":1,"result":{}}`)
	n, err := w.Write(canned)
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	// The rewritten body can differ in length; reporting anything but the
	// caller's own length makes an encoder treat this as a short write.
	if n != len(canned) {
		t.Fatalf("Write reported %d bytes, caller wrote %d", n, len(canned))
	}
	if got := rec.Body.String(); !strings.Contains(got, `"id":7`) {
		t.Fatalf("reply was not re-addressed to the request: %s", got)
	}
}
