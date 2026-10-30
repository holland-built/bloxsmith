package demo

import (
	"context"
	"os"
	"strings"
)

// Check is one thing the build needs, and whether it is there.
type Check struct {
	OK   bool   `json:"ok"`
	Says string `json:"says"`
	Fix  string `json:"fix,omitempty"`
}

// Preflight reads only. It is what the page shows before Build is pressed.
func (d *Demo) Preflight(ctx context.Context) []Check {
	var out []Check
	add := func(ok bool, says, fix string) { out = append(out, Check{ok, says, fix}) }

	probs := d.Cfg.Problems()
	add(len(probs) == 0, "Demo settings are filled in", strings.Join(probs, ". "))
	add(d.Key != "", "An Infoblox API key is active", "Unlock the vault, or switch back from a portal account to the key")
	add(TerraformBin() != "", "OpenTofu or Terraform is installed", "brew install opentofu")
	if len(probs) > 0 {
		return out
	}
	_, err := os.Stat(d.Cfg.Image)
	add(err == nil, "The NIOS-X image is on this machine", "Download the NIOS-X On-Prem qcow2 from the Infoblox Portal to "+d.Cfg.Image)
	tools, err := d.ssh(ctx, "check", `for t in qm genisoimage dig flock; do command -v $t >/dev/null || echo "missing $t"; done
ip -br addr show `+d.Cfg.Bridge+` | grep -q '`+d.Cfg.Gateway+`/' || echo "bridge"
echo checked`, nil)
	reach := err == nil && strings.Contains(tools, "checked")
	add(reach, "Proxmox answers over SSH without a password", "Set up an SSH key for "+d.Cfg.PVE)
	if reach {
		add(!strings.Contains(tools, "missing"), "Proxmox has qm, genisoimage, dig and flock", "On Proxmox: apt install genisoimage dnsutils")
		add(!strings.Contains(tools, "bridge"), "The demo bridge "+d.Cfg.Bridge+" is up with "+d.Cfg.Gateway, "Add the bridge with NAT on Proxmox; see the Demo server docs")
	}
	return out
}

// Ready says whether every check passed.
func Ready(cs []Check) bool {
	for _, c := range cs {
		if !c.OK {
			return false
		}
	}
	return len(cs) > 0
}
