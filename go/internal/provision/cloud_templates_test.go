package provision

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// A host's optional offset is where its address search starts. Without one,
// the first host of a subnet still starts at .1, as it always has.
func TestSiteProvision_HostOffset(t *testing.T) {
	for _, dry := range []bool{true, false} {
		e, _ := newSiteRollbackHarness(t)
		cfg := siteRollbackConfig(dry)
		cfg.CreateReverseZone = false
		cfg.SubnetPlan = []SubnetDef{{Name: "hq-mgmt", Purpose: "mgmt", Dhcp: "false"}}
		cfg.Hosts = []HostDef{
			{Hostname: "app01", Subnet: "hq-mgmt", Offset: 4},
			{Hostname: "app02", Subnet: "hq-mgmt"},
		}
		result, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
		if err != nil {
			t.Fatalf("dry=%v: Provision: %v", dry, err)
		}
		if got := hostIPs(result); got != "10.10.1.4 10.10.1.5" {
			t.Fatalf("dry=%v: host addresses = %s, want 10.10.1.4 10.10.1.5", dry, got)
		}
	}
}

func TestSiteProvision_NoOffsetStillStartsAtOne(t *testing.T) {
	tpl, err := New(nil, "../../templates").LoadTemplate("amer/production/site-amer-hq.yaml")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := TemplateToSiteConfig(tpl, M{"dry": "1"})
	if err != nil {
		t.Fatal(err)
	}
	for _, h := range cfg.Hosts {
		if h.Offset != 0 {
			t.Fatalf("host %s has offset %d from a template that sets none", h.Hostname, h.Offset)
		}
	}
	e, _ := newSiteRollbackHarness(t)
	rc := siteRollbackConfig(true)
	rc.CreateReverseZone = false
	rc.SubnetPlan = []SubnetDef{{Name: "hq-mgmt", Purpose: "mgmt", Dhcp: "false"}}
	rc.Hosts = []HostDef{{Hostname: "sw01", Subnet: "hq-mgmt"}, {Hostname: "fw01", Subnet: "hq-mgmt"}}
	result, err := e.NewSiteProvisioner(rc, func(M) {}).Provision()
	if err != nil {
		t.Fatal(err)
	}
	if got := hostIPs(result); got != "10.10.1.1 10.10.1.2" {
		t.Fatalf("host addresses = %s, want 10.10.1.1 10.10.1.2", got)
	}
}

func hostIPs(result M) string {
	var ips []string
	for _, h := range getList(result, "hosts") {
		ips = append(ips, pyStr(asMap(h)["ip"]))
	}
	return strings.Join(ips, " ")
}

func TestValidateSite_HostOffset(t *testing.T) {
	base := func(offset any) M {
		return M{
			"site": M{"name": "x", "region": "AWS", "environment": "production"},
			"network": M{"ip_space": "default", "subnets": []any{
				M{"name": "lan", "purpose": "p", "cidr": 28, "dhcp": true, "dhcp_start": 8, "dhcp_end": 12},
			}},
			"hosts": []any{M{"hostname": "h", "subnet": "lan", "offset": offset}},
		}
	}
	cases := []struct {
		offset any
		want   string
	}{
		{4, ""},
		{13, ""},
		{"four", "Must be an integer"},
		{0, "outside 1-14"},
		{15, "outside 1-14"},
		{10, "inside the subnet's DHCP range"},
	}
	for _, c := range cases {
		res := ValidateTemplate(base(c.offset), "t")
		errs := fmt.Sprint(res["errors"])
		if c.want == "" && res["valid"] != true {
			t.Fatalf("offset %v: errors = %s, want valid", c.offset, errs)
		}
		if c.want != "" && !strings.Contains(errs, c.want) {
			t.Fatalf("offset %v: errors = %s, want %q", c.offset, errs, c.want)
		}
	}
}

// Every cloud site template keeps its hosts and DHCP ranges off the addresses
// the cloud keeps for itself: AWS and Azure the network address, +1 to +3 and
// the last; Google Cloud the network address, +1, the second-to-last and the
// last. AWS subnets are /28 or larger, the smallest AWS accepts.
func TestCloudSiteTemplates_AvoidReservedAddresses(t *testing.T) {
	e := New(nil, "../../templates")
	reserved := func(cloud string, cidr int) map[int]bool {
		last := 1<<(32-cidr) - 1
		if cloud == "gcp" {
			return map[int]bool{0: true, 1: true, last - 1: true, last: true}
		}
		return map[int]bool{0: true, 1: true, 2: true, 3: true, last: true}
	}
	for _, cloud := range []string{"aws", "azure", "gcp"} {
		paths, unreadable := e.SiteTemplateRelPaths([]string{cloud})
		if len(unreadable) > 0 || len(paths) == 0 {
			t.Fatalf("%s: templates = %v, unreadable = %v, want at least one site", cloud, paths, unreadable)
		}
		for _, rel := range paths {
			tpl, err := e.LoadTemplate(rel)
			if err != nil {
				t.Fatalf("%s: %v", rel, err)
			}
			if res := ValidateTemplate(tpl, rel); res["valid"] != true {
				t.Fatalf("%s: invalid: %v", rel, res["errors"])
			}
			if hs := getList(tpl, "hosts"); len(hs) == 0 {
				t.Fatalf("%s: no hosts listed, so the provisioner would add a default gw01 on .1", rel)
			}
			cfg, err := TemplateToSiteConfig(tpl, M{"dry": "1"})
			if err != nil {
				t.Fatalf("%s: %v", rel, err)
			}
			cidrOf := map[string]int{}
			for _, s := range cfg.SubnetPlan {
				cidr, ok := intCoerce(s.Cidr)
				if !ok {
					cidr = cfg.SubnetSize
				}
				cidrOf[s.Name] = cidr
				if cloud == "aws" && cidr > 28 {
					t.Fatalf("%s: subnet %s is /%d; AWS refuses subnets smaller than /28", rel, s.Name, cidr)
				}
				if s.Dhcp != "true" {
					continue
				}
				start, _, _ := resolvedOffset(M{"dhcp_start": s.DhcpStart}, "dhcp_start", dhcpStartDefault)
				end, _, _ := resolvedOffset(M{"dhcp_end": s.DhcpEnd}, "dhcp_end", dhcpEndDefault)
				for o := start; o <= end; o++ {
					if reserved(cloud, cidr)[o] {
						t.Fatalf("%s: subnet %s DHCP range %d-%d covers reserved offset %d", rel, s.Name, start, end, o)
					}
				}
			}
			// Hosts in one subnet take consecutive addresses from their offset.
			next := map[string]int{}
			for _, h := range cfg.Hosts {
				if h.Offset == 0 {
					t.Fatalf("%s: host %s has no offset, so it would start at reserved .1", rel, h.Hostname)
				}
				o := h.Offset
				if n := next[h.Subnet]; n > o {
					o = n
				}
				next[h.Subnet] = o + 1
				if reserved(cloud, cidrOf[h.Subnet])[o] {
					t.Fatalf("%s: host %s lands on reserved offset %d of %s", rel, h.Hostname, o, h.Subnet)
				}
			}
		}
	}
	if _, err := e.LoadTemplate(filepath.Join("blocks", "cloud_address_blocks.yaml")); err != nil {
		t.Fatalf("cloud blocks template: %v", err)
	}
}
