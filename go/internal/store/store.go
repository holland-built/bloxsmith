// Package store ports server.py's file-backed local state stores that live on
// the same mounted volume as the vault: saved views (server.py:2676-2749),
// the alert-snooze store (2641-2674), and the first-seen tracker (2461-2639).
// Each is a plain JSON file (or, for views, one JSON file per view under a
// views/ subdir), written via a temp-file + rename for atomicity — the same
// shapes the Python app reads and writes, so state migrates unchanged.
package store

import (
	"encoding/json"
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

	alertMu sync.Mutex // ALERT_STATE_FILE (server.py:2642 _alert_lock)
	fsMu    sync.Mutex // FIRST_SEEN_FILE  (server.py:2472 _first_seen_lock)
}

// New builds a Store rooted at stateDir. VIEWS_DIR is stateDir/views
// (server.py:2680); alert + first-seen files sit directly in stateDir.
func New(stateDir string) *Store {
	return &Store{stateDir: stateDir, viewsDir: filepath.Join(stateDir, "views")}
}

func (s *Store) alertFile() string     { return filepath.Join(s.stateDir, "alert_state.json") }
func (s *Store) firstSeenFile() string { return filepath.Join(s.stateDir, "first_seen.json") }

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
func (s *Store) ViewsList() map[string]any {
	out := []map[string]any{}
	ents, err := os.ReadDir(s.viewsDir)
	if err != nil {
		return map[string]any{"views": out}
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
			continue
		}
		var v map[string]any
		if json.Unmarshal(b, &v) != nil {
			continue
		}
		name := str(v, "name")
		if name == "" {
			name = strings.TrimSuffix(fn, ".json")
		}
		out = append(out, map[string]any{
			"name": name, "saved_at": v["saved_at"], "folder": str(v, "folder"),
		})
	}
	return map[string]any{"views": out}
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
	firstSeenMeta        = "__meta__"
	firstSeenGraceS      = 15 * 60      // flap-protection window (server.py:2473)
	firstSeenRetentionS  = 24 * 60 * 60 // prune entries older than this (2474)
	firstSeenEntitySep   = "\x00"       // "{category}\x00{entity_id}" key (2622)
)

func (s *Store) firstSeenLoad() map[string]map[string]float64 {
	m := map[string]map[string]float64{}
	b, err := os.ReadFile(s.firstSeenFile())
	if err != nil {
		return m
	}
	_ = json.Unmarshal(b, &m)
	return m
}

// StampFirstSeen ports stamp_first_seen (server.py:2586): rewrite each signal's
// detected_at with a persisted first-seen timestamp so ages survive polls and
// restarts. Mutates and returns signals. Never propagates an error (matches the
// Python contract of leaving detected_at untouched on any failure). No HTTP
// route of its own — /api/incidents (a later phase) is its only caller.
func (s *Store) StampFirstSeen(signals []map[string]any) []map[string]any {
	s.fsMu.Lock()
	defer s.fsMu.Unlock()

	store := s.firstSeenLoad()
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
	_ = atomicWriteJSON(s.firstSeenFile(), store)
	return signals
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
