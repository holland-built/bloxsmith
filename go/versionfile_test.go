package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// NO TEST IN THIS PACKAGE MAY REACH THE REAL github.com.
//
// fetchUpdate now tries the static version file BEFORE the GitHub API, and the
// static path has its own base URL (githubDownloadBase) separate from the API
// seam (githubAPIBase) the older tests stub. Without this, every pre-existing
// test in the package would quietly start making a live request to github.com
// on its way to the stubbed API. Port 1 is never listening, so the probe fails
// instantly and those tests exercise the API-fallback path — which is exactly
// the behaviour they were written to pin.
//
// Tests that want the static path stub it explicitly via withUpdateStubs.
func init() {
	githubDownloadBase = "http://127.0.0.1:1"
}

// withUpdateStubs points BOTH update paths at local httptest servers for the
// duration of one test and restores them (and version) afterwards. Deliberately
// self-contained rather than reusing update_test.go's helper: the static-file
// change and the caching change landed side by side, and neither should be able
// to break the other's tests by editing a shared fixture.
//
// staticH serves https://github.com/<repo>/releases/latest/download/version.json;
// apiH serves https://api.github.com/repos/<repo>/releases/latest.
func withUpdateStubs(t *testing.T, staticH, apiH http.HandlerFunc, testVersion string) {
	t.Helper()
	staticSrv := httptest.NewServer(staticH)
	apiSrv := httptest.NewServer(apiH)
	t.Cleanup(staticSrv.Close)
	t.Cleanup(apiSrv.Close)

	origDownload, origAPI, origVersion := githubDownloadBase, githubAPIBase, version
	githubDownloadBase, githubAPIBase, version = staticSrv.URL, apiSrv.URL, testVersion
	t.Cleanup(func() {
		githubDownloadBase, githubAPIBase, version = origDownload, origAPI, origVersion
	})
}

// countingAPI returns a handler that serves body with the given status and
// records how many times the rate-limited GitHub API was actually hit.
func countingAPI(hits *atomic.Int32, status int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}
}

// serveVersionFile serves the static asset ONLY at the exact path goreleaser
// publishes it to, and 404s anything else — so a test cannot pass by accident
// against a URL the real release would not answer.
func serveVersionFile(body string) http.HandlerFunc {
	want := "/" + appRepo + "/releases/latest/download/" + versionFileAsset
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != want {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(body))
	}
}

// TestFetchUpdate_PrefersStaticVersionFile is the whole point of the feature:
// when the free file is there, the rate-limited API must not be touched at all.
func TestFetchUpdate_PrefersStaticVersionFile(t *testing.T) {
	var apiHits atomic.Int32
	withUpdateStubs(t,
		serveVersionFile(`{"tag":"v3.14.0"}`),
		countingAPI(&apiHits, http.StatusOK, `{"tag_name":"v9.9.9","html_url":"https://example.com/api"}`),
		"3.13.0")

	st, err := fetchUpdate()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := apiHits.Load(); got != 0 {
		t.Fatalf("GitHub API was called %d time(s); the static file was available so it must be 0 — "+
			"that is the entire rate-limit saving", got)
	}
	if st.Latest != "v3.14.0" {
		t.Fatalf("Latest = %q, want v3.14.0 (the tag from the static file, not the API's v9.9.9)", st.Latest)
	}
	if !st.Available {
		t.Fatal("Available = false, want true (3.14.0 > 3.13.0)")
	}
	if st.Error != "" {
		t.Fatalf("Error = %q, want empty on a clean static read", st.Error)
	}
}

// TestFetchUpdate_MissingStaticFileFallsBackToAPI covers every release
// published before version.json existed: the asset 404s and the check must
// still produce a real answer from the API.
func TestFetchUpdate_MissingStaticFileFallsBackToAPI(t *testing.T) {
	var apiHits atomic.Int32
	withUpdateStubs(t,
		func(w http.ResponseWriter, r *http.Request) { http.Error(w, "Not Found", http.StatusNotFound) },
		countingAPI(&apiHits, http.StatusOK, `{"tag_name":"v3.14.0","html_url":"https://example.com/api"}`),
		"3.13.0")

	st, err := fetchUpdate()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := apiHits.Load(); got != 1 {
		t.Fatalf("GitHub API hits = %d, want 1 — a missing static file must fall back, not give up", got)
	}
	if st.Latest != "v3.14.0" || !st.Available {
		t.Fatalf("Latest = %q Available = %v, want v3.14.0 / true from the API fallback", st.Latest, st.Available)
	}
	if st.Error != "" {
		t.Fatalf("Error = %q, want empty — the static file being absent is not a failed check", st.Error)
	}
}

// TestFetchUpdate_MissingStaticFileIsNeverReportedAsNoUpdate is the honesty
// pin. A read that FAILED and a read that found nothing must not look the same.
// Static 404 plus a failing API is a failed check — never a silent "you are on
// the newest version", which is what a 404-means-up-to-date shortcut produces.
func TestFetchUpdate_MissingStaticFileIsNeverReportedAsNoUpdate(t *testing.T) {
	var apiHits atomic.Int32
	withUpdateStubs(t,
		func(w http.ResponseWriter, r *http.Request) { http.Error(w, "Not Found", http.StatusNotFound) },
		countingAPI(&apiHits, http.StatusForbidden, `{"message":"API rate limit exceeded for 1.2.3.4."}`),
		"3.13.0")

	st, err := fetchUpdate()
	if err == nil {
		t.Fatal("err = nil: static file missing AND the API failed, yet the check reported success")
	}
	if st.Error == "" {
		t.Fatal("Error is empty on a failed check — a caller cannot tell this from a genuine up-to-date result")
	}
	if st.Latest != "" {
		t.Fatalf("Latest = %q, want empty: nothing was successfully looked up", st.Latest)
	}
	if st.Available {
		t.Fatal("Available = true on a failed check, want false")
	}
	if got := apiHits.Load(); got != 1 {
		t.Fatalf("GitHub API hits = %d, want 1 — the fallback must still be attempted", got)
	}
}

// TestFetchUpdate_UnsignedFileCannotSteerTheReleaseLink pins the scope limit in
// versionfile.go's header comment. The file is unsigned, so the only thing it
// is allowed to supply is a tag; a url smuggled into it must be ignored and the
// link derived from the hardcoded repo instead. The UI opens st.URL in a new
// tab, so this is the difference between a link to GitHub and a link to
// wherever a forged copy of the file says.
func TestFetchUpdate_UnsignedFileCannotSteerTheReleaseLink(t *testing.T) {
	var apiHits atomic.Int32
	withUpdateStubs(t,
		serveVersionFile(`{"tag":"v3.14.0","url":"https://evil.example/pwn"}`),
		countingAPI(&apiHits, http.StatusOK, `{"tag_name":"v3.14.0"}`),
		"3.13.0")

	st, err := fetchUpdate()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(st.URL, "evil.example") {
		t.Fatalf("URL = %q — the unsigned version file was allowed to choose the link the operator clicks", st.URL)
	}
	if !strings.HasSuffix(st.URL, "/"+appRepo+"/releases/tag/v3.14.0") {
		t.Fatalf("URL = %q, want the derived release page for %s@v3.14.0", st.URL, appRepo)
	}
}

// TestStaticVersion_ParsesWhatGoreleaserPublishes pins the parser against the
// exact bytes go/.goreleaser.yaml's before-hook writes. Verified by running a
// real `goreleaser release` against a local fake GitHub: the uploaded asset was
// `{"tag":"v9.9.9"}` plus a newline. If the hook's printf and this struct ever
// drift apart, every install silently falls back to the rate-limited API and
// nothing else would notice.
func TestStaticVersion_ParsesWhatGoreleaserPublishes(t *testing.T) {
	withUpdateStubs(t,
		serveVersionFile("{\"tag\":\"v9.9.9\"}\n"),
		countingAPI(new(atomic.Int32), http.StatusOK, `{}`),
		"1.0.0")

	tag, err := staticVersion()
	if err != nil {
		t.Fatalf("could not parse the bytes goreleaser publishes: %v", err)
	}
	if tag != "v9.9.9" {
		t.Fatalf("tag = %q, want v9.9.9", tag)
	}
}

// TestStaticVersion_RejectsUnusableBodies covers what a proxy, a captive portal
// or a stale CDN can put in front of this URL. Each must be an ERROR so the
// caller falls back — never a tag, and never a quiet empty success.
func TestStaticVersion_RejectsUnusableBodies(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"html interstitial served with 200", "<!DOCTYPE html><title>Sign in</title>"},
		{"empty body", ""},
		{"valid json, no tag field", `{"version":"3.14.0"}`},
		{"tag present but unrankable", `{"tag":"latest"}`},
		{"oversized body", `{"tag":"v3.14.0","pad":"` + strings.Repeat("x", maxVersionFileBytes) + `"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withUpdateStubs(t, serveVersionFile(tc.body),
				countingAPI(new(atomic.Int32), http.StatusOK, `{}`), "3.13.0")
			tag, err := staticVersion()
			if err == nil {
				t.Fatalf("err = nil for %s, want an error so the caller falls back", tc.name)
			}
			if tag != "" {
				t.Fatalf("tag = %q alongside a failure, want empty", tag)
			}
		})
	}
}
