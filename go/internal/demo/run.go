package demo

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Run is the ownership record for one demo. Every ID is written the moment the
// thing exists, so teardown deletes by recorded ID and never by searching.
type Run struct {
	Change  string    `json:"change"`
	Created time.Time `json:"created"`
	Engine  string    `json:"engine"`
	Status  string    `json:"status"` // building, ready, failed, removing, removed, remove-failed
	Error   string    `json:"error,omitempty"`

	IP     string `json:"ip,omitempty"`
	VMID   int    `json:"vmid,omitempty"`
	VMName string `json:"vmName,omitempty"`
	HostID string `json:"hostId,omitempty"`
	Zone   string `json:"zone,omitempty"`

	PVEName string   `json:"pveName,omitempty"`
	PVEIP   string   `json:"pveIp,omitempty"`
	Proof   []string `json:"proof,omitempty"`

	// Where the run was built, kept so teardown goes back to the same place
	// even after the settings change.
	PVE     string `json:"pve,omitempty"`
	Bridge  string `json:"bridge,omitempty"`
	Subnet  string `json:"subnet,omitempty"`
	Gateway string `json:"gateway,omitempty"`
	MAC     string `json:"mac,omitempty"`
}

// Store keeps run records and Terraform working folders under <state>/demo.
type Store struct{ Dir string }

func (s Store) netDir() string                { return filepath.Join(s.Dir, "net") }
func (s Store) runDir(ch string) string       { return filepath.Join(s.Dir, "runs", ch) }
func (s Store) stageDir(ch, st string) string { return filepath.Join(s.runDir(ch), st) }
func (s Store) pluginCache() string           { return filepath.Join(s.Dir, "plugin-cache") }

func (s Store) Save(r *Run) error {
	if err := validChange(r.Change); err != nil {
		return err
	}
	if err := os.MkdirAll(s.runDir(r.Change), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(s.runDir(r.Change), "run.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.runDir(r.Change), "run.json"))
}

func (s Store) Load(ch string) (*Run, error) {
	if err := validChange(ch); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(s.runDir(ch), "run.json"))
	if err != nil {
		return nil, err
	}
	var r Run
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	if r.Change != ch {
		return nil, errors.New("run record does not match its folder")
	}
	return &r, nil
}

// Live returns every run not yet removed. Unlike List, a record it cannot
// read is an error, because a run nobody can see may still own a VM.
func (s Store) Live() ([]Run, error) {
	ents, err := os.ReadDir(filepath.Join(s.Dir, "runs"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Run
	for _, e := range ents {
		// A plain file such as .DS_Store is not a run. Anything else that
		// cannot be read still counts, because it may own a VM.
		if e.Type().IsRegular() {
			continue
		}
		r, err := s.Load(e.Name())
		if err != nil {
			return nil, fmt.Errorf("run record %s cannot be read (%v); fix or remove it first", e.Name(), err)
		}
		if r.Status != "removed" {
			out = append(out, *r)
		}
	}
	return out, nil
}

// List returns every run, newest first.
func (s Store) List() []Run {
	ents, _ := os.ReadDir(filepath.Join(s.Dir, "runs"))
	out := []Run{}
	for _, e := range ents {
		if r, err := s.Load(e.Name()); err == nil {
			out = append(out, *r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	return out
}

func newChange(now time.Time) string { return "c-" + now.UTC().Format("20060102-150405") }

const (
	// lockMarker is what this version writes in build.lock. With a free OS
	// lock it means the owner died, so taking the lock is safe at once.
	lockMarker = "oslock"
	// olderLockLife is how long a timestamp lock from an older server is
	// honored. Those servers hold no OS lock, so only its age says anything.
	olderLockLife = 2 * time.Hour
	// olderWriteWait covers an older server that has created the file and not
	// yet written its timestamp.
	olderWriteWait = 50 * time.Millisecond
	lockTries      = 5
)

// Lock takes the demo lock shared by every app process using this state
// folder, using an operating-system file lock that is dropped when the owner
// exits or dies and survives the computer sleeping. It returns ErrBusy when
// another process holds it. The caller must call the returned release.
func (s Store) Lock(now func() time.Time) (func(), error) {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return nil, err
	}
	p := filepath.Join(s.Dir, "build.lock")
	for i := 0; i < lockTries; i++ {
		f, created, err := openLockFile(p)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if err := tryLockFile(f); err != nil {
			_ = f.Close()
			return nil, err
		}
		// The last owner may have removed this file before we locked it.
		if !sameLockFile(f, p) {
			_ = f.Close()
			continue
		}
		if err := claimLockFile(f, created, now); err != nil {
			_ = f.Close()
			return nil, err
		}
		var once sync.Once
		return func() {
			once.Do(func() {
				releaseLockFile(f, p)
				_ = f.Close()
			})
		}, nil
	}
	return nil, ErrBusy
}

// openLockFile opens build.lock and reports whether this call created it.
func openLockFile(p string) (*os.File, bool, error) {
	f, err := os.OpenFile(p, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		return f, true, nil
	}
	if !errors.Is(err, os.ErrExist) {
		return nil, false, err
	}
	f, err = os.OpenFile(p, os.O_RDWR, 0o600)
	return f, false, err
}

func sameLockFile(f *os.File, p string) bool {
	open, err := f.Stat()
	if err != nil {
		return false
	}
	onDisk, err := os.Stat(p)
	return err == nil && os.SameFile(open, onDisk)
}

// claimLockFile runs with the OS lock held. It refuses a recent timestamp from
// an older server, which may be building, and otherwise writes this version's
// marker. The file must stay in place so older servers keep out.
func claimLockFile(f *os.File, created bool, now func() time.Time) error {
	held, err := readLockFile(f)
	if err != nil {
		return err
	}
	if held == "" && !created {
		time.Sleep(olderWriteWait)
		if held, err = readLockFile(f); err != nil {
			return err
		}
	}
	if _, err := time.Parse(time.RFC3339, held); err == nil {
		st, err := f.Stat()
		if err != nil {
			return err
		}
		if now().Sub(st.ModTime()) < olderLockLife {
			return ErrBusy
		}
	}
	if err := f.Truncate(0); err != nil {
		return err
	}
	_, err = f.WriteAt([]byte(lockMarker), 0)
	return err
}

func readLockFile(f *os.File) (string, error) {
	b := make([]byte, 64)
	n, err := f.ReadAt(b, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return strings.TrimSpace(string(b[:n])), nil
}

// Recover marks runs left "building" or "removing" by a process that stopped
// part way, keeping every recorded ID so teardown can still delete by ID. A
// record alone does not prove its build died, so this holds the demo lock while
// it works and returns ErrBusy, changing nothing, when a live lock exists.
func (s Store) Recover(now func() time.Time) error {
	ents, err := os.ReadDir(filepath.Join(s.Dir, "runs"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	release, err := s.Lock(now)
	if err != nil {
		return err
	}
	defer release()
	var errs []error
	for _, e := range ents {
		if e.Type().IsRegular() {
			continue
		}
		r, err := s.Load(e.Name())
		if err != nil {
			if e.IsDir() && clearUnstartedRun(filepath.Join(s.Dir, "runs", e.Name())) {
				continue
			}
			errs = append(errs, fmt.Errorf("run record %s: %w", e.Name(), err))
			continue
		}
		switch r.Status {
		case "building":
			r.Status = "failed"
			r.Error = "Bloxsmith stopped while this was being built. Check it by hand; it can be torn down."
		case "removing":
			r.Status = "remove-failed"
			r.Error = "Bloxsmith stopped while removing this. Remove it again to finish."
		default:
			continue
		}
		if err := s.Save(r); err != nil {
			errs = append(errs, fmt.Errorf("run record %s: %w", e.Name(), err))
		}
	}
	return errors.Join(errs...)
}

// clearUnstartedRun removes a run folder left by a crash before the first save
// finished: empty, or holding only run.json.tmp. No VM can exist at that point.
// os.Remove refuses a folder that still has anything in it.
func clearUnstartedRun(dir string) bool {
	ents, err := os.ReadDir(dir)
	if err != nil || len(ents) > 1 {
		return false
	}
	if len(ents) == 1 {
		if ents[0].Name() != "run.json.tmp" || !ents[0].Type().IsRegular() {
			return false
		}
		if err := os.Remove(filepath.Join(dir, "run.json.tmp")); err != nil {
			return false
		}
	}
	return os.Remove(dir) == nil
}

// Claim takes a run ID no other build has, by creating its folder exclusively.
// Two builds in the same second, even from two app processes, cannot share one.
func (s Store) Claim(now func() time.Time, sleep func(time.Duration)) (string, error) {
	if err := os.MkdirAll(filepath.Join(s.Dir, "runs"), 0o700); err != nil {
		return "", err
	}
	for i := 0; i < 5; i++ {
		ch := newChange(now())
		err := os.Mkdir(s.runDir(ch), 0o700)
		if err == nil {
			return ch, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return "", err
		}
		sleep(time.Second)
	}
	return "", errors.New("could not get a free run ID; try again")
}
