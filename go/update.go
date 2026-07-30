package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// appRepo is the GitHub repo the self-updater checks. Mirrors APP_REPO in
// server.py.
const appRepo = "holland-built/bloxsmith"

// githubAPIBase is the host checkUpdate hits for the latest-release lookup.
// A var (not a const) so tests can point it at an httptest.Server instead of
// reaching the real network.
var githubAPIBase = "https://api.github.com"

// maxErrBodySnippet bounds how much of a non-200 response body we quote in an
// error — enough to surface GitHub's rate-limit message, not enough to dump
// an arbitrary body into logs.
const maxErrBodySnippet = 300

// verN maps a "major.minor.patch" / "vMAJOR.MINOR.PATCH" version to a single
// comparable integer for full-semver ranking, or -1 when unparseable.
// v2.0.0 > 1.9.0 > v1.0.595. Wide bases (1e6 per level) so the old
// 1.0.<commit-count> scheme's large patch numbers can't carry into minor.
// (The old port of _ver_n compared only the patch digit, so a 2.0.0 release
// ranked equal to any x.y.0 and self-update could never detect it.)
func verN(v string) int {
	m := regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`).FindStringSubmatch(v)
	if m == nil {
		return -1
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	patch, _ := strconv.Atoi(m[3])
	return major*1_000_000_000_000 + minor*1_000_000 + patch
}

type updateStatus struct {
	Current    string `json:"current"`
	Latest     string `json:"latest"`
	Available  bool   `json:"available"`
	URL        string `json:"url"`
	SelfUpdate bool   `json:"selfUpdate"`
	// Error is set when the check itself failed (network error, non-200
	// response, or a body with no usable tag_name) — distinguishes "could
	// not check" from a genuine "you are on the newest version". Empty on
	// a clean check, whether or not an update is available.
	Error string `json:"error,omitempty"`
}

// checkUpdate hits the GitHub Releases API for the latest tag. Same JSON shape
// as update_status (server.py:123). Really reaches GitHub — no stub.
//
// A non-200 response, a request/decode error, or a body with no parseable
// tag_name is a FAILED check, not "no update available": it returns a
// non-nil error and st.Error is populated so callers (and the UI) can tell
// the two states apart instead of silently reporting up-to-date.
func checkUpdate() (updateStatus, error) {
	st := updateStatus{Current: version, SelfUpdate: true}
	req, _ := http.NewRequest("GET",
		fmt.Sprintf("%s/repos/%s/releases/latest", githubAPIBase, appRepo), nil)
	req.Header.Set("User-Agent", "bloxsmith")
	req.Header.Set("Accept", "application/vnd.github+json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		st.Error = err.Error()
		return st, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// Bound how much of the body we read/quote — enough to surface
		// GitHub's rate-limit message, not enough to log an arbitrary body.
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrBodySnippet+1))
		s := string(snippet)
		if len(s) > maxErrBodySnippet {
			s = s[:maxErrBodySnippet] + "..."
		}
		// The raw body (rate-limit message, GitHub's own error JSON, whatever
		// it is) goes to the server log exactly as before. What reaches the
		// caller — and from there st.Error / the UI — is the plain sentence
		// githubFailureDetail builds instead, never this snippet verbatim.
		log.Printf("checkUpdate: github releases API returned HTTP %d: %s", resp.StatusCode, s)
		err := fmt.Errorf("%s", githubFailureDetail(resp, s))
		st.Error = err.Error()
		return st, err
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		st.Error = err.Error()
		return st, err
	}
	var rel struct {
		Tag     string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.Unmarshal(body, &rel); err != nil {
		st.Error = err.Error()
		return st, err
	}
	latest := verN(rel.Tag)
	if rel.Tag == "" || latest < 0 {
		err := fmt.Errorf("github release response had no usable tag_name (got %q)", rel.Tag)
		st.Error = err.Error()
		return st, err
	}
	st.Latest, st.URL = rel.Tag, rel.HTMLURL
	st.Available = latest > verN(version)
	return st, nil
}

// A NON-2XX FROM GITHUB IS NOT ONE FAILURE.
//
// Live on 2026-07-30: POST /api/update/apply left /api/update/status reading
// {"error":"github releases: HTTP 403", ...} with no way for the operator to
// tell why. The server log had the real reason ("API rate limit exceeded for
// <ip>. ... Authenticated requests get a higher rate limit.") — GitHub's
// UNAUTHENTICATED limit of 60 requests/hour, shared per IP, which clears on
// its own. The update worked on retry once the hour rolled over.
//
// A 403 alone conflates that with an invalid/blocked token and a private or
// invisible repo — three different conditions needing three different
// operator actions, all rendered as the same status code. This follows
// internal/ai.rateLimitDetail's exact discipline: switch on what the response
// actually said (status + the rate-limit headers GitHub sends + the body),
// one plain actionable sentence per condition, and NOTHING invented when the
// reply can't be read.
func githubFailureDetail(resp *http.Response, body string) string {
	status := resp.StatusCode
	// GitHub sends x-ratelimit-remaining: 0 on the exhausted case; a 429 is by
	// definition "too many requests" even absent that header; and the body
	// itself sometimes says "rate limit" in prose (the case this codebase
	// already had a regression test for) when headers are stripped by a proxy.
	rateLimited := status == 429 ||
		resp.Header.Get("X-RateLimit-Remaining") == "0" ||
		strings.Contains(strings.ToLower(body), "rate limit")

	switch {
	case (status == 403 || status == 429) && rateLimited:
		if wait, ok := githubRateLimitWait(resp.Header.Get("X-RateLimit-Reset")); ok {
			return fmt.Sprintf("GitHub's release API returned %d: its rate limit is exhausted. "+
				"This is GitHub's unauthenticated limit of 60 requests/hour, shared per IP, and it "+
				"clears on its own — try again in %s.", status, wait)
		}
		// The reset header was missing or unparseable — say the limit is
		// exhausted and stop there. A guessed wait is a number the operator
		// would plan around, and it would be fabricated.
		return fmt.Sprintf("GitHub's release API returned %d: its rate limit is exhausted, and the "+
			"reply did not say how long until it resets. This is GitHub's unauthenticated limit of "+
			"60 requests/hour, shared per IP — it clears on its own; wait and try again.", status)
	case status == 403:
		return fmt.Sprintf("GitHub's release API returned 403: access was refused. This is not about "+
			"request volume — the repo %s may be private, not visible without authentication, or a "+
			"configured token was rejected.", appRepo)
	case status == 404:
		return fmt.Sprintf("GitHub's release API returned 404: no release could be found for %s — "+
			"check that the repo name is correct and it has a published release.", appRepo)
	case status >= 500:
		return fmt.Sprintf("GitHub's release API had a server error (%d). Try again shortly.", status)
	default:
		return fmt.Sprintf("GitHub's release API returned HTTP %d. The detail is in the server log.", status)
	}
}

// githubRateLimitWait turns GitHub's x-ratelimit-reset header (unix seconds)
// into a plain-language wait, or ok=false when the header is absent or does
// not parse — the only two cases where inventing a wait would be a guess.
func githubRateLimitWait(reset string) (wait string, ok bool) {
	if reset == "" {
		return "", false
	}
	secs, err := strconv.ParseInt(reset, 10, 64)
	if err != nil {
		return "", false
	}
	d := time.Until(time.Unix(secs, 0))
	if d < 0 {
		d = 0
	}
	return humanizeWait(d), true
}

// humanizeWait renders a duration the way an operator reads a wait, not the
// way a computer does — "about 12 minutes", not "11m47.312s".
func humanizeWait(d time.Duration) string {
	mins := int(d.Round(time.Minute) / time.Minute)
	if mins < 1 {
		return "under a minute"
	}
	if mins < 60 {
		return fmt.Sprintf("about %d minute%s", mins, plural(mins, "", "s"))
	}
	hours, rem := mins/60, mins%60
	if rem == 0 {
		return fmt.Sprintf("about %d hour%s", hours, plural(hours, "", "s"))
	}
	return fmt.Sprintf("about %d hour%s %d minute%s", hours, plural(hours, "", "s"), rem, plural(rem, "", "s"))
}
