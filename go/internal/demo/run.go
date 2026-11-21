package demo

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
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
	// lockStaleAfter is how long a lock can go unrefreshed before its owner
	// counts as stopped. Lock age alone proves nothing: a build has no time limit.
	lockStaleAfter = 10 * time.Minute
	// guardStaleAfter clears a guard left by a crash. A guard is held for
	// milliseconds, only while the lock file itself is being changed.
	guardStaleAfter = time.Minute
	guardWait       = 5 * time.Second
)

// lockHeartbeat is how often a held lock is refreshed. Tests shorten it.
var lockHeartbeat = 30 * time.Second

// Lock takes the demo lock shared by every app process using this state
// folder, by creating a file exclusively. The holder refreshes it until
// release, and a lock not refreshed for ten minutes is taken over. The caller
// must call the returned release.
func (s Store) Lock(now func() time.Time) (func(), error) {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return nil, err
	}
	p := filepath.Join(s.Dir, "build.lock")
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	token := hex.EncodeToString(b)
	unguard, err := guardLock(p)
	if err != nil {
		return nil, err
	}
	defer unguard()
	for i := 0; i < 2; i++ {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, werr := f.WriteString(token)
			if cerr := f.Close(); werr == nil {
				werr = cerr
			}
			if werr != nil {
				_ = os.Remove(p)
				return nil, werr
			}
			return holdLock(p, token), nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if err := takeOverStale(p, token, now); err != nil {
			return nil, err
		}
	}
	return nil, ErrBusy
}

// guardLock lets one process at a time change the lock file. Without it, a
// third process could create a lock in the moment a takeover has moved a live
// one aside. It is a plain file because releases include Windows.
func guardLock(p string) (func(), error) {
	g := p + ".guard"
	deadline := time.Now().Add(guardWait)
	for time.Now().Before(deadline) {
		f, err := os.OpenFile(g, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_ = f.Close()
			return func() { _ = os.Remove(g) }, nil
		}
		// Windows reports a file being deleted as permission denied.
		if !errors.Is(err, os.ErrExist) && !errors.Is(err, os.ErrPermission) {
			return nil, err
		}
		if st, serr := os.Stat(g); serr == nil && time.Since(st.ModTime()) > guardStaleAfter {
			_ = os.Remove(g)
			continue
		}
		time.Sleep(2 * time.Millisecond)
	}
	return nil, ErrBusy
}

// takeOverStale claims a stale lock by renaming it, then checks the claimed
// file really is stale. A lock refreshed in between goes back, overwriting
// nothing, and the answer is ErrBusy. On nil the lock path is free.
func takeOverStale(p, token string, now func() time.Time) error {
	st, err := os.Stat(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || now().Sub(st.ModTime()) < lockStaleAfter {
		return ErrBusy
	}
	claimed := p + ".takeover-" + token
	if err := os.Rename(p, claimed); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return ErrBusy
	}
	st, err = os.Stat(claimed)
	if err == nil && now().Sub(st.ModTime()) >= lockStaleAfter {
		return os.Remove(claimed)
	}
	if lerr := os.Link(claimed, p); lerr != nil && !errors.Is(lerr, os.ErrExist) {
		// No hard links on this disk. The guard means nothing can have
		// created a new lock, so moving it back overwrites nothing.
		_ = os.Rename(claimed, p)
		return ErrBusy
	}
	_ = os.Remove(claimed)
	return ErrBusy
}

// holdLock refreshes the lock until the returned release is called. A missing
// file may be mid-takeover check and come back, so only another owner's token
// ends the heartbeat. Release removes the lock only if it is still this one.
func holdLock(p, token string) func() {
	stop, done := make(chan struct{}), make(chan struct{})
	every := lockHeartbeat
	go func() {
		defer close(done)
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				b, err := os.ReadFile(p)
				if err != nil {
					continue
				}
				if string(b) != token {
					return
				}
				n := time.Now()
				_ = os.Chtimes(p, n, n)
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(stop)
			<-done
			if unguard, err := guardLock(p); err == nil {
				defer unguard()
			}
			if b, err := os.ReadFile(p); err == nil && string(b) == token {
				_ = os.Remove(p)
			}
		})
	}
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
			// A crash right after Claim leaves an empty folder, and no VM can
			// exist yet. os.Remove refuses a folder with anything in it.
			if e.IsDir() && os.Remove(filepath.Join(s.Dir, "runs", e.Name())) == nil {
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
