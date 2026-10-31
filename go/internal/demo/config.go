// Package demo runs the "Demo server" walkthrough: take the next free IP from
// Infoblox, build a NIOS-X VM on Proxmox with it, give it DNS, prove it answers,
// and tear down exactly what the run made. Infoblox objects are created by
// OpenTofu or Terraform from the files under files/terraform; the VM is built
// over SSH with the same steps proxblox uses.
package demo

import (
	"fmt"
	"net"
	"regexp"
	"strings"
)

// Config is what an SE fills in once. It is kept in the encrypted vault because
// the join token is a secret; the rest is not, but lives beside it.
type Config struct {
	PVE       string `json:"pve"`       // SSH target, e.g. root@192.168.100.2
	PVEName   string `json:"pveName"`   // short DNS name for the Proxmox host, e.g. lab
	PVEIP     string `json:"pveIp"`     // the Proxmox host's address, answered for PVEName
	Pool      string `json:"pool"`      // Proxmox storage for the disk, e.g. local-zfs
	Bridge    string `json:"bridge"`    // the demo bridge, e.g. vmbr9
	Subnet    string `json:"subnet"`    // the demo network on that bridge, e.g. 10.99.0.0/24
	Gateway   string `json:"gateway"`   // the bridge's address, e.g. 10.99.0.1
	Image     string `json:"image"`     // NIOS-X On-Prem qcow2 on this machine
	Owner     string `json:"owner"`     // VM name prefix, e.g. sholland
	JoinToken string `json:"joinToken"` // NIOS-X join token; never shown back
	RAM       int    `json:"ram"`       // MB
	Cores     int    `json:"cores"`
	Disk      string `json:"disk"` // e.g. 64G
}

// Defaults fills the sizes with Infoblox's smallest supported NIOS-X VM.
func (c Config) Defaults() Config {
	if c.RAM == 0 {
		c.RAM = 4096
	}
	if c.Cores == 0 {
		c.Cores = 3
	}
	if c.Disk == "" {
		c.Disk = "64G"
	}
	return c
}

var (
	reSSH    = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9.-]{1,253}$`)
	reWord   = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)
	reLabel  = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	reOwner  = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$`)
	reDisk   = regexp.MustCompile(`^[1-9][0-9]{1,3}G$`)
	reImage  = regexp.MustCompile(`^/[A-Za-z0-9 _./+-]+\.qcow2$`)
	reToken  = regexp.MustCompile(`^[A-Za-z0-9+/=._-]{20,1000}$`)
	reChange = regexp.MustCompile(`^c-[0-9]{8}-[0-9]{6}$`)
	reMAC    = regexp.MustCompile(`^([0-9a-f]{2}:){5}[0-9a-f]{2}$`)
)

// Problems lists every field that is missing or unsafe, in plain words. Every
// value here ends up inside a shell command on the Proxmox host or a Terraform
// variable, so anything outside these shapes is refused rather than quoted.
func (c Config) Problems() []string {
	var p []string
	if !reSSH.MatchString(c.PVE) {
		p = append(p, "Proxmox SSH login should look like jsmith@10.0.0.2")
	}
	if !reLabel.MatchString(c.PVEName) {
		p = append(p, "Proxmox host name should be a short name like lab")
	}
	if ip := net.ParseIP(c.PVEIP); ip == nil || ip.To4() == nil {
		p = append(p, "Proxmox host address should be an IPv4 address")
	}
	if !reWord.MatchString(c.Pool) {
		p = append(p, "Storage pool should be a name like local-zfs")
	}
	if !reWord.MatchString(c.Bridge) {
		p = append(p, "Bridge should be a name like vmbr9")
	}
	_, n, err := net.ParseCIDR(c.Subnet)
	if err != nil || n.IP.To4() == nil || n.String() != c.Subnet {
		p = append(p, "Demo network should be written like 10.99.0.0/24")
	} else if gw := net.ParseIP(c.Gateway); gw == nil || !n.Contains(gw) || gw.Equal(n.IP) {
		p = append(p, "Gateway should be an address inside the demo network, like 10.99.0.1")
	}
	if !reImage.MatchString(c.Image) {
		p = append(p, "Image should be the full path to the NIOS-X .qcow2 file")
	}
	if !reOwner.MatchString(c.Owner) {
		p = append(p, "Owner should be a short lowercase name like jsmith")
	}
	if !reToken.MatchString(c.JoinToken) {
		p = append(p, "Join token is missing")
	}
	if c.RAM < 4096 || c.RAM > 65536 || c.Cores < 1 || c.Cores > 32 || !reDisk.MatchString(c.Disk) {
		p = append(p, "VM size is outside 4-64 GB RAM, 1-32 cores, or a disk like 64G")
	}
	return p
}

// SubnetParts splits the demo network into the address and prefix Terraform wants.
func (c Config) SubnetParts() (string, int) {
	_, n, err := net.ParseCIDR(c.Subnet)
	if err != nil {
		return "", 0
	}
	ones, _ := n.Mask.Size()
	return n.IP.String(), ones
}

// Public is the config with the join token replaced by whether one is set.
func (c Config) Public() map[string]any {
	return map[string]any{
		"pve": c.PVE, "pveName": c.PVEName, "pveIp": c.PVEIP, "pool": c.Pool,
		"bridge": c.Bridge, "subnet": c.Subnet, "gateway": c.Gateway, "image": c.Image,
		"owner": c.Owner, "ram": c.RAM, "cores": c.Cores, "disk": c.Disk,
		"hasJoinToken": strings.TrimSpace(c.JoinToken) != "",
	}
}

func validChange(ch string) error {
	if !reChange.MatchString(ch) {
		return fmt.Errorf("not a demo run id: %q", ch)
	}
	return nil
}
