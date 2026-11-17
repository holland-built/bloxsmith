package provision

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

// answerFreecheckRead answers freecheck's full inventory reads (the only
// requests that send _order_by) with an empty tenant, so a fake built for one
// create path need not know every list. It reports whether it answered.
func answerFreecheckRead(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodGet || r.URL.Query().Get("_order_by") == "" {
		return false
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"results":[]}`))
	return true
}

// The site's own DHCP range is not free for its hosts. The emea-hq template
// starts a range at offset 5 (templates/emea/production/site-emea-hq.yaml), and
// hosts were numbered .1, .2, .3 ... straight into it.
func TestSiteProvision_HostsSkipTheSiteOwnDHCPRange(t *testing.T) {
	for _, dry := range []bool{true, false} {
		e, _ := newSiteRollbackHarness(t)
		cfg := siteRollbackConfig(dry)
		cfg.CreateReverseZone = false
		cfg.SubnetPlan = []SubnetDef{{Name: "hq-lan", Purpose: "user-lan", Dhcp: "true", DhcpStart: 5, DhcpEnd: 60}}
		cfg.Hosts = nil
		for _, h := range []string{"sw01", "sw02", "sw03", "sw04", "sw05"} {
			cfg.Hosts = append(cfg.Hosts, HostDef{Hostname: h, Subnet: "hq-lan"})
		}
		result, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
		if err != nil {
			t.Fatalf("dry=%v: Provision: %v", dry, err)
		}
		var ips []string
		for _, h := range getList(result, "hosts") {
			ips = append(ips, pyStr(asMap(h)["ip"]))
		}
		want := "10.10.1.1 10.10.1.2 10.10.1.3 10.10.1.4 10.10.1.61"
		if got := strings.Join(ips, " "); got != want {
			t.Fatalf("dry=%v: host addresses = %s, want %s (none inside the DHCP range .5 to .60)", dry, got, want)
		}
		skipped := getList(result, "skipped_picks")
		if len(skipped) != 1 || pyStr(asMap(skipped[0])["reason"]) != "a DHCP range in default already uses 10.10.1.5 to 10.10.1.60" {
			t.Fatalf("dry=%v: skipped_picks = %v, want the DHCP range named once", dry, skipped)
		}
		if c := asMap(result["checked"]); c == nil || c["spaces"] != 1 || c["networks"] != 1 {
			t.Fatalf("dry=%v: checked = %v, want the spaces and networks read", dry, result["checked"])
		}
	}
}

// Infoblox's nextavailablesubnet knows only the block's own space. A pick that
// the same space already uses is refused at Apply, and rollback removes it.
func TestSiteProvision_RefusesInfobloxPickUsedInItsOwnSpace(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.inventorySubnets = `{"id":"ipam/subnet/ours","space":"ipam/ip_space/space-1","address":"10.10.1.0","cidr":24}`
	cfg := siteRollbackConfig(false)
	_, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
	if err == nil || !strings.Contains(err.Error(), "Infoblox picked 10.10.1.0/24 for hq-mgmt, but a subnet in default already uses 10.10.1.0/24") {
		t.Fatalf("Provision error = %v, want the clashing pick refused", err)
	}
	if len(f.deletePaths) != 1 || !strings.Contains(f.deletePaths[0], "ipam/subnet/") {
		t.Fatalf("deletes = %v, want the clashing subnet rolled back", f.deletePaths)
	}
}

const sharedSubnet = `{"id":"ipam/subnet/theirs","space":"ipam/ip_space/space-2","address":"10.10.1.0","cidr":24}`

// sharedEverywhere is another space's network over the whole block: no /24 in
// it is clean.
const sharedEverywhere = `{"id":"ipam/subnet/theirs","space":"ipam/ip_space/space-2","address":"10.10.0.0","cidr":16}`

// Live: Infoblox picks 10.10.1.0/24, which only another space uses, while
// 10.10.0.0/24 is clean. The shared pick is not refused, but the clean one is
// made instead (the owner's rule: a warned one only when none is clean).
func TestSiteProvision_LiveReplacesASharedPickWithTheCleanOne(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.inventorySubnets = sharedSubnet
	cfg := siteRollbackConfig(false)
	cfg.CreateReverseZone = false
	result, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
	if err != nil {
		t.Fatalf("Provision error = %v, want the clean subnet made", err)
	}
	if got := subnetAddrs(result); got != "10.10.0.0/24 10.10.2.0/24" {
		t.Fatalf("subnets = %v, want the clean 10.10.0.0/24 in place of 10.10.1.0/24", got)
	}
	if d := f.deletes(); len(d) != 1 || d[0] != "/api/ddi/v1/ipam/subnet/s-1" {
		t.Fatalf("deletes = %v, want only Infoblox's shared pick removed", d)
	}
	if ws := getList(result, "warnings"); len(ws) != 0 {
		t.Fatalf("warnings = %v, want none", ws)
	}
}

// Live: the clean subnet is checked again against a fresh read once it is
// made, not against the run's earlier read. Something in the site's own space
// that appeared since (10.10.0.0/25 here) is a clash: the clean subnet is
// removed and the step fails, instead of building the site on it.
func TestSiteProvision_LiveRemovesACleanPickThatClashesOnAFreshRead(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.inventorySubnets = sharedSubnet
	f.afterCreate = `{"id":"ipam/subnet/late","space":"ipam/ip_space/space-1","address":"10.10.0.0","cidr":25}`
	cfg := siteRollbackConfig(false)
	cfg.CreateReverseZone = false
	_, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
	if err == nil || !strings.Contains(err.Error(), "10.10.0.0/24") {
		t.Fatalf("Provision error = %v, want the clean 10.10.0.0/24 refused", err)
	}
	if d := f.deletes(); !slices.Contains(d, "/api/ddi/v1/ipam/subnet/s-2") {
		t.Fatalf("deletes = %v, want the clean subnet s-2 removed", d)
	}
}

// Live: once Infoblox's shared pick is removed, a failed create of the clean
// one fails the step; it is not reported as a site with that subnet.
func TestSiteProvision_LiveFailsWhenTheCleanCreateFails(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.inventorySubnets = sharedSubnet
	f.createStatus = 500
	cfg := siteRollbackConfig(false)
	cfg.CreateReverseZone = false
	_, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
	if err == nil || !strings.Contains(err.Error(), "10.10.0.0/24") {
		t.Fatalf("Provision error = %v, want the failed create of 10.10.0.0/24 reported", err)
	}
	if f.hostPosts != 0 {
		t.Fatalf("%d hosts made after the subnet failed", f.hostPosts)
	}
}

// Live: when Infoblox's answer to the clean create is lost (a gateway error),
// the subnet may exist, so the error must not say nothing was made.
func TestSiteProvision_LiveSaysACleanCreateWithNoAnswerMayExist(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.inventorySubnets = sharedSubnet
	f.createStatus = 504
	cfg := siteRollbackConfig(false)
	cfg.CreateReverseZone = false
	_, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
	if err == nil || !strings.Contains(err.Error(), "may have been created") {
		t.Fatalf("Provision error = %v, want it to say 10.10.0.0/24 may have been created", err)
	}
}

// Live: with no clean one anywhere, Infoblox's shared pick is kept, warned.
func TestSiteProvision_LiveKeepsASharedPickWhenNoneIsClean(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.inventorySubnets = sharedEverywhere
	cfg := siteRollbackConfig(false)
	cfg.CreateReverseZone = false
	result, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
	if err != nil {
		t.Fatalf("Provision error = %v, want the pick kept", err)
	}
	if len(f.deletes()) != 0 || subnetAddrs(result) != "10.10.1.0/24 10.10.2.0/24" {
		t.Fatalf("deletes %v, subnets %v: want Infoblox's picks kept", f.deletes(), subnetAddrs(result))
	}
	if ws := getList(result, "warnings"); len(ws) != 2 {
		t.Fatalf("warnings = %v, want one per subnet", ws)
	}
}

// The preview never offers a subnet its own space uses: it offers the next one.
func TestSiteProvision_DryRunOffersTheNextFreeSubnet(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.inventorySubnets = `{"id":"ipam/subnet/ours","space":"ipam/ip_space/space-1","address":"10.10.1.0","cidr":24}`
	cfg := siteRollbackConfig(true)
	cfg.CreateReverseZone = false
	result, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if got := subnetAddrs(result); got != "10.10.0.0/24 10.10.2.0/24" {
		t.Fatalf("subnets = %v, want 10.10.1.0/24 passed over", got)
	}
}

// Preview: Infoblox's pick is shared with another space and a clean one
// exists, so the clean one is offered, and the shared pick is listed skipped.
func TestSiteProvision_DryRunOffersTheCleanOneOverASharedPick(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.inventorySubnets = sharedSubnet
	cfg := siteRollbackConfig(true)
	cfg.CreateReverseZone = false
	result, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if got := subnetAddrs(result); got != "10.10.0.0/24 10.10.2.0/24" {
		t.Fatalf("subnets = %v, want the clean 10.10.0.0/24 offered", got)
	}
	if ws := getList(result, "warnings"); len(ws) != 0 {
		t.Fatalf("warnings = %v, want none", ws)
	}
	sk := getList(result, "skipped_picks")
	if len(sk) == 0 || asMap(sk[0])["candidate"] != "10.10.1.0/24" {
		t.Fatalf("skipped_picks = %v, want the shared pick named", sk)
	}
}

// Preview: with no clean one anywhere, Infoblox's shared pick is offered with
// its warning.
func TestSiteProvision_DryRunOffersASharedPickWhenNoneIsClean(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.inventorySubnets = sharedEverywhere
	cfg := siteRollbackConfig(true)
	cfg.CreateReverseZone = false
	result, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if got := subnetAddrs(result); got != "10.10.1.0/24 10.10.2.0/24" {
		t.Fatalf("subnets = %v, want Infoblox's picks offered", got)
	}
	ws := getList(result, "warnings")
	if len(ws) != 2 || asMap(ws[0])["candidate"] != "10.10.1.0/24" || asMap(ws[0])["object"] != "10.10.0.0/16" {
		t.Fatalf("warnings = %v, want 10.10.1.0/24 inside 10.10.0.0/16", ws)
	}
	if c := asMap(result["checked"]); c["shared"] != 2 {
		t.Fatalf("checked = %v, want shared 2", result["checked"])
	}
}

func subnetAddrs(result M) string {
	var got []string
	for _, s := range getList(result, "subnets") {
		got = append(got, pyStr(asMap(s)["address"]))
	}
	return strings.Join(got, " ")
}

// blockServer answers a block template's reads with one subnet, subnetRow, and
// counts the POSTs.
func blockServer(t *testing.T, subnetRow string, posts *int) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		q := r.URL.Query()
		switch {
		case r.Method == http.MethodPost:
			*posts++
			w.WriteHeader(201)
			w.Write([]byte(`{"result":{"id":"ipam/address_block/new"}}`))
		case q.Get("_offset") != "" && q.Get("_offset") != "0":
			w.Write([]byte(`{"results":[]}`))
		case strings.HasSuffix(r.URL.Path, "/ipam/ip_space"):
			w.Write([]byte(`{"results":[{"id":"ipam/ip_space/space-1","name":"default"},{"id":"ipam/ip_space/space-2","name":"lab"}]}`))
		case strings.HasSuffix(r.URL.Path, "/ipam/subnet") && q.Get("_order_by") != "":
			w.Write([]byte(`{"results":[` + subnetRow + `]}`))
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// A template block that overlaps a subnet in its own IP space is not created,
// in the preview or live; the old existence check matched only the exact same
// block in the same space.
func TestBlockProvision_RefusesABlockItsOwnSpaceOverlaps(t *testing.T) {
	for _, dry := range []bool{true, false} {
		var posts int
		srv := blockServer(t, `{"id":"ipam/subnet/ours","space":"ipam/ip_space/space-1","address":"10.20.5.0","cidr":24}`, &posts)
		cfg := &BlockConfig{Name: "pool", IPSpace: "default", DryRun: dry, ExtraTags: M{},
			Blocks: []any{M{"address": "10.20.0.0", "cidr": 16, "status": "deployed"}}}
		_, err := newTestEngine(srv).NewBlockProvisioner(cfg, func(M) {}).Provision(false)
		if err == nil || !strings.Contains(err.Error(), "Block 10.20.0.0/16 is not free: a subnet in default already uses 10.20.5.0/24") {
			t.Fatalf("dry=%v: Provision error = %v, want the overlap named", dry, err)
		}
		if posts != 0 {
			t.Fatalf("dry=%v: %d POST(s), want none", dry, posts)
		}
	}
}

// A template block that overlaps only a subnet in ANOTHER IP space is made,
// in the preview and live, with a warning.
func TestBlockProvision_MakesABlockOnlyAnotherSpaceOverlaps(t *testing.T) {
	for _, dry := range []bool{true, false} {
		var posts int
		srv := blockServer(t, `{"id":"ipam/subnet/theirs","space":"ipam/ip_space/space-2","address":"10.20.5.0","cidr":24}`, &posts)
		cfg := &BlockConfig{Name: "pool", IPSpace: "default", DryRun: dry, ExtraTags: M{},
			Blocks: []any{M{"address": "10.20.0.0", "cidr": 16, "status": "deployed"}}}
		result, err := newTestEngine(srv).NewBlockProvisioner(cfg, func(M) {}).Provision(false)
		if err != nil {
			t.Fatalf("dry=%v: Provision error = %v, want the block made", dry, err)
		}
		if want := map[bool]int{true: 0, false: 1}[dry]; posts != want {
			t.Fatalf("dry=%v: %d POST(s), want %d", dry, posts, want)
		}
		ws := getList(result, "warnings")
		if len(ws) != 1 || asMap(ws[0])["space"] != "lab" || asMap(ws[0])["contains"] != false {
			t.Fatalf("dry=%v: warnings = %v, want lab's subnet, inside the block", dry, result["warnings"])
		}
	}
}

// Site and block provisioning read what is in use only around the block they
// use (every IP space), not across the whole tenant: about 60 s on a large one.
// checked.around names the span read; a whole-tenant read has none.
func TestSiteProvision_ReadsOnlyAroundTheChosenBlock(t *testing.T) {
	for _, dry := range []bool{true, false} {
		e, _ := newSiteRollbackHarness(t)
		cfg := siteRollbackConfig(dry)
		cfg.CreateReverseZone = false
		result, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
		if err != nil {
			t.Fatalf("dry=%v: Provision: %v", dry, err)
		}
		block := pyStr(result["block_address"])
		if got := pyStr(asMap(result["checked"])["around"]); block != "10.10.0.0/16" || got != "10.10.0.0 to 10.10.255.255" {
			t.Fatalf("dry=%v: block %s read around %q, want 10.10.0.0 to 10.10.255.255", dry, block, got)
		}
	}
}

func TestBlockProvision_ReadsOnlyAroundEachTopLevelBlock(t *testing.T) {
	for _, dry := range []bool{true, false} {
		var filters []string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			q := r.URL.Query()
			switch {
			case r.Method == http.MethodPost:
				w.WriteHeader(201)
				w.Write([]byte(`{"result":{"id":"ipam/address_block/new"}}`))
			case q.Get("_offset") != "" && q.Get("_offset") != "0":
				w.Write([]byte(`{"results":[]}`))
			case strings.HasSuffix(r.URL.Path, "/ipam/ip_space"):
				w.Write([]byte(`{"results":[{"id":"ipam/ip_space/space-1","name":"default"}]}`))
			default:
				if q.Get("_order_by") != "" && strings.HasSuffix(r.URL.Path, "/ipam/subnet") {
					filters = append(filters, q.Get("_filter"))
				}
				w.Write([]byte(`{"results":[]}`))
			}
		}))
		defer srv.Close()
		cfg := &BlockConfig{Name: "pool", IPSpace: "default", DryRun: dry, ExtraTags: M{},
			Blocks: []any{M{"address": "10.20.0.0", "cidr": 16, "status": "deployed"},
				M{"address": "10.40.0.0", "cidr": 16, "status": "deployed"}}}
		result, err := newTestEngine(srv).NewBlockProvisioner(cfg, func(M) {}).Provision(false)
		if err != nil {
			t.Fatalf("dry=%v: Provision: %v", dry, err)
		}
		got := pyStr(asMap(result["checked"])["around"])
		if got != "10.20.0.0 to 10.20.255.255, 10.40.0.0 to 10.40.255.255" || len(filters) != 2 {
			t.Fatalf("dry=%v: read around %q with subnet filters %v, want one read per top-level block", dry, got, filters)
		}
	}
}
