package ai

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// This file tests the token-budget feature end to end at the ai.Service
// boundary: HandleQuery must accumulate every chat() call's tokens into ONE
// persisted count per query, never show a stale day's count as today's, and
// never say a limit exists until a 429 body has actually stated one. Those
// are the honesty rules the whole feature exists to enforce — see the Budget
// doc comment in ai.go.

// fakeCreds always returns a non-empty key (so runLoop never short-circuits
// on the "no key configured" path) pointed at a test HTTP server.
type fakeCreds struct{ base string }

func (f fakeCreds) LLM() (key, base, model string) { return "test-key", f.base, "test-model" }

// fakeToolRunner stands in for the dashboard's real tool dispatch; the tests
// here care about token accounting, not tool results.
type fakeToolRunner struct{}

func (fakeToolRunner) RunAITool(ctx context.Context, name string, args map[string]any) string {
	return `{"summary":"ok"}`
}

// fakeBudget is an in-memory Budget whose "today" is caller-controlled via a
// closure, so day-rollover can be tested deterministically instead of
// waiting on the real UTC clock. Its rollover/limit semantics mirror
// internal/store's real implementation closely enough to be a faithful
// stand-in without importing that package.
type fakeBudget struct {
	today    func() string
	day      string
	tokens   int
	limit    *int
	addCalls int
}

func newFakeBudget(today func() string) *fakeBudget { return &fakeBudget{today: today} }

func (f *fakeBudget) AddTokens(n int) (int, string) {
	f.addCalls++
	d := f.today()
	if f.day != d {
		f.day = d
		f.tokens = 0
	}
	f.tokens += n
	return f.tokens, f.day
}

func (f *fakeBudget) RecordLimit(limit int) {
	l := limit
	f.limit = &l
}

func (f *fakeBudget) Status() (tokensToday int, day string, limitTokens int, hasLimit bool) {
	d := f.today()
	tokens := f.tokens
	if f.day != d {
		tokens = 0 // a stale day's count must never be reported as today's
	}
	if f.limit != nil {
		return tokens, d, *f.limit, true
	}
	return tokens, d, 0, false
}

// singleTurnChatServer always answers with one finish_reason:"stop" choice
// (no tool call) carrying the given usage.total_tokens.
func singleTurnChatServer(t *testing.T, tokens int) *httptest.Server {
	t.Helper()
	body := fmt.Sprintf(`{"choices":[{"finish_reason":"stop","message":{"content":"{\"answer\":\"ok\",\"suggestions\":[]}"}}],"usage":{"total_tokens":%d}}`, tokens)
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
}

// TestBudgetAccumulatesAcrossToolLoop is the case runLoop exists to handle:
// one question can drive several chat() calls (a tool call, then the answer
// that follows it), and every one of them spends real tokens. They must be
// summed and persisted ONCE for the query, not once per chat() call — the
// latter would make a single question look like several days'-worth of
// separate budget entries.
func TestBudgetAccumulatesAcrossToolLoop(t *testing.T) {
	responses := []string{
		`{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"id":"call_1","function":{"name":"get_hosts","arguments":"{}"}}]}}],"usage":{"total_tokens":500}}`,
		`{"choices":[{"finish_reason":"stop","message":{"content":"{\"answer\":\"done\",\"suggestions\":[]}"}}],"usage":{"total_tokens":300}}`,
	}
	i := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if i >= len(responses) {
			t.Fatalf("unexpected extra chat call #%d", i+1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(responses[i]))
		i++
	}))
	defer srv.Close()

	fb := newFakeBudget(func() string { return "2026-07-30" })
	svc := New(fakeCreds{base: srv.URL}, fakeToolRunner{}, fb)

	out := svc.HandleQuery("how many hosts are offline?", "")

	b, ok := out["budget"].(map[string]any)
	if !ok {
		t.Fatalf("HandleQuery result has no budget map: %#v", out)
	}
	if b["tokens_today"] != 800 {
		t.Fatalf("tokens_today = %v, want 500+300=800 summed across both chat() calls", b["tokens_today"])
	}
	if fb.addCalls != 1 {
		t.Fatalf("AddTokens called %d times, want exactly 1 (one persisted add per query)", fb.addCalls)
	}
	if b["counted_by"] != "this server only" {
		t.Fatalf("counted_by = %v, want an explicit this-server-only disclaimer", b["counted_by"])
	}
}

// TestBudgetDayRolloverResetsCount: a query answered just after UTC midnight
// must start today's count from zero, not carry yesterday's total forward —
// otherwise a server left running across midnight would report an
// impossible number and could trigger a false near-limit warning on a
// budget that actually just reset.
func TestBudgetDayRolloverResetsCount(t *testing.T) {
	srv := singleTurnChatServer(t, 100)
	defer srv.Close()

	day := "2026-07-30"
	fb := newFakeBudget(func() string { return day })
	svc := New(fakeCreds{base: srv.URL}, fakeToolRunner{}, fb)

	out := svc.HandleQuery("q1", "")
	b := out["budget"].(map[string]any)
	if b["day"] != "2026-07-30" || b["tokens_today"] != 100 {
		t.Fatalf("day 1 budget = %#v, want day 2026-07-30 tokens_today 100", b)
	}

	day = "2026-07-31" // simulate the UTC calendar day turning over
	out = svc.HandleQuery("q2", "")
	b = out["budget"].(map[string]any)
	if b["day"] != "2026-07-31" {
		t.Fatalf("day did not roll over: %#v", b)
	}
	if b["tokens_today"] != 100 {
		t.Fatalf("tokens_today = %v, want 100 (this call only) — yesterday's count leaked into today", b["tokens_today"])
	}
}

// TestBudgetNoLimitFieldWhenNoneSeen: rule 1 — a limit is reported ONLY once
// a 429 body has actually stated one. Before that ever happens, the field
// must be ABSENT, not present-and-zero (zero would read as "the cap is
// zero", which is false and would make near_limit meaningless).
func TestBudgetNoLimitFieldWhenNoneSeen(t *testing.T) {
	fb := newFakeBudget(func() string { return "2026-07-30" })
	svc := New(fakeCreds{}, fakeToolRunner{}, fb)

	out := svc.budgetField()
	if _, ok := out["limit_tokens"]; ok {
		t.Fatalf("limit_tokens present with no 429 ever seen: %#v", out)
	}
	if _, ok := out["near_limit"]; ok {
		t.Fatalf("near_limit present with no limit known: %#v", out)
	}
	if out["tokens_today"] != 0 {
		t.Fatalf("tokens_today = %v, want 0 on a fresh budget", out["tokens_today"])
	}
}

// TestBudgetLimitAppearsOnlyAfterRateLimitBodyRevealsIt exercises the real
// wiring: runLoop must call Budget.RecordLimit with the number pulled out of
// an actual 429 body (never a guess), and it must NOT appear on any query
// answered before that 429 happened.
func TestBudgetLimitAppearsOnlyAfterRateLimitBodyRevealsIt(t *testing.T) {
	fb := newFakeBudget(func() string { return "2026-07-30" })

	okSrv := singleTurnChatServer(t, 10)
	defer okSrv.Close()
	out := New(fakeCreds{base: okSrv.URL}, fakeToolRunner{}, fb).HandleQuery("q1", "")
	b := out["budget"].(map[string]any)
	if _, ok := b["limit_tokens"]; ok {
		t.Fatalf("limit_tokens present before any 429: %#v", b)
	}

	// A verbatim-shaped capture of Groq's real TPD body (see ratelimit_test.go).
	body := `{"error":{"message":"Rate limit reached for model x in organization org_x ` +
		`service tier on_demand on tokens per day (TPD): Limit 100000, Used 98902, ` +
		`Requested 1779. Please try again in 9m48.384s."}}`
	rlSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(body))
	}))
	defer rlSrv.Close()

	out = New(fakeCreds{base: rlSrv.URL}, fakeToolRunner{}, fb).HandleQuery("q2", "")
	b = out["budget"].(map[string]any)
	lt, ok := b["limit_tokens"]
	if !ok {
		t.Fatalf("limit_tokens still absent after a 429 body stated one: %#v", b)
	}
	if lt != 100000 {
		t.Fatalf("limit_tokens = %v, want the 100000 read from the 429 body", lt)
	}
}

// TestBudgetNearLimitThresholdAtEightyPercent: near_limit is a >=80% cutoff
// against a KNOWN limit only — this pins the boundary exactly, both sides.
func TestBudgetNearLimitThresholdAtEightyPercent(t *testing.T) {
	fb := newFakeBudget(func() string { return "2026-07-30" })
	l := 100000
	fb.day, fb.limit = "2026-07-30", &l
	svc := New(fakeCreds{}, fakeToolRunner{}, fb)

	fb.tokens = 79999
	if v, _ := svc.budgetField()["near_limit"].(bool); v {
		t.Fatalf("79999/100000 must not be near_limit (below 80%%)")
	}

	fb.tokens = 80000
	if v, _ := svc.budgetField()["near_limit"].(bool); !v {
		t.Fatalf("80000/100000 (exactly 80%%) must be near_limit")
	}
}

// TestDailyTokenLimitParsesGroqBody: the extractor rateLimitDetail's kind
// switch and this function both rely on (isDailyTokenLimit) must actually
// pull the numeric cap, not just recognize the phrasing.
func TestDailyTokenLimitParsesGroqBody(t *testing.T) {
	msg := `chat/completions: http 429: {"error":{"message":"... on tokens per day (TPD): ` +
		`Limit 100000, Used 98902, Requested 1779. Please try again in 9m48.384s. ..."}}`
	got, ok := dailyTokenLimit(msg)
	if !ok || got != 100000 {
		t.Fatalf("dailyTokenLimit(%q) = (%d, %v), want (100000, true)", msg, got, ok)
	}
}

// TestDailyTokenLimitAbsentWhenNotDailyOrUnparseable: never invent a daily
// cap out of a per-minute limit, a bare 429, or an unrelated failure.
func TestDailyTokenLimitAbsentWhenNotDailyOrUnparseable(t *testing.T) {
	for _, body := range []string{
		`chat/completions: http 429: on tokens per minute (TPM): Limit 6000, Used 5900.`,
		`chat/completions: http 429: Too Many Requests`,
		`chat/completions: http 500: internal error`,
	} {
		if limit, ok := dailyTokenLimit(body); ok {
			t.Fatalf("body %q yielded an invented daily limit %d", body, limit)
		}
	}
}
