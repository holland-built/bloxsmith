package mcp

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// A gateway that refuses a tool call with an HTTP status carries the reason in
// the reply — Infoblox's own shape is {"error":[{"message":"..."}]}. post used
// to throw the reply away and report only "http 403", so the Assets tab said
// "failed upstream" and the log said "http 403", and neither said why the key
// was refused. The refusal's own message is the diagnosis (see the rule above callTimeout in
// mcp.go: an upstream error message IS logged).

func refuse(status int, body string) func(string, http.ResponseWriter) {
	return func(_ string, w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}
}

func TestHTTPRefusalLogsTheUpstreamReason(t *testing.T) {
	for name, body := range map[string]string{
		"infoblox error list": `{"error":[{"message":"you are not authorized to use this feature"}]}`,
		"error object":        `{"error":{"message":"you are not authorized to use this feature"}}`,
		"error string":        `{"error":"you are not authorized to use this feature"}`,
		"top-level message":   `{"message":"you are not authorized to use this feature"}`,
	} {
		t.Run(name, func(t *testing.T) {
			logs := captureLog(t)
			srv := replyServer(t, refuse(http.StatusForbidden, body))

			rows := newTestClient(srv.URL).QueryCube(t.Context(), "AssetDetails_ch_agg", []string{"count"}, nil)
			if rows != nil {
				t.Fatalf("expected nil rows on a refused call, got %+v", rows)
			}
			mustLog(t, logs, "QueryCube", "AssetDetails_ch_agg", "http 403", "you are not authorized to use this feature")
		})
	}
}

// The standing rule is that a data-bearing body never reaches the log. A refusal
// whose body is not an error envelope is not echoed, in part or whole.
func TestHTTPRefusalWithoutAnErrorMessageEchoesNothing(t *testing.T) {
	logs := captureLog(t)
	srv := replyServer(t, refuse(http.StatusForbidden, `{"rows":[{"name":"HOST-77","ip":"10.1.2.3"}]}`))

	_ = newTestClient(srv.URL).QueryCube(t.Context(), "AssetDetails_ch_agg", []string{"count"}, nil)

	mustLog(t, logs, "http 403")
	for _, leaked := range []string{"HOST-77", "10.1.2.3"} {
		if strings.Contains(logs.String(), leaked) {
			t.Fatalf("log echoed %q from a body that was not an error message:\n%s", leaked, logs.String())
		}
	}
}

// A long or multi-line message is kept to one bounded line, so one refusal
// cannot bury the log.
func TestHTTPRefusalReasonIsBounded(t *testing.T) {
	logs := captureLog(t)
	long := strings.Repeat("x", 5000)
	srv := replyServer(t, refuse(http.StatusForbidden, `{"error":[{"message":"line one\nline two `+long+`"}]}`))

	_ = newTestClient(srv.URL).QueryCube(t.Context(), "AssetDetails_ch_agg", []string{"count"}, nil)

	// QueryCube asks the Cube.js endpoint first and notes when it hands over to
	// the MCP; that notice is a separate line and not the refusal under test.
	var kept []string
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		if !strings.Contains(line, "direct query not used") {
			kept = append(kept, line)
		}
	}
	got := strings.Join(kept, "\n")
	if strings.Contains(got, "\n") {
		t.Fatalf("a refusal must log as one line, got:\n%s", got)
	}
	if len(got) > 400 {
		t.Fatalf("a refusal's reason must be bounded, log line was %d bytes", len(got))
	}
	mustLog(t, logs, "http 403", "line one")
}

// Tool payloads use a top-level "message" for query results, so on a refusal the
// error envelope is read first and the top-level field only when there is none.
func TestHTTPRefusalPrefersTheErrorFieldOverAMessage(t *testing.T) {
	logs := captureLog(t)
	srv := replyServer(t, refuse(http.StatusForbidden,
		`{"error":[{"message":"not authorized"}],"message":"HOST-77 10.1.2.3"}`))

	_ = newTestClient(srv.URL).QueryCube(t.Context(), "AssetDetails_ch_agg", []string{"count"}, nil)

	mustLog(t, logs, "http 403", "not authorized")
	if strings.Contains(logs.String(), "HOST-77") {
		t.Fatalf("log echoed the top-level message next to an error envelope:\n%s", logs.String())
	}
}

// A refusal whose body never finishes must not hold the call: the status alone
// is already the answer, and it used to be returned the moment it arrived.
func TestHTTPRefusalDoesNotWaitForASlowBody(t *testing.T) {
	logs := captureLog(t)
	release := make(chan struct{})
	srv := replyServer(t, func(_ string, w http.ResponseWriter) {
		raw := w.(idEchoWriter).ResponseWriter
		raw.Header().Set("Content-Type", "application/json")
		raw.WriteHeader(http.StatusForbidden)
		_, _ = raw.Write([]byte(`{"error":`))
		raw.(http.Flusher).Flush()
		<-release
	})
	t.Cleanup(func() { close(release) })

	start := time.Now()
	_ = newTestClient(srv.URL).QueryCube(t.Context(), "AssetDetails_ch_agg", []string{"count"}, nil)

	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("a refusal with an unfinished body held the call for %v", took)
	}
	mustLog(t, logs, "http 403")
}

// An error field that is present but empty is still an error envelope: the
// top-level message is only read when there is no "error" field at all.
func TestHTTPRefusalWithAnEmptyErrorFieldIgnoresTheMessage(t *testing.T) {
	logs := captureLog(t)
	srv := replyServer(t, refuse(http.StatusForbidden, `{"error":[],"message":"HOST-77 10.1.2.3"}`))

	_ = newTestClient(srv.URL).QueryCube(t.Context(), "AssetDetails_ch_agg", []string{"count"}, nil)

	mustLog(t, logs, "http 403")
	if strings.Contains(logs.String(), "HOST-77") {
		t.Fatalf("log echoed the top-level message beside a present error field:\n%s", logs.String())
	}
}
