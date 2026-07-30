package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestCheckUpdate_RateLimitWithReset reproduces the 2026-07-30 live incident:
// GitHub answers 403 with x-ratelimit-remaining: 0 and a reset header. The
// message must name the rate limit AND say when, in plain terms, derived from
// the reset header — not a guess.
func TestCheckUpdate_RateLimitWithReset(t *testing.T) {
	reset := time.Now().Add(12 * time.Minute).Unix()
	withGithubStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset, 10))
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"API rate limit exceeded for 1.2.3.4. (But here's the good news: Authenticated requests get a higher rate limit.)"}`))
	}, "3.13.0")

	st, err := checkUpdate()
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(st.Error, "rate limit") {
		t.Fatalf("Error = %q, want it to name the rate limit", st.Error)
	}
	if !strings.Contains(st.Error, "60 requests/hour") {
		t.Fatalf("Error = %q, want it to name GitHub's unauthenticated 60/hour limit", st.Error)
	}
	if !strings.Contains(st.Error, "minute") {
		t.Fatalf("Error = %q, want a plain-language wait derived from the reset header", st.Error)
	}
	if strings.Contains(st.Error, "API rate limit exceeded for 1.2.3.4") {
		t.Fatalf("Error = %q, must not echo the raw GitHub body into the UI-facing message", st.Error)
	}
}

// TestCheckUpdate_RateLimitNoResetHeader is the "nothing invented" case: rate
// limit evidence is present but the reset header is missing, so the message
// must say the limit is exhausted WITHOUT inventing a wait.
func TestCheckUpdate_RateLimitNoResetHeader(t *testing.T) {
	withGithubStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		// Deliberately no X-RateLimit-Reset header.
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"API rate limit exceeded for 1.2.3.4."}`))
	}, "3.13.0")

	st, err := checkUpdate()
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(st.Error, "rate limit") {
		t.Fatalf("Error = %q, want it to name the rate limit", st.Error)
	}
	if strings.Contains(st.Error, "try again in about") {
		t.Fatalf("Error = %q, must not invent a wait when the reset header is absent", st.Error)
	}
	if !strings.Contains(st.Error, "did not say") {
		t.Fatalf("Error = %q, want it to say the reply did not state how long", st.Error)
	}
}

// TestCheckUpdate_RateLimitUnparseableResetHeader covers a reset header that
// is present but garbage — same "no invented wait" contract as a missing one.
func TestCheckUpdate_RateLimitUnparseableResetHeader(t *testing.T) {
	withGithubStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", "not-a-timestamp")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"rate limit hit"}`))
	}, "3.13.0")

	st, err := checkUpdate()
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if strings.Contains(st.Error, "try again in about") {
		t.Fatalf("Error = %q, must not invent a wait from an unparseable reset header", st.Error)
	}
	if !strings.Contains(st.Error, "rate limit") {
		t.Fatalf("Error = %q, want it to still name the rate limit", st.Error)
	}
}

// TestCheckUpdate_403WithoutRateLimitEvidence covers a plain access-denied
// 403 — no rate-limit headers, no rate-limit wording in the body. This must
// render as a DIFFERENT sentence than the rate-limit case (blocked token /
// private repo), not the rate-limit one.
func TestCheckUpdate_403WithoutRateLimitEvidence(t *testing.T) {
	withGithubStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"Bad credentials"}`))
	}, "3.13.0")

	st, err := checkUpdate()
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if strings.Contains(st.Error, "rate limit") {
		t.Fatalf("Error = %q, must not say rate limit when there is no evidence of one", st.Error)
	}
	if !strings.Contains(st.Error, "403") {
		t.Fatalf("Error = %q, want it to mention the HTTP status", st.Error)
	}
	if !strings.Contains(st.Error, appRepo) {
		t.Fatalf("Error = %q, want it to name the configured repo %q", st.Error, appRepo)
	}
}

// TestCheckUpdate_404NamesRepo covers a not-found release/repo.
func TestCheckUpdate_404NamesRepo(t *testing.T) {
	withGithubStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"Not Found"}`))
	}, "3.13.0")

	st, err := checkUpdate()
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(st.Error, "404") {
		t.Fatalf("Error = %q, want it to mention 404", st.Error)
	}
	if !strings.Contains(st.Error, appRepo) {
		t.Fatalf("Error = %q, want it to name the configured repo %q", st.Error, appRepo)
	}
}

// TestCheckUpdate_500IsServerErrorSentence covers a GitHub-side failure.
func TestCheckUpdate_500IsServerErrorSentence(t *testing.T) {
	withGithubStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`Internal Server Error`))
	}, "3.13.0")

	st, err := checkUpdate()
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(st.Error, "server error") {
		t.Fatalf("Error = %q, want a server-error sentence", st.Error)
	}
	if strings.Contains(st.Error, "Internal Server Error") {
		t.Fatalf("Error = %q, must not echo the raw body", st.Error)
	}
}

// TestLatestRelease_RateLimitWithReset covers apply.go's latestRelease — the
// function POST /api/update/apply -> applyLatest actually calls, and the
// exact path the live 403 incident went through on its way into
// GET /api/update/status's "error" field.
func TestLatestRelease_RateLimitWithReset(t *testing.T) {
	reset := time.Now().Add(90 * time.Second).Unix()
	withGithubStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset, 10))
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"API rate limit exceeded for 5.6.7.8."}`))
	}, "3.13.0")

	_, err := latestRelease()
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(err.Error(), "rate limit") {
		t.Fatalf("err = %q, want it to name the rate limit", err.Error())
	}
	if !strings.Contains(err.Error(), "minute") {
		t.Fatalf("err = %q, want a plain-language wait", err.Error())
	}
	if strings.Contains(err.Error(), "5.6.7.8") {
		t.Fatalf("err = %q, must not echo the raw GitHub body", err.Error())
	}
}

// TestLatestRelease_404NamesRepo pins that apply.go's call site got the same
// fix as update.go's, not just a parallel one that happens to look similar.
func TestLatestRelease_404NamesRepo(t *testing.T) {
	withGithubStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"Not Found"}`))
	}, "3.13.0")

	_, err := latestRelease()
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(err.Error(), "404") || !strings.Contains(err.Error(), appRepo) {
		t.Fatalf("err = %q, want 404 and repo %q named", err.Error(), appRepo)
	}
}

// TestGithubFailureDetail_UnknownStatusPointsAtLog covers the catch-all case:
// a status this switch doesn't otherwise recognize (e.g. 401) states the
// status and says the detail is in the server log, inventing nothing.
func TestGithubFailureDetail_UnknownStatusPointsAtLog(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"Bad credentials"}`))
	}))
	defer srv.Close()

	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("test setup: %v", err)
	}
	defer resp.Body.Close()

	msg := githubFailureDetail(resp, `{"message":"Bad credentials"}`)
	if !strings.Contains(msg, "401") {
		t.Fatalf("msg = %q, want it to mention 401", msg)
	}
	if !strings.Contains(msg, "server log") {
		t.Fatalf("msg = %q, want it to point at the server log", msg)
	}
	if strings.Contains(msg, "Bad credentials") {
		t.Fatalf("msg = %q, must not echo the raw body", msg)
	}
}
