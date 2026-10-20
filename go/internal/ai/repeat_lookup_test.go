package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type countingTools struct{ calls map[string]int }

func (c countingTools) RunAITool(ctx context.Context, name string, args map[string]any) string {
	c.calls[name]++
	return `{"summary":"1440 DNS zones exist in total","sample":["` + strings.Repeat("z", 2000) + `"]}`
}

// The 2026-10-20 failure: the model called get_dns {} twice with identical
// results, and the second copy of the result pushed the third chat call over
// the 7,000-a-minute input cap. A repeat of the same call in the same question
// is answered with a pointer to the first result, not the result again.
func TestRepeatedIdenticalToolCallIsNotRunOrResentAgain(t *testing.T) {
	call := func(id, args string) string {
		return `{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"id":"` + id +
			`","function":{"name":"get_dns","arguments":` + args + `}}]}}],"usage":{"total_tokens":1}}`
	}
	var lastBody string
	round := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		lastBody = string(b)
		round++
		w.Header().Set("Content-Type", "application/json")
		switch round {
		case 1:
			_, _ = w.Write([]byte(call("c1", `"{}"`)))
		case 2:
			// same call, arguments spelled differently but equal
			_, _ = w.Write([]byte(call("c2", `"{ }"`)))
		default:
			_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"content":"{\"answer\":\"ok\",\"suggestions\":[]}"}}],"usage":{"total_tokens":1}}`))
		}
	}))
	defer srv.Close()

	tools := countingTools{calls: map[string]int{}}
	svc := New(fakeCreds{base: srv.URL}, tools, newFakeBudget(func() string { return "2026-10-20" }))
	var trace []map[string]any
	svc.runLoop("how many top level zones do I have", "", &trace)

	if tools.calls["get_dns"] != 1 {
		t.Fatalf("get_dns ran %d times, want 1", tools.calls["get_dns"])
	}
	var req struct {
		Messages []map[string]any `json:"messages"`
	}
	if err := json.Unmarshal([]byte(lastBody), &req); err != nil {
		t.Fatal(err)
	}
	var toolMsgs []string
	for _, m := range req.Messages {
		if m["role"] == "tool" {
			toolMsgs = append(toolMsgs, m["content"].(string))
		}
	}
	if len(toolMsgs) != 2 {
		t.Fatalf("want 2 tool messages (one per call id), got %d", len(toolMsgs))
	}
	if strings.Contains(toolMsgs[1], "zzzz") || !strings.Contains(toolMsgs[1], "same") {
		t.Fatalf("the repeat must point back to the first result, not resend it: %.200s", toolMsgs[1])
	}
	if len(trace) != 2 || trace[1]["fact"] != trace[0]["fact"] {
		t.Fatalf("the trace should show both calls with the same figure: %v", trace)
	}
}

// Different arguments are a different question and still run.
func TestToolCallWithDifferentArgumentsStillRuns(t *testing.T) {
	round := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		round++
		w.Header().Set("Content-Type", "application/json")
		if round <= 2 {
			args := map[int]string{1: `"{\"status\":\"online\"}"`, 2: `"{\"status\":\"offline\"}"`}[round]
			_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"id":"c","function":{"name":"get_hosts","arguments":` + args + `}}]}}],"usage":{"total_tokens":1}}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"content":"{\"answer\":\"ok\",\"suggestions\":[]}"}}],"usage":{"total_tokens":1}}`))
	}))
	defer srv.Close()
	tools := countingTools{calls: map[string]int{}}
	svc := New(fakeCreds{base: srv.URL}, tools, newFakeBudget(func() string { return "2026-10-20" }))
	var trace []map[string]any
	svc.runLoop("q", "", &trace)
	if tools.calls["get_hosts"] != 2 {
		t.Fatalf("get_hosts ran %d times, want 2", tools.calls["get_hosts"])
	}
}

type failingTools struct{ calls *int }

func (f failingTools) RunAITool(ctx context.Context, name string, args map[string]any) string {
	*f.calls++
	return "Could not reach Infoblox to look up DNS zones (network error)."
}

// A failed lookup is not remembered: the model asking again is a retry.
func TestFailedToolCallIsRunAgainWhenRepeated(t *testing.T) {
	round := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		round++
		w.Header().Set("Content-Type", "application/json")
		if round <= 2 {
			_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"id":"c","function":{"name":"get_dns","arguments":"{}"}}]}}],"usage":{"total_tokens":1}}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"content":"{\"answer\":\"ok\",\"suggestions\":[]}"}}],"usage":{"total_tokens":1}}`))
	}))
	defer srv.Close()
	calls := 0
	svc := New(fakeCreds{base: srv.URL}, failingTools{&calls}, newFakeBudget(func() string { return "2026-10-20" }))
	var trace []map[string]any
	svc.runLoop("q", "", &trace)
	if calls != 2 {
		t.Fatalf("a failed get_dns ran %d times, want 2 (the retry must run)", calls)
	}
}
