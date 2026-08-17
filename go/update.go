package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
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
	// Cached says whether this answer came from the in-process memory of an
	// earlier check instead of a live call to GitHub. Always emitted (never
	// omitempty) so a remembered answer can never be read as a fresh one.
	Cached bool `json:"cached"`
	// CheckedAt is when GitHub was actually contacted to produce THIS answer,
	// success or failure, as RFC3339 UTC. Empty only when no contact happened
	// (the check is disabled) — never a guessed or defaulted time.
	CheckedAt string `json:"checkedAt,omitempty"`
	// CheckDisabled is true when DISABLE_UPDATE_CHECK is set and the server
	// therefore did not contact GitHub at all. When it is true, Latest/URL are
	// empty and Available is false because NOTHING WAS LOOKED UP — that is not
	// the same claim as "you are on the newest version", and a consumer must
	// not render it as one.
	CheckDisabled bool `json:"checkDisabled,omitempty"`
}

// The update-check cache.
//
// WHY: /api/update/check is hit on every dashboard page load (plus a probe
// every 1.5s while a restart is being confirmed), and GitHub's unauthenticated
// limit is 60 requests/hour PER SOURCE IP — one shared bucket for every
// operator behind the same corporate connection. Remembering the last answer
// caps one install at roughly 2 counted requests/hour instead of one per page
// load.
//
// Why not conditional requests (ETag / If-None-Match) as well: measured live
// 2026-08-01 against api.github.com — an UNAUTHENTICATED 304 still decrements
// x-ratelimit-remaining. Conditional requests would save bandwidth, not
// allowance, so they are deliberately not implemented here.
//
// Scope, honestly: in-memory only, per process. A restart costs at most one
// extra request, where a state file would add I/O, corruption handling and a
// new file to back up for nothing. It also does not help a large fleet in the
// hour after a release — each install would still spend one request then. That
// last gap is now closed by the static version file (versionfile.go): a plain
// release-asset download, not an API call, so it is not rate limited at all.
// The cache still earns its keep for releases published before that file
// existed, which fall back to the API.
const (
	updateCheckTTL       = 30 * time.Minute
	updateCheckTTLJitter = 3 * time.Minute
	// Failures are remembered far more briefly than successes: long enough
	// that the 1.5-second restart-confirm probes cannot hammer a failing or
	// rate-limited GitHub, short enough that recovery is quick.
	updateCheckErrTTL = 5 * time.Minute
)

// forcedCheckMinInterval is the floor between two FORCED checks — the only
// thing standing between a mashed "check now" and the 60/hour allowance.
//
// It is seconds, deliberately, and must never be raised toward updateCheckTTL:
// a long floor on the forced path is precisely the bug the force flag exists to
// fix (a deliberate check silently answered from a half-hour-old memory). Five
// seconds is longer than anyone can double-click and short enough that a real
// second look — "did my release land yet?" — is never refused.
const forcedCheckMinInterval = 5 * time.Second

// nowFn is a var so tests can drive the clock instead of sleeping.
var nowFn = time.Now

// updateCheckJitter spreads cache expiry over ±updateCheckTTLJitter so a fleet
// of installs started together (site-wide deploy, morning login rush) behind
// one IP does not re-synchronise its cache misses into a single burst against
// the shared 60/hour bucket. A var so tests can pin it.
var updateCheckJitter = func() time.Duration {
	span := int64(2*updateCheckTTLJitter) + 1
	return time.Duration(rand.Int64N(span)) - updateCheckTTLJitter
}

var updateCache struct {
	mu    sync.Mutex
	valid bool
	// st/err are stored exactly as fetchUpdate returned them — including a
	// failure. A failure REPLACES a remembered success; a stale good answer is
	// never served in place of a live failure.
	st        updateStatus
	err       error
	checkedAt time.Time
	expires   time.Time
	// lastForced is when a FORCED check last actually reached GitHub, and it
	// is the only state forcedCheckMinInterval reads. Separate from checkedAt
	// because the background poll must never consume the click budget, nor be
	// throttled by it.
	lastForced time.Time
}

// resetUpdateCache drops the remembered answer. Tests call it so they stay
// order-independent; nothing in production does.
func resetUpdateCache() {
	updateCache.mu.Lock()
	defer updateCache.mu.Unlock()
	updateCache.valid = false
	updateCache.st = updateStatus{}
	updateCache.err = nil
	updateCache.checkedAt = time.Time{}
	updateCache.expires = time.Time{}
	updateCache.lastForced = time.Time{}
}

// labelFreshness stamps an answer with where it came from and when GitHub was
// really consulted. Current is always re-read from the running binary's
// version so a remembered entry can never report a version this process is not
// actually running (the UI's restart-confirm loop keys off exactly that field).
func labelFreshness(st updateStatus, cached bool, checkedAt time.Time) updateStatus {
	st.Current = version
	st.Cached = cached
	if !checkedAt.IsZero() {
		st.CheckedAt = checkedAt.UTC().Format(time.RFC3339)
	}
	return st
}

// checkUpdateForce returns the latest-release answer, serving the remembered
// one while it is still fresh and otherwise contacting GitHub. See the cache
// comment above for why the cache exists. force=false is the ordinary call;
// there was a no-argument checkUpdate() wrapper for it, but every production
// caller passes a force value and only tests used the wrapper, so it is gone.
//
// The lock is held across the network call on purpose: concurrent page loads
// queue behind one in-flight request and read its result, instead of each
// spending a request out of the shared allowance.
//
// The APPLY path deliberately does NOT come through here — applyLatest calls
// latestRelease (apply.go) directly and always fetches fresh. Downloading and
// installing a binary chosen from a half-hour-old answer is not acceptable;
// one request per apply is.
//
// force=true is the escape hatch for a DELIBERATE user action (the ?force=
// parameter on /api/update/check).
//
// WHY THIS EXISTS: the cache above was written to stop the BACKGROUND poll
// spending the shared 60/hour allowance, and it did — but it also answered the
// operator's explicit "check again" from memory, which was never the intent.
// Observed live 2026-08-07 on v3.55.0: v3.56.0 was published at 12:37 and the
// endpoint still reported v3.55.0 at 12:40, because the answer had been
// remembered at 12:21 and there was no way to ask for a new one. A cache the
// user cannot get past is indistinguishable, from where they are standing,
// from a check that does not work.
//
// force=true skips a still-valid entry and asks GitHub, then STORES the result
// as the new entry — so the request the click paid for also refreshes what the
// next background poll reads, instead of it flipping straight back to the
// stale answer.
//
// The floor (forcedCheckMinInterval) is what stops that hatch becoming a hole:
// a click inside the floor is answered from the cache exactly as before, and
// says cached:true, because it is. Note what is NOT throttled — a forced check
// arriving when the entry has already expired is just an ordinary miss and
// fetches regardless; the floor only governs the bypass.
func checkUpdateForce(force bool) (updateStatus, error) {
	updateCache.mu.Lock()
	defer updateCache.mu.Unlock()

	now := nowFn()
	if updateCache.valid && now.Before(updateCache.expires) {
		bypass := force && now.Sub(updateCache.lastForced) >= forcedCheckMinInterval
		if !bypass {
			return labelFreshness(updateCache.st, true, updateCache.checkedAt), updateCache.err
		}
	}

	st, err := fetchUpdate()
	ttl := updateCheckTTL + updateCheckJitter()
	if err != nil {
		ttl = updateCheckErrTTL
	}
	updateCache.valid = true
	updateCache.st, updateCache.err = st, err
	updateCache.checkedAt, updateCache.expires = now, now.Add(ttl)
	if force {
		updateCache.lastForced = now
	}
	return labelFreshness(st, false, now), err
}

// fetchUpdate hits the GitHub Releases API for the latest tag. Same JSON shape
// as update_status (server.py:123). Really reaches GitHub — no stub, and no
// cache: checkUpdate above is the caching wrapper.
//
// A non-200 response, a request/decode error, or a body with no parseable
// tag_name is a FAILED check, not "no update available": it returns a
// non-nil error and st.Error is populated so callers (and the UI) can tell
// the two states apart instead of silently reporting up-to-date.
func fetchUpdate() (updateStatus, error) {
	st := updateStatus{Current: version, SelfUpdate: true}

	// --- static version file first (versionfile.go) -------------------------
	// A release-asset download is not a REST API call and costs NOTHING against
	// GitHub's 60-requests/hour unauthenticated limit, so this is the cheap path
	// and it is tried before the API. It only reports that a tag EXISTS; the
	// file is unsigned and is NOT a trust anchor — installing that version still
	// goes through apply.go's fresh API lookup, checksums and signature
	// verification, unchanged.
	//
	// A failure here is NOT an answer. Every release published before this
	// feature has no version.json and answers 404, and "the file was missing"
	// must never surface as "you are up to date" — so nothing is returned, the
	// reason is logged, and the GitHub API below decides the result (including
	// reporting its own failure through the usual githubFailureDetail path).
	if tag, staticErr := staticVersion(); staticErr != nil {
		log.Printf("fetchUpdate: static version file unusable (%v) — falling back to the GitHub releases API", staticErr)
	} else {
		st.Latest, st.URL = tag, releasePageURL(tag)
		st.Available = verN(tag) > verN(version)
		return st, nil
	}
	// --- end static version file --------------------------------------------

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
		log.Printf("fetchUpdate: github releases API returned HTTP %d: %s", resp.StatusCode, s)
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
