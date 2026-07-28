package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
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
		err := fmt.Errorf("github releases API returned HTTP %d: %s", resp.StatusCode, s)
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
