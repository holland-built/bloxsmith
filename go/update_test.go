package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// withGithubStub points checkUpdate at a local httptest.Server for the
// duration of the test instead of reaching the real network, and restores
// githubAPIBase + version afterwards.
//
// It also empties the update-check cache before and after the test and pins
// the TTL jitter to zero: the cache is package-level state, so without this
// every test after the first would read the previous test's remembered answer
// and its own stub would never be hit.
func withGithubStub(t *testing.T, handler http.HandlerFunc, testVersion string) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	origBase, origVersion := githubAPIBase, version
	origNow, origJitter := nowFn, updateCheckJitter
	githubAPIBase = srv.URL
	version = testVersion
	updateCheckJitter = func() time.Duration { return 0 }
	resetUpdateCache()
	t.Cleanup(func() {
		githubAPIBase = origBase
		version = origVersion
		nowFn, updateCheckJitter = origNow, origJitter
		resetUpdateCache()
	})
}

func TestCheckUpdate_NewerTagAvailable(t *testing.T) {
	withGithubStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"tag_name":"v3.14.0","html_url":"https://example.com/v3.14.0"}`))
	}, "3.13.0")

	st, err := checkUpdate()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if st.Error != "" {
		t.Fatalf("Error = %q, want empty", st.Error)
	}
	if !st.Available {
		t.Fatal("Available = false, want true (newer tag on GitHub)")
	}
	if st.Latest != "v3.14.0" {
		t.Fatalf("Latest = %q, want v3.14.0", st.Latest)
	}
}

// TestCheckUpdate_SameTagIsGenuinelyUpToDate pins the clean case: when the
// latest tag matches the running version, Available must be false AND Error
// must stay empty — this must not regress into the failure state.
func TestCheckUpdate_SameTagIsGenuinelyUpToDate(t *testing.T) {
	withGithubStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"tag_name":"v3.13.0","html_url":"https://example.com/v3.13.0"}`))
	}, "3.13.0")

	st, err := checkUpdate()
	if err != nil {
		t.Fatalf("unexpected error on a genuine up-to-date check: %v", err)
	}
	if st.Available {
		t.Fatal("Available = true, want false (same tag as running version)")
	}
	if st.Error != "" {
		t.Fatalf("Error = %q, want empty for a genuine up-to-date result", st.Error)
	}
}

// TestCheckUpdate_RateLimitedIsAnErrorNotUpToDate reproduces the live-observed
// bug: GitHub answers 403 (rate limit) and the old code silently decoded that
// into available:false with no error. It must now surface as a failed check.
func TestCheckUpdate_RateLimitedIsAnErrorNotUpToDate(t *testing.T) {
	withGithubStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"API rate limit exceeded for 1.2.3.4."}`))
	}, "3.13.0")

	st, err := checkUpdate()
	if err == nil {
		t.Fatal("expected an error for a 403 rate-limit response, got nil")
	}
	if st.Available {
		t.Fatal("Available = true on a failed check, want false")
	}
	if st.Error == "" {
		t.Fatal("Error is empty on a failed check, want it populated so callers can tell this apart from up-to-date")
	}
	if !strings.Contains(st.Error, "403") {
		t.Fatalf("Error = %q, want it to mention the HTTP status", st.Error)
	}
	if !strings.Contains(st.Error, "rate limit") {
		t.Fatalf("Error = %q, want it to surface GitHub's rate-limit message", st.Error)
	}
}

// TestCheckUpdate_MissingTagNameIsAnError covers a 200 response whose body
// has no usable tag_name (e.g. an unexpected shape) — this must not be
// treated as "no update available" just because verN("") is a low number.
func TestCheckUpdate_MissingTagNameIsAnError(t *testing.T) {
	withGithubStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"message":"Not Found"}`))
	}, "3.13.0")

	st, err := checkUpdate()
	if err == nil {
		t.Fatal("expected an error for a 200 body with no tag_name, got nil")
	}
	if st.Available {
		t.Fatal("Available = true on a missing tag_name, want false")
	}
	if st.Error == "" {
		t.Fatal("Error is empty on a missing tag_name, want it populated")
	}
}
