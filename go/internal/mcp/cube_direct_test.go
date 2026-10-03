package mcp

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// cubeServer answers the Portal's Cube.js endpoint with cubeStatus/cubeBody and
// counts how many calls reached it and how many reached the MCP path.
type cubeServer struct {
	cubeCalls, mcpCalls int32
	lastAuth            string
	lastQuery           map[string]any
}

func (s *cubeServer) start(t *testing.T, cubeStatus int, cubeBody string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path == "/api/cubejs/v1/query" {
			atomic.AddInt32(&s.cubeCalls, 1)
			s.lastAuth = r.Header.Get("Authorization")
			var env struct {
				Query string `json:"query"`
			}
			if err := json.Unmarshal(body, &env); err != nil {
				t.Errorf("the cube endpoint wants {\"query\": \"<json text>\"}, got %s", body)
			}
			_ = json.Unmarshal([]byte(env.Query), &s.lastQuery)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(cubeStatus)
			_, _ = w.Write([]byte(cubeBody))
			return
		}
		atomic.AddInt32(&s.mcpCalls, 1)
		var req struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		_ = json.Unmarshal(body, &req)
		switch {
		case req.Method == "tools/call" && req.Params.Name == "infoblox-portal_query_cube":
			w.Header().Set("Content-Type", "application/json")
			text := `{"table_name":"cube_x.parquet","row_count":1,"column_count":1,"columns":["count"],"message":"Query Result: [{'Assets.count': '7'}]. If necessary, use query_stored_data tool."}`
			resp := map[string]any{"jsonrpc": "2.0", "id": requestID(body), "result": map[string]any{"content": []map[string]any{{"text": text}}}}
			_ = json.NewEncoder(w).Encode(resp)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// The Portal's own Assets page reads the Cube.js endpoint directly, with no MCP
// permission and no stored-result second hop. The client does the same, with the
// caller's key as it always sent it.
func TestQueryCubeReadsTheCubeEndpointDirectly(t *testing.T) {
	s := &cubeServer{}
	srv := s.start(t, 200, `{"result":{"data":[{"Assets.name":"a","Assets.n":"3"},{"Assets.name":"b","Assets.n":"4"}]}}`)
	c := New(srv.URL+"/mcp", func() string { return "Token k" })

	rows := c.QueryCube(t.Context(), "Assets", []string{"Assets.n"}, map[string]any{
		"dimensions": []string{"Assets.name"},
		"order":      map[string]any{"Assets.n": "desc"},
		"limit":      50,
		"offset":     100,
		"time_dimensions": []map[string]any{{
			"dimension": "Assets.seen", "dateRange": "last 7 days", "granularity": "day",
		}},
	})

	if len(rows) != 2 || rows[0]["Assets.name"] != "a" || rows[1]["Assets.n"] != "4" {
		t.Fatalf("want the two rows from the cube endpoint, got %v", rows)
	}
	if got := atomic.LoadInt32(&s.mcpCalls); got != 0 {
		t.Fatalf("the MCP must not be called when the cube endpoint answers, got %d calls", got)
	}
	if s.lastAuth != "Token k" {
		t.Fatalf("the caller's Authorization value must be sent as it is, got %q", s.lastAuth)
	}
	q := s.lastQuery
	if q["limit"] != float64(50) || q["offset"] != float64(100) {
		t.Fatalf("limit and offset must be passed on, got %v", q)
	}
	if _, ok := q["timeDimensions"]; !ok {
		t.Fatalf("time_dimensions must reach Cube.js as timeDimensions, got keys of %v", q)
	}
	if ms, _ := q["measures"].([]any); len(ms) != 1 || ms[0] != "Assets.n" {
		t.Fatalf("measures must be passed on, got %v", q["measures"])
	}
}

// No rows is an answer, not a failure: callers read a nil slice as "the query
// failed", and an empty one as "there is nothing".
func TestQueryCubeEmptyDataIsAnAnswerNotAFailure(t *testing.T) {
	s := &cubeServer{}
	srv := s.start(t, 200, `{"result":{"data":[]}}`)
	c := New(srv.URL+"/mcp", func() string { return "Token k" })

	rows := c.QueryCube(t.Context(), "Assets", []string{"Assets.n"}, nil)
	if rows == nil {
		t.Fatal("an empty result must come back as an empty slice, not nil")
	}
	if len(rows) != 0 || atomic.LoadInt32(&s.mcpCalls) != 0 {
		t.Fatalf("want 0 rows and no MCP call, got %d rows and %d MCP calls", len(rows), s.mcpCalls)
	}
}

// A key the endpoint refuses (or an endpoint that is not there) must not leave
// the panel dead when the MCP can still answer: ask the MCP, as before.
func TestQueryCubeFallsBackToTheMCPWhenTheEndpointRefuses(t *testing.T) {
	for _, status := range []int{401, 403, 404} {
		s := &cubeServer{}
		srv := s.start(t, status, `{"error":"no"}`)
		c := New(srv.URL+"/mcp", func() string { return "Token k" })

		rows := c.QueryCube(t.Context(), "Assets", []string{"Assets.count"}, nil)
		if len(rows) != 1 || rows[0]["Assets.count"] != "7" {
			t.Fatalf("status %d: want the MCP's row, got %v", status, rows)
		}
		if atomic.LoadInt32(&s.cubeCalls) != 1 || atomic.LoadInt32(&s.mcpCalls) == 0 {
			t.Fatalf("status %d: want one cube call then the MCP, got %d and %d", status, s.cubeCalls, s.mcpCalls)
		}
	}
}

// An option with no Cube.js equivalent is not guessed at: the MCP gets it.
func TestQueryCubeAnUnknownOptionGoesToTheMCP(t *testing.T) {
	s := &cubeServer{}
	srv := s.start(t, 200, `{"result":{"data":[{"x":"1"}]}}`)
	c := New(srv.URL+"/mcp", func() string { return "Token k" })

	rows := c.QueryCube(t.Context(), "Assets", []string{"Assets.count"}, map[string]any{"mystery": true})
	if len(rows) != 1 || rows[0]["Assets.count"] != "7" {
		t.Fatalf("want the MCP's row, got %v", rows)
	}
	if atomic.LoadInt32(&s.cubeCalls) != 0 {
		t.Fatalf("an option the cube endpoint cannot take must not be sent to it, got %d calls", s.cubeCalls)
	}
}
