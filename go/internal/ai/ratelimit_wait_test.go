package ai

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The 2026-10-20 failure, shaped like the real body: the third chat call of one
// question asked for 4474 input tokens with 4312 already spent against a 7000
// per-minute cap. Groq said to wait 16.62s; there were ~50s left in the query's
// own deadline, and the app gave up anyway. The wait here is shortened so the
// test does not sleep for real.
const realITPM = `{"error":{"message":"Rate limit reached for model x in organization org_x ` +
	`service tier on_demand on input tokens per minute (ITPM): Limit 7000, Used 4316, ` +
	`Requested 4623. Please try again in 0.05s. Need more tokens?"}}`

func TestPerMinuteLimitWithShortWaitIsWaitedOutOnce(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(realITPM))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"content":"{\"answer\":\"ok\",\"suggestions\":[]}"}}],"usage":{"total_tokens":10}}`))
	}))
	defer srv.Close()

	svc := New(fakeCreds{base: srv.URL}, fakeToolRunner{}, newFakeBudget(func() string { return "2026-10-20" }))
	var trace []map[string]any
	got := svc.runLoop("how many top level zones do I have", "", &trace)
	if strings.Contains(got, "AI error") {
		t.Fatalf("a per-minute limit with a 0.05s wait was reported as final: %s", got)
	}
	if calls != 2 {
		t.Fatalf("chat calls = %d, want 2 (the refused one, then one retry)", calls)
	}
}

// Once, not forever: a second per-minute refusal in the same question is
// reported, so a key that is genuinely saturated does not loop.
func TestPerMinuteLimitIsRetriedOnlyOnce(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(realITPM))
	}))
	defer srv.Close()

	svc := New(fakeCreds{base: srv.URL}, fakeToolRunner{}, newFakeBudget(func() string { return "2026-10-20" }))
	var trace []map[string]any
	got := svc.runLoop("q", "", &trace)
	if !strings.Contains(got, "per-minute token") {
		t.Fatalf("second refusal not reported with its limit: %s", got)
	}
	if calls != 2 {
		t.Fatalf("chat calls = %d, want 2", calls)
	}
}

// A single call bigger than the minute's whole allowance (the real 2026-10-07
// OTPM body) cannot succeed after any wait, even if a wait were quoted.
func TestRequestTooLargeIsNotWaitedOut(t *testing.T) {
	body := `Request too large for model x on output tokens per minute (OTPM): Limit 1000, Requested 1024. Please try again in 0.05s.`
	if _, ok := perMinuteWait(body); ok {
		t.Fatal("a Request too large body qualified for a wait")
	}
}

// The retry is the same round asked again, so a refusal on the last of the six
// tool rounds still gets its one retry.
func TestPerMinuteRetryDoesNotSpendAToolRound(t *testing.T) {
	toolCall := `{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"id":"c","function":{"name":"get_dns","arguments":"{}"}}]}}],"usage":{"total_tokens":1}}`
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		switch {
		case calls <= 5:
			_, _ = w.Write([]byte(toolCall))
		case calls == 6:
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(realITPM))
		default:
			_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"content":"{\"answer\":\"ok\",\"suggestions\":[]}"}}],"usage":{"total_tokens":1}}`))
		}
	}))
	defer srv.Close()

	svc := New(fakeCreds{base: srv.URL}, fakeToolRunner{}, newFakeBudget(func() string { return "2026-10-20" }))
	var trace []map[string]any
	got := svc.runLoop("q", "", &trace)
	if calls != 7 || !strings.Contains(got, `"ok"`) {
		t.Fatalf("calls = %d, answer = %s; want 7 calls ending in the answer", calls, got)
	}
}

// A daily cap is never waited out: waiting minutes inside a request cannot help,
// and the existing message already says asking again will not work.
func TestDailyLimitIsNotRetried(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"on tokens per day (TPD): Limit 100000, Used 99000. Please try again in 0.05s."}}`))
	}))
	defer srv.Close()

	svc := New(fakeCreds{base: srv.URL}, fakeToolRunner{}, newFakeBudget(func() string { return "2026-10-20" }))
	var trace []map[string]any
	_ = svc.runLoop("q", "", &trace)
	if calls != 1 {
		t.Fatalf("chat calls = %d, want 1: a daily cap must not be retried", calls)
	}
}
