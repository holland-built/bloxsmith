package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"bloxsmith/internal/config"
)

// These tests pin the update-check cache (update.go) and the
// DISABLE_UPDATE_CHECK off-switch (main.go). Every one of them talks to a
// local httptest.Server — nothing here contacts api.github.com, which would
// spend the very 60-requests/hour allowance this cache exists to protect.

// countingStub serves a fixed sequence of responses and counts how many
// requests actually reached "GitHub". The count IS the thing under test: the
// cache's whole purpose is to make that number smaller.
func countingStub(hits *atomic.Int32, respond http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		respond(w, r)
	}
}

func okRelease(tag string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"tag_name":"` + tag + `","html_url":"https://example.com/` + tag + `"}`))
	}
}

// fakeClock drives nowFn so TTL expiry is tested without sleeping.
func fakeClock(t *testing.T, start time.Time) func(time.Duration) {
	t.Helper()
	cur := start
	nowFn = func() time.Time { return cur }
	return func(d time.Duration) { cur = cur.Add(d) }
}

// TestCheckUpdate_TwoChecksInsideWindowCostOneRequest is the rate-limit test:
// two page loads inside the 30-minute window must reach GitHub once, not twice.
func TestCheckUpdate_TwoChecksInsideWindowCostOneRequest(t *testing.T) {
	var hits atomic.Int32
	withGithubStub(t, countingStub(&hits, okRelease("v3.14.0")), "3.13.0")
	advance := fakeClock(t, time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC))

	first, err := checkUpdate()
	if err != nil {
		t.Fatalf("first check: unexpected error: %v", err)
	}
	advance(29 * time.Minute)
	second, err := checkUpdate()
	if err != nil {
		t.Fatalf("second check: unexpected error: %v", err)
	}

	if got := hits.Load(); got != 1 {
		t.Fatalf("github requests = %d, want 1 — the second check inside the window must be served from memory", got)
	}
	if first.Latest != second.Latest || second.Latest != "v3.14.0" {
		t.Fatalf("cached answer = %q, want the same v3.14.0 the first check got", second.Latest)
	}
	if second.Available != first.Available {
		t.Fatalf("cached Available = %v, want %v", second.Available, first.Available)
	}
}

// TestCheckUpdate_CachedAnswerSaysItIsCached: a remembered answer must never
// be dressed up as a fresh one. The caller has to be able to tell, and to see
// when GitHub was really consulted.
func TestCheckUpdate_CachedAnswerSaysItIsCached(t *testing.T) {
	var hits atomic.Int32
	withGithubStub(t, countingStub(&hits, okRelease("v3.14.0")), "3.13.0")
	start := time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC)
	advance := fakeClock(t, start)

	first, _ := checkUpdate()
	if first.Cached {
		t.Fatal("first check reported Cached = true, want false — it really did contact GitHub")
	}
	if first.CheckedAt != start.Format(time.RFC3339) {
		t.Fatalf("fresh CheckedAt = %q, want %q", first.CheckedAt, start.Format(time.RFC3339))
	}

	advance(10 * time.Minute)
	second, _ := checkUpdate()
	if !second.Cached {
		t.Fatal("cached check reported Cached = false — a remembered answer must not present itself as fresh")
	}
	if second.CheckedAt != first.CheckedAt {
		t.Fatalf("cached CheckedAt = %q, want the original contact time %q (not now)", second.CheckedAt, first.CheckedAt)
	}

	// And it must survive the wire, so the browser can tell too.
	body, err := json.Marshal(second)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(body), `"cached":true`) {
		t.Fatalf("JSON = %s, want it to carry cached:true", body)
	}
	if !strings.Contains(string(body), `"checkedAt":"`) {
		t.Fatalf("JSON = %s, want it to carry checkedAt", body)
	}
}

// TestCheckUpdate_ExpiredCacheRefetches: the cache must expire. Half an hour
// late is the accepted cost; never noticing a new release is not.
func TestCheckUpdate_ExpiredCacheRefetches(t *testing.T) {
	var hits atomic.Int32
	tag := "v3.14.0"
	withGithubStub(t, countingStub(&hits, func(w http.ResponseWriter, r *http.Request) {
		okRelease(tag)(w, r)
	}), "3.13.0")
	advance := fakeClock(t, time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC))

	if _, err := checkUpdate(); err != nil {
		t.Fatalf("first check: %v", err)
	}
	advance(updateCheckTTL + time.Minute)
	tag = "v3.15.0"
	second, err := checkUpdate()
	if err != nil {
		t.Fatalf("second check: %v", err)
	}

	if got := hits.Load(); got != 2 {
		t.Fatalf("github requests = %d, want 2 — the cache must expire after %s", got, updateCheckTTL)
	}
	if second.Cached {
		t.Fatal("refetched answer reported Cached = true, want false")
	}
	if second.Latest != "v3.15.0" {
		t.Fatalf("Latest = %q, want the newly published v3.15.0", second.Latest)
	}
}

// TestCheckUpdate_JitterShiftsExpiry: the ± jitter must actually move the
// expiry, otherwise a fleet restarted together re-synchronises its cache
// misses into one burst against the shared per-IP bucket.
func TestCheckUpdate_JitterShiftsExpiry(t *testing.T) {
	var hits atomic.Int32
	withGithubStub(t, countingStub(&hits, okRelease("v3.14.0")), "3.13.0")
	advance := fakeClock(t, time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC))
	// An exaggerated jitter (well outside the ±3m production range) so the
	// assertion is unambiguous: with jitter applied the entry expires at 20m,
	// without it at 30m.
	updateCheckJitter = func() time.Duration { return -10 * time.Minute }

	if _, err := checkUpdate(); err != nil {
		t.Fatalf("first check: %v", err)
	}
	advance(21 * time.Minute)
	if _, err := checkUpdate(); err != nil {
		t.Fatalf("second check: %v", err)
	}

	if got := hits.Load(); got != 2 {
		t.Fatalf("github requests = %d, want 2 — the entry should have expired at TTL%s, so the jitter is being ignored",
			got, (-10 * time.Minute).String())
	}
}

// TestCheckUpdate_JitterStaysWithinDocumentedBounds pins the real jitter
// function to the ±3 minutes the comment and docs claim — a wider spread would
// silently change how long a stale answer can be served.
func TestCheckUpdate_JitterStaysWithinDocumentedBounds(t *testing.T) {
	for i := 0; i < 500; i++ {
		j := updateCheckJitter()
		if j < -updateCheckTTLJitter || j > updateCheckTTLJitter {
			t.Fatalf("jitter = %s, want within ±%s", j, updateCheckTTLJitter)
		}
	}
}

// TestCheckUpdate_FailureIsNotMaskedByRememberedSuccess is the central rule of
// this repo applied to the cache: "the check failed" must never be served as
// the last "the check succeeded". A stale good answer papering over a live
// failure is exactly the alerting-goes-dark bug class.
func TestCheckUpdate_FailureIsNotMaskedByRememberedSuccess(t *testing.T) {
	var hits atomic.Int32
	fail := false
	withGithubStub(t, countingStub(&hits, func(w http.ResponseWriter, r *http.Request) {
		if fail {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"message":"boom"}`))
			return
		}
		okRelease("v3.14.0")(w, r)
	}), "3.13.0")
	advance := fakeClock(t, time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC))

	good, err := checkUpdate()
	if err != nil || !good.Available {
		t.Fatalf("setup: first check should have found v3.14.0 available (err=%v, st=%+v)", err, good)
	}

	advance(updateCheckTTL + time.Minute)
	fail = true
	st, err := checkUpdate()

	if err == nil {
		t.Fatal("failed check returned nil error — the failure was swallowed")
	}
	if st.Error == "" {
		t.Fatal("failed check returned an empty Error — the UI would render this as 'up to date'")
	}
	if st.Latest != "" || st.Available {
		t.Fatalf("failed check returned Latest=%q Available=%v — the remembered success leaked into a failed check",
			st.Latest, st.Available)
	}
}

// TestCheckUpdate_FailureRememberedBriefly: a failure is cached too (so the
// 1.5s restart-confirm probes can't hammer a rate-limited GitHub), but for
// minutes, not half an hour.
func TestCheckUpdate_FailureRememberedBriefly(t *testing.T) {
	var hits atomic.Int32
	withGithubStub(t, countingStub(&hits, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"message":"boom"}`))
	}), "3.13.0")
	advance := fakeClock(t, time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC))

	if _, err := checkUpdate(); err == nil {
		t.Fatal("setup: expected the first check to fail")
	}
	advance(time.Minute)
	st, err := checkUpdate()
	if err == nil || st.Error == "" {
		t.Fatal("a remembered failure must still be reported as a failure")
	}
	if !st.Cached {
		t.Fatal("remembered failure reported Cached = false — it must say it is remembered")
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("github requests = %d, want 1 — a failure must be remembered briefly", got)
	}

	// ...but it must clear far sooner than a success, so recovery is quick.
	advance(updateCheckErrTTL + time.Minute)
	if _, err := checkUpdate(); err == nil {
		t.Fatal("expected the retried check to fail too")
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("github requests = %d, want 2 — the failure entry must expire after %s", got, updateCheckErrTTL)
	}
}

// TestApplyPath_NeverServedFromCache: the apply path fetches fresh, always.
// Installing a binary chosen from a half-hour-old answer is not acceptable.
func TestApplyPath_NeverServedFromCache(t *testing.T) {
	var hits atomic.Int32
	withGithubStub(t, countingStub(&hits, okRelease("v3.14.0")), "3.13.0")
	fakeClock(t, time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC))

	if _, err := checkUpdate(); err != nil {
		t.Fatalf("check: %v", err)
	}
	if _, err := latestRelease(); err != nil {
		t.Fatalf("latestRelease: %v", err)
	}

	if got := hits.Load(); got != 2 {
		t.Fatalf("github requests = %d, want 2 — the apply path must not reuse the check's cached answer", got)
	}
}

// --- the forced check ------------------------------------------------------
//
// The cache above exists to protect a 60/hour shared allowance from the
// BACKGROUND poll. It was also swallowing the operator's deliberate "check
// now": observed live 2026-08-07 on v3.55.0 — v3.56.0 was published at 12:37
// and /api/update/check still answered v3.55.0 at 12:40 with cached:true,
// because the answer had been remembered at 12:21 and there was no way to ask
// again. These tests pin the escape hatch and its own limiter.

// TestCheckUpdate_ForcedCheckBypassesFreshCache is the regression test: a
// forced check must reach GitHub even when the remembered entry is still well
// inside its 30-minute window, while an unforced one still must not.
func TestCheckUpdate_ForcedCheckBypassesFreshCache(t *testing.T) {
	var hits atomic.Int32
	tag := "v3.55.0"
	withGithubStub(t, countingStub(&hits, func(w http.ResponseWriter, r *http.Request) {
		okRelease(tag)(w, r)
	}), "3.55.0")
	advance := fakeClock(t, time.Date(2026, 8, 7, 12, 21, 47, 0, time.UTC))

	if _, err := checkUpdate(); err != nil {
		t.Fatalf("first check: %v", err)
	}

	// 12:37 — v3.56.0 ships. 12:40 — the operator looks.
	advance(19 * time.Minute)
	tag = "v3.56.0"

	background, err := checkUpdate()
	if err != nil {
		t.Fatalf("background poll: %v", err)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("github requests after the background poll = %d, want 1 — the poll must still be served from memory", got)
	}
	if !background.Cached || background.Latest != "v3.55.0" {
		t.Fatalf("background poll = %+v, want the remembered v3.55.0 with cached:true", background)
	}

	forced, err := checkUpdateForce(true)
	if err != nil {
		t.Fatalf("forced check: %v", err)
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("github requests after the forced check = %d, want 2 — a deliberate check must ask GitHub, not the cache", got)
	}
	if forced.Cached {
		t.Fatal("forced check reported Cached = true — it contacted GitHub, so it must say so")
	}
	if forced.Latest != "v3.56.0" {
		t.Fatalf("forced Latest = %q, want the newly published v3.56.0", forced.Latest)
	}
	if !forced.Available {
		t.Fatal("forced Available = false, want true — 3.56.0 is newer than the running 3.55.0")
	}
	if forced.CheckedAt != nowFn().Format(time.RFC3339) {
		t.Fatalf("forced CheckedAt = %q, want now (%q)", forced.CheckedAt, nowFn().Format(time.RFC3339))
	}
}

// TestCheckUpdate_ForcedResultReplacesTheCacheEntry: the fresh answer a click
// paid for must become what the background poll sees next, otherwise the UI
// flips back to the stale version on its next tick.
func TestCheckUpdate_ForcedResultReplacesTheCacheEntry(t *testing.T) {
	var hits atomic.Int32
	tag := "v3.55.0"
	withGithubStub(t, countingStub(&hits, func(w http.ResponseWriter, r *http.Request) {
		okRelease(tag)(w, r)
	}), "3.55.0")
	advance := fakeClock(t, time.Date(2026, 8, 7, 12, 21, 47, 0, time.UTC))

	if _, err := checkUpdate(); err != nil {
		t.Fatalf("first check: %v", err)
	}
	advance(19 * time.Minute)
	tag = "v3.56.0"
	forced, err := checkUpdateForce(true)
	if err != nil {
		t.Fatalf("forced check: %v", err)
	}

	// The very next background poll reads the forced answer, not the old one,
	// and does not spend a request doing it.
	advance(time.Minute)
	after, err := checkUpdate()
	if err != nil {
		t.Fatalf("poll after force: %v", err)
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("github requests = %d, want 2 — the poll after a force must be served from the refreshed entry", got)
	}
	if !after.Cached {
		t.Fatal("poll after force reported Cached = false — the forced result must have been stored")
	}
	if after.Latest != "v3.56.0" {
		t.Fatalf("poll after force = %q, want the forced v3.56.0 — the stale entry survived", after.Latest)
	}
	if after.CheckedAt != forced.CheckedAt {
		t.Fatalf("poll CheckedAt = %q, want the forced check's contact time %q", after.CheckedAt, forced.CheckedAt)
	}
}

// TestCheckUpdate_ForcedChecksAreRateLimited: the escape hatch must not become
// a hole in the 60/hour allowance. A mashed button is floored at
// forcedCheckMinInterval, and the floor is short — reusing the 30-minute TTL
// here would just recreate the bug this whole section fixes.
func TestCheckUpdate_ForcedChecksAreRateLimited(t *testing.T) {
	var hits atomic.Int32
	withGithubStub(t, countingStub(&hits, okRelease("v3.56.0")), "3.55.0")
	advance := fakeClock(t, time.Date(2026, 8, 7, 12, 40, 0, 0, time.UTC))

	if _, err := checkUpdateForce(true); err != nil {
		t.Fatalf("first forced check: %v", err)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("github requests = %d, want 1", got)
	}

	// Mashing: five more clicks inside the floor buy nothing.
	for i := 0; i < 5; i++ {
		advance(200 * time.Millisecond)
		st, err := checkUpdateForce(true)
		if err != nil {
			t.Fatalf("mashed forced check %d: %v", i, err)
		}
		if !st.Cached {
			t.Fatalf("mashed forced check %d reported Cached = false — a throttled force must admit it served the remembered answer", i)
		}
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("github requests after mashing = %d, want 1 — the forced path is not rate limited", got)
	}

	// ...but the floor is seconds, not the 30-minute TTL: once it passes, a
	// click works again.
	advance(forcedCheckMinInterval)
	if _, err := checkUpdateForce(true); err != nil {
		t.Fatalf("forced check after the floor: %v", err)
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("github requests after the floor = %d, want 2 — the floor must clear after %s", got, forcedCheckMinInterval)
	}
	if forcedCheckMinInterval >= updateCheckTTL {
		t.Fatalf("forcedCheckMinInterval = %s, want far below the %s cache TTL — a long floor is the original bug",
			forcedCheckMinInterval, updateCheckTTL)
	}
}

// TestUpdateCheckHandler_ForceParamReachesGitHub wires the query parameter to
// the behaviour above: without it the handler serves the remembered answer,
// with it the handler asks.
func TestUpdateCheckHandler_ForceParamReachesGitHub(t *testing.T) {
	var hits atomic.Int32
	withGithubStub(t, countingStub(&hits, okRelease("v3.56.0")), "3.55.0")

	call := func(target string) updateStatus {
		t.Helper()
		rec := httptest.NewRecorder()
		updateCheckHandler(&config.Config{})(rec, httptest.NewRequest("GET", target, nil))
		var st updateStatus
		if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
			t.Fatalf("unmarshal %s: %v", rec.Body.Bytes(), err)
		}
		return st
	}

	if st := call("/api/update/check"); st.Cached {
		t.Fatal("setup: the first plain check should have been fresh")
	}
	if st := call("/api/update/check"); !st.Cached {
		t.Fatal("the second plain check was not cached — the background poll must stay cheap")
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("github requests from the two plain checks = %d, want 1", got)
	}

	forced := call("/api/update/check?force=1")
	if forced.Cached {
		t.Fatalf("forced handler response = %+v, want cached:false", forced)
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("github requests after ?force=1 = %d, want 2 — the query parameter is not wired through", got)
	}
	if forced.Latest != "v3.56.0" {
		t.Fatalf("forced Latest = %q, want v3.56.0", forced.Latest)
	}
}

// TestUpdateCheckHandler_DisabledRefusesForcedCheck: DISABLE_UPDATE_CHECK is an
// off-switch, not a default. A force parameter must not talk its way past it.
func TestUpdateCheckHandler_DisabledRefusesForcedCheck(t *testing.T) {
	var hits atomic.Int32
	withGithubStub(t, countingStub(&hits, okRelease("v3.56.0")), "3.55.0")

	rec := httptest.NewRecorder()
	updateCheckHandler(&config.Config{UpdateCheckDisabled: true})(
		rec, httptest.NewRequest("GET", "/api/update/check?force=1", nil))

	if got := hits.Load(); got != 0 {
		t.Fatalf("github requests = %d, want 0 — a forced check must still be refused when the off-switch is on", got)
	}
	var st updateStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("unmarshal %s: %v", rec.Body.Bytes(), err)
	}
	if !st.CheckDisabled {
		t.Fatalf("body = %s, want checkDisabled:true", rec.Body.Bytes())
	}
	if st.Latest != "" || st.Available || st.CheckedAt != "" {
		t.Fatalf("disabled+forced returned %+v — nothing was looked up, so nothing may be claimed", st)
	}
}

// TestUpdateCheckHandler_ForceParamNeedsAnAffirmativeValue: only an explicit
// yes forces. An absent, empty or "0" parameter is the background poll, and
// must not spend a request out of the shared allowance.
func TestUpdateCheckHandler_ForceParamNeedsAnAffirmativeValue(t *testing.T) {
	var hits atomic.Int32
	withGithubStub(t, countingStub(&hits, okRelease("v3.56.0")), "3.55.0")

	for _, target := range []string{
		"/api/update/check",
		"/api/update/check?force=0",
		"/api/update/check?force=false",
		"/api/update/check?force=",
	} {
		rec := httptest.NewRecorder()
		updateCheckHandler(&config.Config{})(rec, httptest.NewRequest("GET", target, nil))
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("github requests = %d, want 1 — only the first, uncached call may reach GitHub; %q must not force",
			got, "force=0/false/empty")
	}
}

// TestUpdateCheckHandler_DisabledNeverContactsGitHub: DISABLE_UPDATE_CHECK is
// documented as opting out entirely (docs/DEPLOYMENT.md). Before 2026-08-01 it
// was read into config and never consulted, so the check still fired.
func TestUpdateCheckHandler_DisabledNeverContactsGitHub(t *testing.T) {
	var hits atomic.Int32
	withGithubStub(t, countingStub(&hits, okRelease("v3.14.0")), "3.13.0")

	rec := httptest.NewRecorder()
	updateCheckHandler(&config.Config{UpdateCheckDisabled: true})(
		rec, httptest.NewRequest("GET", "/api/update/check", nil))

	if got := hits.Load(); got != 0 {
		t.Fatalf("github requests = %d, want 0 — the off-switch must stop the check reaching GitHub", got)
	}

	var st updateStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("unmarshal %s: %v", rec.Body.Bytes(), err)
	}
	if !st.CheckDisabled {
		t.Fatalf("body = %s, want checkDisabled:true so the caller knows nothing was looked up", rec.Body.Bytes())
	}
	if st.Current != "3.13.0" {
		t.Fatalf("Current = %q, want the running version 3.13.0 — it needs no network call", st.Current)
	}
	if st.Latest != "" || st.Available {
		t.Fatalf("disabled check returned Latest=%q Available=%v — nothing was looked up, so neither may claim anything",
			st.Latest, st.Available)
	}
	if st.CheckedAt != "" {
		t.Fatalf("CheckedAt = %q, want empty — GitHub was never contacted, so there is no real time to report", st.CheckedAt)
	}
}

// TestUpdateCheckHandler_DisabledDiffersFromUpToDate: "the check is off" and
// "the check ran and found nothing newer" are different states and must not
// serialise to the same thing.
func TestUpdateCheckHandler_DisabledDiffersFromUpToDate(t *testing.T) {
	var hits atomic.Int32
	withGithubStub(t, countingStub(&hits, okRelease("v3.13.0")), "3.13.0")

	enabled := httptest.NewRecorder()
	updateCheckHandler(&config.Config{})(enabled, httptest.NewRequest("GET", "/api/update/check", nil))
	disabled := httptest.NewRecorder()
	updateCheckHandler(&config.Config{UpdateCheckDisabled: true})(disabled, httptest.NewRequest("GET", "/api/update/check", nil))

	if got := hits.Load(); got != 1 {
		t.Fatalf("github requests = %d, want 1 — only the enabled handler may contact GitHub", got)
	}

	var up, off updateStatus
	if err := json.Unmarshal(enabled.Body.Bytes(), &up); err != nil {
		t.Fatalf("unmarshal enabled: %v", err)
	}
	if err := json.Unmarshal(disabled.Body.Bytes(), &off); err != nil {
		t.Fatalf("unmarshal disabled: %v", err)
	}
	if up.CheckDisabled {
		t.Fatal("a real, enabled check reported checkDisabled:true")
	}
	if up.Available || up.Error != "" {
		t.Fatalf("setup: expected a clean up-to-date answer, got %+v", up)
	}
	if enabled.Body.String() == disabled.Body.String() {
		t.Fatalf("a disabled check and an up-to-date check returned identical bodies: %s", enabled.Body.String())
	}
	// The distinguishing fact must be the flag, not an incidental field.
	if !off.CheckDisabled {
		t.Fatalf("disabled body = %s, want checkDisabled:true", disabled.Body.Bytes())
	}
}
