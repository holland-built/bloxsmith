package demo

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// remoteImageDir is where proxblox keeps shipped images on the Proxmox host,
// so an image proxblox already copied is reused.
const remoteImageDir = "/var/lib/vz/template/qcow"

// ssh runs a script on the Proxmox host. The script goes on stdin so nothing
// in it, the join token included, appears in a process list.
func (d *Demo) ssh(ctx context.Context, step, script string, line func(string)) (string, error) {
	var out []string
	red := d.secrets()
	err := d.Run.Run(ctx, Cmd{
		Name:  "ssh",
		Args:  []string{"-o", "BatchMode=yes", "-o", "ConnectTimeout=10", d.Cfg.PVE, "bash", "-s"},
		Stdin: "set -euo pipefail\n" + script + "\n",
	}, func(l string) {
		l = red.clean(l)
		out = append(out, l)
		if line != nil {
			line(l)
		}
	})
	return strings.Join(out, "\n"), err
}

// buildVM does what proxblox's deploy does, with the IP set at first boot.
// The VMID is saved the moment it is allocated, before anything else, so a
// failure at any later point still leaves teardown a recorded ID to remove.
func (d *Demo) buildVM(ctx context.Context, r *Run, emit func(Event)) error {
	c := d.Cfg.Defaults()
	say := emitTo(emit, "vm")

	// A never-reused VMID from proxblox's counter on the host.
	out, err := d.ssh(ctx, "vm", `mkdir -p /etc/niosx
exec 9>/etc/niosx/.vmid.lock; flock 9
last=$(cat /etc/niosx/last_vmid 2>/dev/null || echo 200)
case "$last" in ""|*[!0-9]*) last=200 ;; esac
[ "$last" -ge 200 ] || last=200
n=$((last + 1))
while qm status "$n" >/dev/null 2>&1; do n=$((n + 1)); done
printf "%s\n" "$n" > /etc/niosx/last_vmid
echo "VMID=$n"`, nil)
	if err != nil {
		return fmt.Errorf("could not allocate a VMID: %w", err)
	}
	id, err := strconv.Atoi(strings.TrimPrefix(lastLine(out), "VMID="))
	if err != nil || id < 200 {
		return fmt.Errorf("unexpected VMID answer %q", lastLine(out))
	}
	r.VMID, r.VMName = id, fmt.Sprintf("%s-%d", c.Owner, id)
	if err := d.Store.Save(r); err != nil {
		return err
	}
	emit(Event{Step: "vm", Note: fmt.Sprintf("VM %d (%s)", id, r.VMName)})

	// Ship the image once; later runs reuse it.
	base := filepath.Base(c.Image)
	remote := remoteImageDir + "/" + base
	if _, err := d.ssh(ctx, "vm", fmt.Sprintf(`qemu-img info --output=json '%s' | grep -q '"format": "qcow2"'`, remote), nil); err != nil {
		if _, err := os.Stat(c.Image); err != nil {
			return fmt.Errorf("the NIOS-X image is not on Proxmox, and not at %s on this machine either", c.Image)
		}
		emit(Event{Step: "vm", Line: "Copying the NIOS-X image to Proxmox (once, about 3 GB)…"})
		if _, err := d.ssh(ctx, "vm", "mkdir -p "+remoteImageDir, nil); err != nil {
			return err
		}
		if err := d.Run.Run(ctx, Cmd{Name: "rsync", Args: []string{"-a", c.Image, c.PVE + ":" + remote}}, say); err != nil {
			return fmt.Errorf("copying the image: %w", err)
		}
	}

	ip := r.IP
	_, ones := c.SubnetParts()
	script := fmt.Sprintf(`if qm status %[1]d >/dev/null 2>&1; then echo "VMID %[1]d appeared since it was allocated" >&2; exit 1; fi
qm create %[1]d --name %[2]s --machine q35 --ostype l26 --memory %[3]d --balloon %[3]d --cores %[4]d \
  --scsihw virtio-scsi-single --net0 virtio,bridge=%[5]s --serial0 socket --vga serial0 \
  --description "Bloxsmith demo %[6]s"
MAC=$(qm config %[1]d | sed -n 's/^net0: virtio=\([^,]*\).*/\1/p' | tr A-Z a-z)
echo "MAC=$MAC"
qm importdisk %[1]d '%[7]s' %[8]s >/dev/null
qm set %[1]d --scsi0 %[8]s:vm-%[1]d-disk-0,discard=on,ssd=1 --boot order=scsi0 >/dev/null
qm resize %[1]d scsi0 %[9]s
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT; cd "$D"
cat > user-data <<'YAML'
#cloud-config
host_setup:
  jointoken: "%[10]s"
YAML
printf 'instance-id: niosx-%[1]d-%%s\nlocal-hostname: %[2]s\n' "$(date +%%s)" > meta-data
cat > network-config <<YAML
version: 2
ethernets:
  nic0:
    match: { macaddress: "$MAC" }
    addresses: [%[11]s/%[12]d]
    gateway4: %[13]s
    nameservers: { addresses: [1.1.1.1, 8.8.8.8] }
YAML
genisoimage -quiet -output /var/lib/vz/template/iso/seed-niosx-%[1]d.iso -volid cidata -joliet -rock user-data meta-data network-config
chmod 600 /var/lib/vz/template/iso/seed-niosx-%[1]d.iso
qm set %[1]d --ide2 local:iso/seed-niosx-%[1]d.iso,media=cdrom >/dev/null
qm start %[1]d
echo "started"`,
		id, r.VMName, c.RAM, c.Cores, c.Bridge, r.Change, remote, c.Pool, c.Disk, c.JoinToken, ip, ones, c.Gateway)
	out, err = d.ssh(ctx, "vm", script, say)
	// The MAC is recorded even when a later line failed, so teardown can match it.
	for _, l := range strings.Split(out, "\n") {
		if m, ok := strings.CutPrefix(strings.TrimSpace(l), "MAC="); ok && reMAC.MatchString(m) {
			r.MAC = m
			_ = d.Store.Save(r)
		}
	}
	if err != nil {
		return fmt.Errorf("building VM %d: %w", id, err)
	}
	if r.MAC == "" {
		return fmt.Errorf("VM %d did not report its MAC, which teardown needs to recognise it", id)
	}
	return d.Store.Save(r)
}

// dropSeed takes the seed disk, which holds the join token, off the VM once it
// has joined. It is only read at first boot. A failure here is reported, not
// fatal: teardown removes the seed as well.
func (d *Demo) dropSeed(ctx context.Context, r *Run, emit func(Event)) {
	_, err := d.ssh(ctx, "join", fmt.Sprintf(`qm set %[1]d --delete ide2 >/dev/null
rm -f /var/lib/vz/template/iso/seed-niosx-%[1]d.iso`, r.VMID), nil)
	if err != nil {
		emit(Event{Step: "join", Line: "Could not remove the seed disk yet; teardown will"})
		return
	}
	emit(Event{Step: "join", Note: "Removed the seed disk that held the join token"})
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[i+1:])
	}
	return s
}
