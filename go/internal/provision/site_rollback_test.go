package provision

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// ROLLBACK AFTER A HALF-FINISHED SITE PROVISION.
//
// Scope of this file: SiteProvisioner.rollback and the one branch in Provision
// that reaches it. Nothing here pins TemplateToSiteConfig, findAvailableBlock's
// sort key, the DHCP offset arithmetic, or the host-skip paths.
//
// The claim under test is narrow and destructive, and it is the OPPOSITE of the
// block rollback's claim. There, everything recorded was created by the run, so
// everything recorded may be deleted. A site run REUSES objects it finds: a
// forward zone that is already there, and — far more often — a reverse zone,
// because in-addr.arpa zones are cut at /16 or /8 and shared by every subnet
// underneath. Rolling those back deletes a customer's live DNS.
//
// So the assertions are on the recorded DELETE sequence, never on the returned
// error. An error assertion goes green whether rollback deleted the right
// objects, the wrong objects, or never ran at all — and "the wrong objects" is
// the entire failure mode this file exists to catch.
//
// NO TEST HERE TOUCHES A REAL TENANT. Everything runs against httptest.

// siteRollbackFake is an Infoblox stand-in for the whole site create path.
//
// It branches on METHOD BEFORE PATH for the same reason blockRollbackFake does
// (block_test.go:33): the site path collides with itself far worse. GET and
// POST /dns/auth_zone are the existence check and the create; PATCH
// /ipam/subnet/<id> and GET /ipam/subnet are the tagging write and the
// already-provisioned check; and every rollback DELETE path CONTAINS one of
// those strings as a prefix. Keyed on path alone, a create would be answered
// with an existence fixture and the file would go green for the wrong reason.
type siteRollbackFake struct {
	mu sync.Mutex

	// deletePaths is every DELETE path in arrival order. The order is the
	// point: rollback must undo in reverse dependency order, and only a
	// recorded sequence can fail when it doesn't.
	deletePaths []string

	// Recorded so a test can prove the run really got far enough for the thing
	// it asserts about to be a decision rather than an empty run.
	hostPosts int
	zonePosts int

	subnetSeq  int
	zoneSeq    int
	rangeSeq   int
	previewIdx int

	// subnets holds each subnet the fake handed out, keyed by id. createSubnet
	// PATCHes the new subnet to tag it and then REPLACES its local copy with the
	// PATCH response, so the fake has to echo the whole object back — answering
	// `{"result":{}}` blanks the id and address and every later assertion would
	// be about an empty map.
	subnets map[string]M

	// --- knobs. Each test flips only the one it is about. -------------------

	// previewAddrs is the sequence of addresses nextavailablesubnet hands out,
	// one per subnet in plan order, so a test can name the subnets it expects.
	previewAddrs []string

	// hostStatus is the failure injector: the status POST /ipam/host answers
	// with. The host create is the LAST step of a site provision, so failing it
	// is the only way to reach rollback with every earlier object recorded.
	hostStatus int

	// hostStatusFor overrides hostStatus per host create, n being 1-based in
	// arrival order. A single status cannot express the case that matters most:
	// a run that creates several hosts successfully and THEN fails, which is the
	// only shape under which hosts can be left stranded upstream. Nil for every
	// test that does not care, so hostStatus keeps its meaning.
	hostStatusFor func(n int) int

	// deleteStatus lets one test make a specific DELETE fail.
	deleteStatus func(path string) int

	// existingForward / existingReverse are what the tenant ALREADY holds,
	// keyed by the fqdn as it appears in the _filter. An fqdn absent from the
	// map is genuinely not there and gets created. Two maps rather than one so
	// a test states which KIND of zone it is reusing; the handler picks between
	// them on "in-addr.arpa" in the filter, which is the only thing that
	// distinguishes the two lookups on the wire.
	existingForward map[string]string
	existingReverse map[string]string
}

func (f *siteRollbackFake) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch r.Method {
		case http.MethodDelete:
			f.mu.Lock()
			f.deletePaths = append(f.deletePaths, r.URL.Path)
			status := 200
			if f.deleteStatus != nil {
				status = f.deleteStatus(r.URL.Path)
			}
			f.mu.Unlock()
			w.WriteHeader(status)
			w.Write([]byte(`{}`))
			return

		case http.MethodPatch:
			id := strings.TrimPrefix(r.URL.Path, "/api/ddi/v1/")
			f.mu.Lock()
			s := f.subnets[id]
			f.mu.Unlock()
			if s == nil {
				w.WriteHeader(404)
				w.Write([]byte(`{"error":"no such subnet"}`))
				return
			}
			w.WriteHeader(200)
			json.NewEncoder(w).Encode(M{"result": s})
			return

		case http.MethodPost:
			switch {
			case strings.HasSuffix(r.URL.Path, "/nextavailablesubnet"):
				id, addr := f.nextSubnet(true)
				w.WriteHeader(201)
				fmt.Fprintf(w, `{"results":[{"id":%q,"address":%q,"cidr":24}]}`, id, addr)

			case strings.HasSuffix(r.URL.Path, "/ipam/range"):
				f.mu.Lock()
				f.rangeSeq++
				n := f.rangeSeq
				f.mu.Unlock()
				w.WriteHeader(201)
				fmt.Fprintf(w, `{"result":{"id":"ipam/range/r-%d"}}`, n)

			case strings.HasSuffix(r.URL.Path, "/dns/auth_zone"):
				// Ids self-describe which zone they are (created-fwd / created-rev)
				// so a wrong DELETE in the asserted sequence names itself.
				fqdn := pyStr(decodeBody(r)["fqdn"])
				kind := "fwd"
				if strings.Contains(fqdn, "in-addr.arpa") {
					kind = "rev"
				}
				f.mu.Lock()
				f.zoneSeq++
				f.zonePosts++
				n := f.zoneSeq
				f.mu.Unlock()
				w.WriteHeader(201)
				fmt.Fprintf(w, `{"result":{"id":"dns/auth_zone/created-%s-%d","fqdn":%q}}`, kind, n, fqdn)

			case strings.HasSuffix(r.URL.Path, "/ipam/host"):
				f.mu.Lock()
				f.hostPosts++
				n := f.hostPosts
				status := f.hostStatus
				if f.hostStatusFor != nil {
					status = f.hostStatusFor(n)
				}
				f.mu.Unlock()
				w.WriteHeader(status)
				if status == 200 || status == 201 {
					fmt.Fprintf(w, `{"result":{"id":"ipam/host/h-%d"}}`, n)
					return
				}
				w.Write([]byte(`{"error":"host create refused"}`))

			default:
				w.WriteHeader(201)
				w.Write([]byte(`{"result":{}}`))
			}
			return
		}

		// GET only, past here.
		switch {
		case strings.HasSuffix(r.URL.Path, "/nextavailablesubnet"):
			// The dry-run preview reads the same endpoint it would POST to.
			_, addr := f.nextSubnet(false)
			fmt.Fprintf(w, `{"results":[{"address":%q}]}`, addr)

		case strings.HasSuffix(r.URL.Path, "/ipam/ip_space"):
			w.Write([]byte(`{"results":[{"id":"ipam/ip_space/space-1","name":"default"}]}`))

		case strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			// findExistingSite: the site is not provisioned yet, so the run
			// proceeds instead of skipping or refusing.
			w.Write([]byte(`{"results":[]}`))

		case strings.HasSuffix(r.URL.Path, "/ipam/address_block"):
			w.Write([]byte(`{"results":[{"id":"ipam/address_block/blk-1","address":"10.10.0.0","cidr":16}]}`))

		case strings.HasSuffix(r.URL.Path, "/dns/view"):
			w.Write([]byte(`{"results":[{"id":"dns/view/v-1","name":"default"}]}`))

		case strings.HasSuffix(r.URL.Path, "/dns/auth_zone"):
			filter := r.URL.Query().Get("_filter")
			table := f.existingForward
			if strings.Contains(filter, "in-addr.arpa") {
				table = f.existingReverse
			}
			fqdn := siteFilterFQDN(filter)
			if id, ok := table[fqdn]; ok {
				fmt.Fprintf(w, `{"results":[{"id":%q,"fqdn":%q}]}`, id, fqdn)
				return
			}
			w.Write([]byte(`{"results":[]}`))

		default:
			w.Write([]byte(`{"results":[]}`))
		}
	}
}

// nextSubnet hands out the next planned address, and (when record is set)
// remembers the object so the PATCH that follows can echo it back.
func (f *siteRollbackFake) nextSubnet(record bool) (id, addr string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := f.previewIdx
	f.previewIdx++
	addr = "10.10.99.0"
	if i < len(f.previewAddrs) {
		addr = f.previewAddrs[i]
	}
	f.subnetSeq++
	id = fmt.Sprintf("ipam/subnet/s-%d", f.subnetSeq)
	if record {
		f.subnets[id] = M{"id": id, "address": addr, "cidr": 24}
	}
	return id, addr
}

func (f *siteRollbackFake) deletes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.deletePaths...)
}

func (f *siteRollbackFake) hostCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hostPosts
}

// siteFilterFQDN pulls the fqdn term out of a zone-lookup _filter, so the fake
// can answer the query it was actually given instead of replaying one fixture
// for every fqdn. A fixture that answers "yes, that exists" no matter what was
// asked cannot tell a reused zone from a created one, which is the distinction
// this whole file turns on.
func siteFilterFQDN(filter string) string {
	_, rest, ok := strings.Cut(filter, `fqdn=="`)
	if !ok {
		return ""
	}
	fqdn, _, ok := strings.Cut(rest, `"`)
	if !ok {
		return ""
	}
	return fqdn
}

func newSiteRollbackHarness(t *testing.T) (*Engine, *siteRollbackFake) {
	t.Helper()
	f := &siteRollbackFake{
		hostStatus:      201,
		previewAddrs:    []string{"10.10.1.0", "10.10.2.0"},
		subnets:         map[string]M{},
		existingForward: map[string]string{},
		existingReverse: map[string]string{},
	}
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	return newTestEngine(srv), f
}

// siteRollbackConfig is a two-subnet, two-host site. testSiteConfig (site_test.go)
// is not reusable here: it carries no subnet plan, no hosts and no dns parent, so
// a Provision built on it never reaches a create at all.
//
// dry is explicit at every call site for the same reason block_test.go spells it
// out: leaving a rollback test's dry flag to chance is how it ends up asserting
// about a preview.
//
// Two subnets, not one, so "reverse order" and "only the reused one is spared"
// are distinguishable. Only the second takes DHCP, so the range list has a
// different length from the subnet list and a rollback that confused the two
// could not pass by coincidence.
func siteRollbackConfig(dry bool) *SiteConfig {
	return &SiteConfig{
		Site: "hq", Region: "east", Environment: "prod", Location: "DC1",
		IPSpace: "default", DNSParent: "example.com", DNSView: "default",
		Owner: "network-team", SubnetSize: 24, DryRun: dry,
		CreateZone: true, CreateReverseZone: true, ExtraTags: M{},
		SubnetPlan: []SubnetDef{
			{Name: "hq-mgmt", Purpose: "mgmt", Dhcp: "false"},
			{Name: "hq-lan", Purpose: "user-lan", Dhcp: "true"},
		},
		Hosts: []HostDef{
			{Hostname: "gw01", Subnet: "hq-mgmt"},
			{Hostname: "gw02", Subnet: "hq-mgmt"},
		},
	}
}

// 1. THE FORWARD ZONE THE RUN DID NOT CREATE.
//
// The tenant already holds site-hq.example.com. createDNSZone reuses it and
// records its REAL id in the result, so the id sitting in dns_zone_id is
// indistinguishable from one this run created — the p.zoneCreated flag is the
// only thing that tells them apart. Deleting it takes out the customer's zone
// and every record in it because a host create failed.
func TestSiteRollbackNeverDeletesAReusedForwardZone(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.existingForward["site-hq.example.com."] = "dns/auth_zone/customers-forward-zone"
	f.hostStatus = 500

	var steps []string
	p := e.NewSiteProvisioner(siteRollbackConfig(false), collectSteps(&steps))

	result, err := p.Provision()
	if err == nil {
		t.Fatalf("Provision() error = nil, want the host-create failure (result %v)", result)
	}
	if !strings.Contains(err.Error(), "Failed to create host") {
		t.Fatalf("Provision() error = %q, want the host-create failure — the fixture failed somewhere "+
			"else and this test is not exercising what it claims", err.Error())
	}

	// Sanity: the zone really was REUSED, not created. Without this a green bar
	// could mean the fake never served the existing zone at all.
	reused := false
	for _, s := range steps {
		if strings.Contains(s, "Zone already exists") {
			reused = true
		}
	}
	if !reused {
		t.Fatalf("the run never reported reusing the existing forward zone — the fixture did not take "+
			"the reuse branch, so this test cannot distinguish anything. steps: %v", steps)
	}
	// Sanity: rollback actually ran. An empty delete list otherwise reads as
	// "nothing was deleted" when it really means "nothing happened".
	if len(f.deletes()) == 0 {
		t.Fatalf("rollback issued no DELETEs at all — it never ran, so 'the zone survived' is vacuous. steps: %v", steps)
	}

	for _, d := range f.deletes() {
		if strings.Contains(d, "customers-forward-zone") {
			t.Fatalf("rollback deleted the customer's pre-existing forward zone: %s (all: %v)\n"+
				"This run found that zone already there and only reused it. Deleting it destroys every "+
				"record in it, for a site build that failed at a later step.", d, f.deletes())
		}
	}
}

// 2. THE REVERSE ZONE THE RUN DID NOT CREATE. — the Bug A proof.
//
// Same shape as the forward case and far more likely to bite: in-addr.arpa
// zones are cut at /16 or /8, so one zone covers every subnet under it and a
// second site — or a retry after a partial run — finds it already there.
//
// The fixture deliberately reuses ONE reverse zone and creates the OTHER, so
// this test also fails if rollback is "fixed" by never deleting reverse zones
// at all. The created one must still go.
func TestSiteRollbackNeverDeletesAReusedReverseZone(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.existingReverse["1.10.10.in-addr.arpa."] = "dns/auth_zone/customers-reverse-zone"
	f.hostStatus = 500

	var steps []string
	p := e.NewSiteProvisioner(siteRollbackConfig(false), collectSteps(&steps))

	if _, err := p.Provision(); err == nil {
		t.Fatal("Provision() error = nil, want the host-create failure")
	}

	// Sanity: one reverse zone was reused and one was created. If both had been
	// reused, "the created one is still deleted" below would be vacuous.
	reused := 0
	for _, s := range steps {
		if strings.Contains(s, "Reverse zone already exists") {
			reused++
		}
	}
	if reused != 1 {
		t.Fatalf("the run reused %d reverse zone(s), want exactly 1 — the fixture is not exercising the "+
			"reuse-and-create mix this test is about. steps: %v", reused, steps)
	}

	got := f.deletes()
	for _, d := range got {
		if strings.Contains(d, "customers-reverse-zone") {
			t.Fatalf("rollback deleted the customer's pre-existing reverse zone: %s (all: %v)\n"+
				"1.10.10.in-addr.arpa was already there and this run only reused it. A /16- or /8-scoped "+
				"reverse zone is shared by every subnet under it, so this DELETE takes out reverse DNS for "+
				"hosts that have nothing to do with this site — and it is triggered by a failure at a "+
				"completely unrelated later step.", d, got)
		}
	}

	// The whole sequence, so the spared zone cannot be spared by deleting
	// nothing. created-fwd-2 and created-rev-1 are this run's own zones and must
	// still go; the reused one is simply absent.
	want := []string{
		"/api/ddi/v1/dns/auth_zone/created-fwd-2",
		"/api/ddi/v1/dns/auth_zone/created-rev-1",
		"/api/ddi/v1/ipam/range/r-1",
		"/api/ddi/v1/ipam/subnet/s-2",
		"/api/ddi/v1/ipam/subnet/s-1",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rollback DELETEs = %v,\nwant %v", got, want)
	}
}

// 3. A PREVIEW UNDOES NOTHING.
//
// A dry run creates nothing, so there is nothing to roll back. The ids it
// records are placeholders; announcing a rollback over them is noise at best,
// and if any recorded id were ever real it is a delete nobody asked for.
//
// The failure injector here is local, not an HTTP status: the last subnet's
// preview comes back as an address that is not an address, so the reverse-zone
// FQDN cannot be computed and createSubnets fails — after both subnet previews
// have already been recorded. Same idea as block_test.go's cidr:"x" fixture: it
// fails at a value check rather than on the wire, so it cannot be flaky.
func TestSiteProvisionDryRunFailureNeverRollsBack(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.previewAddrs = []string{"10.10.1.0", "not-an-ip"}

	var steps []string
	p := e.NewSiteProvisioner(siteRollbackConfig(true), collectSteps(&steps))

	_, err := p.Provision()
	if err == nil {
		t.Fatal("Provision() error = nil, want the unusable-address failure")
	}
	if !strings.Contains(err.Error(), "not-an-ip") {
		t.Fatalf("Provision() error = %q, want the unusable-address failure — the dry run failed for "+
			"some other reason", err.Error())
	}

	// Sanity: the preview really reached both subnets and recorded them, so
	// "no rollback" below is a decision and not an empty run.
	previewed := 0
	for _, s := range steps {
		if strings.Contains(s, "[DRY-RUN] Creating subnet") {
			previewed++
		}
	}
	if previewed != 2 {
		t.Fatalf("the dry run previewed %d subnet create(s), want 2 — it never got far enough for a "+
			"rollback to be tempting. steps: %v", previewed, steps)
	}

	if d := f.deletes(); len(d) != 0 {
		t.Fatalf("a dry run sent %d DELETE(s) upstream: %v", len(d), d)
	}
	if n := f.hostCount(); n != 0 {
		t.Fatalf("a dry run sent %d host create(s) upstream", n)
	}
	for _, s := range steps {
		if strings.Contains(s, "Rolling back") {
			t.Fatalf("a dry run announced a rollback (%q) — nothing was created, so there is nothing "+
				"to undo. steps: %v", s, steps)
		}
	}
}

// 4. THE THREE STRINGS THAT ARE NOT IDS. — the Bug B proof for "(exists)".
//
// Called directly, because the three never co-occur in one wired run: "" is a
// create whose response carried no id, "(dry-run)" only appears in a preview,
// and "(exists)" is recorded when upstream answers 409 for a host the customer
// ALREADY had. Each one sent upstream produces a DELETE on a nonsense path.
func TestSiteRollbackSkipsBlankDryRunAndExistsIDs(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	p := e.NewSiteProvisioner(siteRollbackConfig(false), func(M) {})

	result := M{"hosts": []any{
		M{"id": "", "fqdn": "noid.site-hq.example.com"},
		M{"id": "(dry-run)", "fqdn": "preview.site-hq.example.com"},
		M{"id": "(exists)", "fqdn": "gw01.site-hq.example.com"},
		M{"id": "ipam/host/h-9", "fqdn": "gw09.site-hq.example.com"},
	}}
	p.rollback(result)

	got := f.deletes()
	for _, d := range got {
		if strings.Contains(d, "(exists)") {
			t.Fatalf("rollback sent a DELETE for the 409 marker: %s (all: %v)\n"+
				"\"(exists)\" is not an id — it marks a host the customer already had, which this run "+
				"did not create. The DELETE is certain to fail, and the failure then reports a residual "+
				"object that was never ours, telling the operator to go clean up something that is fine.", d, got)
		}
		if strings.Contains(d, "(dry-run)") {
			t.Fatalf("rollback sent a DELETE for a preview placeholder id: %s (all: %v)", d, got)
		}
		if d == "/api/ddi/v1/" {
			t.Fatalf("rollback sent a DELETE with an empty host id: %s (all: %v)", d, got)
		}
	}
	want := []string{"/api/ddi/v1/ipam/host/h-9"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rollback DELETEs = %v, want %v (only the one real id)", got, want)
	}

	// And nothing is reported as left behind: the three skipped entries were
	// never this run's to delete.
	if residual := getList(result, "rollback_residual"); len(residual) != 0 {
		t.Fatalf("rollback_residual = %v, want empty — a skipped non-id must not be reported as an "+
			"object that could not be deleted", residual)
	}
}

// 5. FULL REVERSE-DEPENDENCY ORDER WHEN EVERYTHING WAS CREATED.
//
// hosts -> forward zone -> reverse zones -> dhcp ranges -> subnets, each list
// walked backwards. Upstream refuses a delete whose children still exist, so a
// rollback that ran in creation order would fail on its first call and strand
// everything: the ranges live inside the subnets, the hosts hold addresses in
// them and names in the zone.
//
// Called directly rather than wired so the ordering can be pinned against a
// fully-populated partial result — every resource kind present at once, which a
// wired failure reaches only at the exact step that fails. The wired
// counterpart is TestSiteRollbackDeletesHostsCreatedBeforeAMidListFailure.
//
// (An earlier version of this comment said a wired run COULD NOT reach rollback
// with hosts recorded, because provisionHosts discarded its partial results on
// failure. That was true, and it was a bug — created hosts were stranded on the
// customer's network. It is fixed; the sentence is corrected rather than left
// tidy and false.)
//
// This is also the inverse of test 1: a forward zone this run DID create must be
// deleted. Sparing zones unconditionally would leave orphans behind on every
// failed build.
func TestSiteRollbackDeletesEverythingItCreatedInReverseOrder(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	var steps []string
	p := e.NewSiteProvisioner(siteRollbackConfig(false), collectSteps(&steps))
	p.zoneCreated = true

	result := M{
		"subnets": []any{
			M{"id": "ipam/subnet/s-1", "address": "10.10.1.0/24", "name": "hq-mgmt"},
			M{"id": "ipam/subnet/s-2", "address": "10.10.2.0/24", "name": "hq-lan"},
		},
		"dhcp_ranges": []any{
			M{"id": "ipam/range/r-1", "name": "hq-mgmt-dhcp"},
			M{"id": "ipam/range/r-2", "name": "hq-lan-dhcp"},
		},
		"reverse_zones": []any{
			M{"id": "dns/auth_zone/rev-1", "fqdn": "1.10.10.in-addr.arpa.", "created": true},
			M{"id": "dns/auth_zone/rev-2", "fqdn": "2.10.10.in-addr.arpa.", "created": true},
		},
		"dns_zone_id":   "dns/auth_zone/fwd-1",
		"dns_zone_fqdn": "site-hq.example.com.",
		"hosts": []any{
			M{"id": "ipam/host/h-1", "fqdn": "gw01.site-hq.example.com"},
			M{"id": "ipam/host/h-2", "fqdn": "gw02.site-hq.example.com"},
		},
	}
	p.rollback(result)

	want := []string{
		"/api/ddi/v1/ipam/host/h-2", // hosts first, youngest first
		"/api/ddi/v1/ipam/host/h-1",
		"/api/ddi/v1/dns/auth_zone/fwd-1", // then the zone whose names those hosts held
		"/api/ddi/v1/dns/auth_zone/rev-2",
		"/api/ddi/v1/dns/auth_zone/rev-1",
		"/api/ddi/v1/ipam/range/r-2", // then the ranges inside the subnets
		"/api/ddi/v1/ipam/range/r-1",
		"/api/ddi/v1/ipam/subnet/s-2", // and the subnets last
		"/api/ddi/v1/ipam/subnet/s-1",
	}
	if got := f.deletes(); !reflect.DeepEqual(got, want) {
		t.Fatalf("rollback DELETEs =\n %v\nwant\n %v\n(children before parents, newest first, within each kind)", got, want)
	}
	if residual := getList(result, "rollback_residual"); len(residual) != 0 {
		t.Fatalf("rollback_residual = %v, want empty — every delete succeeded", residual)
	}
}

// 6. ONE REFUSED DELETE MUST NOT STRAND THE REST.
//
// Stopping at the first failure leaves everything underneath it behind, and
// those are exactly the objects a retry then collides with. What the operator
// gets instead is a residual list naming what survived — so the contents are
// asserted, not just the count: a residual entry that does not say which kind
// and which id is not actionable.
func TestSiteRollbackReportsAFailedDeleteAndKeepsGoing(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.deleteStatus = func(path string) int {
		if strings.HasSuffix(path, "/h-2") {
			return 500
		}
		return 200
	}
	var steps []string
	p := e.NewSiteProvisioner(siteRollbackConfig(false), collectSteps(&steps))

	result := M{
		"hosts": []any{
			M{"id": "ipam/host/h-1", "fqdn": "gw01.site-hq.example.com"},
			M{"id": "ipam/host/h-2", "fqdn": "gw02.site-hq.example.com"},
		},
		"subnets": []any{M{"id": "ipam/subnet/s-1", "address": "10.10.1.0/24"}},
	}
	p.rollback(result)

	want := []string{
		"/api/ddi/v1/ipam/host/h-2", // refused with a 500
		"/api/ddi/v1/ipam/host/h-1", // must still be tried
		"/api/ddi/v1/ipam/subnet/s-1",
	}
	if got := f.deletes(); !reflect.DeepEqual(got, want) {
		t.Fatalf("rollback DELETEs = %v, want %v — a failed delete must not abandon the rest", got, want)
	}

	wantResidual := []any{M{
		"kind": "host", "id": "ipam/host/h-2",
		"label": "gw02.site-hq.example.com", "status": 500,
	}}
	if got := getList(result, "rollback_residual"); !reflect.DeepEqual(got, wantResidual) {
		t.Fatalf("rollback_residual = %v, want %v — the operator needs the kind and the id of what "+
			"survived, not just a count", got, wantResidual)
	}

	named, counted := false, false
	for _, s := range steps {
		if strings.Contains(s, "failed to delete host id=ipam/host/h-2") {
			named = true
		}
		if strings.Contains(s, "Rollback incomplete: 1 object(s)") {
			counted = true
		}
	}
	if !named {
		t.Fatalf("a host was left behind upstream and nothing said so. steps: %v", steps)
	}
	if !counted {
		t.Fatalf("the run did not report how many objects survived the rollback, so nobody knows there "+
			"is anything to clean up. steps: %v", steps)
	}
}

// 7. HOSTS CREATED BEFORE A MID-LIST FAILURE MUST NOT BE LEFT UPSTREAM.
//
// This is the wired counterpart of test 5. Test 5 has to call rollback directly
// and hand it a hosts list, because provisionHosts used to return nil alongside
// its error and Provision assigned result["hosts"] only after that error check —
// so on the one failure that can strand hosts, rollback was handed an EMPTY host
// list and deleted nothing. The hosts were already POSTed. They stayed on the
// customer's network, holding addresses inside subnets rollback then deleted out
// from under them, with nothing in the result or the residual list naming them.
//
// Hosts were the only resource with this asymmetry: subnets, DHCP ranges and
// reverse zones are appended into `result` as each one is created, so a
// mid-sequence failure already leaves rollback a complete list.
//
// Two hosts created and the third refused, not one and one: with a single
// success, "reverse order" is unobservable, and a fix that recorded only the
// last host would pass. The assertion is the full DELETE sequence, so recording
// the wrong hosts, recording them in creation order, or recording the refused
// third one all fail here.
func TestSiteRollbackDeletesHostsCreatedBeforeAMidListFailure(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	// Hosts 1 and 2 land upstream for real; host 3 is refused.
	f.hostStatusFor = func(n int) int {
		if n == 3 {
			return 500
		}
		return 201
	}
	cfg := siteRollbackConfig(false)
	cfg.Hosts = []HostDef{
		{Hostname: "gw01", Subnet: "hq-mgmt"},
		{Hostname: "gw02", Subnet: "hq-mgmt"},
		{Hostname: "gw03", Subnet: "hq-mgmt"},
	}

	var steps []string
	p := e.NewSiteProvisioner(cfg, collectSteps(&steps))

	_, err := p.Provision()
	if err == nil {
		t.Fatal("Provision() error = nil, want the third host's create failure")
	}
	if !strings.Contains(err.Error(), "Failed to create host gw03") {
		t.Fatalf("Provision() error = %q, want gw03's create failure — the run broke somewhere else and "+
			"this test is not exercising a mid-list host failure", err.Error())
	}

	// Sanity: three host creates really were attempted, so "two survived" below
	// is a fact about a partially-completed list and not an empty run.
	if n := f.hostCount(); n != 3 {
		t.Fatalf("the run attempted %d host create(s), want 3 — it never got two hosts upstream, so "+
			"there is nothing for this test to strand. steps: %v", n, steps)
	}

	got := f.deletes()
	want := []string{
		"/api/ddi/v1/ipam/host/h-2", // the two that really exist, youngest first
		"/api/ddi/v1/ipam/host/h-1",
		"/api/ddi/v1/dns/auth_zone/created-fwd-3", // then everything the run had already built
		"/api/ddi/v1/dns/auth_zone/created-rev-2",
		"/api/ddi/v1/dns/auth_zone/created-rev-1",
		"/api/ddi/v1/ipam/range/r-1",
		"/api/ddi/v1/ipam/subnet/s-2",
		"/api/ddi/v1/ipam/subnet/s-1",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rollback DELETEs =\n %v\nwant\n %v\n"+
			"gw01 and gw02 were created upstream before gw03 was refused. If their DELETEs are missing, "+
			"rollback tore down the subnets and zones around them and left two live hosts on the "+
			"customer's network, unnamed in the result and unnamed in rollback_residual — nothing tells "+
			"the operator they are there.", got, want)
	}
}
