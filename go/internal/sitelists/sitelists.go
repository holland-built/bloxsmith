// Package sitelists keeps what Site lists remembers between visits, per
// tenant, in site_lists.json beside the vault: the sites never to add (owner,
// 2026-11-13). It is Bloxsmith's own file, so it works on read-only tenants.
package sitelists

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// MaxNeverAdd is the most never-add sites a tenant keeps.
const MaxNeverAdd = 5000

// Tenant is one tenant's settings.
type Tenant struct {
	NeverAdd []string `json:"never_add"`
}

// State is the file. Every change is a whole-file atomic save.
type State struct {
	path string
	mu   sync.Mutex
}

// Open uses site_lists.json in stateDir.
func Open(stateDir string) *State {
	return &State{path: filepath.Join(stateDir, "site_lists.json")}
}

func (s *State) load() (map[string]Tenant, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]Tenant{}, nil
	}
	if err != nil {
		return nil, err
	}
	m := map[string]Tenant{}
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// save writes the file atomically: temp file, fsync, rename.
func (s *State) save(m map[string]Tenant) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
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
	return os.Rename(tmp, s.path)
}

// NeverAdd is the tenant's never-add list. A file that cannot be read is an
// error, never an empty list, so a broken file cannot let those sites in.
func (s *State) NeverAdd(tenant string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.load()
	if err != nil {
		return nil, err
	}
	return m[tenant].NeverAdd, nil
}

// SetNeverAdd replaces the tenant's never-add list with sites, lowercased,
// without a trailing dot, sorted and without repeats.
func (s *State) SetNeverAdd(tenant string, sites []string) ([]string, error) {
	seen := map[string]bool{}
	clean := []string{}
	for _, x := range sites {
		x = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(x)), ".")
		if x != "" && !seen[x] {
			seen[x] = true
			clean = append(clean, x)
		}
	}
	if len(clean) > MaxNeverAdd {
		return nil, errors.New("too many sites")
	}
	sort.Strings(clean)
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.load()
	if err != nil {
		return nil, err
	}
	t := m[tenant]
	t.NeverAdd = clean
	m[tenant] = t
	return clean, s.save(m)
}
