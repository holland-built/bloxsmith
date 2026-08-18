package mcp

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The tests in this file redirect the process-global standard logger, so NONE
// of them may call t.Parallel(): a parallel sibling would both race on
// log.SetOutput and capture unrelated output into these buffers, making the
// diagnostic assertions below flaky and their failures unreadable. That is not
// an oversight to tidy up later.

// captureLog redirects the standard logger for one test and returns the buffer
// holding everything written to it. Same shape as internal/audit's and
// internal/vault's helpers.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prevOut, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	t.Cleanup(func() { log.SetOutput(prevOut); log.SetFlags(prevFlags) })
	return &buf
}

// toolServer returns an httptest server that answers the MCP handshake
// normally and routes every tools/call to respond, which writes the reply for
// the named tool directly.
func replyServer(t *testing.T, respond func(tool string, w http.ResponseWriter)) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		body, _ := decodeBody(r)
		_ = json.Unmarshal(body, &req)

		if req.Method == "tools/call" {
			respond(req.Params.Name, idEchoWriter{w, requestID(body)})
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(reID(`{"jsonrpc":"2.0","id":1,"result":{}}`, body)))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// rpcError writes a JSON-RPC error envelope carrying msg, which is how the
// upstream reports a refused tool call. post turns it into an error whose text
// contains msg.
func rpcError(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0", "id": 1,
		"error": map[string]any{"code": -32000, "message": msg},
	})
}

// toolText writes a successful tools/call envelope whose single content block
// carries text verbatim — the raw upstream payload the client must parse.
func toolTextReply(w http.ResponseWriter, text string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0", "id": 1,
		"result": map[string]any{
			"content": []map[string]any{{"text": text}},
		},
	})
}

func newTestClient(url string) *Client {
	return New(url, func() string { return "Bearer test" })
}

// mustLog fails the test unless every want appears in the captured log.
func mustLog(t *testing.T, buf *bytes.Buffer, wants ...string) {
	t.Helper()
	got := buf.String()
	if strings.TrimSpace(got) == "" {
		t.Fatalf("nothing was logged at all — the failure discarded its own reason\nwanted: %v", wants)
	}
	for _, w := range wants {
		if !strings.Contains(got, w) {
			t.Fatalf("log is missing %q\ngot: %s", w, got)
		}
	}
}

// --- Sites 1 and 3: a transport failure inside Get and QueryCube ------------

// TestQueryCubeLogsATransportFailure covers site 3. A refused query_cube call
// returns a nil slice, which every dashboard assembler reads as "the query
// failed upstream" — the string the operator sees on the red Assets tab. The
// server must record why.
func TestQueryCubeLogsATransportFailure(t *testing.T) {
	logs := captureLog(t)
	srv := replyServer(t, func(tool string, w http.ResponseWriter) {
		rpcError(w, "cube quota exceeded")
	})

	rows := newTestClient(srv.URL).QueryCube(t.Context(), "AssetDiscoveryStatus", []string{"count"}, nil)
	if rows != nil {
		t.Fatalf("expected nil rows on a refused call, got %+v", rows)
	}
	mustLog(t, logs, "QueryCube", "AssetDiscoveryStatus", "cube quota exceeded")
}

// TestGetLogsATransportFailure covers site 1, the same failure in Get.
func TestGetLogsATransportFailure(t *testing.T) {
	logs := captureLog(t)
	srv := replyServer(t, func(tool string, w http.ResponseWriter) {
		rpcError(w, "upstream is unavailable")
	})

	rows := newTestClient(srv.URL).Get(t.Context(), "atcfw", "security_policies", nil, false)
	if rows != nil {
		t.Fatalf("expected nil rows on a refused call, got %+v", rows)
	}
	mustLog(t, logs, "Get", "atcfw", "security_policies", "upstream is unavailable")
}

// --- Sites 2 and 4: a stored-result payload that cannot be used ------------

// unusablePayloads are query_cube / make_get_request replies that parse as JSON
// but carry no usable (table_name, row_count) pair. Each must produce its own
// reason, so an operator reading the log can tell them apart. The sentinel in
// every one of them is tenant-shaped data that must never be echoed.
var unusablePayloads = []struct {
	name   string
	text   string
	reason string
}{
	{"not JSON at all", `Rate limit exceeded for SENTINEL-BODY`, "not JSON"},
	{"no table_name", `{"row_count":5,"note":"SENTINEL-BODY"}`, "no table_name"},
	{"table_name rejected", `{"table_name":"../../SENTINEL-TABLE","row_count":5}`, "table_name"},
	{"row_count is zero", `{"table_name":"cube_x.parquet","row_count":0,"note":"SENTINEL-BODY"}`, "row_count"},
	{"row_count is negative", `{"table_name":"cube_x.parquet","row_count":-5,"note":"SENTINEL-BODY"}`, "row_count"},
	{"row_count is fractional", `{"table_name":"cube_x.parquet","row_count":10.5,"note":"SENTINEL-BODY"}`, "row_count"},
}

// TestQueryCubeLogsWhyAStoredPayloadIsUnusable covers site 4.
func TestQueryCubeLogsWhyAStoredPayloadIsUnusable(t *testing.T) {
	for _, tc := range unusablePayloads {
		t.Run(tc.name, func(t *testing.T) {
			logs := captureLog(t)
			srv := replyServer(t, func(tool string, w http.ResponseWriter) {
				toolTextReply(w, tc.text)
			})

			rows := newTestClient(srv.URL).QueryCube(t.Context(), "SecurityActionAssets", []string{"count"}, nil)
			if rows != nil {
				t.Fatalf("expected nil rows, got %+v", rows)
			}
			mustLog(t, logs, "QueryCube", "SecurityActionAssets", tc.reason)
		})
	}
}

// TestGetLogsWhyAStoredPayloadIsUnusable covers site 2.
func TestGetLogsWhyAStoredPayloadIsUnusable(t *testing.T) {
	for _, tc := range unusablePayloads {
		t.Run(tc.name, func(t *testing.T) {
			logs := captureLog(t)
			srv := replyServer(t, func(tool string, w http.ResponseWriter) {
				toolTextReply(w, tc.text)
			})

			rows := newTestClient(srv.URL).Get(t.Context(), "atcfw", "named_lists", nil, true)
			if rows != nil {
				t.Fatalf("expected nil rows, got %+v", rows)
			}
			mustLog(t, logs, "Get", "atcfw", "named_lists", tc.reason)
		})
	}
}

// --- Sites 5, 6 and 7: every failure path in Search ------------------------

// TestSearchLogsEachFailurePath covers sites 5, 6 and 7. ai_tools.go documents
// at length that a nil here means the search DIED and must never be collapsed
// into "No entities found", so each of the three ways it can die needs its own
// line in the log.
func TestSearchLogsEachFailurePath(t *testing.T) {
	cases := []struct {
		name  string
		reply func(w http.ResponseWriter)
		want  string
	}{
		{"transport failure", func(w http.ResponseWriter) { rpcError(w, "search backend down") }, "search backend down"},
		{"response is not JSON", func(w http.ResponseWriter) { toolTextReply(w, `not json at all`) }, "not JSON"},
		{"shape not recognised", func(w http.ResponseWriter) { toolTextReply(w, `{"unexpected":{"a":1}}`) }, "shape"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			logs := captureLog(t)
			srv := replyServer(t, func(tool string, w http.ResponseWriter) { tc.reply(w) })

			if hits := newTestClient(srv.URL).Search(t.Context(), "10.0.0.1"); hits != nil {
				t.Fatalf("expected nil hits, got %+v", hits)
			}
			mustLog(t, logs, "Search", tc.want)
		})
	}
}

// --- Site 8: the page-0 break inside queryAllRows --------------------------

// TestQueryAllRowsLogsAPage0Failure covers site 8. A first-page failure
// deliberately returns (nil, nil) — identical to "no data", a contract
// TestQueryAllRowsPage0FailureReturnsEmptyNoError locks in on purpose — so the
// log line is the ONLY way to tell a dead read from an empty one. That makes it
// load-bearing, not decorative.
func TestQueryAllRowsLogsAPage0Failure(t *testing.T) {
	cases := []struct {
		name  string
		reply func(w http.ResponseWriter)
	}{
		{"transport", func(w http.ResponseWriter) { w.WriteHeader(http.StatusInternalServerError) }},
		{"decode", func(w http.ResponseWriter) { toolTextReply(w, `{"columns":`) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			logs := captureLog(t)
			srv := replyServer(t, func(tool string, w http.ResponseWriter) { tc.reply(w) })

			rows, err := newTestClient(srv.URL).queryAllRows(t.Context(), "t.parquet", 200, "assets cube")
			if err != nil {
				t.Fatalf("page-0 contract is unchanged: expected nil error, got %v", err)
			}
			if len(rows) != 0 {
				t.Fatalf("expected 0 rows, got %d", len(rows))
			}
			mustLog(t, logs, "assets cube")
		})
	}
}

// --- Sites 9 and 10: Initialize --------------------------------------------

// TestInitializeLogsAFailedHandshake covers site 10. Initialize returns its
// error, but ten of its eleven callers throw it away — every one of them
// spelled `s.Mcp.Initialize(ctx) != nil`. Logging inside Initialize is what
// gives all ten of them a reason.
func TestInitializeLogsAFailedHandshake(t *testing.T) {
	logs := captureLog(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(srv.Close)

	if err := newTestClient(srv.URL).Initialize(t.Context()); err == nil {
		t.Fatal("expected the handshake to fail")
	}
	mustLog(t, logs, "Initialize", "401")
}

// TestInitializeLogsAFailedInitializedNotification covers site 9. The
// handshake itself succeeds, so the client goes on to serve queries, but the
// notifications/initialized that the protocol requires was refused. That was
// discarded with `_, _ =`.
func TestInitializeLogsAFailedInitializedNotification(t *testing.T) {
	logs := captureLog(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
		}
		body, _ := decodeBody(r)
		_ = json.Unmarshal(body, &req)

		if req.Method == "notifications/initialized" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Mcp-Session-Id", "sid-1")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(reID(`{"jsonrpc":"2.0","id":1,"result":{}}`, body)))
	}))
	t.Cleanup(srv.Close)

	if err := newTestClient(srv.URL).Initialize(t.Context()); err != nil {
		t.Fatalf("a refused notification must not fail the handshake: %v", err)
	}
	mustLog(t, logs, "notifications/initialized", "400")
}

// TestInitializeSuppressesRepeatedIdenticalFailures covers R1, the one real
// flood risk in this change: a failed handshake is deliberately NOT cached, and
// four dashboard files call Initialize on every request, so an outage would
// otherwise write the same line thousands of times. Suppression must not hide a
// CHANGE of failure, and must reset on success so a re-failure is heard again.
func TestInitializeSuppressesRepeatedIdenticalFailures(t *testing.T) {
	logs := captureLog(t)
	status := http.StatusUnauthorized
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := decodeBody(r)
		if status == http.StatusOK {
			w.Header().Set("Mcp-Session-Id", "sid-1")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(reID(`{"jsonrpc":"2.0","id":1,"result":{}}`, body)))
			return
		}
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	c := newTestClient(srv.URL)

	for i := 0; i < 5; i++ {
		_ = c.Initialize(t.Context())
	}
	if n := strings.Count(logs.String(), "401"); n != 1 {
		t.Fatalf("five identical handshake failures should log once, logged %d times:\n%s", n, logs)
	}

	// A DIFFERENT failure is news and must be heard.
	status = http.StatusServiceUnavailable
	_ = c.Initialize(t.Context())
	if n := strings.Count(logs.String(), "503"); n != 1 {
		t.Fatalf("a changed failure must log, logged %d times:\n%s", n, logs)
	}
	// ...and then goes quiet again, like the first one did.
	_ = c.Initialize(t.Context())
	if n := strings.Count(logs.String(), "503"); n != 1 {
		t.Fatalf("the changed failure must then dedupe too, logged %d times:\n%s", n, logs)
	}

	// RECOVERY MUST CLEAR THE MEMO. The re-failure below is the SAME 503 that
	// was just suppressed, deliberately — an earlier draft put a different
	// status here, and the mutation "never clear lastInitErr" then survived,
	// because a changed message logs on its own merits and proved nothing about
	// the reset. Only repeating the identical error across a recovery can.
	status = http.StatusOK
	if err := c.Initialize(t.Context()); err != nil {
		t.Fatalf("expected recovery to succeed, got %v", err)
	}
	c.initialized = false // force the next call to redo the handshake
	status = http.StatusServiceUnavailable
	_ = c.Initialize(t.Context())
	if n := strings.Count(logs.String(), "503"); n != 2 {
		t.Fatalf("an outage that returns after a recovery must be heard again, saw %d 503 lines:\n%s", n, logs)
	}
}

// --- The two halves of the leak rule ---------------------------------------

// TestFailureLogsNeverEchoAResponseBody is the payload half of R2. The four
// paths below are the ones handed a data-bearing reply — the body that carries
// asset names, IP and MAC addresses on a real tenant. None of them may echo any
// part of it, which is why every reason string is a fixed classification rather
// than a formatted excerpt.
func TestFailureLogsNeverEchoAResponseBody(t *testing.T) {
	const sentinels = "SENTINEL"

	run := func(t *testing.T, text string, call func(c *Client)) {
		t.Helper()
		logs := captureLog(t)
		srv := replyServer(t, func(tool string, w http.ResponseWriter) { toolTextReply(w, text) })
		call(newTestClient(srv.URL))
		if strings.Contains(logs.String(), sentinels) {
			t.Fatalf("the response body reached the log:\n%s", logs)
		}
		if strings.TrimSpace(logs.String()) == "" {
			t.Fatalf("nothing was logged — this test would pass vacuously")
		}
	}

	for _, tc := range unusablePayloads {
		t.Run("QueryCube/"+tc.name, func(t *testing.T) {
			run(t, tc.text, func(c *Client) { c.QueryCube(t.Context(), "SecurityActionAssets", []string{"count"}, nil) })
		})
		t.Run("Get/"+tc.name, func(t *testing.T) {
			run(t, tc.text, func(c *Client) { c.Get(t.Context(), "atcfw", "named_lists", nil, true) })
		})
	}
	t.Run("Search/not JSON", func(t *testing.T) {
		run(t, `SENTINEL-BODY is not json`, func(c *Client) { c.Search(t.Context(), "q") })
	})
	t.Run("Search/shape not recognised", func(t *testing.T) {
		run(t, `{"unexpected":"SENTINEL-BODY"}`, func(c *Client) { c.Search(t.Context(), "q") })
	})
}

// TestTransportFailuresLogTheUpstreamReason is the other half of R2, and the
// point of this whole change. An upstream JSON-RPC error message is NOT a data
// payload, it is the diagnosis — "cube quota exceeded", "session expired" — and
// it must reach the operator verbatim. Sanitising it here would leave the log
// saying only that something failed, which is where this file started.
func TestTransportFailuresLogTheUpstreamReason(t *testing.T) {
	const reason = "the tenant is not entitled to SecurityActionAssets"

	cases := map[string]func(c *Client){
		"QueryCube": func(c *Client) { c.QueryCube(t.Context(), "SecurityActionAssets", []string{"count"}, nil) },
		"Get":       func(c *Client) { c.Get(t.Context(), "atcfw", "named_lists", nil, true) },
		"Search":    func(c *Client) { c.Search(t.Context(), "q") },
	}
	for name, call := range cases {
		t.Run(name, func(t *testing.T) {
			logs := captureLog(t)
			srv := replyServer(t, func(tool string, w http.ResponseWriter) { rpcError(w, reason) })
			call(newTestClient(srv.URL))
			mustLog(t, logs, reason)
		})
	}
}
