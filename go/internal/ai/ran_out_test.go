package ai

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// The 2026-10-26 failure: a suggested question spent every round on lookups
// and the reader got "No response." When the rounds run out, the model is
// asked once more with no tools on offer, and that answer is what comes back.
func TestRoundsUsedUpAsksForAnAnswerWithoutTools(t *testing.T) {
	var lastHadTools bool
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		b, _ := io.ReadAll(r.Body)
		var req map[string]any
		_ = json.Unmarshal(b, &req)
		_, lastHadTools = req["tools"]
		w.Header().Set("Content-Type", "application/json")
		if lastHadTools {
			// A different lookup every round, so none is a repeat.
			args := strconv.Quote(`{"page":` + strconv.Itoa(calls) + `}`)
			_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"id":"c` + strconv.Itoa(calls) +
				`","function":{"name":"get_subnets","arguments":` + args + `}}]}}],"usage":{"total_tokens":1}}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"content":"{\"answer\":\"Two subnets are over 80%.\",\"suggestions\":[]}"}}],"usage":{"total_tokens":1}}`))
	}))
	defer srv.Close()

	svc := New(fakeCreds{base: srv.URL}, countingTools{calls: map[string]int{}}, newFakeBudget(func() string { return "2026-10-26" }))
	var trace []map[string]any
	got := svc.runLoop("which subnets are nearly full?", "", &trace)

	if lastHadTools {
		t.Fatal("the last call still offered tools; it must ask for an answer only")
	}
	if !strings.Contains(got, "Two subnets are over 80%") {
		t.Fatalf("want the tool-free answer, got %s", got)
	}
	if calls != 7 {
		t.Fatalf("want 6 lookup rounds and 1 answer call, got %d calls", calls)
	}
}

// If even the tool-free call gives nothing, the reader is told in plain words
// that lookups ran and no answer came, never a bare "No response."
func TestRoundsUsedUpWithNoAnswerSaysSoPlainly(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		args := strconv.Quote(`{"page":` + strconv.Itoa(calls) + `}`)
		_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"id":"c` + strconv.Itoa(calls) +
			`","function":{"name":"get_subnets","arguments":` + args + `}}]}}],"usage":{"total_tokens":1}}`))
	}))
	defer srv.Close()

	svc := New(fakeCreds{base: srv.URL}, countingTools{calls: map[string]int{}}, newFakeBudget(func() string { return "2026-10-26" }))
	var trace []map[string]any
	got := svc.runLoop("which subnets are nearly full?", "", &trace)
	if strings.Contains(got, "No response.") || !strings.Contains(got, "couldn't put an answer together") {
		t.Fatalf("want the plain ran-out answer, got %s", got)
	}
}
