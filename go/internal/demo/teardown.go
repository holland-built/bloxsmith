package demo

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// Teardown removes exactly what one run created, by recorded ID, after checking
// each one still belongs to the run. It stops at the first check that fails and
// leaves that thing alone. The shared demo network is kept.
func (d *Demo) Teardown(ctx context.Context, change string, emit func(Event)) (*Run, error) {
	if !busy.TryLock() {
		return nil, ErrBusy
	}
	defer busy.Unlock()
	release, err := d.Store.Lock(d.Now)
	if err != nil {
		return nil, err
	}
	defer release()
	r, err := d.Store.Load(change)
	if err != nil {
		return nil, err
	}
	if r.Status == "removed" {
		return r, nil
	}
	// Go back to where this run was built, not where the settings point now.
	if r.PVE != "" {
		cp := *d
		cp.Cfg.PVE, cp.Cfg.Bridge = r.PVE, r.Bridge
		d = &cp
	}
	r.Status, r.Error = "removing", ""
	_ = d.Store.Save(r)
	stop := func(err error) (*Run, error) {
		r.Status, r.Error = "remove-failed", d.secrets().clean(err.Error())
		_ = d.Store.Save(r)
		emit(Event{Step: "remove", State: "fail", Note: r.Error})
		return r, err
	}
	emit(Event{Step: "remove", State: "start"})

	// 1. DNS objects, through the state Terraform kept for this run.
	if dir := d.Store.stageDir(r.Change, "dns"); exists(dir) {
		if err := d.checkState(ctx, dir, r.Change); err != nil {
			return stop(err)
		}
		if err := d.tf(ctx, "remove", dir, emit, "destroy", "-auto-approve", "-input=false",
			"-var", "change="+r.Change, "-var", "ip="+r.IP, "-var", "pve_ip="+r.PVEIP, "-var", "pve_name="+r.PVEName); err != nil {
			return stop(fmt.Errorf("removing the DNS objects: %w", err))
		}
		emit(Event{Step: "remove", Note: "DNS service, name server group and zone removed"})
	}

	// 2. The VM, only if it is still the one this run built.
	if r.VMID != 0 {
		if err := d.removeVM(ctx, r, emit); err != nil {
			return stop(err)
		}
		r.VMID = 0
		_ = d.Store.Save(r)
	}

	// 3. The Portal host, only if it is still at this run's IP.
	if r.HostID != "" {
		body, code, err := d.API.GetEx(hostPath(r.HostID), nil)
		created, _ := time.Parse(time.RFC3339Nano, str(asMap(body)["created_at"]))
		switch {
		case err == nil && code == 404:
			emit(Event{Step: "remove", Note: "Portal host already gone"})
		case err != nil || code != 200:
			return stop(fmt.Errorf("could not read Portal host %s (%d): %v", r.HostID, code, err))
		case str(asMap(body)["ip_address"]) != r.IP:
			return stop(fmt.Errorf("Portal host %s is no longer at %s; left alone", r.HostID, r.IP))
		case !created.After(r.Created) || r.MAC == "" || !strings.EqualFold(str(asMap(body)["mac_address"]), r.MAC):
			return stop(fmt.Errorf("Portal host %s is not this run's VM (older than the run, or a different MAC); left alone", r.HostID))
		default:
			if _, code, err := d.API.Write("DELETE", hostPath(r.HostID), nil, nil); err != nil || (code != 200 && code != 204) {
				return stop(fmt.Errorf("removing Portal host: %d %v", code, err))
			}
			emit(Event{Step: "remove", Note: "Portal host removed"})
		}
		r.HostID = ""
		_ = d.Store.Save(r)
	}

	// 4. The reserved IP, through its own state.
	if dir := d.Store.stageDir(r.Change, "ip"); exists(dir) {
		if err := d.checkState(ctx, dir, r.Change); err != nil {
			return stop(err)
		}
		space, _ := d.tfOutput(ctx, d.Store.netDir(), "space_id")
		sub, _ := d.tfOutput(ctx, d.Store.netDir(), "subnet_id")
		if err := d.tf(ctx, "remove", dir, emit, "destroy", "-auto-approve", "-input=false",
			"-var", "change="+r.Change, "-var", "space_id="+space, "-var", "subnet_id="+sub); err != nil {
			return stop(fmt.Errorf("releasing the IP: %w", err))
		}
		emit(Event{Step: "remove", Note: "Released " + r.IP})
	}

	// 5. Nothing tagged with this run may be left.
	if left := d.leftovers(r.Change); len(left) > 0 {
		return stop(fmt.Errorf("still in Infoblox after removal: %s", strings.Join(left, ", ")))
	}
	r.Status = "removed"
	emit(Event{Step: "remove", State: "ok", Note: "Everything this run made is gone. The demo network is kept for the next run."})
	return r, d.Store.Save(r)
}

// checkState refuses to destroy a folder whose state holds anything not tagged
// with this run, which is how a reused or mixed-up folder is caught.
func (d *Demo) checkState(ctx context.Context, dir, change string) error {
	var buf strings.Builder
	if err := d.Run.Run(ctx, Cmd{Name: TerraformBin(), Args: []string{"show", "-json"}, Dir: dir, Env: d.tfEnv()},
		func(l string) { buf.WriteString(l) }); err != nil {
		return fmt.Errorf("reading Terraform state in %s: %w", dir, err)
	}
	var st struct {
		Values struct {
			Root struct {
				Resources []struct {
					Mode    string         `json:"mode"`
					Address string         `json:"address"`
					Values  map[string]any `json:"values"`
				} `json:"resources"`
			} `json:"root_module"`
		} `json:"values"`
	}
	if buf.Len() == 0 {
		return nil // nothing was ever applied here
	}
	if err := json.Unmarshal([]byte(buf.String()), &st); err != nil {
		return fmt.Errorf("Terraform state in %s is unreadable: %w", dir, err)
	}
	for _, res := range st.Values.Root.Resources {
		if res.Mode != "managed" {
			continue
		}
		tags, _ := res.Values["tags"].(map[string]any)
		if str(tags["bloxsmith_change"]) != change {
			return fmt.Errorf("%s in %s is not tagged %s; nothing removed", res.Address, dir, change)
		}
	}
	return nil
}

// removeVM checks the VM is the one this run built (its name, the demo bridge,
// the run ID in its description, its recorded MAC, and the machine answering
// at the run's IP has that MAC), then stops and destroys it with its disk and
// seed. The seed is not required: a build that failed before making it, or one
// that already removed it after joining, still leaves a VM to remove.
func (d *Demo) removeVM(ctx context.Context, r *Run, emit func(Event)) error {
	seed := fmt.Sprintf("/var/lib/vz/template/iso/seed-niosx-%d.iso", r.VMID)
	gone, _ := d.ssh(ctx, "remove", fmt.Sprintf("qm status %d >/dev/null 2>&1 && echo here || echo gone", r.VMID), nil)
	if lastLine(gone) == "gone" {
		// The seed holds the join token; it goes even when the VM is gone.
		if _, err := d.ssh(ctx, "remove", "rm -f "+seed, nil); err != nil {
			return fmt.Errorf("removing the seed disk for VM %d: %w", r.VMID, err)
		}
		emit(Event{Step: "remove", Note: fmt.Sprintf("VM %d already gone", r.VMID)})
		return nil
	}
	if !reMAC.MatchString(r.MAC) {
		return fmt.Errorf("the run record has no valid MAC for VM %d, so it cannot be recognised; left alone", r.VMID)
	}

	check := fmt.Sprintf(`c=$(qm config %[1]d)
echo "$c" | grep -qx 'name: %[2]s'
echo "$c" | grep -q 'bridge=%[3]s'
echo "$c" | grep -q 'Bloxsmith demo %[5]s'
mac=$(echo "$c" | sed -n 's/^net0: virtio=\([^,]*\).*/\1/p' | tr A-Z a-z)
[ "$mac" = '%[6]s' ]
if ping -c1 -W2 %[4]s >/dev/null 2>&1; then ip neigh show %[4]s | grep -qi "$mac"; fi
echo owned`, r.VMID, r.VMName, d.Cfg.Bridge, r.IP, r.Change, r.MAC)
	if out, err := d.ssh(ctx, "remove", check, nil); err != nil || lastLine(out) != "owned" {
		return fmt.Errorf("VM %d does not match what this run built; left alone", r.VMID)
	}
	rm := fmt.Sprintf(`qm stop %[1]d --timeout 60 >/dev/null 2>&1 || true
qm destroy %[1]d --purge 1 --destroy-unreferenced-disks 1
rm -f /var/lib/vz/template/iso/seed-niosx-%[1]d.iso
! qm status %[1]d >/dev/null 2>&1`, r.VMID)
	if _, err := d.ssh(ctx, "remove", rm, emitTo(emit, "remove")); err != nil {
		return fmt.Errorf("removing VM %d: %w", r.VMID, err)
	}
	emit(Event{Step: "remove", Note: fmt.Sprintf("VM %d removed", r.VMID)})
	return nil
}

// leftovers lists object types that still hold something tagged with the run.
func (d *Demo) leftovers(change string) []string {
	var left []string
	tf := fmt.Sprintf("bloxsmith_change==%q", change)
	for _, p := range []string{"/api/ddi/v1/ipam/address", "/api/ddi/v1/dns/auth_zone", "/api/ddi/v1/dns/auth_nsg",
		"/api/ddi/v1/dns/record", "/api/infra/v1/services"} {
		body, code, err := d.API.GetEx(p, map[string]string{"_tfilter": tf, "_fields": "id"})
		if err != nil || code != 200 {
			left = append(left, p+" (could not check)")
			continue
		}
		if rows, _ := asMap(body)["results"].([]any); len(rows) > 0 {
			left = append(left, fmt.Sprintf("%d in %s", len(rows), p))
		}
	}
	return left
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// WouldRemove lists, in plain words, what Teardown would take away for a run.
func WouldRemove(r *Run) []string {
	var out []string
	if r.Zone != "" {
		out = append(out, "DNS zone "+r.Zone+", its name server group and DNS service")
	}
	if r.VMID != 0 {
		out = append(out, fmt.Sprintf("VM %d (%s) with its disk and seed", r.VMID, r.VMName))
	}
	if r.HostID != "" {
		out = append(out, "Portal host "+r.HostID)
	}
	if r.IP != "" {
		out = append(out, "Reserved address "+r.IP)
	}
	return out
}
