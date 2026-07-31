package provision

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// WHAT THE OPERATOR IS TOLD AFTER A TEARDOWN DIES HALFWAY.
//
// Teardown is fail-forward: there is no rollback, every step is a delete, and a
// delete that fails leaves everything the earlier steps already deleted gone for
// good. emitIncomplete is the ONLY record the operator gets of how far it got.
// If it is wrong — names the wrong step, claims a list is empty when two objects
// in it are already deleted, or omits a list entirely — the operator's next move
// is based on a false picture of the tenant.
//
// SCOPE, HONESTLY. These tests pin the CONTENT of that event at all five failure
// sites in Decommission. They do NOT prove the deletes themselves are correct,
// that ordering upstream is right, or anything about restore — export_test.go
// covers the record-before-delete claim and site_test.go the plan phase.
//
// The core test drives the real Decommission through a fake upstream that fails
// one specific DELETE. A direct call to emitIncomplete would be much easier to
// write and much weaker: delete any of the five d.emitIncomplete(...) lines in
// decommission.go and a direct-call test stays green. Wiring it through
// Decommission is what makes a missing call site a red bar.
//
// NO TEST HERE TOUCHES A REAL TENANT. Everything runs against httptest.

// The object ids the fake tenant hands out. Named constants because each one is
// used twice — once as fixture data, once as the DELETE the test makes fail —
// and a typo in the second copy would silently turn a case into a happy path.
const (
	failFwdZoneID = "dns/auth_zone/z-fwd"
	failRange1ID  = "ipam/range/r-1"
	failRange2ID  = "ipam/range/r-2"
	failRevZone1  = "dns/auth_zone/rz-1"
	failRevZone2  = "dns/auth_zone/rz-2"
	failSubnet1ID = "ipam/subnet/sn-1"
	failSubnet2ID = "ipam/subnet/sn-2"
	failHost1ID   = "ipam/host/h-1"
	failHost2ID   = "ipam/host/h-2"
)

// failingTenant is an Infoblox stand-in whose reads all succeed and in which
// exactly ONE delete fails, chosen by the test. Fixture data is cloned from
// export_test.go's fakeTenant rather than shared, because this one needs shapes
// that one deliberately does not have: TWO ranges, TWO subnets and TWO
// site-owned hosts, so a "the list is partial" assertion has something to be
// partial about, and so the two reverse zones derived from those subnets are
// distinguishable from each other and from the forward zone.
type failingTenant struct {
	mu sync.Mutex

	// failDeleteID is the object id whose DELETE returns 500. Every other
	// delete succeeds, so the run reaches exactly the failure site under test.
	failDeleteID string

	// deletes is every object id DELETEd, in order. Order matters: it is what
	// proves the run stopped AT the failure rather than carrying on past it.
	deletes []string
}

func (f *failingTenant) handler() http.HandlerFunc {
	// Reverse zones are looked up by fqdn on the same /dns/auth_zone path as the
	// forward zone, so the handler has to answer per-fqdn to give each one a
	// distinct id. Anything not listed here reads as "zone does not exist".
	revZones := map[string]string{
		"0.20.10.in-addr.arpa.": failRevZone1,
		"1.20.10.in-addr.arpa.": failRevZone2,
	}

	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		// METHOD FIRST. A DELETE goes to /api/ddi/v1/<objectID>, and objectIDs
		// like "ipam/range/r-1" end in path fragments the read switch below also
		// matches on. Branching on the path first would route deletes into the
		// read handlers and every failure case would silently succeed.
		if r.Method == http.MethodDelete {
			id := strings.TrimPrefix(r.URL.Path, "/api/ddi/v1/")
			f.mu.Lock()
			f.deletes = append(f.deletes, id)
			shouldFail := id == f.failDeleteID
			f.mu.Unlock()
			if shouldFail {
				w.WriteHeader(http.StatusInternalServerError)
				w.Write([]byte(`{"error":"upstream refused the delete"}`))
				return
			}
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{}`))
			return
		}

		p := r.URL.Path
		switch {
		case strings.HasSuffix(p, "/ipam/ip_space"):
			w.Write([]byte(`{"results":[{"id":"ipam/ip_space/space-1","name":"default"}]}`))
		case strings.HasSuffix(p, "/dns/view"):
			w.Write([]byte(`{"results":[{"id":"dns/view/view-1","name":"default"}]}`))
		case strings.HasSuffix(p, "/ipam/subnet"):
			// Two subnets, in this order. The second is the one the subnet case
			// fails on, so "exactly one deleted" can only mean the first.
			w.Write([]byte(`{"results":[
			  {"id":"` + failSubnet1ID + `","address":"10.20.0.0","cidr":24,"name":"ams-general",
			   "tags":{"Site":"ams"}},
			  {"id":"` + failSubnet2ID + `","address":"10.20.1.0","cidr":24,"name":"ams-voice",
			   "tags":{"Site":"ams"}}
			]}`))
		case strings.HasSuffix(p, "/dns/auth_zone"):
			// planReverseZones and planDNSZone share this path; the fqdn in the
			// filter is the only thing telling them apart.
			fqdn := filterFQDN(r.URL.Query().Get("_filter"))
			if id, ok := revZones[fqdn]; ok {
				w.Write([]byte(`{"results":[{"id":"` + id + `","fqdn":"` + fqdn + `","view":"dns/view/view-1"}]}`))
				return
			}
			if fqdn == "site-ams.example.com." {
				w.Write([]byte(`{"results":[{"id":"` + failFwdZoneID + `","fqdn":"site-ams.example.com.",
				  "view":"dns/view/view-1"}]}`))
				return
			}
			w.Write([]byte(`{"results":[]}`))
		case strings.HasSuffix(p, "/ipam/range"):
			w.Write([]byte(`{"results":[
			  {"id":"` + failRange1ID + `","start":"10.20.0.100","end":"10.20.0.200","tags":{"Site":"ams"}},
			  {"id":"` + failRange2ID + `","start":"10.20.1.100","end":"10.20.1.200","tags":{"Site":"ams"}}
			]}`))
		case strings.HasSuffix(p, "/ipam/host"):
			// Two hosts under this site's zone plus one that is not, so the
			// site filter in planHosts stays exercised here too.
			w.Write([]byte(`{"results":[
			  {"id":"` + failHost1ID + `","name":"printer.site-ams.example.com"},
			  {"id":"` + failHost2ID + `","name":"scanner.site-ams.example.com"},
			  {"id":"ipam/host/h-other","name":"other.example.com"}
			]}`))
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	}
}

// filterFQDN pulls the quoted fqdn out of a CSP filter expression such as
// `fqdn=="site-ams.example.com." and view=="dns/view/view-1"`. Returns "" when
// there is no quoted value, which the caller reads as "no such zone".
func filterFQDN(filter string) string {
	parts := strings.SplitN(filter, `"`, 3)
	if len(parts) < 3 {
		return ""
	}
	return parts[1]
}

func (f *failingTenant) deletedIDs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.deletes...)
}

// newFailingHarness wires an engine to a failingTenant. A real (non-dry) run is
// required to reach the delete phase at all, and a real run REFUSES unless
// recordPlan can write, so a working export directory is not optional scaffolding
// here — without it the run dies before the first delete and every case below
// would be testing the export refusal instead.
func newFailingHarness(t *testing.T, failDeleteID string) (*Engine, *failingTenant) {
	t.Helper()
	ft := &failingTenant{failDeleteID: failDeleteID}
	srv := httptest.NewServer(ft.handler())
	t.Cleanup(srv.Close)
	e := newTestEngine(srv).WithExport(&ExportWriter{
		Dir:     filepath.Join(t.TempDir(), "teardown-exports"),
		Version: "test",
	})
	return e, ft
}

// wantDeleted is the expected contents of the incomplete event's "deleted" map:
// how many of each kind were already gone when the run aborted.
type wantDeleted struct {
	zone    bool
	ranges  int
	reverse int
	subnets int
	hosts   int
}

// THE CORE TEST. One case per d.emitIncomplete call site in Decommission
// (decommission.go:530/537/544/551/558). Each fails a different delete and
// checks the whole event: the exact failed_step, a real error, the full lists
// for kinds that finished, the PARTIAL list for the kind that died mid-loop, and
// present-but-empty lists for kinds never reached.
func TestDecommissionIncompleteEventReportsWhatWasAlreadyDeleted(t *testing.T) {
	cases := []struct {
		name         string
		failDeleteID string
		wantStep     string
		want         wantDeleted
		// wantDeletes is every DELETE the tenant should see, in order, ending
		// with the one that failed. Teardown is fail-forward with no rollback,
		// so nothing may be attempted after the failure and nothing may be
		// retried — a list, not a count, because both are failure modes.
		wantDeletes []string
		// wantPartialID is the single id that must be in the failing kind's
		// list: the FIRST of that kind's two objects. Two objects in the
		// fixture, the second one failing, so "exactly one, and it is the
		// first" can distinguish a partial list from an empty or a full one.
		wantPartialKey string
		wantPartialID  string
	}{
		{
			// The forward zone is the first delete, so nothing precedes it and
			// every list must be present and empty. This is the case that
			// catches "never reached" rendering as a missing key.
			name:         "forward zone delete fails",
			failDeleteID: failFwdZoneID,
			wantStep:     "delete forward DNS zone",
			want:         wantDeleted{zone: false},
			wantDeletes:  []string{failFwdZoneID},
		},
		{
			name:         "second DHCP range delete fails",
			failDeleteID: failRange2ID,
			wantStep:     "delete DHCP ranges",
			want:         wantDeleted{zone: true, ranges: 1},
			wantDeletes:  []string{failFwdZoneID, failRange1ID, failRange2ID},
			// The first range is already gone and the operator has to know it.
			wantPartialKey: "dhcp_ranges_deleted",
			wantPartialID:  failRange1ID,
		},
		{
			name:         "second reverse zone delete fails",
			failDeleteID: failRevZone2,
			wantStep:     "delete reverse DNS zones",
			want:         wantDeleted{zone: true, ranges: 2, reverse: 1},
			wantDeletes: []string{failFwdZoneID, failRange1ID, failRange2ID,
				failRevZone1, failRevZone2},
			wantPartialKey: "reverse_zones_deleted",
			wantPartialID:  failRevZone1,
		},
		{
			name:         "second subnet delete fails",
			failDeleteID: failSubnet2ID,
			wantStep:     "delete subnets",
			want:         wantDeleted{zone: true, ranges: 2, reverse: 2, subnets: 1},
			wantDeletes: []string{failFwdZoneID, failRange1ID, failRange2ID,
				failRevZone1, failRevZone2, failSubnet1ID, failSubnet2ID},
			wantPartialKey: "subnets_deleted",
			wantPartialID:  failSubnet1ID,
		},
		{
			name:         "second host delete fails",
			failDeleteID: failHost2ID,
			wantStep:     "delete hosts",
			want:         wantDeleted{zone: true, ranges: 2, reverse: 2, subnets: 2, hosts: 1},
			wantDeletes: []string{failFwdZoneID, failRange1ID, failRange2ID,
				failRevZone1, failRevZone2, failSubnet1ID, failSubnet2ID, failHost1ID, failHost2ID},
			wantPartialKey: "hosts_deleted",
			wantPartialID:  failHost1ID,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e, ft := newFailingHarness(t, c.failDeleteID)

			var events []M
			_, err := e.NewSiteDecommissioner(teardownCfg(false), func(m M) {
				events = append(events, m)
			}).Decommission()
			if err == nil {
				t.Fatalf("Decommission succeeded even though DELETE %s returned 500 — "+
					"the fixture never reached the failure site, so this case proves nothing",
					c.failDeleteID)
			}

			// The run must stop at the failure, having attempted exactly the
			// deletes up to and including it.
			if got := ft.deletedIDs(); !equalStrings(got, c.wantDeletes) {
				t.Fatalf("deletes sent = %v, want %v", got, c.wantDeletes)
			}

			ev := onlyIncompleteEvent(t, events)

			if ev["operation"] != "decommission" {
				t.Fatalf("operation = %v, want decommission", ev["operation"])
			}
			if ev["site"] != "ams" {
				t.Fatalf("site = %v, want ams — an incomplete report that does not say WHICH site "+
					"is already gone is not actionable", ev["site"])
			}
			if ev["incomplete"] != true {
				t.Fatalf("incomplete = %v, want true", ev["incomplete"])
			}
			// The exact step string, not a substring: it is the only thing that
			// says which of the five phases died, and a run that reports the
			// wrong phase sends the operator to the wrong objects.
			if ev["failed_step"] != c.wantStep {
				t.Fatalf("failed_step = %v, want %q", ev["failed_step"], c.wantStep)
			}
			// The error must be the real upstream failure, not an empty string
			// or a generic placeholder.
			errText, _ := ev["error"].(string)
			if errText == "" {
				t.Fatalf("error = %v, want the failure text — an incomplete event with no reason "+
					"tells the operator nothing about why the tenant is half torn down", ev["error"])
			}
			if errText != err.Error() {
				t.Fatalf("event error %q differs from the returned error %q — the operator sees one "+
					"of these and the logs the other", errText, err.Error())
			}
			if !strings.Contains(errText, "status 500") {
				t.Fatalf("error %q does not carry the upstream status", errText)
			}

			deleted, ok := ev["deleted"].(M)
			if !ok {
				t.Fatalf("deleted = %#v, want a map of what is already gone", ev["deleted"])
			}
			if got := deleted["dns_zone_deleted"]; got != c.want.zone {
				t.Fatalf("dns_zone_deleted = %v, want %v", got, c.want.zone)
			}
			for key, wantLen := range map[string]int{
				"dhcp_ranges_deleted":   c.want.ranges,
				"reverse_zones_deleted": c.want.reverse,
				"subnets_deleted":       c.want.subnets,
				"hosts_deleted":         c.want.hosts,
			} {
				raw, present := deleted[key]
				if !present {
					t.Fatalf("%s is MISSING from the event. A kind the run never reached must be "+
						"present and empty: a missing key reads as 'unknown', an empty list reads as "+
						"'none deleted', and those are different facts", key)
				}
				list, ok := raw.([]any)
				if !ok {
					t.Fatalf("%s = %#v, want a list (nil or a non-list renders as 'unknown', not "+
						"as 'none deleted')", key, raw)
				}
				if len(list) != wantLen {
					t.Fatalf("%s holds %d entries (%v), want %d", key, len(list), list, wantLen)
				}
			}

			// The partial list: the kind that died mid-loop must report the
			// objects already deleted, and only those. Each such kind has two
			// objects in the fixture and fails on the second, so this can tell
			// a genuinely partial list apart from an empty or a full one.
			if c.wantPartialKey != "" {
				list := deleted[c.wantPartialKey].([]any)
				if len(list) != 1 {
					t.Fatalf("%s = %v, want exactly the first of the two", c.wantPartialKey, list)
				}
				entry, ok := list[0].(M)
				if !ok {
					t.Fatalf("%s[0] = %#v, want a map", c.wantPartialKey, list[0])
				}
				if entry["id"] != c.wantPartialID {
					t.Fatalf("%s[0] id = %v, want %s — the already-deleted object is the one the "+
						"operator has to go and rebuild", c.wantPartialKey, entry["id"], c.wantPartialID)
				}
			}
		})
	}
}

// onlyIncompleteEvent finds the single incomplete-teardown event in the stream.
// Exactly one: a second would mean two failure sites fired for one abort, which
// would double-report the same loss.
func onlyIncompleteEvent(t *testing.T, events []M) M {
	t.Helper()
	var found []M
	for _, m := range events {
		if _, ok := m["incomplete"]; ok {
			found = append(found, m)
		}
	}
	if len(found) != 1 {
		steps := []string{}
		for _, m := range events {
			steps = append(steps, pyStr(m["step"]))
		}
		t.Fatalf("the run emitted %d incomplete-teardown events, want exactly 1. "+
			"The teardown aborted partway and this event is the only record of what is already "+
			"deleted. steps seen: %v", len(found), steps)
	}
	return found[0]
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// SUPPLEMENT, AND WEAKER ON PURPOSE. This calls emitIncomplete directly, so it
// pins the event's shape without going through Decommission. It CANNOT detect a
// deleted call site — remove all five d.emitIncomplete lines and this still
// passes — which is why the table test above is the real coverage and this is
// only here to pin the field names and the pass-through of a caller's partial
// result independently of how Decommission happens to build one.
func TestEmitIncompleteCarriesTheCallersPartialResultVerbatim(t *testing.T) {
	var got []M
	d := &SiteDecommissioner{
		cfg:  teardownCfg(false),
		emit: func(m M) { got = append(got, m) },
	}
	// A result mid-run: the zone and one range are gone, nothing after.
	result := M{
		"dns_zone_deleted":      true,
		"dhcp_ranges_deleted":   []any{M{"id": failRange1ID}},
		"reverse_zones_deleted": []any{},
		"subnets_deleted":       []any{},
		"hosts_deleted":         []any{},
	}
	d.emitIncomplete(result, "delete DHCP ranges", perr("Failed to delete DHCP range %s: status 500", failRange2ID))

	if len(got) != 1 {
		t.Fatalf("emitIncomplete emitted %d events, want 1", len(got))
	}
	ev := got[0]
	if ev["failed_step"] != "delete DHCP ranges" {
		t.Fatalf("failed_step = %v", ev["failed_step"])
	}
	if s, _ := ev["error"].(string); !strings.Contains(s, failRange2ID) {
		t.Fatalf("error = %v, want the failing object named", ev["error"])
	}
	deleted, ok := ev["deleted"].(M)
	if !ok {
		t.Fatalf("deleted = %#v, want a map", ev["deleted"])
	}
	ranges, _ := deleted["dhcp_ranges_deleted"].([]any)
	if len(ranges) != 1 {
		t.Fatalf("dhcp_ranges_deleted = %v, want the caller's one entry unchanged", deleted["dhcp_ranges_deleted"])
	}
	if entry, _ := ranges[0].(M); entry["id"] != failRange1ID {
		t.Fatalf("dhcp_ranges_deleted[0] = %v, want %s", ranges[0], failRange1ID)
	}
}
