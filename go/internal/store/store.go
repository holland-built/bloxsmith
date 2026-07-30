// Package store ports server.py's file-backed local state stores that live on
// the same mounted volume as the vault: saved views (server.py:2676-2749),
// the alert-snooze store (2641-2674), and the first-seen tracker (2461-2639).
// Each is a plain JSON file (or, for views, one JSON file per view under a
// views/ subdir), written via a temp-file + rename for atomicity — the same
// shapes the Python app reads and writes, so state migrates unchanged.
package store

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Store binds all three stores to one state directory (dir of vault.json).
type Store struct {
	stateDir string
	viewsDir string

	alertMu  sync.Mutex // ALERT_STATE_FILE (server.py:2642 _alert_lock)
	fsMu     sync.Mutex // FIRST_SEEN_FILE  (server.py:2472 _first_seen_lock)
	budgetMu sync.Mutex // ai_budget.json — no Python precedent, new in this port
}

// New builds a Store rooted at stateDir. VIEWS_DIR is stateDir/views
// (server.py:2680); alert + first-seen files sit directly in stateDir.
func New(stateDir string) *Store {
	return &Store{stateDir: stateDir, viewsDir: filepath.Join(stateDir, "views")}
}

func (s *Store) alertFile() string     { return filepath.Join(s.stateDir, "alert_state.json") }
func (s *Store) firstSeenFile() string { return filepath.Join(s.stateDir, "first_seen.json") }
func (s *Store) aiBudgetFile() string  { return filepath.Join(s.stateDir, "ai_budget.json") }

func now() float64 { return float64(time.Now().UnixNano()) / 1e9 }

// atomicWriteJSON is the temp-file + os.Rename pattern server.py uses for
// _first_seen_save / _alert_save / view_write.
func atomicWriteJSON(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ── saved views (server.py:2676-2749) ────────────────────────────────────────

var viewSanitize = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// viewPath ports _view_path (server.py:2682): sanitize to a flat filename so no
// "/" or ".." can escape viewsDir. Empty / "." / ".." -> "" (invalid).
func (s *Store) viewPath(name string) string {
	safe := viewSanitize.ReplaceAllString(strings.TrimSpace(name), "_")
	if len(safe) > 120 {
		safe = safe[:120]
	}
	if safe == "" || safe == "." || safe == ".." {
		return ""
	}
	return filepath.Join(s.viewsDir, safe+".json")
}

// ViewsList ports views_list (server.py:2689): name + saved_at + folder only.
//
// The returned error distinguishes "I could not read the views directory"
// from "there are no saved views". A missing viewsDir is a genuine first
// run (no view has ever been saved) and returns an empty list with a nil
// error, exactly as before. Any other ReadDir failure, or a per-file
// read/decode failure, is NOT swallowed into that same empty list — it is
// reported via the returned error so the caller can tell "empty" apart from
// "we couldn't check" instead of presenting a read failure as "none saved".
func (s *Store) ViewsList() (map[string]any, error) {
	out := []map[string]any{}
	ents, err := os.ReadDir(s.viewsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{"views": out}, nil
		}
		return nil, err
	}
	names := make([]string, 0, len(ents))
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, fn := range names {
		b, err := os.ReadFile(filepath.Join(s.viewsDir, fn))
		if err != nil {
			return nil, err
		}
		var v map[string]any
		if jerr := json.Unmarshal(b, &v); jerr != nil {
			return nil, jerr
		}
		name := str(v, "name")
		if name == "" {
			name = strings.TrimSuffix(fn, ".json")
		}
		out = append(out, map[string]any{
			"name": name, "saved_at": v["saved_at"], "folder": str(v, "folder"),
		})
	}
	return map[string]any{"views": out}, nil
}

// ViewRead ports view_read (server.py:2707): the full stored blob or nil.
func (s *Store) ViewRead(name string) map[string]any {
	p := s.viewPath(name)
	if p == "" {
		return nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var v map[string]any
	if json.Unmarshal(b, &v) != nil {
		return nil
	}
	return v
}

// ViewWrite ports view_write (server.py:2718): validate + persist an opaque
// blob. Returns (payload, httpStatus).
func (s *Store) ViewWrite(blob map[string]any) (map[string]any, int) {
	name := strings.TrimSpace(str(blob, "name"))
	if name == "" {
		return map[string]any{"ok": false, "error": "name required"}, 400
	}
	p := s.viewPath(name)
	if p == "" {
		return map[string]any{"ok": false, "error": "invalid name"}, 400
	}
	savedAt := str(blob, "saved_at")
	if savedAt == "" {
		savedAt = time.Now().UTC().Format("2006-01-02T15:04:05Z")
	}
	rec := map[string]any{
		"name":     str(blob, "name"),
		"widgets":  orDefault(blob["widgets"], map[string]any{}),
		"order":    orDefault(blob["order"], []any{}),
		"layout":   orDefault(blob["layout"], map[string]any{}),
		"folder":   str(blob, "folder"),
		"saved_at": savedAt,
	}
	if err := atomicWriteJSON(p, rec); err != nil {
		return map[string]any{"ok": false, "error": "internal error"}, 500
	}
	return map[string]any{"ok": true, "name": rec["name"]}, 200
}

// ViewDelete ports view_delete (server.py:2743): true if a file was removed.
func (s *Store) ViewDelete(name string) bool {
	p := s.viewPath(name)
	if p == "" {
		return false
	}
	if _, err := os.Stat(p); err != nil {
		return false
	}
	return os.Remove(p) == nil
}

// ── alert snooze store (server.py:2641-2674) ─────────────────────────────────

func (s *Store) alertLoad() map[string]float64 {
	m := map[string]float64{}
	b, err := os.ReadFile(s.alertFile())
	if err != nil {
		return m
	}
	_ = json.Unmarshal(b, &m)
	return m
}

// Snooze ports snooze (server.py:2657): snooze a category for `minutes`.
func (s *Store) Snooze(category string, minutes int) error {
	s.alertMu.Lock()
	defer s.alertMu.Unlock()
	d := s.alertLoad()
	d[category] = now() + float64(minutes)*60
	return atomicWriteJSON(s.alertFile(), d)
}

// IsSnoozed ports is_snoozed (server.py:2664).
func (s *Store) IsSnoozed(category string) bool {
	s.alertMu.Lock()
	defer s.alertMu.Unlock()
	return s.alertLoad()[category] > now()
}

// ActiveSnoozes ports active_snoozes (server.py:2669): still-active entries.
func (s *Store) ActiveSnoozes() map[string]float64 {
	s.alertMu.Lock()
	defer s.alertMu.Unlock()
	d := s.alertLoad()
	n := now()
	out := map[string]float64{}
	for k, v := range d {
		if v > n {
			out[k] = v
		}
	}
	return out
}

// ── first-seen tracker (server.py:2461-2639) ─────────────────────────────────

const (
	firstSeenMeta       = "__meta__"
	firstSeenGraceS     = 15 * 60      // flap-protection window (server.py:2473)
	firstSeenRetentionS = 24 * 60 * 60 // prune entries older than this (2474)
	firstSeenEntitySep  = "\x00"       // "{category}\x00{entity_id}" key (2622)
)

// firstSeenLoad reads the persisted first-seen history. Its second return
// value distinguishes "no history exists yet" (a genuine first run — the
// caller should proceed with a fresh, empty map, exactly as before) from "the
// file exists but couldn't be read or decoded" (a real failure — the caller
// must NOT treat that as equivalent to "nothing has ever been seen").
func (s *Store) firstSeenLoad() (m map[string]map[string]float64, ok bool) {
	b, err := os.ReadFile(s.firstSeenFile())
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]map[string]float64{}, true
		}
		log.Printf("store: first_seen.json unreadable (%v) — treating history as unknown, not empty; incident ages will be reported as unknown rather than reset to now", err)
		return nil, false
	}
	m = map[string]map[string]float64{}
	if err := json.Unmarshal(b, &m); err != nil {
		log.Printf("store: first_seen.json corrupt (%v) — treating history as unknown, not empty; incident ages will be reported as unknown rather than reset to now", err)
		return nil, false
	}
	return m, true
}

// StampFirstSeen ports stamp_first_seen (server.py:2586): rewrite each signal's
// detected_at with a persisted first-seen timestamp so ages survive polls and
// restarts. Mutates and returns signals. Never propagates an error (matches the
// Python contract of leaving detected_at untouched on any failure). No HTTP
// route of its own — /api/incidents (a later phase) is its only caller.
//
// If the on-disk history could not be loaded (firstSeenLoad ok=false), this
// does NOT fall back to treating every signal as brand-new: doing so used to
// stamp detected_at = now on every signal, so ages silently reset to 0s and
// ackKey-based dismissals (keyed on detected_at) vanished on every poll. Now
// each signal is left without a fabricated detected_at and is instead flagged
// "first_seen_unknown": true, so a caller/UI can render "age unknown" rather
// than a confident-looking "0s". The store is also NOT written in this case —
// see the CRITICAL note below.
func (s *Store) StampFirstSeen(signals []map[string]any) []map[string]any {
	s.fsMu.Lock()
	defer s.fsMu.Unlock()

	store, loadOK := s.firstSeenLoad()
	if !loadOK {
		// CRITICAL: a failed load must never be allowed to reach the write
		// path below. Previously firstSeenLoad() always returned a usable
		// (if empty) map, so a transient read/decode failure quietly
		// produced an empty map that then got written back over the real
		// history file, permanently destroying it. Refusing to write here
		// means a bad poll can never turn into data loss — the next poll
		// gets to try loading the untouched file again.
		for _, sig := range signals {
			sig["first_seen_unknown"] = true
			// BuildSignals stamps every signal with detected_at:now moments
			// before this runs. Flagging first_seen_unknown without also
			// deleting that fabricated timestamp left the payload reading
			// detected_at:<now>, first_seen_unknown:true — a confident-looking
			// "0s" age and an ackKey that churns every poll, exactly the
			// falsehood this flag exists to prevent. Delete it so no caller
			// can accidentally read a timestamp that was never earned.
			delete(sig, "detected_at")
		}
		return signals
	}
	n := now()
	meta := store[firstSeenMeta]
	lastPoll := 0.0
	if meta != nil {
		lastPoll = meta["last_poll"]
	}
	weWereAway := lastPoll != 0 && (n-lastPoll) > firstSeenGraceS

	for _, sig := range signals {
		key := str(sig, "category") + firstSeenEntitySep + str(sig, "entity_id")
		rec := store[key]
		stillOpen := rec != nil && (weWereAway || (n-rec["last"]) <= firstSeenGraceS)
		if stillOpen {
			rec["last"] = n
		} else {
			rec = map[string]float64{"first": n, "last": n}
		}
		store[key] = rec
		sig["detected_at"] = rec["first"]
	}

	cutoff := n - firstSeenRetentionS
	for k, v := range store {
		if k != firstSeenMeta && v["last"] < cutoff {
			delete(store, k)
		}
	}
	store[firstSeenMeta] = map[string]float64{"last_poll": n}
	if err := atomicWriteJSON(s.firstSeenFile(), store); err != nil {
		log.Printf("store: failed to persist first_seen.json: %v", err)
	}
	return signals
}

// ── AI token budget (new in this port — no Python precedent) ─────────────────
//
// WHY THIS EXISTS. The provider's daily token cap is real but never shows up
// anywhere except the text of a 429 error, and this server is only one of
// possibly several things spending against the same key. Two honesty rules
// follow directly from that and are enforced here, not just in package ai:
//
//  1. LimitTokens is a pointer, not an int with omitempty. A real daily cap
//     of 0 is nonsensical, so an int would work in practice — but a pointer
//     makes "never told a limit" a distinct, unrepresentable-as-zero state
//     instead of relying on that coincidence. Nothing is ever written here
//     except a number that arrived in an actual 429 body.
//  2. Tokens is this server's own running count, not the account's. It is
//     reset by calendar day (UTC) so a stale day's spend is never reported
//     as today's — see aiBudgetToday.

// aiBudgetState is the on-disk shape of ai_budget.json.
type aiBudgetState struct {
	Day         string `json:"day"`
	Tokens      int    `json:"tokens"`
	LimitTokens *int   `json:"limit_tokens,omitempty"`
	LimitSeenAt string `json:"limit_seen_at,omitempty"`
}

// aiBudgetToday is today's UTC calendar date, the key the whole file rolls
// over on. Using UTC (not local time) matches the provider's own reset clock.
func aiBudgetToday() string { return time.Now().UTC().Format("2006-01-02") }

func (s *Store) aiBudgetLoad() aiBudgetState {
	var b aiBudgetState
	raw, err := os.ReadFile(s.aiBudgetFile())
	if err != nil {
		return aiBudgetState{}
	}
	_ = json.Unmarshal(raw, &b)
	return b
}

// AddTokens accumulates n tokens (this server's own chat-completion usage)
// onto today's running count and persists it, rolling a stale persisted day
// over to zero first so yesterday's total is never carried into today's.
// Returns the day's total after the add and the day it was counted against.
func (s *Store) AddTokens(n int) (tokensToday int, day string) {
	s.budgetMu.Lock()
	defer s.budgetMu.Unlock()

	b := s.aiBudgetLoad()
	today := aiBudgetToday()
	if b.Day != today {
		// The limit value itself is a property of the plan, not of the day,
		// so it survives the rollover — only the spend count resets.
		b = aiBudgetState{Day: today, LimitTokens: b.LimitTokens, LimitSeenAt: b.LimitSeenAt}
	}
	b.Tokens += n
	if err := atomicWriteJSON(s.aiBudgetFile(), b); err != nil {
		log.Printf("store: failed to persist ai_budget.json: %v", err)
	}
	return b.Tokens, b.Day
}

// RecordLimit persists a daily token cap read verbatim out of a provider 429
// body. Never call this with a guessed or default value — see the package
// doc comment above.
func (s *Store) RecordLimit(limit int) {
	s.budgetMu.Lock()
	defer s.budgetMu.Unlock()

	b := s.aiBudgetLoad()
	today := aiBudgetToday()
	if b.Day != today {
		b = aiBudgetState{Day: today}
	}
	l := limit
	b.LimitTokens = &l
	b.LimitSeenAt = time.Now().UTC().Format(time.RFC3339)
	if err := atomicWriteJSON(s.aiBudgetFile(), b); err != nil {
		log.Printf("store: failed to persist ai_budget.json: %v", err)
	}
}

// Status is a read-only snapshot — unlike AddTokens/RecordLimit it never
// writes, so a plain status check can't itself race a concurrent query's
// accumulation. hasLimit is false, and limitTokens meaningless, until a 429
// body has actually stated a cap.
func (s *Store) Status() (tokensToday int, day string, limitTokens int, hasLimit bool) {
	s.budgetMu.Lock()
	defer s.budgetMu.Unlock()

	b := s.aiBudgetLoad()
	today := aiBudgetToday()
	tokens := b.Tokens
	if b.Day != today {
		// A stale file (server idle since a previous UTC day) must report
		// zero, not yesterday's leftover count, for a day it never wrote.
		tokens = 0
	}
	if b.LimitTokens != nil {
		return tokens, today, *b.LimitTokens, true
	}
	return tokens, today, 0, false
}

// ── helpers ──────────────────────────────────────────────────────────────────

func str(m map[string]any, k string) string {
	if v, ok := m[k].(string); ok {
		return v
	}
	return ""
}

func orDefault(v, def any) any {
	if v == nil {
		return def
	}
	return v
}
