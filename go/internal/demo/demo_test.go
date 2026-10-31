package demo

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
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
	// A lock left by a crash is taken over once it is old.
	if _, err := d.Store.Lock(d.Now); err != nil {
		t.Fatal(err)
	}
	// Staleness is read from the file's real timestamp, so age the file and
	// use the real clock rather than the test's fixed one.
	old := time.Now().Add(-3 * time.Hour)
	if err := os.Chtimes(filepath.Join(d.Store.Dir, "build.lock"), old, old); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Store.Lock(time.Now); err != nil {
		t.Fatalf("a stale lock was not taken over: %v", err)
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
