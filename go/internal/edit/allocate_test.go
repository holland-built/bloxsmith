package edit

// Tests for SelfserviceAllocate (edit.go:478) and its response plumbing —
// pyStrOr (623), respAddresses (632), addressSummaries (646).
//
// Why this file exists and why it is careful: SelfserviceAllocate reserves REAL
// IP addresses in a customer tenant, then creates a DNS record for them, and if
// that DNS step fails it DELETEs the addresses it just reserved (the
// "compensating release", edit.go:592-615). That release loop is the only code
// in this package that issues a DELETE the operator never asked for. Two ways
// it can hurt a customer:
//
//   - it deletes the WRONG address object — an address someone else owns, which
//     no operator asked to release and no audit trail explains;
//   - it releases only some of the reservations, so the rest leak until the
//     subnet is exhausted and nothing can be allocated at all.
//
// Neither failure is visible with a single reservation ("released them all" and
// "released the last one only" are the same run), so every release test here
// allocates count:2 and asserts BOTH DELETEs, by id, in order.
//
// All upstream traffic is a net/http/httptest fake. No test in this file may
// ever be pointed at a live tenant.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// --- the two-personality recording fake --------------------------------------

// allocReq is one captured upstream request. Method, path, query and the
// decoded body are all recorded because "the right thing was sent upstream" is
// otherwise unprovable — asserting the returned map only proves local
// bookkeeping. Requests are kept in arrival order: the release DELETEs must be
// shown to target the exact addresses the allocation POST handed back, and that
// is an ordering claim.
type allocReq struct {
	method string
	path   string
	query  url.Values
	body   M // decoded JSON request body; nil when no body was sent
}

// allocConfig configures the fake's two personalities independently. The whole
// point of this fixture is a run where the allocation POST SUCCEEDS and the DNS
// record POST FAILS — that is the only way the compensating release executes.
type allocConfig struct {
	allocStatus int    // status for POST .../nextavailableip (0 => 200)
	allocBody   string // its JSON body
	dnsStatus   int    // status for POST /api/ddi/v1/dns/record (0 => 201)
	dnsBody     string // its JSON body
	// deleteStatuses answers the release DELETEs in call order. A call past
	// the end of the slice gets 204. Per-call control is what lets one release
	// succeed and the next fail, splitting released from orphaned.
	deleteStatuses []int
}

type allocFake struct {
	t   *testing.T
	srv *httptest.Server

	mu          sync.Mutex
	reqs        []allocReq
	deleteCalls int
}

// allocTwoAddresses is a two-reservation nextavailableip response. Ids are bare
// here so the release loop's own logic is what is under test; the full-form id
// that CSP really returns is covered separately in
// TestAllocateReleaseUsesObjectPathSoFullFormIDsAreNotDoubled.
const allocTwoAddresses = `{"results":[{"id":"a-1111","address":"10.7.0.4"},{"id":"a-2222","address":"10.7.0.5"}]}`

// newAllocFake starts the fake and registers its shutdown. The handler branches
// on r.Method FIRST and only then on path: allocate's three upstream calls
// (POST nextavailableip, POST dns/record, DELETE ipam/address/<id>) overlap on
// path substrings, and a path-keyed handler would feed the wrong fixture to the
// wrong call while still looking green.
func newAllocFake(t *testing.T, cfg allocConfig) *allocFake {
	t.Helper()
	f := &allocFake{t: t}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body M
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			if err := json.Unmarshal(raw, &body); err != nil {
				// An undecodable body is recorded as a distinct failure rather
				// than as "no body" — those are not the same thing.
				t.Errorf("fake received an undecodable body on %s %s: %v", r.Method, r.URL.Path, err)
			}
		}
		f.mu.Lock()
		f.reqs = append(f.reqs, allocReq{method: r.Method, path: r.URL.Path, query: r.URL.Query(), body: body})
		nDelete := f.deleteCalls
		if r.Method == http.MethodDelete {
			f.deleteCalls++
		}
		f.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")

		switch r.Method {
		case http.MethodPost:
			switch {
			case strings.HasSuffix(r.URL.Path, "/nextavailableip"):
				w.WriteHeader(allocStatusOr(cfg.allocStatus, 200))
				_, _ = io.WriteString(w, allocStringOr(cfg.allocBody, allocTwoAddresses))
			case strings.HasSuffix(r.URL.Path, "/dns/record"):
				w.WriteHeader(allocStatusOr(cfg.dnsStatus, 201))
				_, _ = io.WriteString(w, allocStringOr(cfg.dnsBody, `{"result":{"id":"dns/record/r-1"}}`))
			default:
				t.Errorf("fake received an unexpected POST path: %s", r.URL.Path)
				w.WriteHeader(500)
			}
		case http.MethodDelete:
			st := 204
			if nDelete < len(cfg.deleteStatuses) {
				st = cfg.deleteStatuses[nDelete]
			}
			w.WriteHeader(st)
			if st >= 400 {
				_, _ = io.WriteString(w, `{"error":"release refused"}`)
			}
		default:
			t.Errorf("fake received an unexpected method: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func allocStatusOr(v, def int) int {
	if v == 0 {
		return def
	}
	return v
}

func allocStringOr(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func (f *allocFake) client() *Client { return newTestClient(f.srv) }

// all returns every captured request in arrival order.
func (f *allocFake) all() []allocReq {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]allocReq{}, f.reqs...)
}

// byMethod returns the captured requests for one method, in arrival order.
func (f *allocFake) byMethod(method string) []allocReq {
	out := []allocReq{}
	for _, r := range f.all() {
		if r.method == method {
			out = append(out, r)
		}
	}
	return out
}

// allocIDs renders a released/orphaned list as strings for comparison. It
// reports a non-list as a distinct failure instead of silently yielding an
// empty slice — "the key held the wrong type" and "the list was empty" are
// different outcomes and must not render the same.
func allocIDs(t *testing.T, label string, v any) []string {
	t.Helper()
	if v == nil {
		t.Fatalf("%s is absent (nil), which is not the same as an empty list", label)
	}
	list, ok := v.([]any)
	if !ok {
		t.Fatalf("%s = %#v, want a list", label, v)
	}
	out := make([]string, 0, len(list))
	for _, e := range list {
		out = append(out, pyStr(e))
	}
	return out
}

// --- the live allocation request itself ---------------------------------------

// TestAllocateSendsCountAndNameOnTheWire proves the reservation request itself
// is correct. count is a query parameter, not a body field; getting it wrong
// reserves the wrong number of real addresses.
func TestAllocateSendsCountAndNameOnTheWire(t *testing.T) {
	f := newAllocFake(t, allocConfig{})

	res, status := f.client().SelfserviceAllocate(M{
		"subnet_id": "s-42",
		"count":     float64(2),
		"name":      "web-vip",
		"dry":       false,
	})

	if status != 200 || !resultOK(res) {
		t.Fatalf("status/ok = %d/%v, want 200/true; res=%v", status, res["ok"], res)
	}
	posts := f.byMethod(http.MethodPost)
	if len(posts) != 1 {
		t.Fatalf("POSTs = %d, want exactly 1 (no dns payload was supplied)", len(posts))
	}
	if want := "/api/ddi/v1/ipam/subnet/s-42/nextavailableip"; posts[0].path != want {
		t.Fatalf("path = %q, want %q", posts[0].path, want)
	}
	if got := posts[0].query.Get("count"); got != "2" {
		t.Fatalf("count query = %q, want \"2\" — a wrong count reserves the wrong number of real IPs", got)
	}
	if got := pyStr(posts[0].body["name"]); got != "web-vip" {
		t.Fatalf("body name = %q, want \"web-vip\"; body=%v", got, posts[0].body)
	}
}

// TestAllocateOmitsTheBodyWhenNoNameGiven pins that no name means no request
// body at all (edit.go:547-550 leaves bodyExtra nil), rather than a body
// carrying an empty name — an invented value the caller never supplied.
func TestAllocateOmitsTheBodyWhenNoNameGiven(t *testing.T) {
	f := newAllocFake(t, allocConfig{})

	_, status := f.client().SelfserviceAllocate(M{"subnet_id": "s-42", "count": float64(2), "dry": false})

	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	posts := f.byMethod(http.MethodPost)
	if len(posts) != 1 {
		t.Fatalf("POSTs = %d, want 1", len(posts))
	}
	if posts[0].body != nil {
		t.Fatalf("body = %v, want none sent when name is omitted", posts[0].body)
	}
}

// TestAllocateSummarizesEveryReservedAddress covers addressSummaries: the
// caller is told the id and address of each reservation. A shape bug here turns
// a successful allocation into "no addresses" and the operator re-runs it,
// double-reserving.
func TestAllocateSummarizesEveryReservedAddress(t *testing.T) {
	f := newAllocFake(t, allocConfig{})

	res, status := f.client().SelfserviceAllocate(M{"subnet_id": "s-42", "count": float64(2), "dry": false})

	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	got, ok := res["addresses"].([]any)
	if !ok {
		t.Fatalf("addresses = %#v, want a list", res["addresses"])
	}
	if len(got) != 2 {
		t.Fatalf("addresses = %v, want 2 summaries", got)
	}
	for i, want := range []M{
		{"id": "a-1111", "address": "10.7.0.4"},
		{"id": "a-2222", "address": "10.7.0.5"},
	} {
		am := asMap(got[i])
		if am["id"] != want["id"] || am["address"] != want["address"] {
			t.Fatalf("addresses[%d] = %v, want %v", i, am, want)
		}
	}
}

// TestAllocateUpstreamFailureIsNotSuccess: a refused reservation must not read
// as a completed one, and must not go on to create a DNS record pointing at an
// address that was never reserved.
func TestAllocateUpstreamFailureIsNotSuccess(t *testing.T) {
	f := newAllocFake(t, allocConfig{allocStatus: 500, allocBody: `{"error":"no free addresses"}`})

	res, status := f.client().SelfserviceAllocate(M{
		"subnet_id": "s-42", "count": float64(2), "dry": false,
		"dns": M{"zone_id": "z-1", "name": "web"},
	})

	if status != 500 {
		t.Fatalf("status = %d, want the upstream 500 passed through; res=%v", status, res)
	}
	if resultOK(res) {
		t.Fatalf("ok = true on a failed allocation: %v", res)
	}
	if n := len(f.byMethod(http.MethodPost)); n != 1 {
		t.Fatalf("POSTs = %d, want 1 — no DNS record may be created for an allocation that failed", n)
	}
	if n := len(f.byMethod(http.MethodDelete)); n != 0 {
		t.Fatalf("DELETEs = %d, want 0 — nothing was reserved, so nothing may be released", n)
	}
}

// --- the DNS success path -----------------------------------------------------

// TestAllocateExtractsRecordIDFromBothResponseShapes covers edit.go:578-590.
// CSP answers a record create as either {"result":{...}} or {"results":[{...}]};
// only the first is obvious from the code, and a miss yields a nil record id
// that the operator cannot use to find (or delete) the record later.
func TestAllocateExtractsRecordIDFromBothResponseShapes(t *testing.T) {
	for _, tc := range []struct {
		name, body, wantID string
	}{
		{"result shape", `{"result":{"id":"dns/record/r-9"}}`, "dns/record/r-9"},
		{"results shape", `{"results":[{"id":"dns/record/r-8"}]}`, "dns/record/r-8"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newAllocFake(t, allocConfig{dnsStatus: 201, dnsBody: tc.body})

			res, status := f.client().SelfserviceAllocate(M{
				"subnet_id": "s-42", "count": float64(2), "dry": false,
				"dns": M{"zone_id": "z-1", "name": "web"},
			})

			if status != 200 || !resultOK(res) {
				t.Fatalf("status/ok = %d/%v, want 200/true; res=%v", status, res["ok"], res)
			}
			rec := asMap(res["record"])
			if rec["ok"] != true {
				t.Fatalf("record.ok = %v, want true; record=%v", rec["ok"], rec)
			}
			if got := pyStr(rec["id"]); got != tc.wantID {
				t.Fatalf("record.id = %q, want %q", got, tc.wantID)
			}
			if n := len(f.byMethod(http.MethodDelete)); n != 0 {
				t.Fatalf("DELETEs = %d, want 0 — the DNS step succeeded, nothing may be released", n)
			}
		})
	}
}

// TestAllocateDNSRecordDefaultsToTheFirstReservedAddress pins edit.go:566-568:
// with no explicit dns.value the record points at the address just reserved.
// The captured body is asserted, not the returned map.
func TestAllocateDNSRecordDefaultsToTheFirstReservedAddress(t *testing.T) {
	f := newAllocFake(t, allocConfig{})

	_, status := f.client().SelfserviceAllocate(M{
		"subnet_id": "s-42", "count": float64(2), "dry": false,
		"dns": M{"zone_id": "z-1", "name": "web"},
	})

	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	posts := f.byMethod(http.MethodPost)
	if len(posts) != 2 {
		t.Fatalf("POSTs = %d, want 2 (reserve then record)", len(posts))
	}
	rec := posts[1].body
	if rec["zone"] != "z-1" || rec["name_in_zone"] != "web" || rec["type"] != "A" {
		t.Fatalf("record body = %v, want zone z-1 / name_in_zone web / type A", rec)
	}
	if got := pyStr(asMap(rec["rdata"])["address"]); got != "10.7.0.4" {
		t.Fatalf("rdata.address = %q, want the first reserved address 10.7.0.4", got)
	}
}

// --- the compensating release: the path that DELETEs real reservations --------

// TestAllocateDNSFailureReleasesBothReservedAddresses is the central test of
// this file. The DNS record POST fails after two real IPs have been reserved,
// so edit.go:592-615 must DELETE exactly those two addresses — the ones the
// tenant just handed back — and no others.
//
// count:2 is deliberate: with a single reservation "released both" and
// "released the last one only" are indistinguishable, so a leak that exhausts
// the subnet would pass unnoticed.
func TestAllocateDNSFailureReleasesBothReservedAddresses(t *testing.T) {
	f := newAllocFake(t, allocConfig{dnsStatus: 500, dnsBody: `{"error":"zone is frozen"}`})

	res, status := f.client().SelfserviceAllocate(M{
		"subnet_id": "s-42", "count": float64(2), "dry": false,
		"dns": M{"zone_id": "z-1", "name": "web"},
	})

	if status != 502 {
		t.Fatalf("status = %d, want 502; res=%v", status, res)
	}
	if resultOK(res) {
		t.Fatalf("ok = true — a half-done allocation (IPs reserved, no DNS record) must never report success: %v", res)
	}

	// The wire, not the bookkeeping: both reservations must actually have been
	// deleted upstream, targeted by the ids the allocation POST returned, in
	// the order they were returned.
	dels := f.byMethod(http.MethodDelete)
	if len(dels) != 2 {
		t.Fatalf("DELETEs = %d, want 2 — every reservation made must be released, or it leaks until the subnet is exhausted", len(dels))
	}
	wantPaths := []string{"/api/ddi/v1/ipam/address/a-1111", "/api/ddi/v1/ipam/address/a-2222"}
	for i, want := range wantPaths {
		if dels[i].path != want {
			t.Fatalf("DELETE[%d] path = %q, want %q — releasing the wrong address object destroys an allocation nobody asked to release", i, dels[i].path, want)
		}
	}

	// And the report back to the operator must name the same two ids.
	if got := allocIDs(t, "released", res["released"]); !allocEqual(got, []string{"a-1111", "a-2222"}) {
		t.Fatalf("released = %v, want both reserved ids", got)
	}
	if v, present := res["orphaned"]; present {
		t.Fatalf("orphaned = %v, want the key absent when every release succeeded", v)
	}
	if res["error"] != "dns record creation failed; reserved address(es) released" {
		t.Fatalf("error = %v, want the inherited release message", res["error"])
	}
	rec := asMap(res["record"])
	if rec["ok"] != false || rec["status"] != 500 {
		t.Fatalf("record = %v, want ok:false and the real upstream status 500", rec)
	}
}

// TestAllocateFailedReleaseIsOrphanedNotReleased: an address whose DELETE was
// refused is still reserved in the tenant. Reporting it as "released" would
// tell the operator the cleanup is done when a real IP is in fact stranded, so
// the two outcomes must be reported separately and never merged.
func TestAllocateFailedReleaseIsOrphanedNotReleased(t *testing.T) {
	f := newAllocFake(t, allocConfig{
		dnsStatus: 500,
		// first release succeeds, second is refused
		deleteStatuses: []int{204, 500},
	})

	res, status := f.client().SelfserviceAllocate(M{
		"subnet_id": "s-42", "count": float64(2), "dry": false,
		"dns": M{"zone_id": "z-1", "name": "web"},
	})

	if status != 502 || resultOK(res) {
		t.Fatalf("status/ok = %d/%v, want 502/false; res=%v", status, res["ok"], res)
	}
	if n := len(f.byMethod(http.MethodDelete)); n != 2 {
		t.Fatalf("DELETEs = %d, want 2 — a refused release must not abort the remaining ones", n)
	}
	if got := allocIDs(t, "released", res["released"]); !allocEqual(got, []string{"a-1111"}) {
		t.Fatalf("released = %v, want only the address whose DELETE succeeded", got)
	}
	if got := allocIDs(t, "orphaned", res["orphaned"]); !allocEqual(got, []string{"a-2222"}) {
		t.Fatalf("orphaned = %v, want the address still reserved in the tenant", got)
	}
}

// TestAllocateReleaseTreats404AsAlreadyReleased pins edit.go:602's 404 arm:
// for a DELETE, "already gone" is the requested end state, so it counts as
// released rather than orphaned. This is idempotency, not a failure being
// hidden — the address genuinely is not reserved any more.
func TestAllocateReleaseTreats404AsAlreadyReleased(t *testing.T) {
	f := newAllocFake(t, allocConfig{dnsStatus: 500, deleteStatuses: []int{404, 200}})

	res, _ := f.client().SelfserviceAllocate(M{
		"subnet_id": "s-42", "count": float64(2), "dry": false,
		"dns": M{"zone_id": "z-1", "name": "web"},
	})

	if got := allocIDs(t, "released", res["released"]); !allocEqual(got, []string{"a-1111", "a-2222"}) {
		t.Fatalf("released = %v, want both (404 = already gone, 200 = deleted now)", got)
	}
	if v, present := res["orphaned"]; present {
		t.Fatalf("orphaned = %v, want absent", v)
	}
}

// TestAllocateReleaseSkipsAddressesWithNoID covers edit.go:598-600. An address
// object with no usable id cannot be targeted, so no DELETE is attempted for
// it. It is reported in neither list — the code cannot claim it was released
// and has no id with which to report it orphaned. That silence is itself a
// finding (see the file-level note in the report), not something asserted to be
// correct here; this test only pins that no DELETE is fired at a made-up path.
func TestAllocateReleaseSkipsAddressesWithNoID(t *testing.T) {
	f := newAllocFake(t, allocConfig{
		allocBody: `{"results":[{"id":"a-1111","address":"10.7.0.4"},{"address":"10.7.0.5"}]}`,
		dnsStatus: 500,
	})

	res, status := f.client().SelfserviceAllocate(M{
		"subnet_id": "s-42", "count": float64(2), "dry": false,
		"dns": M{"zone_id": "z-1", "name": "web"},
	})

	if status != 502 {
		t.Fatalf("status = %d, want 502", status)
	}
	dels := f.byMethod(http.MethodDelete)
	if len(dels) != 1 {
		t.Fatalf("DELETEs = %d, want 1 — an id-less address must not produce a DELETE at a guessed path", len(dels))
	}
	if dels[0].path != "/api/ddi/v1/ipam/address/a-1111" {
		t.Fatalf("DELETE path = %q, want the one address that had an id", dels[0].path)
	}
	if got := allocIDs(t, "released", res["released"]); !allocEqual(got, []string{"a-1111"}) {
		t.Fatalf("released = %v, want only the id-bearing address", got)
	}
}

// TestAllocateReleaseUsesObjectPathSoFullFormIDsAreNotDoubled is the case that
// matters in production: CSP returns full-form ids ("ipam/address/<uuid>"), the
// shape used throughout this repo. The release must build its path with
// ObjectPath, exactly like the operator-facing delete route (see
// internal/server/edit.go's ipamAddressDelete), NOT by concatenating the id onto
// the type path — that yields /api/ddi/v1/ipam/address/ipam/address/<uuid>,
// which CSP answers 501 (see ObjectPath's doc). While that was the behaviour,
// every rollback against a real tenant failed and the addresses stayed reserved.
//
// This was previously pinned as observed behaviour and is now asserted correct.
func TestAllocateReleaseUsesObjectPathSoFullFormIDsAreNotDoubled(t *testing.T) {
	f := newAllocFake(t, allocConfig{
		allocBody: `{"results":[{"id":"ipam/address/a-1111","address":"10.7.0.4"},{"id":"ipam/address/a-2222","address":"10.7.0.5"}]}`,
		dnsStatus: 500,
	})

	res, status := f.client().SelfserviceAllocate(M{
		"subnet_id": "s-42", "count": float64(2), "dry": false,
		"dns": M{"zone_id": "z-1", "name": "web"},
	})

	if status != 502 {
		t.Fatalf("status = %d, want 502", status)
	}
	dels := f.byMethod(http.MethodDelete)
	if len(dels) != 2 {
		t.Fatalf("DELETEs = %d, want 2", len(dels))
	}
	for i, want := range []string{
		"/api/ddi/v1/ipam/address/a-1111",
		"/api/ddi/v1/ipam/address/a-2222",
	} {
		if dels[i].path != want {
			t.Fatalf("DELETE[%d] path = %q, want %q — a doubled \"ipam/address/\" segment "+
				"is answered 501 by CSP, so the reservation is never released and leaks "+
				"until the subnet is exhausted", i, dels[i].path, want)
		}
	}

	// The report must name the ids as the tenant gave them, full-form.
	if got := allocIDs(t, "released", res["released"]); !allocEqual(got, []string{"ipam/address/a-1111", "ipam/address/a-2222"}) {
		t.Fatalf("released = %v, want both full-form ids", got)
	}
	if v, present := res["orphaned"]; present {
		t.Fatalf("orphaned = %v, want the key absent when every release succeeded", v)
	}
}

// TestAllocateReleaseOrphansAnIDItCannotTarget: an id ObjectPath rejects (a
// different kind, traversal, extra segments) yields no DELETE at all, so the
// address is still reserved in the tenant. It must be reported orphaned —
// calling it released would tell the operator the cleanup is done while a real
// IP is stranded.
func TestAllocateReleaseOrphansAnIDItCannotTarget(t *testing.T) {
	f := newAllocFake(t, allocConfig{
		allocBody: `{"results":[{"id":"ipam/address/a-1111","address":"10.7.0.4"},{"id":"ipam/subnet/../../secret","address":"10.7.0.5"}]}`,
		dnsStatus: 500,
	})

	res, status := f.client().SelfserviceAllocate(M{
		"subnet_id": "s-42", "count": float64(2), "dry": false,
		"dns": M{"zone_id": "z-1", "name": "web"},
	})

	if status != 502 {
		t.Fatalf("status = %d, want 502", status)
	}
	dels := f.byMethod(http.MethodDelete)
	if len(dels) != 1 {
		t.Fatalf("DELETEs = %d, want 1 — an unroutable id must not produce a DELETE at a guessed path", len(dels))
	}
	if dels[0].path != "/api/ddi/v1/ipam/address/a-1111" {
		t.Fatalf("DELETE path = %q, want the one address that could be targeted", dels[0].path)
	}
	if got := allocIDs(t, "released", res["released"]); !allocEqual(got, []string{"ipam/address/a-1111"}) {
		t.Fatalf("released = %v, want only the address actually deleted", got)
	}
	if got := allocIDs(t, "orphaned", res["orphaned"]); !allocEqual(got, []string{"ipam/subnet/../../secret"}) {
		t.Fatalf("orphaned = %v, want the address still reserved in the tenant", got)
	}
}

// TestAllocateInvalidDNSPayloadReservesNothing covers edit.go:535-545: the DNS
// payload is validated BEFORE any address is reserved, so a typo cannot strand
// a real IP with no record and no release.
func TestAllocateInvalidDNSPayloadReservesNothing(t *testing.T) {
	f := newAllocFake(t, allocConfig{})

	res, status := f.client().SelfserviceAllocate(M{
		"subnet_id": "s-42", "count": float64(2), "dry": false,
		"dns": M{"zone_id": "z-1", "name": "mail", "type": "MX", "value": "not-a-preference mail.example.com."},
	})

	if status != 400 {
		t.Fatalf("status = %d, want 400; res=%v", status, res)
	}
	if resultOK(res) {
		t.Fatalf("ok = true on an invalid dns payload: %v", res)
	}
	if !strings.HasPrefix(pyStr(res["error"]), "invalid dns payload: ") {
		t.Fatalf("error = %v, want the invalid-dns-payload prefix", res["error"])
	}
	if n := len(f.all()); n != 0 {
		t.Fatalf("upstream requests = %d, want 0 — validation must run before any IP is reserved", n)
	}
}

// --- the dry path -------------------------------------------------------------

// TestAllocateDryIsTheDefaultAndTouchesNothing pins the dry default for this
// path: truthyDry (edit.go:487) means an omitted dry flag PREVIEWS. Note the
// contrast with the two DNS-record builders, which default to live via boolPy —
// copying either default onto the other path is the trap this test guards.
func TestAllocateDryIsTheDefaultAndTouchesNothing(t *testing.T) {
	f := newAllocFake(t, allocConfig{})

	res, status := f.client().SelfserviceAllocate(M{"subnet_id": "s-42", "count": float64(2)})

	if status != 200 || !resultOK(res) {
		t.Fatalf("status/ok = %d/%v, want 200/true; res=%v", status, res["ok"], res)
	}
	if res["dry_run"] != true {
		t.Fatalf("dry_run = %v, want true — an omitted dry flag must not reserve real IPs", res["dry_run"])
	}
	if n := len(f.all()); n != 0 {
		t.Fatalf("upstream requests = %d, want 0 on a preview", n)
	}
	if res["would_allocate"] != 2 {
		t.Fatalf("would_allocate = %v, want 2", res["would_allocate"])
	}
	// A preview reserved nothing, so the list is present and empty. It must not
	// be absent or null: "no addresses yet, by design" and "the addresses could
	// not be determined" must not render the same.
	addrs, ok := res["addresses"].([]any)
	if !ok {
		t.Fatalf("addresses = %#v, want a present, empty list on a preview", res["addresses"])
	}
	if len(addrs) != 0 {
		t.Fatalf("addresses = %v, want empty — a preview reserves nothing", addrs)
	}
}

// TestAllocateDryEchoesTheDNSPayloadWithoutValidatingIt characterizes a gap,
// it does NOT bless it: the dry path (edit.go:520-533) returns before the DNS
// validation the live path runs at 537-545. The same payload previews clean and
// then 400s on the real run, moving the surprise to the live write — the exact
// thing DNSRecordUpdate's conflict check deliberately avoids by running on the
// dry path too (edit.go:385-388). Reported as a finding; the assertion below
// records what happens today.
func TestAllocateDryEchoesTheDNSPayloadWithoutValidatingIt(t *testing.T) {
	f := newAllocFake(t, allocConfig{})
	badDNS := M{"zone_id": "z-1", "name": "mail", "type": "MX", "value": "not-a-preference mail.example.com."}

	dryRes, dryStatus := f.client().SelfserviceAllocate(M{"subnet_id": "s-42", "count": float64(2), "dns": badDNS})

	if dryStatus != 200 {
		t.Fatalf("dry status = %d, want the inherited 200; res=%v", dryStatus, dryRes)
	}
	rec := asMap(dryRes["record"])
	if rec == nil || rec["dry_run"] != true || rec["value"] != badDNS["value"] {
		t.Fatalf("dry record = %v, want the payload echoed back unvalidated", rec)
	}

	// Same payload, live: rejected. The preview said nothing was wrong.
	_, liveStatus := f.client().SelfserviceAllocate(M{"subnet_id": "s-42", "count": float64(2), "dry": false, "dns": badDNS})
	if liveStatus != 400 {
		t.Fatalf("live status = %d, want 400 — this test exists because it differs from the dry 200", liveStatus)
	}
	if n := len(f.all()); n != 0 {
		t.Fatalf("upstream requests = %d, want 0 in both runs", n)
	}
}

// --- response plumbing: pyStrOr / respAddresses / addressSummaries ------------

// TestPyStrOrFallsBackOnEveryFalsyValue: pyStrOr picks the rdata type for the
// allocate DNS record. A wrong fallback creates the wrong record type.
func TestPyStrOrFallsBackOnEveryFalsyValue(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   M
		want string
	}{
		{"present", M{"type": "AAAA"}, "AAAA"},
		{"absent", M{}, "A"},
		{"explicit null", M{"type": nil}, "A"},
		{"empty string", M{"type": ""}, "A"},
		{"zero", M{"type": float64(0)}, "A"},
		{"false", M{"type": false}, "A"},
		{"non-string truthy is stringified", M{"type": float64(28)}, "28"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := pyStrOr(tc.in, "type", "A"); got != tc.want {
				t.Fatalf("pyStrOr(%v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestRespAddressesPrefersResultsThenResult covers all three shapes plus the
// non-object case. A miss here silently turns a successful allocation into "no
// addresses" — the operator sees nothing was allocated while real IPs are in
// fact reserved, and the compensating release never runs because the loop has
// nothing to iterate.
func TestRespAddressesPrefersResultsThenResult(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   any
		want []string // rendered "id" of each returned address
	}{
		{"results wins", M{"results": []any{M{"id": "a1"}, M{"id": "a2"}}, "result": M{"id": "ignored"}}, []string{"a1", "a2"}},
		{"empty results falls through to result", M{"results": []any{}, "result": M{"id": "only"}}, []string{"only"}},
		{"result alone is wrapped", M{"result": M{"id": "solo"}}, []string{"solo"}},
		{"neither yields nothing", M{"meta": M{"x": 1}}, nil},
		{"falsy result yields nothing", M{"result": nil}, nil},
		{"non-object yields nothing", []any{M{"id": "a1"}}, nil},
		{"nil yields nothing", nil, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := respAddresses(tc.in)
			ids := make([]string, 0, len(got))
			for _, a := range got {
				ids = append(ids, pyStr(asMap(a)["id"]))
			}
			if len(tc.want) == 0 {
				if len(got) != 0 {
					t.Fatalf("respAddresses(%v) = %v, want none", tc.in, ids)
				}
				return
			}
			if !allocEqual(ids, tc.want) {
				t.Fatalf("respAddresses(%v) ids = %v, want %v", tc.in, ids, tc.want)
			}
		})
	}
}

// TestAddressSummariesProjectsIDAndAddressOnly: the summary keeps exactly the
// two fields the caller needs and drops the rest, and an empty input yields a
// present, empty list rather than nil — so a JSON response carries [] and not
// null.
func TestAddressSummariesProjectsIDAndAddressOnly(t *testing.T) {
	got := addressSummaries([]any{
		M{"id": "a1", "address": "10.0.0.1", "tags": M{"Owner": "team"}, "state": "used"},
		M{"id": "a2", "address": "10.0.0.2"},
	})
	if len(got) != 2 {
		t.Fatalf("summaries = %v, want 2", got)
	}
	for i, want := range []M{{"id": "a1", "address": "10.0.0.1"}, {"id": "a2", "address": "10.0.0.2"}} {
		am := asMap(got[i])
		if len(am) != 2 {
			t.Fatalf("summaries[%d] = %v, want exactly id+address", i, am)
		}
		if am["id"] != want["id"] || am["address"] != want["address"] {
			t.Fatalf("summaries[%d] = %v, want %v", i, am, want)
		}
	}

	empty := addressSummaries(nil)
	if empty == nil {
		t.Fatalf("addressSummaries(nil) = nil, want a present empty list so the response carries [] not null")
	}
	if len(empty) != 0 {
		t.Fatalf("addressSummaries(nil) = %v, want empty", empty)
	}

	// A non-object entry cannot be projected: asMap yields nil, so both fields
	// come back nil rather than an invented placeholder value.
	odd := addressSummaries([]any{"10.0.0.9"})
	am := asMap(odd[0])
	if am["id"] != nil || am["address"] != nil {
		t.Fatalf("summary of a non-object = %v, want nil fields, never a guessed value", am)
	}
}

// allocEqual compares two string slices element-wise, order significant.
func allocEqual(a, b []string) bool {
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
