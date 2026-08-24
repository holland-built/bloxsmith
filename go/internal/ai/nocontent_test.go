package ai

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// These cover the state a screenshot caught on 2026-08-24: the Ask AI panel ran
// get_subnets, showed the tool's own fact line, and then said "No content." —
// which tells a reader nothing about what went wrong or what to do next.
//
// The shape is: one tool_calls round, then a round that stops with an EMPTY
// content string. The most likely producer is finish_reason "length" on a
// reasoning model, where the token budget is consumed before a single answer
// token is emitted. That cause is a hypothesis; these tests pin the BEHAVIOUR,
// which has to be right whatever produced it.

// chatScript replies with each response in order, failing if the loop asks for
// more than the script has. It also records every request body so a test can
// assert what the retry actually sent.
func chatScript(t *testing.T, responses ...string) (*httptest.Server, *[]map[string]any) {
	t.Helper()
	var seen []map[string]any
	i := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		seen = append(seen, body)
		if i >= len(responses) {
			t.Errorf("unexpected extra chat call #%d", i+1)
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(responses[i]))
		i++
	}))
	t.Cleanup(srv.Close)
	return srv, &seen
}

const toolCallRound = `{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"id":"c1","function":{"name":"get_subnets","arguments":"{}"}}]}}],"usage":{"total_tokens":400}}`

// TestLengthTruncationRetriesWithMoreRoom is the fix. A round that ran out of
// room before producing any answer is not a finished answer — it is a budget
// problem, and the one thing that can rescue it is more room. The loop retries
// ONCE, and the retry must actually ask for a bigger budget or it is just the
// same call again.
func TestLengthTruncationRetriesWithMoreRoom(t *testing.T) {
	srv, seen := chatScript(t,
		toolCallRound,
		// All the room went to reasoning; not one answer token came out.
		`{"choices":[{"finish_reason":"length","message":{"content":""}}],"usage":{"total_tokens":1024}}`,
		// With more room it answers.
		`{"choices":[{"finish_reason":"stop","message":{"content":"{\"answer\":\"42 subnets are over 90%\",\"suggestions\":[]}"}}],"usage":{"total_tokens":900}}`,
	)
	fb := newFakeBudget(func() string { return "2026-08-24" })
	svc := New(fakeCreds{base: srv.URL}, fakeToolRunner{}, fb)

	var trace []map[string]any
	got := svc.runLoop("Which subnets are nearly full?", "", &trace)
	if !strings.Contains(got, "42 subnets are over 90%") {
		t.Fatalf("runLoop = %q, want the answer the retry produced", got)
	}
	if len(*seen) != 3 {
		t.Fatalf("made %d chat calls, want 3 (tool round, truncated round, retry)", len(*seen))
	}
	first, _ := (*seen)[1]["max_tokens"].(float64)
	retry, _ := (*seen)[2]["max_tokens"].(float64)
	if !(retry > first) {
		t.Errorf("retry asked for max_tokens %v, not more than the %v that was truncated", retry, first)
	}
	// Every call's tokens belong to the same day's count, retry included.
	if fb.tokens != 400+1024+900 {
		t.Errorf("tokens = %d, want every round summed including the retry", fb.tokens)
	}
}

// TestLengthTruncationTwiceExplainsItself: when more room does not help either,
// the user must be told what happened. "No content." is not that.
func TestLengthTruncationTwiceExplainsItself(t *testing.T) {
	empty := `{"choices":[{"finish_reason":"length","message":{"content":""}}],"usage":{"total_tokens":10}}`
	srv, _ := chatScript(t, toolCallRound, empty, empty)
	fb := newFakeBudget(func() string { return "2026-08-24" })
	svc := New(fakeCreds{base: srv.URL}, fakeToolRunner{}, fb)

	var trace []map[string]any
	got := svc.runLoop("q", "", &trace)
	var parsed struct {
		Answer string `json:"answer"`
	}
	if err := json.Unmarshal([]byte(got), &parsed); err != nil {
		t.Fatalf("runLoop returned non-JSON %q: %v", got, err)
	}
	if parsed.Answer == "No content." {
		t.Fatal(`still the bare "No content." — the reason is what the reader needs`)
	}
	low := strings.ToLower(parsed.Answer)
	if !strings.Contains(low, "cut off") && !strings.Contains(low, "length") && !strings.Contains(low, "room") {
		t.Errorf("answer = %q, want it to name the length limit as the cause", parsed.Answer)
	}
}

// TestEmptyStopNamesTheReason: a model that stops cleanly with nothing to say
// is a different fault from a truncated one, and must not be reported as a
// truncation. It still may not be reported as a bare "No content."
func TestEmptyStopNamesTheReason(t *testing.T) {
	srv, _ := chatScript(t,
		toolCallRound,
		`{"choices":[{"finish_reason":"stop","message":{"content":""}}],"usage":{"total_tokens":10}}`,
	)
	fb := newFakeBudget(func() string { return "2026-08-24" })
	svc := New(fakeCreds{base: srv.URL}, fakeToolRunner{}, fb)

	var trace []map[string]any
	got := svc.runLoop("q", "", &trace)
	var parsed struct {
		Answer string `json:"answer"`
	}
	if err := json.Unmarshal([]byte(got), &parsed); err != nil {
		t.Fatalf("non-JSON %q: %v", got, err)
	}
	if parsed.Answer == "No content." {
		t.Fatal(`bare "No content." again`)
	}
	if strings.Contains(strings.ToLower(parsed.Answer), "cut off") {
		t.Errorf("answer = %q, but finish_reason was stop — nothing was cut off", parsed.Answer)
	}
	if !strings.Contains(parsed.Answer, "stop") {
		t.Errorf("answer = %q, want the finish reason named so the next report is self-diagnosing", parsed.Answer)
	}
}

// TestSuggestionsSurviveAnEmptyAnswer: whatever went wrong, the panel's
// follow-up chips are the reader's way out of a dead end. An empty-answer path
// that also returns no suggestions leaves them with nothing to click.
func TestSuggestionsSurviveAnEmptyAnswer(t *testing.T) {
	srv, _ := chatScript(t,
		toolCallRound,
		`{"choices":[{"finish_reason":"stop","message":{"content":""}}],"usage":{"total_tokens":10}}`,
	)
	fb := newFakeBudget(func() string { return "2026-08-24" })
	svc := New(fakeCreds{base: srv.URL}, fakeToolRunner{}, fb)

	var trace []map[string]any
	got := svc.runLoop("q", "", &trace)
	var parsed struct {
		Suggestions []string `json:"suggestions"`
	}
	_ = json.Unmarshal([]byte(got), &parsed)
	if len(parsed.Suggestions) == 0 {
		t.Error("no suggestions on the empty-answer path — the panel becomes a dead end")
	}
}
