package demo

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed files
var files embed.FS

// API is the slice of the Infoblox REST client the demo needs. *rest.Client has it.
type API interface {
	GetEx(path string, params map[string]string) (any, int, error)
	Write(method, path string, body any, params map[string]string) (any, int, error)
}

// Event is one line of progress for the page.
type Event struct {
	Step  string            `json:"step"`            // network, ip, vm, join, dns, prove, remove
	State string            `json:"state,omitempty"` // start, ok, fail
	Line  string            `json:"line,omitempty"`  // command output, secrets hidden
	Note  string            `json:"note,omitempty"`  // a plain sentence for the reader
	Code  map[string]string `json:"code,omitempty"`  // file name -> Terraform the step runs
}

// Demo holds everything a run needs. Key is the bare Infoblox API key and
// BaseURL the portal it belongs to; both go to Terraform through its
// environment only.
type Demo struct {
	Store   Store
	Run     Runner
	API     API
	Key     string
	BaseURL string
	Cfg     Config
	Now     func() time.Time
	Sleep   func(time.Duration)
	Timeout time.Duration // how long to wait for the join and for DNS answers
}

var busy sync.Mutex // one build or teardown at a time on this machine

// ErrBusy is returned when another run is in progress.
var ErrBusy = errors.New("another demo build or teardown is already running")

// Steps names the build steps in order, with what each does, for the preview.
var Steps = []struct{ ID, Says string }{
	{"network", "Make sure the demo network exists in Infoblox (created once, then kept)"},
	{"ip", "Take the next free IP in the demo network and reserve it in the same call"},
	{"vm", "Build a NIOS-X VM on Proxmox with that IP and the join token"},
	{"join", "Wait for the VM to join the Infoblox Portal"},
	{"dns", "Start DNS on it, add it to a name server group, and serve a demo zone"},
	{"prove", "From the Proxmox host, ask the new server for its own name and an outside name"},
}

// TerraformBin finds tofu, else terraform.
func TerraformBin() string {
	for _, b := range []string{"tofu", "terraform"} {
		if p, err := exec.LookPath(b); err == nil {
			return p
		}
	}
	return ""
}

func (d *Demo) secrets() redactor { return redactor{d.Key, d.Cfg.JoinToken} }

// keyVar is the variable the bloxone provider reads its API key from.
const keyVar = "BLOXONE_API_KEY"

func (d *Demo) tfEnv() []string {
	return []string{
		strings.Join([]string{keyVar, d.Key}, "="),
		"BLOXONE_CSP_URL=" + d.BaseURL,
		"TF_PLUGIN_CACHE_DIR=" + d.Store.pluginCache(),
		"TF_IN_AUTOMATION=1",
		"TF_INPUT=0",
	}
}

// Code returns the Terraform for a stage, for the page to show.
func Code(stage string) map[string]string {
	out := map[string]string{}
	base := "files/terraform/" + stage
	ents, _ := fs.ReadDir(files, base)
	for _, e := range ents {
		b, _ := fs.ReadFile(files, base+"/"+e.Name())
		out[e.Name()] = string(b)
	}
	return out
}

// writeStage copies a stage's Terraform into dir. The folder keeps its state
// file, which is how teardown knows exactly what this stage created.
func writeStage(stage, dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for name, body := range Code(stage) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			return err
		}
	}
	return nil
}

// tf runs one terraform command in dir and streams its output under step.
func (d *Demo) tf(ctx context.Context, step, dir string, emit func(Event), args ...string) error {
	bin := TerraformBin()
	if bin == "" {
		return errors.New("neither tofu nor terraform is installed")
	}
	_ = os.MkdirAll(d.Store.pluginCache(), 0o700)
	red := d.secrets()
	return d.Run.Run(ctx, Cmd{Name: bin, Args: append(args, "-no-color"), Dir: dir, Env: d.tfEnv()},
		func(l string) { emit(Event{Step: step, Line: red.clean(l)}) })
}

func (d *Demo) tfOutput(ctx context.Context, dir, name string) (string, error) {
	var got []string
	err := d.Run.Run(ctx, Cmd{Name: TerraformBin(), Args: []string{"output", "-raw", name}, Dir: dir, Env: d.tfEnv()},
		func(l string) { got = append(got, l) })
	return strings.TrimSpace(strings.Join(got, "")), err
}

func (d *Demo) apply(ctx context.Context, step, dir string, emit func(Event), vars map[string]string) error {
	if err := d.tf(ctx, step, dir, emit, "init", "-input=false"); err != nil {
		return fmt.Errorf("terraform init: %w", err)
	}
	args := []string{"apply", "-auto-approve", "-input=false"}
	for k, v := range vars {
		args = append(args, "-var", k+"="+v)
	}
	if err := d.tf(ctx, step, dir, emit, args...); err != nil {
		return fmt.Errorf("terraform apply: %w", err)
	}
	return nil
}

// Build runs every step and keeps the run record current, so a failure at any
// point leaves a record that teardown can finish from.
func (d *Demo) Build(ctx context.Context, emit func(Event)) (*Run, error) {
	if !busy.TryLock() {
		return nil, ErrBusy
	}
	defer busy.Unlock()
	release, err := d.Store.Lock(d.Now)
	if err != nil {
		return nil, err
	}
	defer release()
	if p := d.Cfg.Problems(); len(p) > 0 {
		return nil, errors.New(strings.Join(p, "; "))
	}
	// The demo network is shared by every run. Changing it under a run that
	// still exists would move or replace the network that run's VM sits on.
	live, err := d.Store.Live()
	if err != nil {
		return nil, err
	}
	for _, o := range live {
		if o.Subnet != d.Cfg.Subnet || o.Gateway != d.Cfg.Gateway {
			return nil, fmt.Errorf("run %s still uses the demo network %s; tear it down before changing the network", o.Change, o.Subnet)
		}
	}
	ch, err := d.Store.Claim(d.Now, d.Sleep)
	if err != nil {
		return nil, err
	}
	r := &Run{Change: ch, Created: d.Now().UTC(), Engine: "terraform", Status: "building",
		PVEName: d.Cfg.PVEName, PVEIP: d.Cfg.PVEIP, PVE: d.Cfg.PVE, Bridge: d.Cfg.Bridge,
		Subnet: d.Cfg.Subnet, Gateway: d.Cfg.Gateway}
	if err := d.Store.Save(r); err != nil {
		return nil, err
	}
	fail := func(step string, err error) (*Run, error) {
		r.Status, r.Error = "failed", step+": "+d.secrets().clean(err.Error())
		_ = d.Store.Save(r)
		emit(Event{Step: step, State: "fail", Note: r.Error})
		return r, err
	}
	step := func(id string, fn func() error) error {
		emit(Event{Step: id, State: "start"})
		if err := fn(); err != nil {
			return err
		}
		emit(Event{Step: id, State: "ok"})
		return d.Store.Save(r)
	}

	subnet, cidr := d.Cfg.SubnetParts()
	if err := step("network", func() error {
		emit(Event{Step: "network", Code: Code("net")})
		if err := writeStage("net", d.Store.netDir()); err != nil {
			return err
		}
		return d.apply(ctx, "network", d.Store.netDir(), emit, map[string]string{
			"subnet": subnet, "cidr": strconv.Itoa(cidr), "gateway": d.Cfg.Gateway})
	}); err != nil {
		return fail("network", err)
	}

	if err := step("ip", func() error {
		emit(Event{Step: "ip", Code: Code("ip")})
		space, err := d.tfOutput(ctx, d.Store.netDir(), "space_id")
		if err != nil {
			return err
		}
		sub, err := d.tfOutput(ctx, d.Store.netDir(), "subnet_id")
		if err != nil {
			return err
		}
		dir := d.Store.stageDir(r.Change, "ip")
		if err := writeStage("ip", dir); err != nil {
			return err
		}
		if err := d.apply(ctx, "ip", dir, emit, map[string]string{"change": r.Change, "space_id": space, "subnet_id": sub}); err != nil {
			return err
		}
		ip, err := d.tfOutput(ctx, dir, "ip")
		if err != nil || ip == "" {
			return fmt.Errorf("no address came back: %v", err)
		}
		r.IP = ip
		emit(Event{Step: "ip", Note: "Reserved " + ip})
		return nil
	}); err != nil {
		return fail("ip", err)
	}

	if err := step("vm", func() error { return d.buildVM(ctx, r, emit) }); err != nil {
		return fail("vm", err)
	}

	if err := step("join", func() error { return d.waitJoin(ctx, r, emit) }); err != nil {
		return fail("join", err)
	}
	d.dropSeed(ctx, r, emit)

	if err := step("dns", func() error {
		emit(Event{Step: "dns", Code: Code("dns")})
		dir := d.Store.stageDir(r.Change, "dns")
		if err := writeStage("dns", dir); err != nil {
			return err
		}
		if err := d.apply(ctx, "dns", dir, emit, map[string]string{
			"change": r.Change, "ip": r.IP, "pve_ip": d.Cfg.PVEIP, "pve_name": d.Cfg.PVEName}); err != nil {
			return err
		}
		z, err := d.tfOutput(ctx, dir, "zone")
		if err != nil {
			return err
		}
		r.Zone = strings.TrimSuffix(z, ".")
		emit(Event{Step: "dns", Note: "Serving " + r.Zone})
		return nil
	}); err != nil {
		return fail("dns", err)
	}

	if err := step("prove", func() error { return d.prove(ctx, r, emit) }); err != nil {
		return fail("prove", err)
	}
	r.Status = "ready"
	return r, d.Store.Save(r)
}

// waitJoin polls the Portal for a host at the run's IP that appeared after the
// run started and reports this VM's MAC, so it is this VM and not another
// machine that took the address.
func (d *Demo) waitJoin(ctx context.Context, r *Run, emit func(Event)) error {
	deadline := d.Now().Add(d.Timeout)
	for {
		id, created, mac, n, err := d.hostAt(r.IP)
		switch {
		case err != nil:
			emit(Event{Step: "join", Line: "Portal check failed, retrying: " + err.Error()})
		case n == 1 && created.After(r.Created) && strings.EqualFold(mac, r.MAC):
			r.HostID = id
			emit(Event{Step: "join", Note: "Joined the Portal"})
			return nil
		case n > 1:
			return fmt.Errorf("%d Portal hosts claim %s; stopping rather than guess", n, r.IP)
		}
		if d.Now().After(deadline) {
			return errors.New("the VM did not join the Portal in time. Check that the demo network reaches the internet")
		}
		emit(Event{Step: "join", Line: "Waiting for the VM to join the Portal…"})
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		d.Sleep(20 * time.Second)
	}
}

func (d *Demo) hostAt(ip string) (id string, created time.Time, mac string, n int, err error) {
	body, code, err := d.API.GetEx("/api/infra/v1/hosts", map[string]string{
		"_filter": fmt.Sprintf("ip_address==%q", ip), "_fields": "id,display_name,ip_address,created_at,mac_address"})
	if err != nil {
		return "", time.Time{}, "", 0, err
	}
	if code != 200 {
		return "", time.Time{}, "", 0, fmt.Errorf("portal answered %d", code)
	}
	rows, _ := asMap(body)["results"].([]any)
	if len(rows) != 1 {
		return "", time.Time{}, "", len(rows), nil
	}
	h := asMap(rows[0])
	t, _ := time.Parse(time.RFC3339Nano, str(h["created_at"]))
	return str(h["id"]), t, str(h["mac_address"]), 1, nil
}

// prove asks the new server, from the Proxmox host, for the Proxmox host's own
// name in the demo zone (expecting an authoritative answer) and for an outside name.
func (d *Demo) prove(ctx context.Context, r *Run, emit func(Event)) error {
	name := d.Cfg.PVEName + "." + r.Zone
	deadline := d.Now().Add(d.Timeout)
	for {
		ans, _ := d.ssh(ctx, "prove", fmt.Sprintf("dig +norec +short @%s %s A", r.IP, name), nil)
		if strings.TrimSpace(ans) == d.Cfg.PVEIP {
			break
		}
		if d.Now().After(deadline) {
			return fmt.Errorf("%s did not answer for %s in time", r.IP, name)
		}
		emit(Event{Step: "prove", Line: "Waiting for the zone to reach the server…"})
		d.Sleep(15 * time.Second)
	}
	own, err := d.ssh(ctx, "prove", fmt.Sprintf("dig +norec @%s %s A | grep -E 'flags:|IN[[:space:]]+A'", r.IP, name), emitTo(emit, "prove"))
	if err != nil {
		return err
	}
	out, err := d.ssh(ctx, "prove", fmt.Sprintf("dig +short @%s infoblox.com A", r.IP), emitTo(emit, "prove"))
	if err != nil || strings.TrimSpace(out) == "" {
		return fmt.Errorf("the server did not resolve an outside name: %v", err)
	}
	r.Proof = []string{
		fmt.Sprintf("%s asked %s for %s and got %s", d.Cfg.PVEName, r.IP, name, d.Cfg.PVEIP),
		fmt.Sprintf("%s asked %s for infoblox.com and got %s", d.Cfg.PVEName, r.IP, strings.Fields(out)[0]),
	}
	if !strings.Contains(own, " aa") {
		r.Proof[0] += " (answer not marked authoritative)"
	}
	for _, p := range r.Proof {
		emit(Event{Step: "prove", Note: p})
	}
	return nil
}

func emitTo(emit func(Event), step string) func(string) {
	return func(l string) { emit(Event{Step: step, Line: l}) }
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	if r, ok := m["result"].(map[string]any); ok && m["results"] == nil {
		return r
	}
	return m
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func hostPath(id string) string {
	return "/api/infra/v1/hosts/" + url.PathEscape(strings.TrimPrefix(id, "infra/host/"))
}
