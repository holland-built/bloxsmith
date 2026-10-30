package demo

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
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

// Lock takes the demo lock shared by every app process using this state
// folder, by creating a file exclusively. A lock left by a crashed process is
// taken over after two hours, longer than any build runs. The caller must
// call the returned release.
func (s Store) Lock(now func() time.Time) (func(), error) {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return nil, err
	}
	p := filepath.Join(s.Dir, "build.lock")
	for i := 0; i < 2; i++ {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, _ = f.WriteString(now().UTC().Format(time.RFC3339))
			_ = f.Close()
			return func() { _ = os.Remove(p) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		st, serr := os.Stat(p)
		if serr != nil || now().Sub(st.ModTime()) < 2*time.Hour {
			return nil, ErrBusy
		}
		_ = os.Remove(p)
	}
	return nil, ErrBusy
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
