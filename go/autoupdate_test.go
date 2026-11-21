package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Every test here uses a fake apply function and a fake clock. Nothing in this
// file can download a release or replace a binary.

type auRig struct {
	u        *autoUpdater
	clock    time.Time
	applies  int
	applyFn  func(applyHooks) error
	gateBusy string
	closes   int
	reopens  int
	events   []string
	details  []map[string]any
	locked   bool
	needs    bool
	blocked  string
}

const auTag = "v9.0.0"

func newRig(t *testing.T) *auRig {
	t.Helper()
	r := &auRig{clock: nyTime(t, 2027, 1, 15, 3, 0)}
	r.applyFn = func(h applyHooks) error {
		if err := h.allow(auTag); err != nil {
			return err
		}
		return h.beforeSwap(auTag)
	}
	r.u = &autoUpdater{
		path:    filepath.Join(t.TempDir(), "auto_update.json"),
		version: "v8.0.0",
		now:     func() time.Time { return r.clock },
		started: r.clock.Add(-time.Hour),
		apply:   func(h applyHooks) error { r.applies++; return r.applyFn(h) },
		closeGate: func() string {
			r.closes++
			return r.gateBusy
		},
		reopenGate: func() { r.reopens++ },
		audit: func(ev, _ string, det map[string]any) {
			r.events = append(r.events, ev)
			r.details = append(r.details, det)
		},
		unavailable:     func() string { return r.blocked },
		needsPassphrase: func() bool { return r.needs },
		vaultLocked:     func() bool { return r.locked },
		begin:           func() bool { return true },
		finish:          func(error) {},
	}
	return r
}

func nyTime(t *testing.T, y int, m time.Month, d, hh, mm int) time.Time {
	t.Helper()
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	return time.Date(y, m, d, hh, mm, 0, 0, loc)
}

func (r *auRig) enable(t *testing.T) {
	t.Helper()
	s := r.u.load()
	s.Enabled, s.Time, s.Zone = true, "03:00", "America/New_York"
	s.ArmedAt = r.clock.Add(-24 * time.Hour)
	if err := r.u.save(s); err != nil {
		t.Fatal(err)
	}
}

func (r *auRig) post(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	rr := httptest.NewRecorder()
	r.u.handler(rr, httptest.NewRequest("POST", "/api/update/auto", strings.NewReader(body)))
	return rr
}

func (r *auRig) view(t *testing.T) map[string]any {
	t.Helper()
	rr := httptest.NewRecorder()
	r.u.handler(rr, httptest.NewRequest("GET", "/api/update/auto", nil))
	var out map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("GET answer is not JSON: %v: %s", err, rr.Body.String())
	}
	return out
}

func lastOutcome(t *testing.T, r *auRig) string {
	t.Helper()
	l := r.u.load().Last
	if l == nil {
		t.Fatal("no outcome was recorded in the settings file")
	}
	return l.Outcome
}

// --- Rule 1: off unless an admin POST turned it on ---

func TestMissingOrInvalidSettingsMeanOff(t *testing.T) {
	bad := map[string]string{
		"not json":     "{nope",
		"bad time":     `{"enabled":true,"time":"25:00","zone":"America/New_York"}`,
		"bad zone":     `{"enabled":true,"time":"03:00","zone":"Mars/Olympus"}`,
		"string flag":  `{"enabled":"true","time":"03:00","zone":"America/New_York"}`,
		"missing zone": `{"enabled":true,"time":"03:00"}`,
	}
	r := newRig(t)
	r.u.tick()
	if r.applies != 0 || r.u.load().Enabled {
		t.Fatal("a missing file did not mean off")
	}
	for name, raw := range bad {
		r := newRig(t)
		if err := os.WriteFile(r.u.path, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		r.u.tick()
		if r.u.load().Enabled || r.applies != 0 {
			t.Errorf("%s: invalid settings were treated as on", name)
		}
	}
}

func TestStartingANewReleaseNeverTurnsItOn(t *testing.T) {
	r := newRig(t)
	r.u.acknowledge()
	r.u.tick()
	if r.u.load().Enabled || r.applies != 0 {
		t.Fatal("startup turned overnight updates on")
	}
	if _, err := os.Stat(r.u.path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("startup created a settings file nobody asked for")
	}
}

func TestOnlyAPostTurnsItOn(t *testing.T) {
	r := newRig(t)
	rr := r.post(t, `{"enabled":true,"time":"03:00","zone":"America/New_York"}`)
	if rr.Code != 200 || !r.u.load().Enabled {
		t.Fatalf("POST did not turn it on: %d %s", rr.Code, rr.Body.String())
	}
	if !contains(r.events, "auto-update-settings") {
		t.Fatalf("the settings change was not audited: %v", r.events)
	}
	if rr := r.post(t, `{"enabled":false}`); rr.Code != 200 || r.u.load().Enabled {
		t.Fatalf("POST did not turn it off: %d", rr.Code)
	}
}

func TestPostRejectsBadTimeAndZone(t *testing.T) {
	for _, body := range []string{
		`{"enabled":true,"time":"3am","zone":"America/New_York"}`,
		`{"enabled":true,"time":"03:00","zone":"../../etc/passwd"}`,
		`{"enabled":true,"time":"03:00","zone":""}`,
		`{"enabled":"yes","time":"03:00","zone":"UTC"}`,
	} {
		r := newRig(t)
		if rr := r.post(t, body); rr.Code != http.StatusBadRequest || r.u.load().Enabled {
			t.Errorf("%s: code %d enabled=%v", body, rr.Code, r.u.load().Enabled)
		}
	}
}

// --- Rule 2: local time, once per date, daylight saving, missed slots ---

func TestSkippedDaylightHourRunsAtTheFirstRealMinute(t *testing.T) {
	loc, _ := time.LoadLocation("America/New_York")
	got := autoSlot(2027, time.March, 14, 2, 30, loc)
	want := time.Date(2027, time.March, 14, 3, 0, 0, 0, loc)
	if !got.Equal(want) {
		t.Fatalf("slot in the skipped hour = %v, want %v", got, want)
	}
}

func TestRepeatedDaylightHourUsesTheFirstAndRunsOnce(t *testing.T) {
	loc, _ := time.LoadLocation("America/New_York")
	got := autoSlot(2027, time.November, 7, 1, 30, loc)
	if _, off := got.Zone(); off != -4*3600 {
		t.Fatalf("slot in the repeated hour used offset %d, want the first (EDT)", off)
	}
	r := newRig(t)
	s := r.u.load()
	s.Enabled, s.Time, s.Zone, s.ArmedAt = true, "01:30", "America/New_York", got.Add(-48*time.Hour)
	if err := r.u.save(s); err != nil {
		t.Fatal(err)
	}
	r.u.started = got.Add(-time.Hour)
	r.clock = got
	r.u.tick()
	r.clock = got.Add(time.Hour) // 01:30 again, on standard time
	r.u.tick()
	if r.applies != 1 {
		t.Fatalf("repeated hour ran %d times, want 1", r.applies)
	}
}

func TestRunsAtMostOncePerLocalDate(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	r.u.tick()
	r.clock = r.clock.Add(time.Minute)
	r.u.tick()
	if r.applies != 1 {
		t.Fatalf("ran %d times in one night", r.applies)
	}
	r.clock = r.clock.Add(24 * time.Hour)
	r.u.tick()
	if r.applies != 2 {
		t.Fatalf("did not run the next night: %d", r.applies)
	}
}

func TestSlotMissedWhileDownIsSkipped(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	r.clock = nyTime(t, 2027, 1, 15, 11, 0) // came back up in the daytime
	r.u.tick()
	if r.applies != 0 {
		t.Fatal("a missed slot ran in the daytime")
	}
}

func TestSavingATimeJustPassedDoesNotRunNow(t *testing.T) {
	r := newRig(t)
	r.clock = nyTime(t, 2027, 1, 15, 3, 2)
	if rr := r.post(t, `{"enabled":true,"time":"03:00","zone":"America/New_York"}`); rr.Code != 200 {
		t.Fatal(rr.Body.String())
	}
	r.u.tick()
	if r.applies != 0 {
		t.Fatal("turning it on at 03:02 for 03:00 installed immediately")
	}
}

func TestSlotNearMidnightStillRunsAfterTheDateChanges(t *testing.T) {
	r := newRig(t)
	s := r.u.load()
	s.Enabled, s.Time, s.Zone, s.ArmedAt = true, "23:58", "America/New_York", r.clock.Add(-48*time.Hour)
	if err := r.u.save(s); err != nil {
		t.Fatal(err)
	}
	r.clock = nyTime(t, 2027, 1, 16, 0, 1)
	r.u.tick()
	if r.applies != 1 {
		t.Fatalf("slot crossing midnight ran %d times", r.applies)
	}
}

func TestStartupCooldownHoldsTheSlot(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	r.u.started = r.clock.Add(-10 * time.Second)
	r.u.tick()
	if r.applies != 0 {
		t.Fatal("ran inside the crash-loop cooldown")
	}
	r.clock = r.clock.Add(2 * time.Minute)
	r.u.tick()
	if r.applies != 1 {
		t.Fatal("the cooldown used up the night's slot")
	}
}

// --- Rule 3: one install path ---

func TestOnlyOneCallToTheSwap(t *testing.T) {
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi os.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	for _, f := range pkgs["main"].Files {
		ast.Inspect(f, func(n ast.Node) bool {
			if s, ok := n.(*ast.SelectorExpr); ok {
				if x, ok := s.X.(*ast.Ident); ok && x.Name == "selfupdate" && s.Sel.Name == "Apply" {
					calls++
				}
			}
			return true
		})
	}
	if calls != 1 {
		t.Fatalf("selfupdate.Apply is called from %d places, want 1", calls)
	}
}

// The real install path, with a fake release and a fake swap.
func realPathRelease(t *testing.T, signGood bool) {
	t.Helper()
	const tag = "v9.0.0"
	_, priv := swapSigningKey(t)
	archName := archiveAssetName(tag)
	archive := buildArchive(t, []byte("new binary"))
	sum := checksumsFor(archive)
	sums := bytes.ReplaceAll(sum, []byte(testArchName), []byte(archName))
	sig := sign(priv, sums)
	if !signGood {
		sig = sign(priv, []byte("something else"))
	}
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	mux.HandleFunc("/repos/", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `{"tag_name":%q,"assets":[{"name":%q,"browser_download_url":%q},{"name":"checksums.txt","browser_download_url":%q},{"name":%q,"browser_download_url":%q}]}`,
			tag, archName, srv.URL+"/a", srv.URL+"/s", releaseSigAssetName, srv.URL+"/g")
	})
	mux.HandleFunc("/a", func(w http.ResponseWriter, _ *http.Request) { w.Write(archive) })
	mux.HandleFunc("/s", func(w http.ResponseWriter, _ *http.Request) { w.Write(sums) })
	mux.HandleFunc("/g", func(w http.ResponseWriter, _ *http.Request) { w.Write(sig) })
	prevBase, prevVersion, prevSwap := githubAPIBase, version, swapBinary
	githubAPIBase, version = srv.URL, "v8.0.0"
	t.Cleanup(func() { githubAPIBase, version, swapBinary = prevBase, prevVersion, prevSwap })
}

func TestBeforeSwapRunsAfterVerificationAndCanStopTheSwap(t *testing.T) {
	realPathRelease(t, true)
	swapped := false
	swapBinary = func(io.Reader) error { swapped = true; return nil }
	var seen string
	stop := errors.New("busy")
	err := applyLatestWith(applyHooks{beforeSwap: func(tag string) error { seen = tag; return stop }})
	if !errors.Is(err, stop) || seen != "v9.0.0" {
		t.Fatalf("err=%v seen=%q", err, seen)
	}
	if swapped {
		t.Fatal("the swap ran after beforeSwap refused")
	}
}

func TestBadSignatureStopsBeforeTheHook(t *testing.T) {
	realPathRelease(t, false)
	swapBinary = func(io.Reader) error { t.Error("swap ran on a bad signature"); return nil }
	err := applyLatestWith(applyHooks{beforeSwap: func(string) error {
		t.Error("beforeSwap ran on a bad signature")
		return nil
	}})
	if err == nil {
		t.Fatal("a bad signature was accepted")
	}
}

// --- Rule 4: busy means skip to the next night ---

func TestBusyGateSkipsToTheNextNight(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	r.gateBusy = "a change is running"
	r.u.tick()
	if got := lastOutcome(t, r); got != "skipped-busy" {
		t.Fatalf("outcome %q", got)
	}
	if r.u.load().Attempt != nil {
		t.Fatal("a skipped night left an attempt behind")
	}
	r.gateBusy = ""
	r.clock = r.clock.Add(time.Minute)
	r.u.tick()
	if r.applies != 1 {
		t.Fatalf("retried the same night: %d applies", r.applies)
	}
	r.clock = r.clock.Add(24 * time.Hour)
	r.u.tick()
	if r.applies != 2 {
		t.Fatalf("did not try the next night: %d applies", r.applies)
	}
}

func TestGateStaysClosedOnSuccessAndReopensOnFailure(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	r.u.tick()
	if r.closes != 1 || r.reopens != 0 {
		t.Fatalf("success: closes=%d reopens=%d, want the gate held through restart", r.closes, r.reopens)
	}

	r = newRig(t)
	r.enable(t)
	r.applyFn = func(h applyHooks) error {
		_ = h.allow(auTag)
		if err := h.beforeSwap(auTag); err != nil {
			return err
		}
		return errors.New("swap failed")
	}
	r.u.tick()
	if r.reopens != 1 {
		t.Fatalf("failed swap: reopens=%d, want 1", r.reopens)
	}
}

func TestFailedRestartReopensAndBlocks(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	var hooks applyHooks
	r.applyFn = func(h applyHooks) error {
		hooks = h
		_ = h.allow(auTag)
		return h.beforeSwap(auTag)
	}
	r.u.tick()
	hooks.handoffFailed(errors.New("the new version could not be started"))
	if r.reopens != 1 {
		t.Fatalf("reopens=%d", r.reopens)
	}
	s := r.u.load()
	if s.BlockedTag != auTag || s.Attempt != nil || s.Last == nil || s.Last.Outcome != "failed" {
		t.Fatalf("settings after failed restart: %+v", s)
	}
}

// --- Rule 5: Docker ---

func TestContainerIsUnavailable(t *testing.T) {
	if containerUnavailable(true) == "" {
		t.Fatal("no reason given for a container")
	}
	if containerUnavailable(false) != "" {
		t.Fatal("a non-container was refused")
	}
}

func TestUnavailablePostIsRefusedAndNeverRuns(t *testing.T) {
	r := newRig(t)
	r.enable(t) // a file carried over from a restored backup
	r.blocked = containerUnavailable(true)
	rr := r.post(t, `{"enabled":true,"time":"04:00","zone":"UTC"}`)
	if rr.Code != http.StatusConflict {
		t.Fatalf("POST in a container answered %d", rr.Code)
	}
	if r.u.load().Time != "03:00" {
		t.Fatal("a refused POST changed the settings")
	}
	r.u.tick()
	if r.applies != 0 {
		t.Fatal("ran in a container")
	}
	v := r.view(t)
	if v["available"] != false || v["unavailableReason"] == "" {
		t.Fatalf("GET did not say unavailable: %v", v)
	}
}

// --- Rule 6: attempt, acknowledgement, blocked tags ---

func TestAttemptIsSavedBeforeTheSwap(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	var during *autoAttempt
	r.applyFn = func(h applyHooks) error {
		_ = h.allow(auTag)
		if err := h.beforeSwap(auTag); err != nil {
			return err
		}
		during = r.u.load().Attempt // what the swap would find on disk
		return nil
	}
	r.u.tick()
	if during == nil || during.Tag != auTag {
		t.Fatalf("attempt on disk at swap time: %+v", during)
	}
}

func TestNewVersionAcknowledgesItself(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	r.u.tick()
	r.u.version = auTag // the successor process
	r.u.acknowledge()
	s := r.u.load()
	if s.Attempt != nil || s.Last == nil || s.Last.Outcome != "updated" {
		t.Fatalf("after ack: %+v last=%+v", s, s.Last)
	}
	if !s.Enabled {
		t.Fatal("the update turned the setting off")
	}
	if !contains(r.events, "auto-update-result") {
		t.Fatalf("outcome not audited: %v", r.events)
	}
}

func TestNoAcknowledgementShowsIncompleteNeverSuccess(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	r.u.tick() // attempt saved, process "died" with no ack
	v := r.view(t)
	last, _ := v["last"].(map[string]any)
	if last == nil || last["outcome"] != "incomplete" {
		t.Fatalf("unacknowledged attempt shows as %v", v["last"])
	}
}

func TestComingBackOnTheOldVersionBlocksTheTag(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	r.u.tick()
	r.u.acknowledge() // still v8.0.0
	s := r.u.load()
	if s.BlockedTag != auTag || s.Last == nil || s.Last.Outcome != "failed" || s.Attempt != nil {
		t.Fatalf("after coming back on the old version: %+v", s)
	}
	r.clock = r.clock.Add(24 * time.Hour)
	before := r.closes
	r.u.tick()
	if r.closes != before {
		t.Fatal("a blocked tag reached the swap gate")
	}
	if got := lastOutcome(t, r); got != "blocked" {
		t.Fatalf("outcome %q", got)
	}
}

func TestFailedSwapBlocksUntilANewerTag(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	tag := auTag
	fail := true
	r.applyFn = func(h applyHooks) error {
		if err := h.allow(tag); err != nil {
			return err
		}
		if err := h.beforeSwap(tag); err != nil {
			return err
		}
		if fail {
			return errors.New("swap failed")
		}
		return nil
	}
	r.u.tick()
	if s := r.u.load(); s.BlockedTag != auTag || s.Last.Outcome != "failed" {
		t.Fatalf("after failed swap: %+v", s)
	}
	fail = false
	r.clock = r.clock.Add(24 * time.Hour)
	closes := r.closes
	r.u.tick()
	if r.closes != closes {
		t.Fatal("the failed tag was tried again")
	}
	tag = "v9.0.1"
	r.clock = r.clock.Add(24 * time.Hour)
	r.u.tick()
	if r.closes != closes+1 {
		t.Fatal("a newer tag was not allowed")
	}
}

// An attempt nobody could settle (its result failed to save) must not be
// installed again as though it had never happened.
func TestUnsettledAttemptIsNotRetried(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	s := r.u.load()
	s.Attempt = &autoAttempt{Tag: auTag, From: "v8.0.0", At: r.clock}
	if err := r.u.save(s); err != nil {
		t.Fatal(err)
	}
	r.u.tick()
	if r.closes != 0 {
		t.Fatal("an unsettled tag reached the swap gate")
	}
}

func TestDownloadFailureDoesNotBlockTheTag(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	r.applyFn = func(h applyHooks) error {
		_ = h.allow(auTag)
		return errors.New("network down")
	}
	r.u.tick()
	s := r.u.load()
	if s.BlockedTag != "" || s.Last.Outcome != "failed" {
		t.Fatalf("a failure before the swap: %+v", s)
	}
	if r.reopens != 0 || r.closes != 0 {
		t.Fatalf("gate touched without a swap: closes=%d reopens=%d", r.closes, r.reopens)
	}
}

func TestAlreadyCurrentIsNotAFailure(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	r.applyFn = func(applyHooks) error { return fmt.Errorf("%w (x)", errAlreadyCurrent) }
	r.u.tick()
	if got := lastOutcome(t, r); got != "no-update" {
		t.Fatalf("outcome %q", got)
	}
}

func TestPanicInApplyIsRecordedAndReleasesTheGate(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	r.applyFn = func(h applyHooks) error {
		_ = h.allow(auTag)
		_ = h.beforeSwap(auTag)
		panic("boom")
	}
	r.u.tick()
	if r.reopens != 1 || lastOutcome(t, r) != "failed" {
		t.Fatalf("reopens=%d last=%+v", r.reopens, r.u.load().Last)
	}
}

// --- Rule 7: the vault ---

func TestTurningOnWithoutUnattendedUnlockMustBeAcknowledged(t *testing.T) {
	r := newRig(t)
	r.needs = true
	rr := r.post(t, `{"enabled":true,"time":"03:00","zone":"UTC"}`)
	if rr.Code != http.StatusConflict || r.u.load().Enabled {
		t.Fatalf("turned on without the warning: %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "enter your passphrase") {
		t.Fatalf("refusal does not say it in plain words: %s", rr.Body.String())
	}
	if v := r.view(t); v["needsPassphrase"] != true {
		t.Fatalf("GET does not warn: %v", v)
	}
	rr = r.post(t, `{"enabled":true,"time":"03:00","zone":"UTC","ackPassphrase":true}`)
	if rr.Code != 200 || !r.u.load().Enabled {
		t.Fatalf("acknowledged POST: %d %s", rr.Code, rr.Body.String())
	}
}

func TestResultSaysWhenThePassphraseIsNeeded(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	r.u.tick()
	r.u.version, r.locked = auTag, true
	r.u.acknowledge()
	l := r.u.load().Last
	if l == nil || l.Outcome != "updated-locked" || !strings.Contains(l.Message, "enter your passphrase") {
		t.Fatalf("result: %+v", l)
	}
}

// --- Rule 8: every outcome recorded in both places ---

func TestEveryOutcomeIsAudited(t *testing.T) {
	r := newRig(t)
	r.enable(t)
	r.gateBusy = "busy"
	r.u.tick()
	if len(r.details) == 0 || r.details[len(r.details)-1]["outcome"] != "skipped-busy" {
		t.Fatalf("audit details: %v", r.details)
	}
	v := r.view(t)
	if last, _ := v["last"].(map[string]any); last == nil || last["outcome"] != "skipped-busy" {
		t.Fatalf("GET last: %v", v["last"])
	}
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
