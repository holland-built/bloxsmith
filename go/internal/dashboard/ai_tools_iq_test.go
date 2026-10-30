package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// iqCube answers the Cube.js endpoint with rows, and records each query.
func iqCube(t *testing.T, rows []map[string]any, seen *[]map[string]any) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/cubejs/v1/query") {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		var q map[string]any
		if err := json.Unmarshal([]byte(r.URL.Query().Get("query")), &q); err != nil {
			t.Fatalf("query param not valid JSON: %v", err)
		}
		*seen = append(*seen, q)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"data": rows}})
	}
}

func TestRunAITool_IQInsights_SummaryCountsActionsByType(t *testing.T) {
	var seen []map[string]any
	s, _ := newAIToolsTestService(t, iqCube(t, []map[string]any{
		{"IqActions.type": "DNS Latency Spike", "IqActions.status": "resolved", "IqActions.severity": "high", "IqActions.count": "70"},
	}, &seen))
	out := s.RunAITool(context.Background(), "iq_insights", map[string]any{})
	if !strings.Contains(out, "DNS Latency Spike") || !strings.Contains(out, "70") {
		t.Fatalf("expected the IQ action counts, got %q", out)
	}
	if len(seen) != 1 {
		t.Fatalf("expected one cube query, got %d", len(seen))
	}
	m, _ := seen[0]["measures"].([]any)
	if len(m) != 1 || m[0] != "IqActions.count" {
		t.Fatalf("summary should count IqActions, sent %v", seen[0])
	}
}

func TestRunAITool_IQInsights_RecentListsNewestFirstWithAClampedLimit(t *testing.T) {
	var seen []map[string]any
	s, _ := newAIToolsTestService(t, iqCube(t, []map[string]any{
		{"IqActions.display_id": "IQ-219", "IqActions.title": "Latency up on dns1"},
	}, &seen))
	out := s.RunAITool(context.Background(), "iq_insights", map[string]any{"view": "recent", "limit": float64(9999)})
	if !strings.Contains(out, "IQ-219") {
		t.Fatalf("expected the recent action, got %q", out)
	}
	order, _ := seen[0]["order"].(map[string]any)
	if order["IqActions.created_on"] != "desc" {
		t.Fatalf("recent must be newest first, sent %v", seen[0])
	}
	if lim, _ := seen[0]["limit"].(float64); int(lim) != 50 {
		t.Fatalf("limit not clamped to 50: %v", seen[0]["limit"])
	}
}

// IQ token billing is not live on every tenant: the cube answers with no rows.
// That is a real "nothing used yet", and must read as one, not as a failure.
func TestRunAITool_IQInsights_NoTokenUsageSaysSo(t *testing.T) {
	var seen []map[string]any
	s, _ := newAIToolsTestService(t, iqCube(t, []map[string]any{}, &seen))
	out := s.RunAITool(context.Background(), "iq_insights", map[string]any{"view": "tokens"})
	if !strings.Contains(out, "No IQ token usage recorded") {
		t.Fatalf("expected the no-usage sentence, got %q", out)
	}
	m, _ := seen[0]["measures"].([]any)
	if len(m) != 1 || m[0] != "TokenUtilProtoSrvIQMonthly.tokens" {
		t.Fatalf("tokens view should read the monthly token cube, sent %v", seen[0])
	}
}

func TestRunAITool_IQInsights_MonthlyCountsByMonth(t *testing.T) {
	var seen []map[string]any
	s, _ := newAIToolsTestService(t, iqCube(t, []map[string]any{
		{"IqActions.created_on.month": "2026-10-01T00:00:00.000", "IqActions.count": "31"},
	}, &seen))
	out := s.RunAITool(context.Background(), "iq_insights", map[string]any{"view": "monthly"})
	if !strings.Contains(out, "2026-10") || !strings.Contains(out, "31") {
		t.Fatalf("expected the monthly count, got %q", out)
	}
	td, _ := seen[0]["timeDimensions"].([]any)
	if len(td) != 1 || td[0].(map[string]any)["granularity"] != "month" {
		t.Fatalf("monthly should group by month, sent %v", seen[0])
	}
}

func TestRunAITool_IQInsights_TotalIsActionsNotGroups(t *testing.T) {
	var seen []map[string]any
	s, _ := newAIToolsTestService(t, iqCube(t, []map[string]any{
		{"IqActions.type": "DNS Latency Spike", "IqActions.count": "70"},
		{"IqActions.type": "DNS NXDOMAIN Spike", "IqActions.count": "39"},
	}, &seen))
	var got struct {
		TotalCount int `json:"total_count"`
	}
	if err := json.Unmarshal([]byte(s.RunAITool(context.Background(), "iq_insights", map[string]any{})), &got); err != nil {
		t.Fatal(err)
	}
	if got.TotalCount != 109 {
		t.Fatalf("total_count should be the 109 actions, got %d", got.TotalCount)
	}
}

func TestRunAITool_IQInsights_AnswerWithoutDataIsAFailure(t *testing.T) {
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":"Continue wait"}`))
	})
	out := s.RunAITool(context.Background(), "iq_insights", map[string]any{})
	if strings.Contains(out, "No IQ actions") || !strings.Contains(out, "lookup failure") {
		t.Fatalf("a 200 with no data was read as no actions: %q", out)
	}
}

func TestRunAITool_IQInsights_LongBreakdownIsCapped(t *testing.T) {
	rows := make([]map[string]any, 80)
	for i := range rows {
		rows[i] = map[string]any{"IqActions.type": "t", "IqActions.count": "1"}
	}
	var seen []map[string]any
	s, _ := newAIToolsTestService(t, iqCube(t, rows, &seen))
	var got struct {
		TotalCount int   `json:"total_count"`
		Truncated  bool  `json:"truncated"`
		Rows       []any `json:"rows"`
	}
	_ = json.Unmarshal([]byte(s.RunAITool(context.Background(), "iq_insights", map[string]any{})), &got)
	if len(got.Rows) != 50 || !got.Truncated || got.TotalCount != 80 {
		t.Fatalf("expected 50 rows shown, truncated, total 80; got %d %v %d", len(got.Rows), got.Truncated, got.TotalCount)
	}
}
