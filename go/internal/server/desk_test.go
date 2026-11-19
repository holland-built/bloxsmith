package server

import (
	"bloxsmith/internal/freecheck"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"bloxsmith/internal/demo"
	"bloxsmith/internal/runs"
)

// fakeTenant answers the calls the desk makes: nextavailableip reserves one
// address, GET says whether an address still exists, DELETE removes it (or is
// refused while refuseDelete is set).
type fakeTenant struct {
	mu             sync.Mutex
	exists         map[string]bool
	deletes        []string
	refuseDelete   bool
	slowDelete     chan struct{}     // when set, each DELETE waits for a value
	refusePatch    bool              // the tag PATCH after a new network fails
	inSubnet       []string          // addresses listed inside the new network
	ranges         int               // DHCP ranges listed inside the new network
	zoneRecords    []string          // record types listed in a zone
	subnet         string            // the network nextavailablesubnet makes; "" is 10.9.0.0/29
	writes         []string          // every POST, PATCH and DELETE, in order
	reserves       []map[string]any  // bodies of POST ipam/address
	refuseHold     map[string]bool   // addresses whose POST ipam/address fails
	held           map[string]string // reservation id -> address, while it exists
	refuseDeleteOf map[string]bool   // ids whose DELETE fails
}

func (f *fakeTenant) subnetJSON() string {
	s := f.subnet
	if s == "" {
		s = "10.9.0.0/29"
	}
	a, c, _ := strings.Cut(s, "/")
	return `{"id":"ipam/subnet/s-9","address":"` + a + `","cidr":` + c + `,"space":"ipam/ip_space/sp-1"}`
}

func (f *fakeTenant) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	p := r.URL.Path
	if r.Method != "GET" {
		f.writes = append(f.writes, r.Method+" "+p)
	}
	switch {
	case r.Method == "POST" && p == "/api/ddi/v1/ipam/address":
		var b map[string]any
		json.NewDecoder(r.Body).Decode(&b)
		f.reserves = append(f.reserves, b)
		addr, _ := b["address"].(string)
		if f.refuseHold[addr] {
			w.WriteHeader(500)
			io.WriteString(w, `{"error":[{"message":"refused"}]}`)
			return
		}
		id := "ipam/address/k-" + strings.ReplaceAll(addr, ".", "-")
		if f.held == nil {
			f.held = map[string]string{}
		}
		f.exists[id], f.held[id] = true, addr
		io.WriteString(w, `{"result":{"id":"`+id+`","address":"`+addr+`"}}`)
	case r.Method == "GET" && strings.HasSuffix(p, "/nextavailablesubnet"):
		io.WriteString(w, `{"results":[`+f.subnetJSON()+`]}`)
	case r.Method == "GET" && strings.HasSuffix(p, "/nextavailableip"):
		io.WriteString(w, `{"results":[{"address":"10.7.0.9"}]}`)
	case r.Method == "POST" && strings.HasSuffix(p, "/nextavailableip"):
		f.exists["ipam/address/a-1111"] = true
		io.WriteString(w, `{"results":[{"id":"ipam/address/a-1111","address":"10.7.0.4"}]}`)
	case r.Method == "POST" && p == "/api/ddi/v1/dns/record":
		f.exists["dns/record/r-1"] = true
		io.WriteString(w, `{"result":{"id":"dns/record/r-1"}}`)
	case r.Method == "POST" && strings.HasSuffix(p, "/nextavailablesubnet"):
		f.exists["ipam/subnet/s-9"] = true
		io.WriteString(w, `{"results":[`+f.subnetJSON()+`]}`)
	case r.Method == "PATCH":
		if f.refusePatch {
			w.WriteHeader(500)
			return
		}
		io.WriteString(w, `{"result":`+f.subnetJSON()+`}`)
	case r.Method == "GET" && p == "/api/ddi/v1/ipam/address":
		rows := []map[string]string{}
		s := f.subnet
		if s == "" {
			s = "10.9.0.0/29"
		}
		for a := range subnetOwnAddresses(s) {
			rows = append(rows, map[string]string{"address": a})
		}
		for _, a := range f.inSubnet {
			rows = append(rows, map[string]string{"address": a})
		}
		for id, a := range f.held {
			if f.exists[id] {
				rows = append(rows, map[string]string{"id": id, "address": a})
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"results": rows})
	case r.Method == "GET" && p == "/api/ddi/v1/dns/record":
		rows := []map[string]string{{"type": "SOA", "name_in_zone": ""}, {"type": "NS", "name_in_zone": ""}}
		for _, t := range f.zoneRecords {
			typ, name, _ := strings.Cut(t, " ")
			rows = append(rows, map[string]string{"type": typ, "name_in_zone": name})
		}
		json.NewEncoder(w).Encode(map[string]any{"results": rows})
	case r.Method == "GET" && p == "/api/ddi/v1/ipam/range":
		rows := make([]map[string]string, f.ranges)
		json.NewEncoder(w).Encode(map[string]any{"results": rows})
	case r.Method == "GET" && strings.Count(strings.TrimPrefix(p, "/api/ddi/v1/"), "/") == 2:
		if strings.Contains(p, "/address_block/") {
			io.WriteString(w, `{"result":{"id":"ipam/address_block/b-1","address":"10.9.0.0","cidr":16,"space":"ipam/ip_space/sp-1"}}`)
		} else if f.exists[strings.TrimPrefix(p, "/api/ddi/v1/")] {
			io.WriteString(w, `{"result":`+f.subnetJSON()+`}`)
		} else {
			w.WriteHeader(404)
		}
	case r.Method == "DELETE":
		id := strings.TrimPrefix(p, "/api/ddi/v1/")
		f.deletes = append(f.deletes, id)
		if f.slowDelete != nil {
			f.mu.Unlock()
			<-f.slowDelete
			f.mu.Lock()
		}
		if f.refuseDelete || f.refuseDeleteOf[id] {
			w.WriteHeader(500)
			io.WriteString(w, `{"error":"refused"}`)
			return
		}
		if !f.exists[id] {
			w.WriteHeader(404)
			return
		}
		delete(f.exists, id)
		w.WriteHeader(204)
	default:
		w.WriteHeader(500)
		io.WriteString(w, `{"error":"unexpected `+r.Method+` `+p+`"}`)
	}
}

func newDeskDeps(t *testing.T) (*Deps, *fakeTenant, string) {
	t.Helper()
	f := &fakeTenant{exists: map[string]bool{}}
	d, logPath := newDeleteDeps(t, f.handler)
	d.StateDir = t.TempDir()
	return d, f, logPath
}

func deskPost(t *testing.T, d *Deps, fn func(http.ResponseWriter, *http.Request, map[string]any), path, body string) (int, map[string]any) {
	t.Helper()
	r := httptest.NewRequest("POST", path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	d.body(fn)(rr, r)
	return rr.Code, decodeBody(t, rr)
}

func onlyRun(t *testing.T, d *Deps) runs.Run {
	t.Helper()
	rs, err := d.ledger().List()
	if err != nil || len(rs) != 1 {
		t.Fatalf("runs = %v (err %v), want exactly 1", rs, err)
	}
	return rs[0]
}

func TestDeskRun_PreviewRecordsNothing(t *testing.T) {
	d, _, _ := newDeskDeps(t)
	code, body := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"ip","input":{"subnet_id":"ipam/subnet/s-1"},"dry":true}`)
	if code != 200 || body["dry_run"] != true {
		t.Fatalf("preview = %d %v, want 200 dry_run", code, body)
	}
	if rs, _ := d.ledger().List(); len(rs) != 0 {
		t.Fatalf("a preview recorded %d runs, want 0", len(rs))
	}
}

func TestDeskRun_BuildRecordsTheExactID(t *testing.T) {
	d, _, logPath := newDeskDeps(t)
	code, body := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"ip","input":{"subnet_id":"ipam/subnet/s-1","name":"printer-02"},"dry":false}`)
	if code != 200 || body["ok"] != true {
		t.Fatalf("build = %d %v", code, body)
	}
	run := onlyRun(t, d)
	if run.Status != runs.Built || len(run.Objects) != 1 || run.Objects[0].ID != "ipam/address/a-1111" {
		t.Fatalf("run = %+v, want built with ipam/address/a-1111", run)
	}
	if run.Title != "IP address for printer-02: 10.7.0.4" {
		t.Fatalf("title = %q", run.Title)
	}
	if n := len(auditEntries(t, logPath, "desk-build")); n != 1 {
		t.Fatalf("desk-build audit entries = %d, want 1", n)
	}
}

func TestDeskRemove_DeletesOnlyTheRunsObjectsAndCanRetry(t *testing.T) {
	d, f, logPath := newDeskDeps(t)
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"ip","input":{"subnet_id":"ipam/subnet/s-1"},"dry":false}`)
	run := onlyRun(t, d)

	// Preview reports what is still there and deletes nothing.
	code, body := deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":true}`)
	would, _ := body["would_remove"].([]any)
	if code != 200 || len(would) != 1 || len(f.deletes) != 0 {
		t.Fatalf("remove preview = %d %v, deletes %v", code, body, f.deletes)
	}

	// Infoblox refuses: the run says so and keeps the object for a retry.
	f.refuseDelete = true
	code, _ = deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	if got := onlyRun(t, d); code != 502 || got.Status != runs.RemoveFailed || got.Objects[0].State != runs.Error {
		t.Fatalf("refused remove = %d %+v", code, got)
	}

	// Retry succeeds and deletes exactly the recorded ID.
	f.refuseDelete = false
	f.deletes = nil
	code, _ = deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	got := onlyRun(t, d)
	if code != 200 || got.Status != runs.Removed || got.Objects[0].State != runs.Deleted {
		t.Fatalf("retried remove = %d %+v", code, got)
	}
	if len(f.deletes) != 1 || f.deletes[0] != "ipam/address/a-1111" {
		t.Fatalf("deletes = %v, want only ipam/address/a-1111", f.deletes)
	}

	// A third Remove has nothing left to delete.
	f.deletes = nil
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	if len(f.deletes) != 0 {
		t.Fatalf("a finished run deleted again: %v", f.deletes)
	}
	if n := len(auditEntries(t, logPath, "desk-remove")); n != 3 {
		t.Fatalf("desk-remove audit entries = %d, want 3", n)
	}
}

// Two Removes at once: one deletes, the other is told the run is busy or finds
// nothing left. The address is never deleted twice.
func TestDeskRemove_TwoAtOnceDeleteOnce(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"ip","input":{"subnet_id":"ipam/subnet/s-1"},"dry":false}`)
	run := onlyRun(t, d)
	f.slowDelete = make(chan struct{})
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i], _ = deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
		}(i)
	}
	// Let any deletes through once both requests are under way.
	go func() {
		for i := 0; i < 2; i++ {
			f.slowDelete <- struct{}{}
		}
	}()
	wg.Wait()
	f.mu.Lock()
	n := len(f.deletes)
	f.mu.Unlock()
	if n != 1 {
		t.Fatalf("deletes = %d (codes %v), want exactly 1", n, codes)
	}
	if got := onlyRun(t, d); got.Status != runs.Removed {
		t.Fatalf("run = %+v, want removed", got)
	}
}

func TestDeskRemove_AlreadyGoneCountsAsDone(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"ip","input":{"subnet_id":"ipam/subnet/s-1"},"dry":false}`)
	run := onlyRun(t, d)
	delete(f.exists, "ipam/address/a-1111") // someone released it by hand
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	if got := onlyRun(t, d); got.Status != runs.Removed || got.Objects[0].State != runs.Gone {
		t.Fatalf("run = %+v, want removed with the object marked gone", got)
	}
}

func TestDeskRun_UnknownJobAndMissingNetworkAreRefused(t *testing.T) {
	d, _, _ := newDeskDeps(t)
	if code, _ := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"rm-rf","input":{},"dry":false}`); code != 400 {
		t.Fatalf("unknown job = %d, want 400", code)
	}
	if code, _ := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"ip","input":{},"dry":false}`); code != 400 {
		t.Fatalf("no network = %d, want 400", code)
	}
}

func TestDeskRun_NoStateDirBuildsNothing(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	d.StateDir = ""
	code, _ := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"ip","input":{"subnet_id":"ipam/subnet/s-1"},"dry":false}`)
	if code != 500 || len(f.exists) != 0 {
		t.Fatalf("with nowhere to record: %d, created %v; want 500 and nothing created", code, f.exists)
	}
}

// A run left "building" by a server that stopped part way shows as failed on
// the next start, not stuck forever.
func TestLedger_BuildingRunIsMarkedFailedOnRestart(t *testing.T) {
	dir := t.TempDir()
	rs := []runs.Run{{ID: "r-1", Status: runs.Building, Created: "2026-11-05T00:00:00Z"}}
	b, _ := json.Marshal(rs)
	if err := os.WriteFile(filepath.Join(dir, "desk_runs.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	got, _, _ := runs.Open(dir).Get("r-1")
	if got.Status != runs.Failed || got.Error == "" {
		t.Fatalf("run = %+v, want failed with a reason", got)
	}
}

func TestDeskRun_DNSNameBuildsAndRemovesTheRecord(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	in := `{"zone_id":"dns/auth_zone/z-1","zone_name":"lab.example.","name_in_zone":"www","type":"a","value":"10.1.2.3"}`
	if code, body := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"dns","input":`+in+`,"dry":true}`); code != 200 || body["dry_run"] != true {
		t.Fatalf("preview = %d %v", code, body)
	}
	if rs, _ := d.ledger().List(); len(rs) != 0 {
		t.Fatalf("a preview recorded %d runs", len(rs))
	}
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"dns","input":`+in+`,"dry":false}`)
	run := onlyRun(t, d)
	if run.Status != runs.Built || len(run.Objects) != 1 || run.Objects[0].ID != "dns/record/r-1" || run.Objects[0].Label != "www.lab.example A 10.1.2.3" {
		t.Fatalf("run = %+v", run)
	}
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	if len(f.deletes) != 1 || f.deletes[0] != "dns/record/r-1" {
		t.Fatalf("deletes = %v, want only dns/record/r-1", f.deletes)
	}
}

func TestDeskRun_DNSNameRefusesOtherTypes(t *testing.T) {
	d, _, _ := newDeskDeps(t)
	code, _ := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"dns","input":{"zone_id":"dns/auth_zone/z-1","name_in_zone":"x","type":"NS","value":"ns1."},"dry":false}`)
	if code != 400 {
		t.Fatalf("NS record = %d, want 400", code)
	}
}

const networkInput = `{"space":"ipam/ip_space/sp-1","block_id":"ipam/address_block/b-1","cidr":29,"name":"demo-net"}`

func TestDeskRun_NetworkRecordsItsSpaceAndID(t *testing.T) {
	d, _, _ := newDeskDeps(t)
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+networkInput+`,"dry":false}`)
	run := onlyRun(t, d)
	if run.Status != runs.Built || run.Space != "ipam/ip_space/sp-1" || len(run.Objects) != 1 ||
		run.Objects[0].ID != "ipam/subnet/s-9" || run.Objects[0].Label != "10.9.0.0/29, demo-net" {
		t.Fatalf("run = %+v", run)
	}
}

// A network whose tags failed still exists, so it is recorded and removable.
func TestDeskRun_NetworkWithFailedTagsIsStillRecorded(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	f.refusePatch = true
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+networkInput+`,"dry":false}`)
	run := onlyRun(t, d)
	if run.Status != runs.Failed || len(run.Objects) != 1 || run.Objects[0].ID != "ipam/subnet/s-9" {
		t.Fatalf("run = %+v, want failed but holding ipam/subnet/s-9", run)
	}
}

// A Build that made nothing does not make its space "yours".
func TestBuiltSpaces_CountsOnlyRunsThatMadeSomething(t *testing.T) {
	d, _, _ := newDeskDeps(t)
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+networkInput+`,"dry":false}`)
	d.ledger().Add(runs.Run{ID: "r-empty", Space: "ipam/ip_space/other", Status: runs.Failed, Created: "2026-11-05T00:00:00Z"})
	got := d.builtSpaces()
	if got["ipam/ip_space/sp-1"] == "" || got["ipam/ip_space/other"] != "" {
		t.Fatalf("built spaces = %v, want only sp-1", got)
	}
}

// Deleting a network takes everything in it, so Remove refuses while it holds
// anything this run did not make, and deletes it once it is empty again.
func TestDeskRemove_NetworkIsKeptWhileItHoldsOtherThings(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+networkInput+`,"dry":false}`)
	run := onlyRun(t, d)

	f.inSubnet = []string{"10.9.0.3"}
	_, body := deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":true}`)
	would, _ := body["would_remove"].([]any)
	if len(would) != 1 || !strings.Contains(anyStr(would[0].(map[string]any)["blocked"]), "1 address") {
		t.Fatalf("preview = %v, want the network flagged as holding 1 address", body)
	}
	code, _ := deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	if got := onlyRun(t, d); code != 502 || got.Status != runs.RemoveFailed || len(f.deletes) != 0 {
		t.Fatalf("remove with an address inside = %d %+v, deletes %v", code, got, f.deletes)
	}

	f.inSubnet, f.ranges = nil, 1
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	if len(f.deletes) != 0 {
		t.Fatalf("a network holding a DHCP range was deleted: %v", f.deletes)
	}

	f.ranges = 0
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	if got := onlyRun(t, d); got.Status != runs.Removed || len(f.deletes) != 1 || f.deletes[0] != "ipam/subnet/s-9" {
		t.Fatalf("empty network remove = %+v, deletes %v", got, f.deletes)
	}
}

func TestSubnetOwnAddresses(t *testing.T) {
	got := subnetOwnAddresses("10.9.0.0/29")
	if len(got) != 2 || !got["10.9.0.0"] || !got["10.9.0.7"] {
		t.Fatalf("own = %v", got)
	}
	if len(subnetOwnAddresses("2001:db8::/64")) != 0 {
		t.Fatal("IPv6 should skip nothing")
	}
}

func TestRankSpaces_YoursFirstThenRoom(t *testing.T) {
	spaces := []any{
		map[string]any{"id": "a", "name": "Big Lab"},
		map[string]any{"id": "b", "name": "jdoe-demo"},
		map[string]any{"id": "c", "name": "Small Lab"},
		map[string]any{"id": "d", "name": "Old Build"},
		map[string]any{"id": "e", "name": "Unknown"},
	}
	free := map[string][2]int{"a": {5000, 6000}, "b": {10, 256}, "c": {20, 256}, "d": {1, 256}}
	got := rankSpaces(spaces, map[string]string{"d": "2026-11-01T10:00:00Z"}, free, "JDoe")
	order := []string{}
	for _, r := range got {
		order = append(order, r.ID)
		if strings.Contains(strings.ToLower(r.Reason), "jdoe") {
			t.Fatalf("the login leaked into a reason: %q", r.Reason)
		}
	}
	if strings.Join(order, ",") != "d,b,a,c,e" {
		t.Fatalf("order = %v, want d,b,a,c,e", order)
	}
	if !got[0].Yours || !got[1].Yours || got[2].Yours || got[2].Reason != "5,000 of 6,000 addresses free" || got[1].Reason != "Named for you" {
		t.Fatalf("rows = %+v", got)
	}
	// A login too short to mean anything matches nothing.
	if r := rankSpaces(spaces, nil, free, "jd"); r[0].Yours {
		t.Fatalf("a 2-letter login matched %+v", r[0])
	}
}

// siteResult is what the site provisioner returns for a built branch office.
func siteResult(zoneCreated bool) map[string]any {
	return map[string]any{"ok": true,
		"subnets":          []any{map[string]any{"id": "ipam/subnet/s-9", "address": "10.9.0.0/29", "name": "bench"}},
		"dhcp_ranges":      []any{map[string]any{"id": "ipam/range/g-1", "start": "10.9.0.2", "end": "10.9.0.5"}},
		"dns_zone_id":      "dns/auth_zone/z-1",
		"dns_zone_fqdn":    "acme.lab.example.com.",
		"dns_zone_created": zoneCreated,
		"reverse_zones":    []any{map[string]any{"id": "dns/auth_zone/rz-1", "fqdn": "0.9.10.in-addr.arpa.", "created": false}},
		"hosts":            []any{map[string]any{"id": "ipam/host/h-1", "fqdn": "jump01.acme.lab.example.com"}, map[string]any{"id": "(dry-run)"}},
		"unknown_ids":      []any{},
	}
}

func objectKinds(objs []runs.Object) string {
	var out []string
	for _, o := range objs {
		out = append(out, o.Kind+":"+o.ID)
	}
	return strings.Join(out, " ")
}

func TestSiteObjects_RecordsOnlyWhatThisRunMade(t *testing.T) {
	objs, _ := siteObjects(siteResult(true))
	want := "host:ipam/host/h-1 dns_zone:dns/auth_zone/z-1 dhcp_range:ipam/range/g-1 subnet:ipam/subnet/s-9"
	if got := objectKinds(objs); got != want {
		t.Fatalf("objects = %s\nwant      %s", got, want)
	}
	// A zone that was already there, and a reverse zone not marked created,
	// are never recorded, so Remove can never delete them.
	objs, _ = siteObjects(siteResult(false))
	if strings.Contains(objectKinds(objs), "auth_zone") {
		t.Fatalf("a zone this run did not create was recorded: %s", objectKinds(objs))
	}
}

func TestSiteObjects_FailedBuildRecordsWhatRollbackLeft(t *testing.T) {
	res := map[string]any{"ok": false, "rollback": map[string]any{"outcome": "partial", "residual": []any{
		map[string]any{"kind": "subnet", "id": "ipam/subnet/s-9", "label": "10.9.0.0/29"},
		map[string]any{"kind": "reverse_zone", "id": "dns/auth_zone/rz-1", "label": "0.9.10.in-addr.arpa"},
	}}}
	objs, _ := siteObjects(res)
	if got := objectKinds(objs); got != "subnet:ipam/subnet/s-9 dns_zone:dns/auth_zone/rz-1" {
		t.Fatalf("objects = %s", got)
	}
}

// A branch office is removed hosts first and the network last, and a zone that
// now holds someone else's record is kept.
func TestDeskRemove_BranchOfficeOrderAndZoneCheck(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	objs, _ := siteObjects(siteResult(true))
	for _, o := range objs {
		f.exists[o.ID] = true
	}
	run := runs.Run{ID: "r-branch", Job: "branch", Status: runs.Built, Created: "2026-11-05T00:00:00Z", Objects: objs}
	if err := d.ledger().Add(run); err != nil {
		t.Fatal(err)
	}
	f.zoneRecords = []string{"NS sub"} // a delegation someone added
	_, body := deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"r-branch","dry":true}`)
	blocked := 0
	for _, x := range body["would_remove"].([]any) {
		if x.(map[string]any)["blocked"] != nil {
			blocked++
		}
	}
	if blocked != 1 {
		t.Fatalf("preview = %v, want only the zone flagged", body)
	}
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"r-branch","dry":false}`)
	if got := strings.Join(f.deletes, " "); got != "ipam/host/h-1 ipam/range/g-1 ipam/subnet/s-9" {
		t.Fatalf("deletes = %s, want host, range, network and the zone kept", got)
	}
	if got := onlyRun(t, d); got.Status != runs.RemoveFailed {
		t.Fatalf("run = %+v, want remove-failed while the zone is kept", got)
	}

	f.zoneRecords, f.deletes = nil, nil
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"r-branch","dry":false}`)
	if got := strings.Join(f.deletes, " "); got != "dns/auth_zone/z-1" {
		t.Fatalf("retry deletes = %s, want only the now-empty zone", got)
	}
	if got := onlyRun(t, d); got.Status != runs.Removed {
		t.Fatalf("run = %+v, want removed", got)
	}
}

func TestDeskRun_SiteAndKitNamesAreChecked(t *testing.T) {
	d, _, _ := newDeskDeps(t)
	for _, body := range []string{
		`{"job":"branch","input":{"template":"amer/lab/site-amer-lab.yaml","site":"Bad Name"},"dry":true}`,
		`{"job":"demo","input":{"customer":"acme","region":"mars"},"dry":true}`,
		`{"job":"demo","input":{"customer":"-acme","region":"amer"},"dry":true}`,
	} {
		if code, _ := deskPost(t, d, d.deskRun, "/api/desk/run", body); code != 400 {
			t.Fatalf("%s = %d, want 400", body, code)
		}
	}
}

func TestSampleNames(t *testing.T) {
	res := map[string]any{"subnets": []any{map[string]any{"address": "10.9.0.0/25"}}, "dns_zone_fqdn": "acme.lab.example.com."}
	base := firstSubnetBase(res)
	addrs, _ := sampleAddrs(freecheck.NewSnapshot(nil), res, base)
	if got := sampleLabel("www", res, sampleAt(addrs, 0)); got != "www.acme.lab.example.com A 10.9.0.10" {
		t.Fatalf("label = %q", got)
	}
	if got := sampleAt(addrs, 4).String(); got != "10.9.0.14" {
		t.Fatalf("ip = %q", got)
	}
	// A network too small for .10 to .14 gets no sample names.
	small := map[string]any{"subnets": []any{map[string]any{"address": "10.9.0.0/29"}}}
	if firstSubnetBase(small).IsValid() {
		t.Fatal("a /29 was offered for sample names")
	}
}

// Demo servers built on the Demo server page are listed for removal but never
// removed by themselves, and one still building cannot be removed.
func TestDeskRuns_ListsOlderDemoServersAndGuardsBuildingOnes(t *testing.T) {
	d, _, _ := newDeskDeps(t)
	st := d.demoStore()
	for _, r := range []*demo.Run{
		{Change: "c-20261101-100000", Status: "ready", IP: "10.99.0.5"},
		{Change: "c-20261101-110000", Status: "building"},
		{Change: "c-20261101-090000", Status: "removed"},
	} {
		if err := st.Save(r); err != nil {
			t.Fatal(err)
		}
	}
	rr := httptest.NewRecorder()
	d.deskRuns(rr, httptest.NewRequest("GET", "/api/desk/runs", nil))
	body := decodeBody(t, rr)
	if older, _ := body["older_demos"].([]any); len(older) != 2 {
		t.Fatalf("older_demos = %v, want the two not removed", body["older_demos"])
	}
	_, plan := deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"demo_change":"c-20261101-110000","dry":true}`)
	row := plan["would_remove"].([]any)[0].(map[string]any)
	if !strings.Contains(anyStr(row["blocked"]), "still being built") {
		t.Fatalf("plan = %v, want a building server flagged", plan)
	}
	if code, _ := deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"demo_change":"c-20261101-110000","dry":false}`); code != 502 {
		t.Fatalf("removing a building demo server = %d, want 502", code)
	}
	if got, _ := st.Load("c-20261101-110000"); got.Status != "building" {
		t.Fatalf("run = %+v, want it left alone", got)
	}
}

// The sample names never point at an address the site's own DHCP range or
// hosts use: a lab template whose first network hands out .10 up by DHCP got
// sample A records inside its own range.
func TestSampleNames_SkipTheSiteOwnRangeAndHosts(t *testing.T) {
	res := map[string]any{
		"subnets":     []any{map[string]any{"address": "10.9.0.0/24"}},
		"dhcp_ranges": []any{map[string]any{"start": "10.9.0.10", "end": "10.9.0.12"}},
		"hosts":       []any{map[string]any{"ip": "10.9.0.14"}},
	}
	addrs, skipped := sampleAddrs(freecheck.NewSnapshot(nil), res, firstSubnetBase(res))
	var got []string
	for _, a := range addrs {
		got = append(got, a.String())
	}
	if strings.Join(got, " ") != "10.9.0.13 10.9.0.15 10.9.0.16 10.9.0.17 10.9.0.18" {
		t.Fatalf("sample addresses = %v", got)
	}
	if len(skipped) != 2 {
		t.Fatalf("skipped = %+v, want the range and the host", skipped)
	}
}

// cloudInput is the network job with a cloud picked.
func cloudInput(cloud string, cidr int) string {
	return fmt.Sprintf(`{"space":"ipam/ip_space/sp-1","block_id":"ipam/address_block/b-1","cidr":%d,"name":"cloud-net","cloud":%q}`, cidr, cloud)
}

func reservedAddrs(f *fakeTenant) string {
	var out []string
	for _, b := range f.reserves {
		out = append(out, anyStr(b["address"])+"="+anyStr(b["comment"]))
	}
	return strings.Join(out, " ")
}

// Build holds back the cloud's own addresses after the network is made,
// counted from the network Infoblox actually made, and records each one.
func TestDeskRun_NetworkHoldsTheCloudsAddresses(t *testing.T) {
	for _, c := range []struct{ cloud, subnet, want string }{
		{"aws", "10.9.0.32/28", "10.9.0.33=Kept by AWS: router 10.9.0.34=Kept by AWS: DNS 10.9.0.35=Kept by AWS: future use"},
		{"azure", "10.9.4.0/24", "10.9.4.1=Kept by Azure: gateway 10.9.4.2=Kept by Azure: DNS 10.9.4.3=Kept by Azure: DNS"},
		{"gcp", "10.9.0.32/28", "10.9.0.33=Kept by Google Cloud: gateway 10.9.0.46=Kept by Google Cloud: reserved by Google"},
	} {
		d, f, _ := newDeskDeps(t)
		f.subnet = c.subnet
		_, cidr, _ := strings.Cut(c.subnet, "/")
		n := 28
		fmt.Sscan(cidr, &n)
		code, body := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+cloudInput(c.cloud, n)+`,"dry":false}`)
		if code != 200 || body["ok"] != true {
			t.Fatalf("%s build = %d %v", c.cloud, code, body)
		}
		if got := reservedAddrs(f); got != c.want {
			t.Fatalf("%s held %q, want %q", c.cloud, got, c.want)
		}
		for _, b := range f.reserves {
			if anyStr(b["space"]) != "ipam/ip_space/sp-1" {
				t.Fatalf("%s reservation without the network's space: %v", c.cloud, b)
			}
		}
		if !strings.HasSuffix(f.writes[0], "/nextavailablesubnet") || !strings.HasPrefix(f.writes[len(f.writes)-1], "POST /api/ddi/v1/ipam/address") {
			t.Fatalf("%s writes %v, want the network first and the reservations after", c.cloud, f.writes)
		}
		run := onlyRun(t, d)
		if run.Status != runs.Built || len(run.Objects) != 1+len(f.reserves) {
			t.Fatalf("%s run = %+v, want the network and each held address recorded", c.cloud, run)
		}
		for _, o := range run.Objects[1:] {
			if o.Kind != "address" || !strings.HasPrefix(o.ID, "ipam/address/k-") || !strings.Contains(o.Label, "Kept by") {
				t.Fatalf("%s recorded %+v", c.cloud, o)
			}
		}
	}
}

// None makes no reservations; Preview writes nothing and lists the held ones.
func TestDeskRun_NetworkNoneHoldsNothingAndPreviewWritesNothing(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+cloudInput("none", 29)+`,"dry":false}`)
	if len(f.reserves) != 0 || len(onlyRun(t, d).Objects) != 1 {
		t.Fatalf("None held %v", f.reserves)
	}

	d, f, _ = newDeskDeps(t)
	_, body := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+cloudInput("aws", 28)+`,"dry":true}`)
	if len(f.writes) != 0 {
		t.Fatalf("preview wrote %v", f.writes)
	}
	if rs, _ := d.ledger().List(); len(rs) != 0 {
		t.Fatalf("preview recorded %v", rs)
	}
	held, _ := body["would_create"].(map[string]any)["held"].([]any)
	if len(held) != 3 {
		t.Fatalf("preview = %v, want 3 held addresses listed", body)
	}
}

// A reservation that fails keeps the network, records it and every hold that
// worked, and says which addresses were not held. The run counts as built, so
// the page never offers a Build that would make a second network.
func TestDeskRun_NetworkFailedHoldKeepsAndRecordsTheNetwork(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	f.subnet = "10.9.0.32/28"
	f.refuseHold = map[string]bool{"10.9.0.34": true}
	code, body := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+cloudInput("aws", 28)+`,"dry":false}`)
	for _, w := range f.writes {
		if strings.HasPrefix(w, "DELETE") {
			t.Fatalf("the network was deleted: %v", f.writes)
		}
	}
	run := onlyRun(t, d)
	if code != 200 || body["ok"] != true || run.Status != runs.Built {
		t.Fatalf("build = %d %v, run %+v", code, body, run)
	}
	if len(run.Objects) != 3 || run.Objects[0].ID != "ipam/subnet/s-9" {
		t.Fatalf("objects = %+v, want the network and the 2 holds that worked", run.Objects)
	}
	if !strings.Contains(run.Note, "10.9.0.34") || strings.Contains(run.Note, "10.9.0.33") {
		t.Fatalf("note = %q, want it to name only 10.9.0.34", run.Note)
	}
}

// Remove deletes this run's held addresses first, then the network, and the
// held addresses do not count as someone else's contents.
func TestDeskRemove_NetworkDeletesItsHeldAddressesFirst(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	f.subnet = "10.9.0.32/28"
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+cloudInput("aws", 28)+`,"dry":false}`)
	run := onlyRun(t, d)
	_, body := deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":true}`)
	for _, w := range body["would_remove"].([]any) {
		if b := anyStr(w.(map[string]any)["blocked"]); b != "" {
			t.Fatalf("preview blocked by its own holds: %v", body)
		}
	}
	f.writes = nil
	code, _ := deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	want := "DELETE /api/ddi/v1/ipam/address/k-10-9-0-33 DELETE /api/ddi/v1/ipam/address/k-10-9-0-34 DELETE /api/ddi/v1/ipam/address/k-10-9-0-35 DELETE /api/ddi/v1/ipam/subnet/s-9"
	if got := strings.Join(f.writes, " "); code != 200 || got != want {
		t.Fatalf("remove = %d, writes %s, want %s", code, got, want)
	}
	// Someone else's address in the network still blocks it.
	d, f, _ = newDeskDeps(t)
	f.subnet = "10.9.0.32/28"
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+cloudInput("aws", 28)+`,"dry":false}`)
	f.inSubnet = []string{"10.9.0.40"}
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+onlyRun(t, d).ID+`","dry":false}`)
	if f.exists["ipam/subnet/s-9"] != true {
		t.Fatal("a network holding someone else's address was deleted")
	}
}

// A held address whose delete fails is still inside the network, so the
// network must not be deleted with it.
func TestDeskRemove_NetworkKeptWhenAHeldAddressWouldNotDelete(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	f.subnet = "10.9.0.32/28"
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+cloudInput("aws", 28)+`,"dry":false}`)
	f.refuseDeleteOf = map[string]bool{"ipam/address/k-10-9-0-34": true}
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+onlyRun(t, d).ID+`","dry":false}`)
	if f.exists["ipam/subnet/s-9"] != true {
		t.Fatalf("the network was deleted while 10.9.0.34 was still held in it: %v", f.writes)
	}
}

// AWS does not allow a network smaller than /28.
func TestDeskRun_AWSRefusesSlash29(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	for _, dry := range []string{"true", "false"} {
		code, body := deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+cloudInput("aws", 29)+`,"dry":`+dry+`}`)
		if code != 400 || !strings.Contains(anyStr(body["error"]), "AWS") {
			t.Fatalf("aws /29 dry=%s = %d %v", dry, code, body)
		}
	}
	if len(f.writes) != 0 {
		t.Fatalf("writes %v", f.writes)
	}
	if rs, _ := d.ledger().List(); len(rs) != 0 {
		t.Fatalf("recorded %v", rs)
	}
}
