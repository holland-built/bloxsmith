package server

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"bloxsmith/internal/demo"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/provision"
	"bloxsmith/internal/sse"
)

// The Demo server page: build a NIOS-X VM on Proxmox with the next free IP,
// give it DNS, prove it answers, and tear down only what the run made.
// Settings live in the vault (the join token is a secret). The two streams
// sit under /provision/ and /teardown/ so the tenant write lock gates them.
func (d *Deps) registerDemoRoutes(mux router) {
	mux.HandleFunc("GET /api/demo/status", d.demoStatus)
	mux.HandleFunc("GET /api/demo/preflight", d.demoPreflight)
	mux.HandleFunc("POST /api/vault/demo", d.body(d.demoSave))
	mux.HandleFunc("GET /api/provision/demo/stream", d.demoBuildStream)
	mux.HandleFunc("GET /api/teardown/demo/stream", d.demoTeardownStream)
}

func (d *Deps) demoConfig() demo.Config {
	var c demo.Config
	if js := d.Vault.DemoConfig(); js != "" {
		_ = json.Unmarshal([]byte(js), &c)
	}
	return c.Defaults()
}

func (d *Deps) demoStore() demo.Store {
	return demo.Store{Dir: filepath.Join(d.StateDir, "demo")}
}

// demoFor builds a Demo bound to this request's pinned tenant credential. A
// portal account switch (a Bearer token) is refused: Terraform needs an API key.
func (d *Deps) demoFor(r *http.Request) (*demo.Demo, string) {
	c, auth := d.restFor(r).PinResolved()
	key := ""
	if strings.HasPrefix(auth, "Token ") {
		key = strings.TrimPrefix(auth, "Token ")
	}
	why := ""
	switch {
	case auth == "":
		why = "No Infoblox API key is active. Unlock the vault first."
	case key == "":
		why = "A portal account switch is active. Switch back to the API key; Terraform needs a key."
	case strings.TrimSpace(d.StateDir) == "":
		why = "This install has no state folder to keep demo runs in."
	}
	return &demo.Demo{
		Store: d.demoStore(), Run: demo.ExecRunner{}, API: c, Key: key, BaseURL: c.BaseURL(),
		Cfg: d.demoConfig(), Now: time.Now, Sleep: time.Sleep, Timeout: 12 * time.Minute,
	}, why
}

func (d *Deps) demoStatus(w http.ResponseWriter, r *http.Request) {
	cfg := d.demoConfig()
	tf := demo.TerraformBin()
	d.json(w, r, 200, map[string]any{
		"settings":  cfg.Public(),
		"problems":  cfg.Problems(),
		"terraform": filepath.Base(tf),
		"unlocked":  d.Vault.IsUnlocked(),
		"steps":     demo.Steps,
		"runs":      d.demoStore().List(),
	})
}

func (d *Deps) demoPreflight(w http.ResponseWriter, r *http.Request) {
	dm, why := d.demoFor(r)
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	checks := dm.Preflight(ctx)
	if why != "" {
		checks = append(checks, demo.Check{OK: false, Says: "Ready to write to Infoblox", Fix: why})
	}
	d.json(w, r, 200, map[string]any{"checks": checks, "ready": demo.Ready(checks)})
}

// demoSave stores the settings. A blank join token keeps the stored one, so the
// page never has to send the secret back.
func (d *Deps) demoSave(w http.ResponseWriter, r *http.Request, b map[string]any) {
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	old := d.demoConfig()
	n := demo.Config{
		PVE: strings.TrimSpace(str(b, "pve")), PVEName: strings.TrimSpace(str(b, "pveName")),
		PVEIP: strings.TrimSpace(str(b, "pveIp")), Pool: strings.TrimSpace(str(b, "pool")),
		Bridge: strings.TrimSpace(str(b, "bridge")), Subnet: strings.TrimSpace(str(b, "subnet")),
		Gateway: strings.TrimSpace(str(b, "gateway")), Image: strings.TrimSpace(str(b, "image")),
		Owner: strings.TrimSpace(str(b, "owner")), JoinToken: strings.TrimSpace(str(b, "joinToken")),
		Disk: strings.TrimSpace(str(b, "disk")),
	}
	n.RAM, _ = strconv.Atoi(str(b, "ram"))
	n.Cores, _ = strconv.Atoi(str(b, "cores"))
	if n.JoinToken == "" {
		n.JoinToken = old.JoinToken
	}
	n = n.Defaults()
	js, _ := json.Marshal(n)
	res := d.Vault.SetDemo(string(js))
	if ok, _ := res["ok"].(bool); ok {
		d.auditAppend("demo-settings", httpx.Actor(r), map[string]any{"pve": n.PVE, "subnet": n.Subnet})
		res["problems"] = n.Problems()
		res["settings"] = n.Public()
	}
	d.json(w, r, code(res, 400), res)
}

// demoBuildStream: dry=1 (the default) shows the checks and the Terraform each
// step will run, and writes nothing. dry=0 builds.
func (d *Deps) demoBuildStream(w http.ResponseWriter, r *http.Request) {
	dry := provision.TruthyDry(queryM(r)["dry"])
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	emit, ok := sse.Start(w, d.sseCORS(w, r))
	if !ok {
		return
	}
	defer d.recoverStream(&emit, r)
	dm, why := d.demoFor(r)
	send := func(e demo.Event) { emit(map[string]any{"event": e}) }

	if dry {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		checks := dm.Preflight(ctx)
		if why != "" {
			checks = append(checks, demo.Check{OK: false, Says: "Ready to write to Infoblox", Fix: why})
		}
		code := map[string]any{"net": demo.Code("net"), "ip": demo.Code("ip"), "dns": demo.Code("dns")}
		emit(map[string]any{"done": true, "dry": true, "checks": checks, "ready": demo.Ready(checks), "steps": demo.Steps, "code": code})
		return
	}
	if why != "" {
		emit(map[string]any{"error": why})
		return
	}
	// The build keeps going if the browser closes, so a half-built run is
	// never abandoned midway; its record on disk shows where it got to.
	ctx := context.WithoutCancel(r.Context())
	run, err := dm.Build(ctx, send)
	detail := map[string]any{}
	if run != nil {
		detail = map[string]any{"change": run.Change, "ip": run.IP, "vmid": run.VMID, "zone": run.Zone, "status": run.Status}
	}
	if err != nil {
		detail["error"] = err.Error()
		d.auditAppend("demo-build-error", httpx.Actor(r), detail)
		emit(map[string]any{"error": err.Error(), "run": run})
		return
	}
	d.auditAppend("demo-build", httpx.Actor(r), detail)
	emit(map[string]any{"done": true, "run": run})
}

// demoTeardownStream: dry=1 lists what the run would remove; dry=0 removes it.
func (d *Deps) demoTeardownStream(w http.ResponseWriter, r *http.Request) {
	q := queryM(r)
	dry := provision.TruthyDry(q["dry"])
	change := strings.TrimSpace(provision.PyStr(q["change"]))
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	emit, ok := sse.Start(w, d.sseCORS(w, r))
	if !ok {
		return
	}
	defer d.recoverStream(&emit, r)
	dm, why := d.demoFor(r)
	run, err := dm.Store.Load(change)
	if err != nil {
		emit(map[string]any{"error": "No demo run " + change})
		return
	}
	if dry {
		emit(map[string]any{"done": true, "dry": true, "run": run, "removes": demo.WouldRemove(run)})
		return
	}
	if why != "" {
		emit(map[string]any{"error": why})
		return
	}
	ctx := context.WithoutCancel(r.Context())
	run, err = dm.Teardown(ctx, change, func(e demo.Event) { emit(map[string]any{"event": e}) })
	detail := map[string]any{"change": change}
	if err != nil {
		detail["error"] = err.Error()
		d.auditAppend("demo-remove-error", httpx.Actor(r), detail)
		emit(map[string]any{"error": err.Error(), "run": run})
		return
	}
	d.auditAppend("demo-remove", httpx.Actor(r), detail)
	emit(map[string]any{"done": true, "run": run})
}
