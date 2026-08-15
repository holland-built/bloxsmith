package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"bloxsmith/internal/ai"
)

// THE NUMBERS IN A TOOL CALL ARE CHOSEN BY THE MODEL.
//
// RunAITool has always guarded the subnet address (regex) and the cidr
// (0..128), because this codebase treats model output as untrusted for a
// measured reason — see untrustedNotice below and toolFact in internal/ai.
// `limit` and `days` were left out and went to the tenant verbatim: `_limit=-5`,
// `_limit=500000`, `"dateRange":"last 99999 days"`.
//
// SCOPE. These assert what leaves the process, not what the tool returns. The
// harm is the request the customer's tenant receives, so the outgoing URL is the
// only thing worth pinning.

// captureQuery drives one tool call and returns the outgoing request line.
func captureQuery(t *testing.T, tool string, args map[string]any) string {
	t.Helper()
	s, paths := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, []map[string]any{{"id": "1"}})
	})
	s.RunAITool(context.Background(), tool, args)
	if len(*paths) != 1 {
		t.Fatalf("expected exactly one upstream call, got %v", *paths)
	}
	return (*paths)[0]
}

func TestAIToolBounds_AuditLogLimit(t *testing.T) {
	cases := []struct {
		name string
		arg  any
		want string
	}{
		{"absent falls back to the default", nil, "_limit=20"},
		{"negative is clamped to the floor", -5, "_limit=1"},
		{"zero is clamped to the floor", 0, "_limit=1"},
		{"the floor passes through", ai.AuditLogLimitMin, "_limit=1"},
		{"just inside the floor passes through", 2, "_limit=2"},
		{"an ordinary value passes through", 50, "_limit=50"},
		{"just inside the ceiling passes through", ai.AuditLogLimitMax - 1, "_limit=199"},
		{"the ceiling passes through", ai.AuditLogLimitMax, "_limit=200"},
		{"one past the ceiling is clamped", ai.AuditLogLimitMax + 1, "_limit=200"},
		{"absurd is clamped", 500000, "_limit=200"},
		{"a non-number falls back to the default", "twenty", "_limit=20"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			args := map[string]any{}
			if c.arg != nil {
				args["limit"] = c.arg
			}
			if got := captureQuery(t, "get_audit_logs", args); !strings.Contains(got, c.want) {
				t.Fatalf("outgoing = %s, want it to carry %s", got, c.want)
			}
		})
	}
}

// cubeQuery pulls the decoded cube query out of the outgoing request.
func cubeQuery(t *testing.T, args map[string]any) map[string]any {
	t.Helper()
	line := captureQuery(t, "get_dns_analytics", args)
	_, raw, ok := strings.Cut(line, "query=")
	if !ok {
		t.Fatalf("no query param in %s", line)
	}
	dec, err := url.QueryUnescape(raw)
	if err != nil {
		t.Fatalf("query param not decodable: %v", err)
	}
	var q map[string]any
	if err := json.Unmarshal([]byte(dec), &q); err != nil {
		t.Fatalf("query param is not JSON: %v (%s)", err, dec)
	}
	return q
}

func dateRange(t *testing.T, q map[string]any) string {
	t.Helper()
	td, _ := q["timeDimensions"].([]any)
	if len(td) == 0 {
		t.Fatalf("no timeDimensions in %v", q)
	}
	m, _ := td[0].(map[string]any)
	s, _ := m["dateRange"].(string)
	return s
}

func TestAIToolBounds_AnalyticsDays(t *testing.T) {
	cases := []struct {
		name string
		arg  any
		want string
	}{
		{"absent falls back to the default", nil, "last 7 days"},
		{"negative is clamped to the floor", -30, "last 1 days"},
		{"zero is clamped to the floor", 0, "last 1 days"},
		{"the floor passes through", ai.AnalyticsDaysMin, "last 1 days"},
		{"an ordinary value passes through", 14, "last 14 days"},
		{"the ceiling passes through", ai.AnalyticsDaysMax, "last 30 days"},
		{"one past the ceiling is clamped", ai.AnalyticsDaysMax + 1, "last 30 days"},
		{"absurd is clamped", 99999, "last 30 days"},
		{"a non-number falls back to the default", "a week", "last 7 days"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			args := map[string]any{}
			if c.arg != nil {
				args["days"] = c.arg
			}
			if got := dateRange(t, cubeQuery(t, args)); got != c.want {
				t.Fatalf("dateRange = %q, want %q", got, c.want)
			}
		})
	}
}

func TestAIToolBounds_AnalyticsLimit(t *testing.T) {
	cases := []struct {
		name string
		arg  any
		want float64
	}{
		{"absent falls back to the default", nil, 10},
		{"negative is clamped to the floor", -1, 1},
		{"the floor passes through", ai.AnalyticsLimitMin, 1},
		{"an ordinary value passes through", 25, 25},
		{"the ceiling passes through", ai.AnalyticsLimitMax, 100},
		{"one past the ceiling is clamped", ai.AnalyticsLimitMax + 1, 100},
		{"absurd is clamped", 100000, 100},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			args := map[string]any{}
			if c.arg != nil {
				args["limit"] = c.arg
			}
			if got := cubeQuery(t, args)["limit"]; got != c.want {
				t.Fatalf("cube limit = %v, want %v", got, c.want)
			}
		})
	}
}

// A clamped time range must be VISIBLE in the result. Without it the model asks
// for 99999 days, silently gets 30, and reports on "the last 99999 days".
func TestAIToolBounds_ClampedWindowIsStatedInTheResult(t *testing.T) {
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":{"data":[{"NstarDnsActivity.device_name":"h1","NstarDnsActivity.total_query_count":5}]}}`))
	})
	out := s.RunAITool(context.Background(), "get_dns_analytics", map[string]any{"days": 99999})

	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("result is not JSON: %v (%s)", err, out)
	}
	if got["window_days"] != float64(ai.AnalyticsDaysMax) {
		t.Fatalf("window_days = %v, want %d — the result must say which range was actually queried",
			got["window_days"], ai.AnalyticsDaysMax)
	}
	note, _ := got["note"].(string)
	if !strings.Contains(note, "30 day") {
		t.Fatalf("note = %q, want it to name the range that was queried", note)
	}
	if got["rows"] == nil {
		t.Fatalf("the rows were dropped: %v", got)
	}
}
