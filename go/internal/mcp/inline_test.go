package mcp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// TestQueryCubeInlineScalar verifies a measure-only cube query whose result is
// carried INLINE in the message field (query_stored_data is broken upstream,
// see mcp.go parseInline doc) is parsed directly, with zero calls to
// query_stored_data.
func TestQueryCubeInlineScalar(t *testing.T) {
	var storedCalls int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		body, _ := decodeBody(r)
		_ = json.Unmarshal(body, &req)

		switch {
		case req.Method == "tools/call" && req.Params.Name == "infoblox-portal_query_stored_data":
			atomic.AddInt32(&storedCalls, 1)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(reID(`{"jsonrpc":"2.0","id":1,"result":{"content":[{"text":"{}"}]}}`, body)))
		case req.Method == "tools/call" && req.Params.Name == "infoblox-portal_query_cube":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			text := `{"table_name":"cube_assetdiscoverystatus.parquet","resource_id":"elaborated-certification-admire-successfully","row_count":1,"column_count":1,"columns":["count"],"message":"Query Result: [{'AssetDiscoveryStatus.count': '319397'}]. If necessary, use query_stored_data tool for further analysis."}`
			resp := map[string]any{
				"jsonrpc": "2.0", "id": requestID(body),
				"result": map[string]any{
					"content": []map[string]any{{"text": text}},
				},
			}
			_ = json.NewEncoder(w).Encode(resp)
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(reID(`{"jsonrpc":"2.0","id":1,"result":{}}`, body)))
		}
	}))
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	rows := c.QueryCube(t.Context(), "AssetDiscoveryStatus", []string{"count"}, nil)

	if atomic.LoadInt32(&storedCalls) != 0 {
		t.Fatalf("expected zero query_stored_data calls, got %d", storedCalls)
	}
	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d: %+v", len(rows), rows)
	}
	if rows[0]["AssetDiscoveryStatus.count"] != "319397" {
		t.Fatalf("unexpected row: %+v", rows[0])
	}
}

// TestQueryCubeOverCapSkipsPaging verifies a stored (non-inline) response
// whose row_count exceeds maxRows is rejected before any query_stored_data
// call is issued.
func TestQueryCubeOverCapSkipsPaging(t *testing.T) {
	var storedCalls int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		body, _ := decodeBody(r)
		_ = json.Unmarshal(body, &req)

		switch {
		case req.Method == "tools/call" && req.Params.Name == "infoblox-portal_query_stored_data":
			atomic.AddInt32(&storedCalls, 1)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(reID(`{"jsonrpc":"2.0","id":1,"result":{"content":[{"text":"{}"}]}}`, body)))
		case req.Method == "tools/call" && req.Params.Name == "infoblox-portal_query_cube":
			text := `{"table_name":"cube_huge.parquet","row_count":999999,"message":"stored, no inline data here"}`
			resp := map[string]any{
				"jsonrpc": "2.0", "id": requestID(body),
				"result": map[string]any{
					"content": []map[string]any{{"text": text}},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(resp)
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(reID(`{"jsonrpc":"2.0","id":1,"result":{}}`, body)))
		}
	}))
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	rows := c.QueryCube(t.Context(), "Huge", []string{"count"}, nil)

	if atomic.LoadInt32(&storedCalls) != 0 {
		t.Fatalf("expected zero query_stored_data calls, got %d", storedCalls)
	}
	if rows != nil {
		t.Fatalf("expected nil rows over cap, got %+v", rows)
	}
}

// TestQueryCubeStoredUnderCapStillPages verifies a stored (non-inline)
// response under maxRows still pages via query_stored_data as before —
// existing behavior is preserved for the day query_stored_data is fixed.
func TestQueryCubeStoredUnderCapStillPages(t *testing.T) {
	var storedCalls int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		body, _ := decodeBody(r)
		_ = json.Unmarshal(body, &req)

		switch {
		case req.Method == "tools/call" && req.Params.Name == "infoblox-portal_query_stored_data":
			n := atomic.AddInt32(&storedCalls, 1)
			var text string
			if n == 1 {
				text = `{"columns":["a"],"data":[["x"],["y"]]}`
			} else {
				text = `{"columns":["a"],"data":[]}`
			}
			resp := map[string]any{
				"jsonrpc": "2.0", "id": requestID(body),
				"result": map[string]any{
					"content": []map[string]any{{"text": text}},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(resp)
		case req.Method == "tools/call" && req.Params.Name == "infoblox-portal_query_cube":
			text := `{"table_name":"cube_small.parquet","row_count":2,"message":"stored, no inline data here"}`
			resp := map[string]any{
				"jsonrpc": "2.0", "id": requestID(body),
				"result": map[string]any{
					"content": []map[string]any{{"text": text}},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(resp)
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(reID(`{"jsonrpc":"2.0","id":1,"result":{}}`, body)))
		}
	}))
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	rows := c.QueryCube(t.Context(), "Small", []string{"a"}, nil)

	if atomic.LoadInt32(&storedCalls) == 0 {
		t.Fatal("expected at least one query_stored_data call for a stored response under the cap")
	}
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d: %+v", len(rows), rows)
	}
}

// TestQueryCubeSSETwoEventsUsesResult reproduces the real bug: the CSP
// endpoint sends a `notifications/message` progress event, then the actual
// result, as two separate SSE events. Before the extractSSEData fix, joining
// both events with "" produced invalid JSON and CallTool failed outright.
// This drives the exact raw body captured live and asserts it comes out the
// other end of QueryCube as the parsed 319397 row.
func TestQueryCubeSSETwoEventsUsesResult(t *testing.T) {
	const rawSSE = "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{\"level\":\"info\",\"data\":{\"msg\":\"raw sse probe\",\"extra\":null}}}\n" +
		"\n" +
		"data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"table_name\\\":\\\"cube_assetdiscoverystatus.parquet\\\",\\\"row_count\\\":1,\\\"columns\\\":[\\\"count\\\"],\\\"message\\\":\\\"Query Result: [{'AssetDiscoveryStatus.count': '319397'}]. If necessary, use query_stored_data tool for further analysis.\\\"}\"}],\"structuredContent\":{},\"isError\":false}}\n"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
		}
		body, _ := decodeBody(r)
		_ = json.Unmarshal(body, &req)

		if req.Method == "tools/call" {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(reID(rawSSE, body)))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(reID(`{"jsonrpc":"2.0","id":1,"result":{}}`, body)))
	}))
	defer srv.Close()

	c := New(srv.URL, func() string { return "Bearer test" })
	rows := c.QueryCube(t.Context(), "AssetDiscoveryStatus", []string{"count"}, nil)

	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d: %+v", len(rows), rows)
	}
	if rows[0]["AssetDiscoveryStatus.count"] != "319397" {
		t.Fatalf("unexpected row: %+v", rows[0])
	}
}

// TestExtractSSEDataSingleEvent is a regression check: a stream with only
// one SSE event (no blank-line-separated notification first) still parses,
// matching pre-fix behavior.
func TestExtractSSEDataSingleEvent(t *testing.T) {
	raw := []byte("data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[]}}\n")
	got := extractSSEData(raw, 0)
	var out rpcResp
	if err := json.Unmarshal(got, &out); err != nil {
		t.Fatalf("expected valid JSON, got error: %v (data=%s)", err, got)
	}
}

// TestExtractSSEDataMultiLineEvent verifies multiple `data:` lines within a
// SINGLE event are joined with "\n" per the SSE spec, and the resulting JSON
// still parses (the lines here split a JSON string value's escaped content
// across two data: lines, which is legal SSE framing).
func TestExtractSSEDataMultiLineEvent(t *testing.T) {
	raw := []byte("data: {\"jsonrpc\":\"2.0\",\"id\":1,\n" +
		"data: \"result\":{\"content\":[]}}\n")
	got := extractSSEData(raw, 0)
	var out rpcResp
	if err := json.Unmarshal(got, &out); err != nil {
		t.Fatalf("expected multi-line data: lines to join into valid JSON, got error: %v (data=%s)", err, got)
	}
}

// TestExtractSSEDataNotificationOnlyFallsBack verifies a stream containing
// ONLY a notification (no id, no result/error) doesn't panic and falls back
// to the join-everything behavior instead of returning nothing.
func TestExtractSSEDataNotificationOnlyFallsBack(t *testing.T) {
	raw := []byte(`data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":{"msg":"hi"}}}` + "\n")
	got := extractSSEData(raw, 0)
	var probe struct {
		Method string `json:"method"`
	}
	if err := json.Unmarshal(got, &probe); err != nil {
		t.Fatalf("expected fallback to still decode as JSON, got error: %v (data=%s)", err, got)
	}
	if probe.Method != "notifications/message" {
		t.Fatalf("expected fallback to preserve the notification, got: %s", got)
	}
}

// inlineText builds a {"message": "..."} tool-response body wrapping a
// Python-repr "Query Result: [...]" payload, matching the real wire shape.
func inlineText(t *testing.T, queryResult string) string {
	t.Helper()
	b, err := json.Marshal(map[string]string{
		"message": "Query Result: " + queryResult + ". If necessary, use query_stored_data tool for further analysis.",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

// TestParseInlineRegression confirms the known-good scalar case still parses.
func TestParseInlineRegression(t *testing.T) {
	rows, ok := parseInline(inlineText(t, `[{'AssetDiscoveryStatus.count': '319397'}]`))
	if !ok {
		t.Fatal("expected ok=true")
	}
	if len(rows) != 1 || rows[0]["AssetDiscoveryStatus.count"] != "319397" {
		t.Fatalf("unexpected rows: %+v", rows)
	}
}

// TestParseInlineNone verifies a row with a None value parses, with the key
// present and mapped to a nil value (not dropped).
func TestParseInlineNone(t *testing.T) {
	rows, ok := parseInline(inlineText(t, `[{'count': '5', 'notes': None}]`))
	if !ok {
		t.Fatal("expected ok=true")
	}
	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d", len(rows))
	}
	val, present := rows[0]["notes"]
	if !present {
		t.Fatal("expected 'notes' key to be present, not dropped")
	}
	if val != nil {
		t.Fatalf("expected notes=nil, got %v", val)
	}
}

// TestParseInlineBooleans verifies True/False map to real Go bools.
func TestParseInlineBooleans(t *testing.T) {
	rows, ok := parseInline(inlineText(t, `[{'active': True, 'disabled': False}]`))
	if !ok {
		t.Fatal("expected ok=true")
	}
	if rows[0]["active"] != true {
		t.Fatalf("expected active=true, got %v (%T)", rows[0]["active"], rows[0]["active"])
	}
	if rows[0]["disabled"] != false {
		t.Fatalf("expected disabled=false, got %v (%T)", rows[0]["disabled"], rows[0]["disabled"])
	}
}

// TestParseInlineUnrecognizedTokenFails verifies an unrecognized bare token
// (not a quoted string, number, or None/True/False) fails the WHOLE parse
// rather than silently dropping that key.
func TestParseInlineUnrecognizedTokenFails(t *testing.T) {
	rows, ok := parseInline(inlineText(t, `[{'count': '5', 'weird': nan}]`))
	if ok {
		t.Fatalf("expected ok=false for an unrecognized bare token, got rows: %+v", rows)
	}
	if rows != nil {
		t.Fatalf("expected nil rows, got %+v", rows)
	}
}

// TestParseInlineNestedDictFails verifies a nested dict value fails the whole
// parse instead of being mis-split or hand-parsed incorrectly.
func TestParseInlineNestedDictFails(t *testing.T) {
	rows, ok := parseInline(inlineText(t, `[{'a': {'b': 1}}]`))
	if ok {
		t.Fatalf("expected ok=false for a nested dict value, got rows: %+v", rows)
	}
	if rows != nil {
		t.Fatalf("expected nil rows, got %+v", rows)
	}
}
