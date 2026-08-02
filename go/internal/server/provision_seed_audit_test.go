package server

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// --- the seed/teardown aggregate audit entries, read back off disk -----------
//
// provisionSeedDemoStream and teardownSeedDemoStream each end with one
// aggregate auditAppend carrying "regions" plus the succeeded/failed/skipped
// counts. Both passed parseRegions' []string straight into the detail map, and
// audit.canonicalJSON's type switch has no []string case — so every one of
// those entries was rejected, logged by auditAppend, and never written. The
// stream still emitted its terminal frame and the request still succeeded,
// which is precisely why nobody noticed: a destructive bulk teardown ran with
// no record of it anywhere.
//
// These tests therefore assert on the FILE. A status code, a terminal frame, or
// a spy on the call site all stay green through the bug. Reading
// audit_log.jsonl is the only assertion that distinguishes "recorded" from
// "logged an error and moved on".

// seedSuccessUpstream answers every call a clean, non-dry seed-demo run makes:
// the address blocks already exist (so the block step succeeds without
// creating), and each site gets its subnets, DHCP range, zones and hosts.
// Nothing fails, so no rollback runs and the terminal frame is all-succeeded.
func seedSuccessUpstream() http.HandlerFunc {
	var mu sync.Mutex
	subnets, ranges, zones, hosts := 0, 0, 0, 0
	next := func(n *int) int {
		mu.Lock()
		defer mu.Unlock()
		*n++
		return *n
	}
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(path, "/nextavailablesubnet"):
			i := next(&subnets)
			fmt.Fprintf(w, `{"results":[{"id":"ipam/subnet/sn-%d","address":"10.1.%d.0","cidr":25}]}`, i, i)
		case r.Method == "PATCH" && strings.Contains(path, "/ipam/subnet/"):
			id := strings.TrimPrefix(path, "/api/ddi/v1/")
			fmt.Fprintf(w, `{"result":{"id":"%s","address":"10.1.%s.0","cidr":25}}`,
				id, strings.TrimPrefix(id, "ipam/subnet/sn-"))
		case strings.HasSuffix(path, "/ipam/host"):
			fmt.Fprintf(w, `{"result":{"id":"ipam/host/h-%d"}}`, next(&hosts))
		case strings.HasSuffix(path, "/ipam/range"):
			fmt.Fprintf(w, `{"result":{"id":"ipam/range/rg-%d"}}`, next(&ranges))
		case strings.HasSuffix(path, "/dns/auth_zone"):
			if r.Method == "POST" {
				fmt.Fprintf(w, `{"result":{"id":"dns/auth_zone/z-%d"}}`, next(&zones))
				return
			}
			io.WriteString(w, `{"results":[]}`) // no existing zone -> this run creates it
		case strings.HasSuffix(path, "/ipam/ip_space"):
			io.WriteString(w, `{"results":[{"id":"ipam/ip_space/sp-1"}]}`)
		case strings.HasSuffix(path, "/ipam/subnet"):
			io.WriteString(w, `{"results":[]}`) // findExistingSite: not provisioned yet
		case strings.HasSuffix(path, "/ipam/address_block"):
			io.WriteString(w, `{"results":[{"id":"ipam/address_block/blk-1","address":"10.1.0.0","cidr":16}]}`)
		case strings.HasSuffix(path, "/dns/view"):
			io.WriteString(w, `{"results":[{"id":"dns/view/v-1"}]}`)
		default:
			w.WriteHeader(500)
			fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, path)
		}
	}
}

// teardownSuccessUpstream answers a clean, non-dry seed-demo teardown: the IP
// space and DNS view resolve, each site's object reads come back empty (nothing
// left to delete, still a successful teardown), and the regional address block
// is found and deleted.
func teardownSuccessUpstream(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.Method == "DELETE":
		io.WriteString(w, `{"result":{}}`)
	case strings.HasSuffix(path, "/ipam/ip_space"):
		io.WriteString(w, `{"results":[{"id":"ipam/ip_space/sp-1","name":"default"}]}`)
	case strings.HasSuffix(path, "/dns/view"):
		io.WriteString(w, `{"results":[{"id":"dns/view/v-1","name":"default"}]}`)
	case strings.HasSuffix(path, "/ipam/address_block"):
		io.WriteString(w, `{"results":[{"id":"ipam/address_block/blk-1","address":"10.1.0.0","cidr":16}]}`)
	case strings.HasSuffix(path, "/ipam/subnet"),
		strings.HasSuffix(path, "/ipam/range"),
		strings.HasSuffix(path, "/ipam/host"),
		strings.HasSuffix(path, "/dns/auth_zone"):
		io.WriteString(w, `{"results":[]}`)
	default:
		w.WriteHeader(500)
		fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, path)
	}
}

func teardownSeedStreamRequest(qs string) *http.Request {
	r := httptest.NewRequest("GET", "/api/teardown/seed-demo/stream?"+qs, nil)
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	return r
}

// regionsOf pulls the "regions" list out of an audit detail read back from
// disk. Absent or wrongly shaped is a failure: regions is the only field that
// says WHICH slice of the demo estate the run touched, and it is the field that
// took the whole entry down with it.
func regionsOf(t *testing.T, detail map[string]any, where string) []string {
	t.Helper()
	raw, ok := detail["regions"]
	if !ok {
		t.Fatalf("%s carries no \"regions\" key: %v", where, detail)
	}
	list, ok := raw.([]any)
	if !ok {
		t.Fatalf("%s regions is %T, want a list: %v", where, raw, raw)
	}
	out := make([]string, 0, len(list))
	for _, v := range list {
		s, ok := v.(string)
		if !ok {
			t.Fatalf("%s regions entry is %T, want a string: %v", where, v, v)
		}
		out = append(out, s)
	}
	return out
}

// A successful non-dry seed-demo run must leave its aggregate entry ON DISK.
// Before the []any widening at the call site, canonicalJSON rejected the
// []string regions, auditAppend logged it, and this file stayed empty while the
// stream reported three templates provisioned.
func TestProvisionSeedDemoStream_SuccessWritesAggregateAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, seedSuccessUpstream())
	rr := httptest.NewRecorder()
	d.provisionSeedDemoStream(rr, seedStreamRequest("regions=amer&dry=0"))

	terminal := terminalFrameOf(t, parseSSEFrames(t, rr.Body.String()))
	if terminal["failed"] != float64(0) || terminal["succeeded"] != float64(3) {
		t.Fatalf("terminal frame = %v, want 3 succeeded / 0 failed (blocks + both amer sites)", terminal)
	}

	entries := auditEntries(t, logPath, "provision-seed-demo")
	if len(entries) != 1 {
		t.Fatalf("provision-seed-demo entries on disk = %d, want 1 — an entry canonicalJSON "+
			"refuses is only log.Printf'd, so the run reports success with nothing recorded", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if got := regionsOf(t, detail, "provision-seed-demo audit detail"); len(got) != 1 || got[0] != "amer" {
		t.Fatalf("audit regions = %v, want [amer]", got)
	}
	if detail["succeeded"] != float64(3) {
		t.Fatalf("audit succeeded = %v, want 3 (the same count the terminal frame reported)", detail["succeeded"])
	}
}

// The destructive half, and the reason this bug mattered: a non-dry seed-demo
// TEARDOWN must leave a record. StateDir is set because a real teardown refuses
// to run unless it can first write its pre-delete export (provision/export.go).
func TestTeardownSeedDemoStream_WritesAggregateAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, teardownSuccessUpstream)
	d.StateDir = t.TempDir()
	rr := httptest.NewRecorder()
	d.teardownSeedDemoStream(rr, teardownSeedStreamRequest("regions=amer&dry=0&confirm=DELETE"))

	terminal := terminalFrameOf(t, parseSSEFrames(t, rr.Body.String()))
	if terminal["failed"] != float64(0) || terminal["succeeded"] != float64(3) {
		t.Fatalf("terminal frame = %v, want 3 succeeded / 0 failed (both amer sites + the block pool)", terminal)
	}

	entries := auditEntries(t, logPath, "teardown-seed-demo")
	if len(entries) != 1 {
		t.Fatalf("teardown-seed-demo entries on disk = %d, want 1 — a bulk teardown that deletes "+
			"a region's estate and records nothing is the worst case of this silent drop", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if got := regionsOf(t, detail, "teardown-seed-demo audit detail"); len(got) != 1 || got[0] != "amer" {
		t.Fatalf("audit regions = %v, want [amer]", got)
	}
	if detail["succeeded"] != float64(3) {
		t.Fatalf("audit succeeded = %v, want 3 (the same count the terminal frame reported)", detail["succeeded"])
	}
}
