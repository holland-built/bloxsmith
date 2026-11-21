package demo

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const token = "JOINTOKEN-abcdefghijklmnopqrstuvwxyz.ibjt"

// apiKey is a made-up value; the test checks it never reaches the page.
var apiKey = strings.Repeat("fake", 3) + "-infoblox-credential"

func goodConfig(t *testing.T) Config {
	img := filepath.Join(t.TempDir(), "NIOS-X.qcow2")
	if err := os.WriteFile(img, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	return Config{PVE: "root@192.168.100.2", PVEName: "lab", PVEIP: "192.168.100.2", Pool: "local-zfs",
		Bridge: "vmbr9", Subnet: "10.99.0.0/24", Gateway: "10.99.0.1", Image: img, Owner: "jsmith",
		JoinToken: token}.Defaults()
}

// fakeRun answers commands by the first rule whose key appears in the command.
type fakeRun struct {
	rules []rule
	seen  []string
}
type rule struct {
	match string
	out   []string
	err   error
}

func (f *fakeRun) Run(_ context.Context, c Cmd, line func(string)) error {
	all := c.Name + " " + strings.Join(c.Args, " ") + "\n" + c.Stdin
	f.seen = append(f.seen, all)
	for _, r := range f.rules {
		if strings.Contains(all, r.match) {
			for _, o := range r.out {
				line(o)
			}
			return r.err
		}
	}
	return nil
}

type fakeAPI struct {
	get     func(path string, p map[string]string) (any, int, error)
	deleted []string
}

func (f *fakeAPI) GetEx(path string, p map[string]string) (any, int, error) { return f.get(path, p) }
func (f *fakeAPI) Write(m, path string, _ any, _ map[string]string) (any, int, error) {
	f.deleted = append(f.deleted, m+" "+path)
	return nil, 204, nil
}

func newDemo(t *testing.T, run *fakeRun, api *fakeAPI) *Demo {
	t.Setenv("PATH", fakeTofuPath(t))
	now := time.Date(2026, 10, 30, 15, 0, 0, 0, time.UTC)
	return &Demo{Store: Store{Dir: t.TempDir()}, Run: run, API: api, Key: apiKey, BaseURL: "https://csp.example",
		Cfg: goodConfig(t), Now: func() time.Time { now = now.Add(time.Second); return now },
		Sleep: func(time.Duration) {}, Timeout: time.Minute}
}

// fakeTofuPath puts an executable named tofu on PATH so TerraformBin finds one.
func fakeTofuPath(t *testing.T) string {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tofu"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestProblemsRefusesValuesThatWouldReachAShell(t *testing.T) {
	bad := []func(*Config){
		func(c *Config) { c.PVE = "root@lab; rm -rf /" },
		func(c *Config) { c.Bridge = "vmbr9 --delete" },
		func(c *Config) { c.Pool = "$(reboot)" },
		func(c *Config) { c.Image = "/tmp/x'.qcow2" },
		func(c *Config) { c.Owner = "A B" },
		func(c *Config) { c.JoinToken = `abc"; reboot; "abcdefghijklmnop` },
		func(c *Config) { c.Gateway = "10.98.0.1" },
		func(c *Config) { c.Subnet = "10.99.0.5/24" },
	}
	for i, mut := range bad {
		c := goodConfig(t)
		mut(&c)
		if len(c.Problems()) == 0 {
			t.Errorf("case %d: accepted an unsafe value: %+v", i, c)
		}
	}
	if p := goodConfig(t).Problems(); len(p) != 0 {
		t.Fatalf("a good config was refused: %v", p)
	}
}

func TestBuildSavesTheVMIDBeforeAnythingCanFail(t *testing.T) {
	run := &fakeRun{rules: []rule{
		{match: "output -raw ip", out: []string{"10.99.0.2"}},
		{match: "output -raw", out: []string{"id/1"}},
		{match: "last_vmid", out: []string{"VMID=211"}},
		{match: "test -f", out: nil},
		{match: "qm create", err: errors.New("storage full")},
	}}
	api := &fakeAPI{get: func(string, map[string]string) (any, int, error) { return map[string]any{}, 200, nil }}
	d := newDemo(t, run, api)
	var events []Event
	r, err := d.Build(context.Background(), func(e Event) { events = append(events, e) })
	if err == nil {
		t.Fatal("expected the VM step to fail")
	}
	saved, lerr := d.Store.Load(r.Change)
	if lerr != nil {
		t.Fatal(lerr)
	}
	if saved.VMID != 211 || saved.IP != "10.99.0.2" || saved.Status != "failed" {
		t.Fatalf("teardown needs the VMID and IP recorded on failure, got %+v", saved)
	}
	for _, e := range events {
		b, _ := json.Marshal(e)
		if strings.Contains(string(b), token) || strings.Contains(string(b), apiKey) {
			t.Fatalf("a secret reached the page: %s", b)
		}
	}
}

func TestTheJoinTokenNeverAppearsInACommandLine(t *testing.T) {
	run := &fakeRun{rules: []rule{
		{match: "output -raw ip", out: []string{"10.99.0.2"}},
		{match: "output -raw", out: []string{"id/1"}},
		{match: "last_vmid", out: []string{"VMID=211"}},
		{match: "qm create", out: []string{"started"}},
	}}
	api := &fakeAPI{get: func(string, map[string]string) (any, int, error) { return nil, 500, nil }}
	d := newDemo(t, run, api)
	_, _ = d.Build(context.Background(), func(Event) {})
	sawSeed := false
	for _, s := range run.seen {
		argv := strings.SplitN(s, "\n", 2)[0]
		if strings.Contains(argv, token) {
			t.Fatalf("join token on a command line: %s", argv)
		}
		if strings.Contains(s, "jointoken: \""+token) {
			sawSeed = true
		}
	}
	if !sawSeed {
		t.Fatal("the seed never received the join token on stdin")
	}
}

func TestTeardownLeavesAVMThatFailsTheOwnershipCheck(t *testing.T) {
	run := &fakeRun{rules: []rule{
		{match: "&& echo here", out: []string{"here"}},
		{match: "grep -qx 'name:", out: []string{"no"}, err: errors.New("exit 1")},
	}}
	api := &fakeAPI{get: func(string, map[string]string) (any, int, error) { return map[string]any{}, 200, nil }}
	d := newDemo(t, run, api)
	r := &Run{Change: "c-20261030-150000", Created: d.Now(), Status: "ready", IP: "10.99.0.2", VMID: 211, VMName: "jsmith-211", HostID: "infra/host/9"}
	if err := d.Store.Save(r); err != nil {
		t.Fatal(err)
	}
	_, err := d.Teardown(context.Background(), r.Change, func(Event) {})
	if err == nil || !strings.Contains(err.Error(), "left alone") {
		t.Fatalf("expected the VM to be left alone, got %v", err)
	}
	for _, s := range run.seen {
		if strings.Contains(s, "qm destroy") {
			t.Fatal("destroyed a VM that failed the ownership check")
		}
	}
	if len(api.deleted) != 0 {
		t.Fatalf("went on to delete %v after stopping", api.deleted)
	}
}

func TestTeardownRefusesStateHoldingSomethingElse(t *testing.T) {
	d := newDemo(t, &fakeRun{}, &fakeAPI{})
	r := &Run{Change: "c-20261030-150000", Created: d.Now(), Status: "ready", IP: "10.99.0.2"}
	_ = d.Store.Save(r)
	_ = os.MkdirAll(d.Store.stageDir(r.Change, "dns"), 0o700)
	state := `{"values":{"root_module":{"resources":[
	 {"mode":"managed","address":"bloxone_dns_auth_zone.demo","values":{"tags":{"bloxsmith_change":"c-20261030-150000"}}},
	 {"mode":"managed","address":"bloxone_dns_auth_zone.someone_else","values":{"tags":{"owner":"rgibson"}}}]}}}`
	d.Run = &fakeRun{rules: []rule{{match: "show -json", out: []string{state}}}}
	_, err := d.Teardown(context.Background(), r.Change, func(Event) {})
	if err == nil || !strings.Contains(err.Error(), "someone_else") {
		t.Fatalf("expected a refusal naming the foreign object, got %v", err)
	}
	for _, s := range d.Run.(*fakeRun).seen {
		if strings.Contains(s, "destroy") {
			t.Fatal("ran destroy on a state that holds someone else's object")
		}
	}
}

func TestTeardownLeavesAPortalHostThatMovedIP(t *testing.T) {
	api := &fakeAPI{get: func(path string, _ map[string]string) (any, int, error) {
		if strings.HasPrefix(path, "/api/infra/v1/hosts/") {
			return map[string]any{"result": map[string]any{"ip_address": "10.99.0.77"}}, 200, nil
		}
		return map[string]any{}, 200, nil
	}}
	d := newDemo(t, &fakeRun{}, api)
	r := &Run{Change: "c-20261030-150000", Created: d.Now(), Status: "ready", IP: "10.99.0.2", HostID: "infra/host/9"}
	_ = d.Store.Save(r)
	_, err := d.Teardown(context.Background(), r.Change, func(Event) {})
	if err == nil || len(api.deleted) != 0 {
		t.Fatalf("deleted a host that is no longer at the run's IP: err=%v deleted=%v", err, api.deleted)
	}
}

func TestStoreRefusesARunIDThatIsAPath(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	if _, err := s.Load("../../etc"); err == nil {
		t.Fatal("loaded a run id that walks out of the store")
	}
}

func TestTwoBuildsInTheSameSecondGetDifferentRunIDs(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	now := time.Date(2026, 10, 30, 15, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	sleep := func(d time.Duration) { now = now.Add(d) }
	a, err := s.Claim(clock, sleep)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.Claim(clock, sleep)
	if err != nil || a == b {
		t.Fatalf("second claim in the same second: %q %q %v", a, b, err)
	}
}

func TestBuildRefusesToChangeTheNetworkUnderALiveRun(t *testing.T) {
	run := &fakeRun{}
	d := newDemo(t, run, &fakeAPI{get: func(string, map[string]string) (any, int, error) { return map[string]any{}, 200, nil }})
	old := &Run{Change: "c-20261029-150000", Created: d.Now(), Status: "ready", Subnet: "10.98.0.0/24", Gateway: "10.98.0.1"}
	if err := d.Store.Save(old); err != nil {
		t.Fatal(err)
	}
	_, err := d.Build(context.Background(), func(Event) {})
	if err == nil || !strings.Contains(err.Error(), old.Change) {
		t.Fatalf("expected a refusal naming %s, got %v", old.Change, err)
	}
	if len(run.seen) != 0 {
		t.Fatalf("ran commands before refusing: %v", run.seen)
	}
}

func TestTeardownGoesBackToTheHostTheRunWasBuiltOn(t *testing.T) {
	run := &fakeRun{rules: []rule{{match: "echo here", out: []string{"gone"}}}}
	d := newDemo(t, run, &fakeAPI{get: func(string, map[string]string) (any, int, error) { return map[string]any{}, 200, nil }})
	r := &Run{Change: "c-20261030-150000", Created: d.Now(), Status: "failed", VMID: 211, PVE: "root@10.0.0.9", Bridge: "vmbr7"}
	_ = d.Store.Save(r)
	_, _ = d.Teardown(context.Background(), r.Change, func(Event) {})
	sawOld, sawSeed := false, false
	for _, s := range run.seen {
		if strings.Contains(s, d.Cfg.PVE) {
			t.Fatalf("teardown used the current settings' host: %s", s)
		}
		if strings.Contains(s, "root@10.0.0.9") {
			sawOld = true
		}
		if strings.Contains(s, "rm -f /var/lib/vz/template/iso/seed-niosx-211.iso") {
			sawSeed = true
		}
	}
	if !sawOld || !sawSeed {
		t.Fatalf("expected the run's own host and the seed removed even with the VM gone: host=%v seed=%v", sawOld, sawSeed)
	}
}

func TestTeardownRemovesAVMThatNeverGotItsSeed(t *testing.T) {
	run := &fakeRun{rules: []rule{
		{match: "echo here", out: []string{"here"}},
		{match: "echo owned", out: []string{"owned"}},
	}}
	d := newDemo(t, run, &fakeAPI{get: func(string, map[string]string) (any, int, error) { return map[string]any{}, 200, nil }})
	r := &Run{Change: "c-20261030-150000", Created: d.Now(), Status: "failed", VMID: 211, VMName: "jsmith-211", MAC: "aa:bb:cc:dd:ee:ff"}
	_ = d.Store.Save(r)
	if _, err := d.Teardown(context.Background(), r.Change, func(Event) {}); err != nil {
		t.Fatal(err)
	}
	destroyed := false
	for _, s := range run.seen {
		if strings.Contains(s, "echo owned") && strings.Contains(s, "ide2") {
			t.Fatal("ownership check still demands the seed disk")
		}
		if strings.Contains(s, "qm destroy 211") {
			destroyed = true
		}
	}
	if !destroyed {
		t.Fatal("a VM that failed before its seed was made was left behind")
	}
}

func TestJoinIgnoresAPortalHostOlderThanTheRun(t *testing.T) {
	run := &fakeRun{rules: []rule{
		{match: "output -raw ip", out: []string{"10.99.0.2"}},
		{match: "output -raw", out: []string{"id/1"}},
		{match: "last_vmid", out: []string{"VMID=211"}},
		{match: "qm create", out: []string{"MAC=aa:bb:cc:dd:ee:ff", "started"}},
	}}
	api := &fakeAPI{get: func(path string, _ map[string]string) (any, int, error) {
		if path == "/api/infra/v1/hosts" {
			return map[string]any{"results": []any{map[string]any{"id": "infra/host/1", "ip_address": "10.99.0.2",
				"created_at": "2026-10-30T14:59:50Z"}}}, 200, nil
		}
		return map[string]any{}, 200, nil
	}}
	d := newDemo(t, run, api)
	r, err := d.Build(context.Background(), func(Event) {})
	if err == nil || r.HostID != "" {
		t.Fatalf("claimed a Portal host created before the run: host=%q err=%v", r.HostID, err)
	}
	if r.MAC != "aa:bb:cc:dd:ee:ff" {
		t.Fatalf("MAC not recorded: %q", r.MAC)
	}
}

func TestASecondProcessCannotBuildWhileTheLockIsHeld(t *testing.T) {
	d := newDemo(t, &fakeRun{}, &fakeAPI{})
	release, err := d.Store.Lock(d.Now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Build(context.Background(), func(Event) {}); !errors.Is(err, ErrBusy) {
		t.Fatalf("built while another process held the lock: %v", err)
	}
	release()
	// A file left by a crash holds no OS lock, so it is free.
	leaveLock(t, d.Store, time.Minute)
	again, err := d.Store.Lock(time.Now)
	if err != nil {
		t.Fatalf("a lock left by a crash was not taken: %v", err)
	}
	again()
}

// leaveLock writes the lock a crashed process leaves, last refreshed age ago.
func leaveLock(t *testing.T, s Store, age time.Duration) {
	t.Helper()
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(s.Dir, "build.lock")
	if err := os.WriteFile(p, []byte("oslock"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-age)
	if err := os.Chtimes(p, old, old); err != nil {
		t.Fatal(err)
	}
}

// TestLockHelperProcess is not a test of its own. The tests below re-run this
// binary to get a real second process that takes the lock and holds it until
// its stdin closes.
func TestLockHelperProcess(t *testing.T) {
	dir := os.Getenv("DEMO_LOCK_HELPER_DIR")
	if dir == "" {
		t.Skip("runs only as a helper process")
	}
	if start := os.Getenv("DEMO_LOCK_HELPER_START"); start != "" {
		fmt.Println("ready")
		for {
			if _, err := os.Stat(start); err == nil {
				break
			}
			time.Sleep(100 * time.Microsecond)
		}
	}
	release, err := Store{Dir: dir}.Lock(time.Now)
	if err != nil {
		fmt.Println("busy")
	} else {
		fmt.Println("held")
		defer release()
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
}

type lockHelper struct {
	cmd   *exec.Cmd
	stdin io.Closer
	lines chan string
}

func startLockHelper(t *testing.T, dir, start string) *lockHelper {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestLockHelperProcess$")
	cmd.Env = append(os.Environ(), "DEMO_LOCK_HELPER_DIR="+dir, "DEMO_LOCK_HELPER_START="+start)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	h := &lockHelper{cmd: cmd, stdin: stdin, lines: make(chan string, 4)}
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			h.lines <- sc.Text()
		}
		close(h.lines)
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	return h
}

func (h *lockHelper) next(t *testing.T) string {
	t.Helper()
	select {
	case l := <-h.lines:
		return l
	case <-time.After(20 * time.Second):
		t.Fatal("the helper process did not answer")
		return ""
	}
}

func TestLockHeldByAnotherProcessIsNotTakenEvenWithAnOldFileTime(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	const ch = "c-20260101-000001"
	if err := s.Save(&Run{Change: ch, Status: "building", VMID: 9001}); err != nil {
		t.Fatal(err)
	}
	h := startLockHelper(t, s.Dir, "")
	if got := h.next(t); got != "held" {
		t.Fatalf("helper: %q", got)
	}
	old := time.Now().Add(-3 * time.Hour)
	if err := os.Chtimes(filepath.Join(s.Dir, "build.lock"), old, old); err != nil {
		t.Fatal(err)
	}
	if release, err := s.Lock(time.Now); !errors.Is(err, ErrBusy) {
		if err == nil {
			release()
		}
		t.Fatalf("a lock held by a live process was taken: %v", err)
	}
	if err := s.Recover(time.Now); !errors.Is(err, ErrBusy) {
		t.Fatalf("recovery ran under a live process's lock: %v", err)
	}
	if r, _ := s.Load(ch); r == nil || r.Status != "building" {
		t.Fatalf("a live run was changed: %+v", r)
	}
}

func TestLockIsFreeTheMomentItsOwnerIsKilled(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	const ch = "c-20260101-000001"
	if err := s.Save(&Run{Change: ch, Status: "building", VMID: 9001}); err != nil {
		t.Fatal(err)
	}
	h := startLockHelper(t, s.Dir, "")
	if got := h.next(t); got != "held" {
		t.Fatalf("helper: %q", got)
	}
	if err := h.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	for range h.lines { // stdout closes once the process is gone
	}
	_ = h.cmd.Wait()
	if err := s.Recover(time.Now); err != nil {
		t.Fatalf("the lock of a killed process was not free: %v", err)
	}
	if r, _ := s.Load(ch); r == nil || r.Status != "failed" || r.VMID != 9001 {
		t.Fatalf("the run was not recovered: %+v", r)
	}
}

func TestOlderServersTimestampLockIsHonoredForTwoHours(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	p := filepath.Join(s.Dir, "build.lock")
	write := func(age time.Duration) {
		t.Helper()
		at := time.Now().Add(-age)
		if err := os.WriteFile(p, []byte(at.UTC().Format(time.RFC3339)), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, at, at); err != nil {
			t.Fatal(err)
		}
	}
	write(time.Hour)
	if release, err := s.Lock(time.Now); !errors.Is(err, ErrBusy) {
		if err == nil {
			release()
		}
		t.Fatalf("a one-hour-old timestamp lock was taken: %v", err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("a refused lock lost the older server's file: %v", err)
	}
	write(3 * time.Hour)
	release, err := s.Lock(time.Now)
	if err != nil {
		t.Fatalf("a three-hour-old timestamp lock was not taken: %v", err)
	}
	release()
}

func TestAnEmptyLockFileIsFree(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	if err := os.WriteFile(filepath.Join(s.Dir, "build.lock"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	release, err := s.Lock(time.Now)
	if err != nil {
		t.Fatalf("an empty lock file was not free: %v", err)
	}
	release()
}

// Guard: an older server creates the file, then writes its timestamp.
func TestLockWaitsForAnOlderServerToWriteItsTimestamp(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	p := filepath.Join(s.Dir, "build.lock")
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	go func() {
		time.Sleep(time.Millisecond)
		_, _ = f.WriteString(time.Now().UTC().Format(time.RFC3339))
	}()
	if release, err := s.Lock(time.Now); !errors.Is(err, ErrBusy) {
		if err == nil {
			release()
		}
		t.Fatalf("took the lock while an older server was writing it: %v", err)
	}
}

// Guard: an older server only checks that the file exists.
func TestOlderServerIsKeptOutUntilRelease(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	release, err := s.Lock(time.Now)
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(s.Dir, "build.lock")
	if _, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600); !errors.Is(err, os.ErrExist) {
		t.Fatalf("an older server could create the lock during a build: %v", err)
	}
	release()
	if runtime.GOOS == "windows" {
		return // Windows empties the file instead of removing it.
	}
	if _, err := os.Stat(p); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("release left the file, which keeps an older server out: %v", err)
	}
}

// Guard: goroutines and real processes race for one lock.
func TestConcurrentLockHasExactlyOneWinner(t *testing.T) {
	for round := 0; round < 5; round++ {
		s := Store{Dir: t.TempDir()}
		start := filepath.Join(t.TempDir(), "go")
		helpers := make([]*lockHelper, 4)
		for i := range helpers {
			helpers[i] = startLockHelper(t, s.Dir, start)
			if got := helpers[i].next(t); got != "ready" {
				t.Fatalf("helper: %q", got)
			}
		}
		const goroutines = 8
		results := make(chan func(), goroutines)
		gate := make(chan struct{})
		for i := 0; i < goroutines; i++ {
			go func() {
				<-gate
				release, err := s.Lock(time.Now)
				if err != nil {
					release = nil
				}
				results <- release
			}()
		}
		if err := os.WriteFile(start, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		close(gate)
		winners := 0
		var releases []func()
		for i := 0; i < goroutines; i++ {
			if r := <-results; r != nil {
				winners++
				releases = append(releases, r)
			}
		}
		for _, h := range helpers {
			if h.next(t) == "held" {
				winners++
			}
		}
		for _, r := range releases {
			r()
		}
		for _, h := range helpers {
			_ = h.stdin.Close()
		}
		if winners != 1 {
			t.Fatalf("round %d: %d winners for one lock", round, winners)
		}
	}
}

// Guard: release removes the file, so a waiter can hold a removed file unless
// Lock checks it is still the one at the path.
func TestLockNeverHasTwoHoldersWhileBeingReleased(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	var holders, overlaps atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				release, err := s.Lock(time.Now)
				if err != nil {
					continue
				}
				if holders.Add(1) != 1 {
					overlaps.Add(1)
				}
				time.Sleep(10 * time.Microsecond)
				holders.Add(-1)
				release()
			}
		}()
	}
	wg.Wait()
	if n := overlaps.Load(); n != 0 {
		t.Fatalf("%d times two callers held the lock at once", n)
	}
}

func TestRecoverClearsAFolderWithOnlyATempRecord(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	tmpOnly := s.runDir("c-20260101-000001")
	withMore := s.runDir("c-20260101-000002")
	for _, dir := range []string{tmpOnly, withMore} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "run.json.tmp"), []byte("{"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(withMore, "ip"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := s.Recover(time.Now); err == nil {
		t.Fatal("the folder with other files was not reported")
	}
	if _, err := os.Stat(tmpOnly); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the folder with only run.json.tmp was not cleared: %v", err)
	}
	if _, err := os.Stat(filepath.Join(withMore, "run.json.tmp")); err != nil {
		t.Fatalf("a folder with other files was changed: %v", err)
	}
	if _, err := s.Live(); err == nil {
		t.Fatal("the folder with other files stopped counting as busy")
	}
}

func TestRecoverRemovesOnlyAnEmptyRunFolder(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	empty := s.runDir("c-20260101-000001")
	full := filepath.Join(s.runDir("c-20260101-000002"), "ip")
	for _, dir := range []string{empty, full} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Recover(time.Now); err == nil {
		t.Fatal("the unreadable non-empty run was not reported")
	}
	if _, err := os.Stat(empty); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the empty folder was not removed: %v", err)
	}
	if _, err := os.Stat(full); err != nil {
		t.Fatalf("a non-empty folder was removed: %v", err)
	}
	if _, err := s.Live(); err == nil {
		t.Fatal("the non-empty unreadable run stopped counting")
	}
}

func TestBuildRefusesWhenALiveRunsNetworkIsUnknown(t *testing.T) {
	for name, setup := range map[string]func(d *Demo){
		"no network recorded": func(d *Demo) {
			_ = d.Store.Save(&Run{Change: "c-20261029-150000", Created: d.Now(), Status: "ready"})
		},
		"unreadable record": func(d *Demo) {
			dir := filepath.Join(d.Store.Dir, "runs", "c-20261029-150000")
			_ = os.MkdirAll(dir, 0o700)
			_ = os.WriteFile(filepath.Join(dir, "run.json"), []byte("{not json"), 0o600)
		},
	} {
		run := &fakeRun{}
		d := newDemo(t, run, &fakeAPI{})
		setup(d)
		if _, err := d.Build(context.Background(), func(Event) {}); err == nil || !strings.Contains(err.Error(), "c-20261029-150000") {
			t.Errorf("%s: expected a refusal naming the run, got %v", name, err)
		}
		if len(run.seen) != 0 {
			t.Errorf("%s: ran commands before refusing", name)
		}
	}
}

func TestTheVMStepFailsWithoutAMAC(t *testing.T) {
	run := &fakeRun{rules: []rule{
		{match: "output -raw ip", out: []string{"10.99.0.2"}},
		{match: "output -raw", out: []string{"id/1"}},
		{match: "last_vmid", out: []string{"VMID=211"}},
		{match: "qm create", out: []string{"started"}},
	}}
	d := newDemo(t, run, &fakeAPI{get: func(string, map[string]string) (any, int, error) { return map[string]any{}, 200, nil }})
	r, err := d.Build(context.Background(), func(Event) {})
	if err == nil || !strings.Contains(r.Error, "MAC") {
		t.Fatalf("a VM with no recorded MAC was accepted: %v", err)
	}
}

func TestJoinIgnoresANewPortalHostWithAnotherMAC(t *testing.T) {
	run := &fakeRun{rules: []rule{
		{match: "output -raw ip", out: []string{"10.99.0.2"}},
		{match: "output -raw", out: []string{"id/1"}},
		{match: "last_vmid", out: []string{"VMID=211"}},
		{match: "qm create", out: []string{"MAC=aa:bb:cc:dd:ee:ff", "started"}},
	}}
	api := &fakeAPI{get: func(path string, _ map[string]string) (any, int, error) {
		if path == "/api/infra/v1/hosts" {
			return map[string]any{"results": []any{map[string]any{"id": "infra/host/1", "ip_address": "10.99.0.2",
				"created_at": "2026-10-30T16:00:00Z", "mac_address": "11:22:33:44:55:66"}}}, 200, nil
		}
		return map[string]any{}, 200, nil
	}}
	d := newDemo(t, run, api)
	r, err := d.Build(context.Background(), func(Event) {})
	if err == nil || r.HostID != "" {
		t.Fatalf("claimed a Portal host with another MAC: host=%q err=%v", r.HostID, err)
	}
}

func TestTeardownLeavesAPortalHostWithAnotherMAC(t *testing.T) {
	api := &fakeAPI{get: func(path string, _ map[string]string) (any, int, error) {
		if strings.HasPrefix(path, "/api/infra/v1/hosts/") {
			return map[string]any{"result": map[string]any{"ip_address": "10.99.0.2", "created_at": "2026-10-30T16:00:00Z",
				"mac_address": "11:22:33:44:55:66"}}, 200, nil
		}
		return map[string]any{}, 200, nil
	}}
	d := newDemo(t, &fakeRun{}, api)
	r := &Run{Change: "c-20261030-150000", Created: d.Now(), Status: "ready", IP: "10.99.0.2", HostID: "infra/host/9", MAC: "aa:bb:cc:dd:ee:ff"}
	_ = d.Store.Save(r)
	if _, err := d.Teardown(context.Background(), r.Change, func(Event) {}); err == nil || len(api.deleted) != 0 {
		t.Fatalf("deleted a Portal host with another MAC: err=%v deleted=%v", err, api.deleted)
	}
}

func TestPreflightCatchesADemoSpaceThisAppDidNotMake(t *testing.T) {
	api := &fakeAPI{get: func(path string, _ map[string]string) (any, int, error) {
		if path == "/api/ddi/v1/ipam/ip_space" {
			return map[string]any{"results": []any{map[string]any{"id": "ipam/ip_space/1"}}}, 200, nil
		}
		return map[string]any{}, 200, nil
	}}
	d := newDemo(t, &fakeRun{}, api)
	for _, c := range d.Preflight(context.Background()) {
		if strings.Contains(c.Says, "bloxsmith-demo") {
			if c.OK {
				t.Fatal("an existing bloxsmith-demo space with no state here was passed as free")
			}
			return
		}
	}
	t.Fatal("no check for an existing bloxsmith-demo space")
}

func TestTeardownFindsAHostThatJoinedAfterTheBuildGaveUp(t *testing.T) {
	api := &fakeAPI{get: func(path string, _ map[string]string) (any, int, error) {
		host := map[string]any{"id": "infra/host/7", "ip_address": "10.99.0.2", "created_at": "2026-10-30T16:00:00Z", "mac_address": "aa:bb:cc:dd:ee:ff"}
		switch {
		case path == "/api/infra/v1/hosts":
			return map[string]any{"results": []any{host}}, 200, nil
		case strings.HasPrefix(path, "/api/infra/v1/hosts/"):
			return map[string]any{"result": host}, 200, nil
		}
		return map[string]any{}, 200, nil
	}}
	d := newDemo(t, &fakeRun{}, api)
	r := &Run{Change: "c-20261030-150000", Created: d.Now(), Status: "failed", IP: "10.99.0.2", MAC: "aa:bb:cc:dd:ee:ff"}
	_ = d.Store.Save(r)
	if _, err := d.Teardown(context.Background(), r.Change, func(Event) {}); err != nil {
		t.Fatal(err)
	}
	if len(api.deleted) != 1 || !strings.HasSuffix(api.deleted[0], "/api/infra/v1/hosts/7") {
		t.Fatalf("the host that joined late was left in the Portal: %v", api.deleted)
	}
}

func TestJoinTimeoutSaysThePortalCouldNotBeRead(t *testing.T) {
	run := &fakeRun{rules: []rule{
		{match: "output -raw ip", out: []string{"10.99.0.2"}},
		{match: "output -raw", out: []string{"id/1"}},
		{match: "last_vmid", out: []string{"VMID=211"}},
		{match: "qm create", out: []string{"MAC=aa:bb:cc:dd:ee:ff", "started"}},
	}}
	api := &fakeAPI{get: func(path string, _ map[string]string) (any, int, error) {
		if path == "/api/infra/v1/hosts" {
			return nil, 401, nil
		}
		return map[string]any{}, 200, nil
	}}
	d := newDemo(t, run, api)
	_, err := d.Build(context.Background(), func(Event) {})
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("a Portal that refused every check was reported as a slow join: %v", err)
	}
}

func TestPreflightDoesNotTrustAnEmptyStateFile(t *testing.T) {
	api := &fakeAPI{get: func(path string, _ map[string]string) (any, int, error) {
		if path == "/api/ddi/v1/ipam/ip_space" {
			return map[string]any{"results": []any{map[string]any{"id": "ipam/ip_space/1"}}}, 200, nil
		}
		return map[string]any{}, 200, nil
	}}
	d := newDemo(t, &fakeRun{}, api)
	_ = os.MkdirAll(d.Store.netDir(), 0o700)
	_ = os.WriteFile(filepath.Join(d.Store.netDir(), "terraform.tfstate"), []byte(`{"version":4,"resources":[]}`), 0o600)
	for _, c := range d.Preflight(context.Background()) {
		if strings.Contains(c.Says, "bloxsmith-demo") && !c.OK {
			return
		}
	}
	t.Fatal("an empty state file hid an existing bloxsmith-demo space")
}

func TestALoginOtherThanRootRunsEveryProxmoxCommandThroughSudo(t *testing.T) {
	for login, wantSudo := range map[string]bool{"jsmith@pve1": true, "root@pve1": false} {
		run := &fakeRun{rules: []rule{
			{match: "output -raw ip", out: []string{"10.99.0.2"}},
			{match: "output -raw", out: []string{"id/1"}},
			{match: "last_vmid", out: []string{"VMID=211"}},
			{match: "qemu-img info", err: errors.New("no image yet")},
			{match: "qm create", err: errors.New("stop here")},
		}}
		api := &fakeAPI{get: func(string, map[string]string) (any, int, error) { return map[string]any{}, 200, nil }}
		d := newDemo(t, run, api)
		d.Cfg.PVE = login
		_, _ = d.Build(context.Background(), func(Event) {})
		var sshes, rsyncs int
		for _, s := range run.seen {
			cmd, _, _ := strings.Cut(s, "\n")
			switch {
			case strings.HasPrefix(cmd, "ssh "):
				sshes++
				if strings.HasSuffix(cmd, login+" sudo -n bash -s") != wantSudo || !strings.HasSuffix(cmd, " bash -s") {
					t.Errorf("%s: ssh command %q", login, cmd)
				}
			case strings.HasPrefix(cmd, "rsync "):
				rsyncs++
				if strings.Contains(cmd, "--rsync-path=sudo -n rsync") != wantSudo {
					t.Errorf("%s: rsync command %q", login, cmd)
				}
			}
		}
		if sshes < 3 || rsyncs != 1 {
			t.Fatalf("%s: expected the VMID, image check and copy to run, saw %d ssh and %d rsync", login, sshes, rsyncs)
		}
	}
}

// Started runs once the run is saved and before anything is built; if it
// cannot record the run, nothing is built.
func TestStartedRunsBeforeTheBuildAndCanStopIt(t *testing.T) {
	run := &fakeRun{}
	api := &fakeAPI{get: func(string, map[string]string) (any, int, error) { return map[string]any{}, 200, nil }}
	d := newDemo(t, run, api)
	var got string
	d.Started = func(r *Run) error { got = r.Change; return errors.New("disk full") }
	r, err := d.Build(context.Background(), func(Event) {})
	if err == nil || r == nil || got != r.Change {
		t.Fatalf("Build = %v, %v; Started saw %q", r, err, got)
	}
	if len(run.seen) != 0 {
		t.Fatalf("commands ran after Started failed: %v", run.seen)
	}
	if saved, _ := d.Store.Load(r.Change); saved.Status != "failed" {
		t.Fatalf("run = %+v, want failed", saved)
	}
}

func TestRecoverMarksStoppedRunsAndKeepsTheirIDs(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	for ch, status := range map[string]string{
		"c-20260101-000001": "building", "c-20260101-000002": "removing", "c-20260101-000003": "ready",
	} {
		if err := s.Save(&Run{Change: ch, Status: status, IP: "10.99.0.5", VMID: 9001, VMName: "demo", HostID: "h-1", Zone: "z", MAC: "aa:bb"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Recover(time.Now); err != nil {
		t.Fatal(err)
	}
	for ch, want := range map[string]string{
		"c-20260101-000001": "failed", "c-20260101-000002": "remove-failed", "c-20260101-000003": "ready",
	} {
		r, err := s.Load(ch)
		if err != nil {
			t.Fatal(err)
		}
		if r.Status != want {
			t.Errorf("%s: status %q, want %q", ch, r.Status, want)
		}
		if (want == "ready") != (r.Error == "") {
			t.Errorf("%s: error text %q", ch, r.Error)
		}
		if r.IP != "10.99.0.5" || r.VMID != 9001 || r.VMName != "demo" || r.HostID != "h-1" || r.Zone != "z" || r.MAC != "aa:bb" {
			t.Errorf("%s lost a recorded ID: %+v", ch, r)
		}
	}
	if _, err := os.Stat(filepath.Join(s.Dir, "build.lock")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("recovery left the lock behind: %v", err)
	}
}

func TestRecoverChangesNothingWhileALiveLockExists(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	const ch = "c-20260101-000001"
	if err := s.Save(&Run{Change: ch, Status: "building", VMID: 9001}); err != nil {
		t.Fatal(err)
	}
	release, err := s.Lock(time.Now)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if err := s.Recover(time.Now); !errors.Is(err, ErrBusy) {
		t.Fatalf("want ErrBusy, got %v", err)
	}
	if r, _ := s.Load(ch); r == nil || r.Status != "building" {
		t.Fatalf("a run under a live lock was changed: %+v", r)
	}
	if _, err := os.Stat(filepath.Join(s.Dir, "build.lock")); err != nil {
		t.Fatalf("recovery removed a live lock: %v", err)
	}
}

func TestRecoverTakesALockLeftByACrash(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	const ch = "c-20260101-000001"
	if err := s.Save(&Run{Change: ch, Status: "building"}); err != nil {
		t.Fatal(err)
	}
	leaveLock(t, s, 11*time.Minute)
	if err := s.Recover(time.Now); err != nil {
		t.Fatal(err)
	}
	if r, _ := s.Load(ch); r == nil || r.Status != "failed" {
		t.Fatalf("stale lock: run not recovered: %+v", r)
	}
}

func TestLiveSkipsPlainFilesButNotAnUnreadableRun(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	runsDir := filepath.Join(s.Dir, "runs")
	if err := os.MkdirAll(runsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runsDir, ".DS_Store"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if live, err := s.Live(); err != nil || len(live) != 0 {
		t.Fatalf("a plain file affected Live: %v %v", live, err)
	}
	bad := filepath.Join(runsDir, "c-20260101-000001")
	if err := os.Mkdir(bad, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bad, "run.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Live(); err == nil {
		t.Fatal("an unreadable run folder was ignored")
	}
}
