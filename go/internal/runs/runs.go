// Package runs is the job desk's record of what each Build made, so Remove can
// delete exactly that and nothing else.
//
// WHY A LIST OF IDS AND NOT TAGS. Infoblox can pass a tag down from a block to
// the objects inside it, so a tag on an object does not prove Bloxsmith made it.
// A run keeps the exact Infoblox ID of every object it created; Remove deletes
// by those IDs only. An object whose ID never came back is never offered.
//
// WHY THE RUN IS SAVED BEFORE THE BUILD. A run is written as "building" before
// Infoblox is called, then updated with the IDs. If the server stops between
// the two, the run still shows up, marked failed, so nobody believes nothing
// happened.
//
// Changes made on the older pages are not recorded here, and Remove cannot
// undo them.
package runs

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Run statuses.
const (
	Building     = "building"
	Built        = "built"
	Failed       = "failed"
	Removing     = "removing"
	Removed      = "removed"
	RemoveFailed = "remove-failed"
)

// Object states.
const (
	Created = "created" // made by this run and not yet removed
	Gone    = "gone"    // was already deleted when Remove looked
	Deleted = "removed" // Remove deleted it
	Error   = "failed"  // Remove tried and Infoblox refused
)

// Object is one thing a run made.
type Object struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`  // "address", "dns_record" or "subnet"
	Label string `json:"label"` // what a person recognises: the IP, or the name
	State string `json:"state"`
	Error string `json:"error,omitempty"`
}

// Run is one Build from the desk.
type Run struct {
	ID      string   `json:"id"`
	Job     string   `json:"job"`
	Title   string   `json:"title"`
	Created string   `json:"created"`
	Space   string   `json:"space,omitempty"` // the IP space it was built in, for "Yours" on the desk
	Status  string   `json:"status"`
	Error   string   `json:"error,omitempty"`
	Note    string   `json:"note,omitempty"`
	Objects []Object `json:"objects"`
}

// Ledger is the runs file, desk_runs.json in the state directory.
type Ledger struct {
	path string
	mu   sync.Mutex
}

// Open opens the ledger in stateDir. Runs left "building" or "removing" by a
// server that stopped part way are marked so they are not stuck forever.
func Open(stateDir string) *Ledger {
	l := &Ledger{path: filepath.Join(stateDir, "desk_runs.json")}
	_ = l.update(func(rs []Run) ([]Run, error) {
		for i := range rs {
			switch rs[i].Status {
			case Building:
				rs[i].Status = Failed
				rs[i].Error = "Bloxsmith stopped while this was being built. Check it by hand; anything listed below can be removed."
			case Removing:
				rs[i].Status = RemoveFailed
				rs[i].Error = "Bloxsmith stopped while removing this. Remove again to finish."
			}
		}
		return rs, nil
	})
	return l
}

// NewID makes a run ID: r-YYYYMMDD-HHMMSS-<4 hex>.
func NewID(now time.Time) string {
	b := make([]byte, 2)
	_, _ = rand.Read(b)
	return "r-" + now.UTC().Format("20060102-150405") + "-" + hex.EncodeToString(b)
}

func (l *Ledger) load() ([]Run, error) {
	raw, err := os.ReadFile(l.path)
	if errors.Is(err, os.ErrNotExist) {
		return []Run{}, nil
	}
	if err != nil {
		return nil, err
	}
	var rs []Run
	if err := json.Unmarshal(raw, &rs); err != nil {
		return nil, err
	}
	return rs, nil
}

// save writes the file atomically: temp file, fsync, rename. A lost write here
// would lose the only record of what to remove.
func (l *Ledger) save(rs []Run) error {
	if err := os.MkdirAll(filepath.Dir(l.path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(rs, "", "  ")
	if err != nil {
		return err
	}
	tmp := l.path + ".tmp"
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
	return os.Rename(tmp, l.path)
}

// update runs fn over the whole list under the lock and saves the result, so a
// read-modify-write can never interleave with another.
func (l *Ledger) update(fn func([]Run) ([]Run, error)) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	rs, err := l.load()
	if err != nil {
		return err
	}
	rs, err = fn(rs)
	if err != nil {
		return err
	}
	return l.save(rs)
}

// List returns every run, newest first.
func (l *Ledger) List() ([]Run, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	rs, err := l.load()
	if err != nil {
		return nil, err
	}
	sort.SliceStable(rs, func(i, j int) bool { return rs[i].Created > rs[j].Created })
	return rs, nil
}

// Get returns one run.
func (l *Ledger) Get(id string) (Run, bool, error) {
	rs, err := l.List()
	if err != nil {
		return Run{}, false, err
	}
	for _, r := range rs {
		if r.ID == id {
			return r, true, nil
		}
	}
	return Run{}, false, nil
}

// Add saves a new run.
func (l *Ledger) Add(r Run) error {
	return l.update(func(rs []Run) ([]Run, error) {
		for _, x := range rs {
			if x.ID == r.ID {
				return nil, errors.New("run id already used")
			}
		}
		return append(rs, r), nil
	})
}

// ErrNotFound is returned by Change for an unknown run.
var ErrNotFound = errors.New("run not found")

// Change edits one run in place under the lock.
func (l *Ledger) Change(id string, fn func(*Run) error) error {
	return l.update(func(rs []Run) ([]Run, error) {
		for i := range rs {
			if rs[i].ID == id {
				if err := fn(&rs[i]); err != nil {
					return nil, err
				}
				return rs, nil
			}
		}
		return nil, ErrNotFound
	})
}
