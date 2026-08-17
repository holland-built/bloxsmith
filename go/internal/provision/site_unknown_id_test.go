package provision

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// AN OBJECT THAT WAS CREATED AND CANNOT BE NAMED.
//
// Every create in SiteProvisioner reads its new object's id out of the response
// body. When upstream answers 200/201 with a body that carries no parseable
// `result` object, the object EXISTS on the customer's network and this code has
// no id for it. site.go already had an explicit branch for that shape
// (`if zone == nil { zone = M{} }`), and the branch recorded the id as
// "(dry-run)" — the one string rollback's del() documents as "a preview
// placeholder" and returns early on. So the object was never deleted, never
// appeared in `residual`, and `outcome` still read "complete", while the success
// path returned "(dry-run)" in the same map as "dry_run": false.
//
// The scope of this file is that one distinction and nothing else: created-and-
// unnameable (idUnknown, reported) versus previewed (nothing exists) versus
// reused (never ours). site_rollback_test.go owns the delete ORDER and the
// reused-zone protection; nothing here re-asserts either.
//
// ASSERTIONS ARE ON RECORDED STATE AND RECORDED REQUESTS, never on the error
// alone. "Provision returned an error" goes green whether the run reported the
// orphan or buried it, and burying it is the whole failure mode.
//
// NO TEST HERE TOUCHES A REAL TENANT. Everything runs against httptest.

// unknownIDFake answers the whole site-create path and can drop the `result`
// envelope from any one create, which is the only injection this file needs.
//
// It branches on METHOD BEFORE PATH for the reason siteRollbackFake does: every
// rollback DELETE path contains a create path as a prefix, so a path-first
// switch would answer a create with an existence fixture.
type unknownIDFake struct {
	mu sync.Mutex

	// deletePaths is every DELETE path in arrival order, so a test can prove no
	// nonsense path like /api/ddi/v1/(unknown-id) was ever sent.
	deletePaths []string

	fwdZonePosts int
	revZonePosts int
	hostPosts    int
	rangePosts   int

	subnetSeq int
	zoneSeq   int
	subnets   map[string]M

	// --- knobs. Each test flips only the one it is about. -------------------

	// fwdZoneResultless / revZoneResultless / hostResultless / rangeResultless
	// make that create answer 201 with `{}`: a success whose body carries no id.
	fwdZoneResultless bool
	revZoneResultless bool
	hostResultless    bool
	rangeResultless   bool

	// reverseRowHasNoID answers the reverse-zone EXISTENCE lookup with a row that
	// has an fqdn and no id. That is a REUSED zone — the customer's — and it must
	// NOT be marked idUnknown, which would claim this run created it.
	reverseRowHasNoID bool

	// hostStatus is the failure injector. The host create is the last step of a
	// site provision, so failing it is the only way to reach rollback with every
	// earlier object already recorded.
	hostStatus int
}

func (f *unknownIDFake) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch r.Method {
		case http.MethodDelete:
			f.mu.Lock()
			f.deletePaths = append(f.deletePaths, r.URL.Path)
			f.mu.Unlock()
			w.WriteHeader(200)
			w.Write([]byte(`{}`))
			return

		case http.MethodPatch:
			// createSubnet replaces its local copy with the PATCH response, so the
			// whole object has to come back or every later assertion is about an
			// empty map.
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
			fmt.Fprintf(w, `{"result":{"id":%q,"address":%q,"cidr":24}}`, id, pyStr(s["address"]))
			return

		case http.MethodPost:
			switch {
			case strings.HasSuffix(r.URL.Path, "/nextavailablesubnet"):
				f.mu.Lock()
				f.subnetSeq++
				id := fmt.Sprintf("ipam/subnet/s-%d", f.subnetSeq)
				addr := fmt.Sprintf("10.10.%d.0", f.subnetSeq)
				f.subnets[id] = M{"id": id, "address": addr, "cidr": 24}
				f.mu.Unlock()
				w.WriteHeader(201)
				fmt.Fprintf(w, `{"results":[{"id":%q,"address":%q,"cidr":24}]}`, id, addr)

			case strings.HasSuffix(r.URL.Path, "/ipam/range"):
				f.mu.Lock()
				f.rangePosts++
				n := f.rangePosts
				resultless := f.rangeResultless
				f.mu.Unlock()
				w.WriteHeader(201)
				if resultless {
					w.Write([]byte(`{}`))
					return
				}
				fmt.Fprintf(w, `{"result":{"id":"ipam/range/r-%d"}}`, n)

			case strings.HasSuffix(r.URL.Path, "/dns/auth_zone"):
				fqdn := pyStr(decodeBody(r)["fqdn"])
				reverse := strings.Contains(fqdn, "in-addr.arpa")
				f.mu.Lock()
				f.zoneSeq++
				n := f.zoneSeq
				resultless := f.fwdZoneResultless
				kind := "fwd"
				if reverse {
					resultless = f.revZoneResultless
					kind = "rev"
					f.revZonePosts++
				} else {
					f.fwdZonePosts++
				}
				f.mu.Unlock()
				w.WriteHeader(201)
				if resultless {
					w.Write([]byte(`{}`))
					return
				}
				fmt.Fprintf(w, `{"result":{"id":"dns/auth_zone/created-%s-%d","fqdn":%q}}`, kind, n, fqdn)

			case strings.HasSuffix(r.URL.Path, "/ipam/host"):
				f.mu.Lock()
				f.hostPosts++
				n := f.hostPosts
				status := f.hostStatus
				resultless := f.hostResultless
				f.mu.Unlock()
				w.WriteHeader(status)
				switch {
				case status != 200 && status != 201:
					w.Write([]byte(`{"error":"host create refused"}`))
				case resultless:
					w.Write([]byte(`{}`))
				default:
					fmt.Fprintf(w, `{"result":{"id":"ipam/host/h-%d"}}`, n)
				}

			default:
				w.WriteHeader(201)
				w.Write([]byte(`{"result":{}}`))
			}
			return
		}

		// GET only, past here.
		switch {
		case strings.HasSuffix(r.URL.Path, "/ipam/ip_space"):
			w.Write([]byte(`{"results":[{"id":"ipam/ip_space/space-1","name":"default"}]}`))
		case strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			// findExistingSite: not provisioned yet, so the run proceeds.
			w.Write([]byte(`{"results":[]}`))
		case strings.HasSuffix(r.URL.Path, "/ipam/address_block"):
			w.Write([]byte(`{"results":[{"id":"ipam/address_block/blk-1","address":"10.10.0.0","cidr":16}]}`))
		case strings.HasSuffix(r.URL.Path, "/dns/view"):
			w.Write([]byte(`{"results":[{"id":"dns/view/v-1","name":"default"}]}`))
		case strings.HasSuffix(r.URL.Path, "/dns/auth_zone"):
			filter := r.URL.Query().Get("_filter")
			if f.reverseRowHasNoID && strings.Contains(filter, "in-addr.arpa") {
				// A zone the customer already has, whose row carries no id.
				fmt.Fprintf(w, `{"results":[{"fqdn":%q}]}`, siteFilterFQDN(filter))
				return
			}
			w.Write([]byte(`{"results":[]}`))
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	}
}

func newUnknownIDHarness(t *testing.T) (*Engine, *unknownIDFake) {
	t.Helper()
	f := &unknownIDFake{subnets: map[string]M{}, hostStatus: 201}
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	return newTestEngine(srv), f
}

func (f *unknownIDFake) deletesSeen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.deletePaths...)
}

// unknownIDs returns the {kind,label} pairs a run recorded, as "kind=label".
func unknownIDs(result M) []string {
	var out []string
	for _, u := range getList(result, "unknown_ids") {
		um := asMap(u)
		out = append(out, pyStr(um["kind"])+"="+pyStr(um["label"]))
	}
	return out
}

// hasUnknown reports whether any {kind,label} pair has this kind.
func hasUnknown(result M, kind string) bool {
	for _, u := range getList(result, "unknown_ids") {
		if pyStr(asMap(u)["kind"]) == kind {
			return true
		}
	}
	return false
}

// residualOf pulls the rollback report out of Provision's failure value.
func residualOf(t *testing.T, failValue M) (outcome string, rows []M, attempted, deleted int) {
	t.Helper()
	rb := asMap(failValue["rollback"])
	if rb == nil {
		t.Fatalf("failure value carried no rollback report: %v", failValue)
	}
	attempted, _ = intCoerce(rb["attempted"])
	deleted, _ = intCoerce(rb["deleted"])
	for _, r := range getList(rb, "residual") {
		rows = append(rows, asMap(r))
	}
	return pyStr(rb["outcome"]), rows, attempted, deleted
}

// A host created by a 201 whose body carried no id is recorded as created-and-
// unnameable, is named in unknown_ids, and is NOT called a dry run.
func TestSiteProvision_CreatedHostWithNoIDIsNotCalledDryRun(t *testing.T) {
	e, f := newUnknownIDHarness(t)
	f.hostResultless = true

	result, err := e.NewSiteProvisioner(siteRollbackConfig(false), func(M) {}).Provision()
	if err != nil {
		t.Fatalf("run should still succeed: %v", err)
	}
	if result["dry_run"] != false {
		t.Fatalf("dry_run = %v, want false", result["dry_run"])
	}
	hosts := getList(result, "hosts")
	if len(hosts) != 2 {
		t.Fatalf("hosts = %d, want 2", len(hosts))
	}
	for i, h := range hosts {
		got := pyStr(asMap(h)["id"])
		if got == "(dry-run)" {
			t.Errorf("host %d id = %q — a live host described as a preview", i, got)
		}
		if got != idUnknown {
			t.Errorf("host %d id = %q, want %q", i, got, idUnknown)
		}
	}
	want := []string{"host=gw01.site-hq.example.com", "host=gw02.site-hq.example.com"}
	got := unknownIDs(result)
	if len(got) != len(want) {
		t.Fatalf("unknown_ids = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("unknown_ids[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// A REVERSE zone this run created without an id is marked created-and-unnameable
// and reported; the run is not aborted for it.
func TestSiteProvision_CreatedReverseZoneWithNoIDIsReported(t *testing.T) {
	e, f := newUnknownIDHarness(t)
	f.revZoneResultless = true

	result, err := e.NewSiteProvisioner(siteRollbackConfig(false), func(M) {}).Provision()
	if err != nil {
		t.Fatalf("an unnameable reverse zone must not abort the run: %v", err)
	}
	zones := getList(result, "reverse_zones")
	if len(zones) != 2 {
		t.Fatalf("reverse_zones = %d, want 2", len(zones))
	}
	for i, z := range zones {
		zm := asMap(z)
		if !truthy(zm["created"], false) {
			t.Errorf("reverse zone %d created = %v, want true", i, zm["created"])
		}
		if got := pyStr(zm["id"]); got != idUnknown {
			t.Errorf("reverse zone %d id = %q, want %q", i, got, idUnknown)
		}
	}
	if !hasUnknown(result, "reverse_zone") {
		t.Errorf("unknown_ids = %v, want a reverse_zone entry", unknownIDs(result))
	}
}

// A REUSED reverse zone whose lookup row carries no id is NOT ours. It must stay
// "" — idUnknown would claim this run created the customer's zone, and idUnknown
// is the one value rollback acts on.
func TestSiteProvision_ReusedReverseZoneWithNoIDIsNotMarkedOurs(t *testing.T) {
	e, f := newUnknownIDHarness(t)
	f.reverseRowHasNoID = true

	result, err := e.NewSiteProvisioner(siteRollbackConfig(false), func(M) {}).Provision()
	if err != nil {
		t.Fatalf("run should succeed: %v", err)
	}
	if f.revZonePosts != 0 {
		t.Fatalf("revZonePosts = %d, want 0 — the fixture must be a REUSE, not a create", f.revZonePosts)
	}
	for i, z := range getList(result, "reverse_zones") {
		zm := asMap(z)
		if truthy(zm["created"], false) {
			t.Errorf("reverse zone %d created = %v, want false", i, zm["created"])
		}
		if got := pyStr(zm["id"]); got != "" {
			t.Errorf("reverse zone %d id = %q, want \"\" — a reused zone is not ours", i, got)
		}
	}
	if hasUnknown(result, "reverse_zone") {
		t.Errorf("unknown_ids = %v, want no reverse_zone entry for a reused zone", unknownIDs(result))
	}
}

// The FORWARD zone is the one unknown id that stops the run: p.zoneID is "" and
// every host would be bound to an empty zone reference. The zone is reported as
// residual, rollback sends no DELETE for it, and the outcome is not "complete".
func TestSiteRollback_UnnameableForwardZoneBecomesResidual(t *testing.T) {
	e, f := newUnknownIDHarness(t)
	f.fwdZoneResultless = true
	// Reverse zones off, so the forward zone is the ONLY zone in the run and
	// "no auth_zone DELETE was sent" is a statement about it. With them on, the
	// two reverse zones have real ids and rollback deletes them correctly, which
	// is site_rollback_test.go's subject, not this file's.
	cfg := siteRollbackConfig(false)
	cfg.CreateReverseZone = false

	failValue, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
	if err == nil {
		t.Fatal("a forward zone with no id must abort the run")
	}
	if f.hostPosts != 0 {
		t.Errorf("hostPosts = %d, want 0 — no host may be written against an empty zone", f.hostPosts)
	}
	outcome, rows, attempted, deleted := residualOf(t, failValue)
	if outcome != "incomplete" {
		t.Errorf("outcome = %q, want %q", outcome, "incomplete")
	}
	var zoneRow M
	for _, r := range rows {
		if pyStr(r["kind"]) == "dns_zone" {
			zoneRow = r
		}
	}
	if zoneRow == nil {
		t.Fatalf("residual = %v, want a dns_zone row", rows)
	}
	if got := pyStr(zoneRow["id"]); got != "" {
		t.Errorf("residual id = %q, want \"\" — there is no id to publish", got)
	}
	if got := pyStr(zoneRow["label"]); got != "site-hq.example.com" {
		t.Errorf("residual label = %q, want the zone fqdn", got)
	}
	if got, _ := intCoerce(zoneRow["status"]); got != 0 {
		t.Errorf("residual status = %v, want 0 — no request was sent", zoneRow["status"])
	}
	if pyStr(zoneRow["reason"]) == "" {
		t.Error("residual row carries no reason")
	}
	// attempted/deleted count REQUESTS. Nothing was sent for this object, so it
	// must not inflate either counter — the outcome carries the meaning instead.
	if attempted != deleted {
		t.Errorf("attempted=%d deleted=%d — the unnameable zone must not count as an attempt", attempted, deleted)
	}
	for _, d := range f.deletesSeen() {
		for _, marker := range []string{idUnknown, "(dry-run)", "(exists)"} {
			if strings.Contains(d, marker) {
				t.Errorf("DELETE %s — a marker was sent upstream as an id", d)
			}
		}
		if strings.Contains(d, "auth_zone") {
			t.Errorf("DELETE %s — there is no id to delete a zone by", d)
		}
	}
}

// A DHCP range created by a 201 with no id lands in the residual naming its
// address span, not an empty label.
func TestSiteRollback_UnnameableDHCPRangeBecomesResidualWithASpan(t *testing.T) {
	e, f := newUnknownIDHarness(t)
	f.rangeResultless = true
	f.hostStatus = 500 // fail last, so rollback runs with everything recorded

	failValue, err := e.NewSiteProvisioner(siteRollbackConfig(false), func(M) {}).Provision()
	if err == nil {
		t.Fatal("want the host create to fail")
	}
	if f.rangePosts != 1 {
		t.Fatalf("rangePosts = %d, want 1", f.rangePosts)
	}
	_, rows, _, _ := residualOf(t, failValue)
	var rangeRow M
	for _, r := range rows {
		if pyStr(r["kind"]) == "dhcp_range" {
			rangeRow = r
		}
	}
	if rangeRow == nil {
		t.Fatalf("residual = %v, want a dhcp_range row", rows)
	}
	if got := pyStr(rangeRow["label"]); got == "" || got == "-" {
		t.Errorf("residual label = %q, want a start-end span an operator can act on", got)
	}
}

// A non-empty residual outranks the counters. An unnameable object sends no
// DELETE, so it moves neither counter, and both words the counters can produce
// on their own — "complete" and "not_needed" — read as success.
//
// The assertion names both rather than one: with the residual-first case removed
// this config was MEASURED reporting "complete". "not_needed" needs a rollback
// that recorded nothing else at all, which no template-built config produces, so
// it is excluded by name here rather than pinned by a config that cannot occur.
func TestSiteRollback_ResidualNeverReportsSuccess(t *testing.T) {
	e, f := newUnknownIDHarness(t)
	f.fwdZoneResultless = true
	// A one-subnet, no-DHCP, no-reverse-zone plan: the forward zone is then the
	// only object rollback has anything to say about, and the subnet delete is the
	// only successful one, so attempted stays low and the residual is what decides.
	cfg := siteRollbackConfig(false)
	cfg.CreateReverseZone = false
	cfg.SubnetPlan = []SubnetDef{{Name: "hq-mgmt", Purpose: "mgmt", Dhcp: "false"}}

	failValue, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
	if err == nil {
		t.Fatal("want the run to abort on the unnameable forward zone")
	}
	outcome, rows, _, _ := residualOf(t, failValue)
	if len(rows) == 0 {
		t.Fatalf("want a residual row for the unnameable zone, got none")
	}
	if outcome == "not_needed" || outcome == "complete" {
		t.Errorf("outcome = %q with %d residual row(s) — a rollback that could not "+
			"remove something never reports success", outcome, len(rows))
	}
}

// A DRY RUN creates nothing, so it can never record an unknown id. Every
// idUnknown fallback sits on the real path only, and this is what pins that:
// "(dry-run)" is still the right word for a preview.
func TestSiteProvision_DryRunRecordsNoUnknownID(t *testing.T) {
	e, f := newUnknownIDHarness(t)
	f.fwdZoneResultless = true
	f.revZoneResultless = true
	f.hostResultless = true
	f.rangeResultless = true

	result, err := e.NewSiteProvisioner(siteRollbackConfig(true), func(M) {}).Provision()
	if err != nil {
		t.Fatalf("dry run failed: %v", err)
	}
	if got := unknownIDs(result); len(got) != 0 {
		t.Errorf("unknown_ids = %v, want empty on a dry run", got)
	}
	for _, key := range []string{"hosts", "reverse_zones", "dhcp_ranges", "subnets"} {
		for i, row := range getList(result, key) {
			if got := pyStr(asMap(row)["id"]); got == idUnknown {
				t.Errorf("%s[%d] id = %q on a dry run — nothing was created", key, i, got)
			}
		}
	}
	if got := pyStr(result["dns_zone_id"]); got != "(dry-run)" {
		t.Errorf("dns_zone_id = %q, want %q on a dry run", got, "(dry-run)")
	}
}
