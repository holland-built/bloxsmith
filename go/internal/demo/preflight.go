package demo

import (
	"context"
	"os"
	"path/filepath"
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
	// The network step creates the bloxsmith-demo IP space. If one exists that
	// this app's state does not know about, the build would stop halfway.
	if !exists(d.Store.netDir() + "/terraform.tfstate") {
		body, code, err := d.API.GetEx("/api/ddi/v1/ipam/ip_space", map[string]string{"_filter": `name=="bloxsmith-demo"`, "_fields": "id"})
		rows, _ := asMap(body)["results"].([]any)
		add(err == nil && code == 200 && len(rows) == 0, "The bloxsmith-demo IP space is free to create",
			"An IP space named bloxsmith-demo already exists, made by another copy of Bloxsmith. Delete it in the Infoblox Portal (when no demo is running), then preview again")
	}
	_, lerr := os.Stat(d.Cfg.Image)
	tools, err := d.ssh(ctx, "check", `for t in qm genisoimage dig flock; do command -v $t >/dev/null || echo "missing $t"; done
ip -br addr show `+d.Cfg.Bridge+` | grep -q '`+d.Cfg.Gateway+`/' || echo "bridge"
test -f '`+remoteImageDir+"/"+filepath.Base(d.Cfg.Image)+`' && echo "has-image"
echo checked`, nil)
	// The image is needed here only if Proxmox does not have it yet.
	add(lerr == nil || strings.Contains(tools, "has-image"), "The NIOS-X image is on Proxmox or on this machine",
		"Download the NIOS-X On-Prem qcow2 from the Infoblox Portal to "+d.Cfg.Image)
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
