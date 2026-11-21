package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // IANA zones on machines and images that ship none

	"bloxsmith/internal/httpx"
)

// OVERNIGHT UPDATES. Off until an admin turns them on. Once a night, at a saved
// local time, this installs the newest release through applyLatestWith, the
// same download, signature check and swap as Update now.
//
// The settings file is the only memory, so a restart cannot lose what happened:
// the tag being installed is saved BEFORE the swap, and the new version clears
// it after it starts. A saved tag nobody cleared is an update that did not
// finish, and it is shown that way.

const (
	autoSettingsFile = "auto_update.json"
	// autoSlotWindow is how long after the saved time a night's update may still
	// start. A slot missed by more than this waits for the next night, so an
	// app that was down overnight never restarts itself in the daytime.
	autoSlotWindow = 10 * time.Minute

	autoPassphraseWarning = "After an overnight update, you will need to enter your passphrase."
)

var autoTimeRE = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)

var (
	errAutoBusy    = errors.New("work was running")
	errAutoBlocked = errors.New("this version failed before")
	errAutoOff     = errors.New("overnight updates were turned off")
)

// autoAttempt is an install that has reached the swap and not been confirmed.
type autoAttempt struct {
	Tag  string    `json:"tag"`
	From string    `json:"from"`
	At   time.Time `json:"at"`
}

// autoResult is the last thing that happened, as shown in Settings.
type autoResult struct {
	At      time.Time `json:"at"`
	Outcome string    `json:"outcome"`
	Tag     string    `json:"tag,omitempty"`
	Message string    `json:"message"`
}

type autoSettings struct {
	Enabled bool   `json:"enabled"`
	Time    string `json:"time,omitempty"` // HH:MM, local to Zone
	Zone    string `json:"zone,omitempty"` // IANA name
	// ArmedAt is when the schedule was last set. A slot before it never runs,
	// so saving 03:00 at 03:02 waits for tomorrow.
	ArmedAt    time.Time    `json:"armedAt,omitzero"`
	LastSlot   string       `json:"lastSlot,omitempty"` // local date of the last slot used
	BlockedTag string       `json:"blockedTag,omitempty"`
	Attempt    *autoAttempt `json:"attempt,omitempty"`
	Last       *autoResult  `json:"last,omitempty"`
}

type autoUpdater struct {
	path    string
	version string
	now     func() time.Time
	started time.Time
	apply   func(applyHooks) error
	// closeGate stops new work and returns why it could not ("" means closed).
	closeGate  func() string
	reopenGate func()
	audit      func(event, actor string, detail map[string]any)
	// unavailable returns why overnight updates cannot work here, or "".
	unavailable func() string
	// needsPassphrase: a restart would leave the vault locked.
	needsPassphrase func() bool
	vaultLocked     func() bool
	begin           func() bool
	finish          func(error)
	mu              sync.Mutex
}

// load reads the settings. Anything missing or invalid means off.
func (u *autoUpdater) load() autoSettings {
	raw, err := os.ReadFile(u.path)
	if err != nil {
		return autoSettings{}
	}
	var s autoSettings
	if err := json.Unmarshal(raw, &s); err != nil {
		log.Printf("[auto-update] settings file is invalid, treating as off: %v", err)
		return autoSettings{}
	}
	if s.Enabled && !validAutoSchedule(s.Time, s.Zone) {
		s.Enabled = false
	}
	return s
}

func validAutoSchedule(hhmm, zone string) bool {
	if !autoTimeRE.MatchString(hhmm) || zone == "" || zone == "Local" {
		return false
	}
	_, err := time.LoadLocation(zone)
	return err == nil
}

// save writes atomically: temp file, fsync, rename.
func (u *autoUpdater) save(s autoSettings) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := u.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, u.path)
}

func (u *autoUpdater) change(fn func(*autoSettings)) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	s := u.load()
	fn(&s)
	return u.save(s)
}

// autoSlot is the instant of HH:MM on a local date. A time inside the hour
// skipped by daylight saving moves to the first minute after the skip. A time
// inside the repeated hour uses its first occurrence.
func autoSlot(y int, m time.Month, d, hh, mm int, loc *time.Location) time.Time {
	t := time.Date(y, m, d, hh, mm, 0, 0, loc)
	if t.Hour() != hh || t.Minute() != mm {
		start, end := t.ZoneBounds()
		wall := time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), 0, 0, time.UTC)
		if wall.After(time.Date(y, m, d, hh, mm, 0, 0, time.UTC)) {
			return start
		}
		return end
	}
	if start, _ := t.ZoneBounds(); !start.IsZero() {
		_, cur := t.Zone()
		_, prev := start.Add(-time.Second).Zone()
		if prev > cur {
			first := t.Add(-time.Duration(prev-cur) * time.Second)
			if first.Before(start) && first.Hour() == hh && first.Minute() == mm {
				return first
			}
		}
	}
	return t
}

// dueSlot returns the local date whose slot is open now and has not been used.
// Yesterday is checked too, because a slot at 23:58 stays open past midnight.
func dueSlot(s autoSettings, now time.Time) (string, bool) {
	if !s.Enabled || !validAutoSchedule(s.Time, s.Zone) {
		return "", false
	}
	loc, err := time.LoadLocation(s.Zone)
	if err != nil {
		return "", false
	}
	var hh, mm int
	if _, err := fmt.Sscanf(s.Time, "%d:%d", &hh, &mm); err != nil {
		return "", false
	}
	local := now.In(loc)
	for _, back := range []int{1, 0} {
		day := time.Date(local.Year(), local.Month(), local.Day()-back, 12, 0, 0, 0, time.UTC)
		date := day.Format("2006-01-02")
		if date <= s.LastSlot {
			continue
		}
		slot := autoSlot(day.Year(), day.Month(), day.Day(), hh, mm, loc)
		if slot.Before(s.ArmedAt) || now.Before(slot) || !now.Before(slot.Add(autoSlotWindow)) {
			continue
		}
		return date, true
	}
	return "", false
}

// tick runs once a minute.
func (u *autoUpdater) tick() {
	if u.unavailable() != "" {
		return
	}
	now := u.now()
	if now.Sub(u.started) < applyCooldown {
		return
	}
	date, due := dueSlot(u.load(), now)
	if !due {
		return
	}
	// The date is saved first. If it cannot be saved, nothing runs, because
	// nothing could then stop a second run tonight.
	if err := u.change(func(s *autoSettings) { s.LastSlot = date }); err != nil {
		log.Printf("[auto-update] could not save tonight's slot, not updating: %v", err)
		return
	}
	u.run()
}

func (u *autoUpdater) run() {
	if !u.begin() {
		u.record("skipped-busy", "", "Skipped last night because another update was running. It will try again tonight.", false)
		return
	}
	attempted, offered, gateClosed := "", "", false
	hooks := applyHooks{
		allow: func(tag string) error {
			offered = tag
			s := u.load()
			if s.BlockedTag != "" && verN(tag) <= verN(s.BlockedTag) {
				return fmt.Errorf("%w: %s", errAutoBlocked, tag)
			}
			if s.Attempt != nil && verN(tag) <= verN(s.Attempt.Tag) {
				return fmt.Errorf("%w: %s", errAutoBlocked, tag)
			}
			return nil
		},
		beforeSwap: func(tag string) error {
			// An admin may have turned this off during the download.
			if !u.load().Enabled {
				return errAutoOff
			}
			if why := u.closeGate(); why != "" {
				return fmt.Errorf("%w: %s", errAutoBusy, why)
			}
			gateClosed = true
			err := u.change(func(s *autoSettings) {
				s.Attempt = &autoAttempt{Tag: tag, From: u.version, At: u.now().UTC()}
			})
			if err != nil {
				return fmt.Errorf("could not record the update before installing it: %w", err)
			}
			attempted = tag
			return nil
		},
		handoffFailed: func(err error) {
			u.reopenGate()
			u.record("failed", attempted, fmt.Sprintf("Version %s was installed but could not start. Restart Bloxsmith to finish.", attempted), true)
		},
	}
	err := u.safeApply(hooks)
	if err == nil {
		return // restarting; the new version reports the result
	}
	if gateClosed {
		u.reopenGate()
	}
	var rejected *releaseRejectedError
	switch {
	case errors.Is(err, errAlreadyCurrent):
		u.finish(nil)
		u.record("no-update", "", "Already on the newest version.", false)
	case errors.Is(err, errAutoBusy):
		u.finish(nil)
		u.record("skipped-busy", "", "Skipped last night because work was running. It will try again tonight.", false)
	case errors.Is(err, errAutoBlocked):
		u.finish(nil)
		tag := strings.TrimPrefix(err.Error(), errAutoBlocked.Error()+": ")
		u.record("blocked", tag, fmt.Sprintf("Skipped %s because it failed before. Overnight updates will wait for a newer version.", tag), false)
	case errors.Is(err, errAutoOff):
		u.finish(nil)
		u.record("turned-off", offered, "Stopped because overnight updates were turned off. Nothing was installed.", false)
	case errors.As(err, &rejected) && offered != "":
		u.finish(err)
		log.Printf("[auto-update] release %s refused: %v", offered, err)
		u.record("rejected", offered, fmt.Sprintf("Did not install %s because it failed its security check. Overnight updates will wait for a newer version.", offered), true)
	default:
		u.finish(err)
		log.Printf("[auto-update] update failed: %v", err)
		msg := "The overnight update failed before anything was installed. It will try again tonight."
		if attempted != "" {
			msg = fmt.Sprintf("The update to %s failed. The current version is still running, and %s will not be tried again.", attempted, attempted)
		}
		u.record("failed", attempted, msg, attempted != "")
	}
}

func (u *autoUpdater) safeApply(h applyHooks) (err error) {
	defer func() {
		if rec := recover(); rec != nil {
			err = fmt.Errorf("update panicked: %v", rec)
		}
	}()
	return u.apply(h)
}

// record saves an outcome to the settings file and the audit log. block also
// stops this tag being tried again until a newer one is published.
func (u *autoUpdater) record(outcome, tag, msg string, block bool) {
	res := &autoResult{At: u.now().UTC(), Outcome: outcome, Tag: tag, Message: msg}
	err := u.change(func(s *autoSettings) {
		s.Last = res
		if block {
			s.BlockedTag = tag
			s.Attempt = nil
		}
	})
	if err != nil {
		log.Printf("[auto-update] could not save the result %q: %v", outcome, err)
	}
	u.audit("auto-update-result", "overnight-update", map[string]any{
		"outcome": outcome, "tag": tag, "from": u.version,
	})
}

// acknowledge runs once the server is listening. It settles any attempt the
// previous process left behind. With no attempt it writes nothing.
func (u *autoUpdater) acknowledge() {
	a := u.load().Attempt
	if a == nil {
		return
	}
	running, target := verN(u.version), verN(a.Tag)
	switch {
	case running == target && running >= 0:
		outcome, msg := "updated", fmt.Sprintf("Updated to %s overnight.", a.Tag)
		if u.vaultLocked() {
			outcome = "updated-locked"
			msg = fmt.Sprintf("Updated to %s overnight. The app is locked, so you need to enter your passphrase.", a.Tag)
		}
		u.settle(outcome, a.Tag, msg, false)
	case running > target:
		u.settle("incomplete", a.Tag, fmt.Sprintf("Could not confirm the update to %s, but a newer version is now running.", a.Tag), false)
	default:
		u.settle("failed", a.Tag, fmt.Sprintf("The update to %s did not take, and Bloxsmith came back on %s. %s will not be tried again.", a.Tag, u.version, a.Tag), true)
	}
}

func (u *autoUpdater) settle(outcome, tag, msg string, block bool) {
	res := &autoResult{At: u.now().UTC(), Outcome: outcome, Tag: tag, Message: msg}
	err := u.change(func(s *autoSettings) {
		s.Attempt, s.Last = nil, res
		if block {
			s.BlockedTag = tag
		}
	})
	if err != nil {
		// The attempt stays on disk, so Settings keeps showing it as incomplete.
		log.Printf("[auto-update] could not save the result %q: %v", outcome, err)
	}
	u.audit("auto-update-result", "overnight-update", map[string]any{
		"outcome": outcome, "tag": tag, "from": u.version,
	})
}

func (u *autoUpdater) view() map[string]any {
	s := u.load()
	why := u.unavailable()
	last := s.Last
	if s.Attempt != nil {
		last = &autoResult{At: s.Attempt.At, Outcome: "incomplete", Tag: s.Attempt.Tag,
			Message: fmt.Sprintf("The update to %s started, but the new version has not confirmed it is running.", s.Attempt.Tag)}
	}
	needs := u.needsPassphrase()
	out := map[string]any{
		"available": why == "", "unavailableReason": why,
		"enabled": s.Enabled, "time": s.Time, "zone": s.Zone,
		"needsPassphrase": needs, "blockedTag": s.BlockedTag, "last": last,
	}
	if needs {
		out["passphraseWarning"] = autoPassphraseWarning
	}
	return out
}

// handler serves GET and POST /api/update/auto. The server wrapper has already
// checked for admin.
func (u *autoUpdater) handler(w http.ResponseWriter, r *http.Request) {
	reply := func(code int, body map[string]any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(body)
	}
	if r.Method != http.MethodPost {
		reply(http.StatusOK, u.view())
		return
	}
	if why := u.unavailable(); why != "" {
		reply(http.StatusConflict, map[string]any{"ok": false, "error": why})
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	var b struct {
		Enabled       *bool  `json:"enabled"`
		Time          string `json:"time"`
		Zone          string `json:"zone"`
		AckPassphrase bool   `json:"ackPassphrase"`
	}
	if err != nil || json.Unmarshal(raw, &b) != nil || b.Enabled == nil {
		reply(http.StatusBadRequest, map[string]any{"ok": false, "error": "enabled must be true or false"})
		return
	}
	cur := u.load()
	next := cur
	next.Enabled = *b.Enabled
	if *b.Enabled {
		if !validAutoSchedule(b.Time, b.Zone) {
			reply(http.StatusBadRequest, map[string]any{"ok": false, "error": "Choose a valid time and time zone."})
			return
		}
		if !cur.Enabled && u.needsPassphrase() && !b.AckPassphrase {
			reply(http.StatusConflict, map[string]any{"ok": false, "needsPassphrase": true, "error": autoPassphraseWarning})
			return
		}
		next.Time, next.Zone = b.Time, b.Zone
		if !cur.Enabled || cur.Time != b.Time || cur.Zone != b.Zone {
			next.ArmedAt = u.now().UTC()
		}
	}
	err = u.change(func(s *autoSettings) {
		s.Enabled, s.Time, s.Zone, s.ArmedAt = next.Enabled, next.Time, next.Zone, next.ArmedAt
	})
	if err != nil {
		log.Printf("[auto-update] could not save settings: %v", err)
		reply(http.StatusInternalServerError, map[string]any{"ok": false, "error": "Could not save the setting. Nothing changed."})
		return
	}
	u.audit("auto-update-settings", httpx.Actor(r), map[string]any{
		"enabled": next.Enabled, "time": next.Time, "zone": next.Zone,
	})
	out := u.view()
	out["ok"] = true
	reply(http.StatusOK, out)
}

// start settles any earlier attempt, then checks the schedule once a minute.
func (u *autoUpdater) start() {
	u.acknowledge()
	go func() {
		for range time.Tick(time.Minute) {
			u.tick()
		}
	}()
}

func containerUnavailable(inContainer bool) string {
	if inContainer {
		return "Overnight updates are not available in Docker. Update by pulling the new image."
	}
	return ""
}

// autoUnavailable is every reason this install cannot update itself overnight.
func autoUnavailable(inContainer, checkDisabled bool) string {
	if why := containerUnavailable(inContainer); why != "" {
		return why
	}
	if checkDisabled {
		return "Checking for new versions is switched off on this server."
	}
	if verN(version) <= 0 {
		return "This is a development build, so it does not update itself."
	}
	return ""
}

// release ends an update run that changed nothing, without showing an error.
func (p *updateProgress) release() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.running, p.Phase, p.Pct, p.Err = false, "idle", 0, ""
}
