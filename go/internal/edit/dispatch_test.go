package edit

// Lane A4 — the dispatch layer: Resources() (the table the HTTP routes look
// every /api/edit/<resource> call up in), Delete (the single live DELETE behind
// all five resource routes plus /api/dns/records/{id} and
// /api/ipam/addresses/{id}), and With (request-scoped tenant pinning).
//
// Why these three, and what a bug in each costs:
//   - Delete is the only write in this package that destroys data. Its whole
//     behaviour is a status switch, and that switch was never executed by a test.
//   - Resources is data, not logic, so it looks unbreakable — but server/edit.go
//     feeds res.Kind straight into edit.ObjectPath to decide whether a DELETE's
//     id is allowed (server/edit.go:214), and feeds res.ResultKey into the audit
//     entry (server/edit.go:161). A wrong Kind validates an id against the wrong
//     object type; a wrong ResultKey writes an audit row with no id in it.
//   - With is one line, and if that line ever returned the receiver, every write
//     in a request would go out on the PROCESS-WIDE client instead of the one
//     pinned to the tenant the request started against — i.e. writes landing in
//     the WRONG TENANT after an account switch. That is the exact failure
//     rest.Client.Pin exists to prevent.
//
// Fake upstream only (net/http/httptest); no test here ever contacts a real
// tenant. Every handler branches on r.Method first, then on the path.
//
// All helpers in this file are prefixed `dispatch` so the four parallel lanes in
// package edit cannot collide.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"

	"bloxsmith/internal/rest"
)

// --- fake upstream -----------------------------------------------------------

// dispatchReq is one recorded inbound request on the fake tenant.
type dispatchReq struct {
	Method string
	Path   string
	Query  string
	Auth   string
	Body   string
}

type dispatchFake struct {
	srv *httptest.Server
	mu  sync.Mutex
	got []dispatchReq
}

// dispatchServer records every request and answers from route, which is given
// the already-recorded request and returns (status, json body). An empty body
// string writes no body at all — that is how a real 204 arrives.
func dispatchServer(t *testing.T, route func(dispatchReq) (int, string)) *dispatchFake {
	t.Helper()
	f := &dispatchFake{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		req := dispatchReq{
			Method: r.Method,
			Path:   r.URL.Path,
			Query:  r.URL.RawQuery,
			Auth:   r.Header.Get("Authorization"),
			Body:   string(raw),
		}
		f.mu.Lock()
		f.got = append(f.got, req)
		f.mu.Unlock()

		status, body := route(req)
		if body == "" {
			w.WriteHeader(status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// dispatchStatic answers every request with one status/body pair.
func dispatchStatic(t *testing.T, status int, body string) *dispatchFake {
	t.Helper()
	return dispatchServer(t, func(dispatchReq) (int, string) { return status, body })
}

func (f *dispatchFake) client() *Client { return newTestClient(f.srv) }

func (f *dispatchFake) calls() []dispatchReq {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]dispatchReq(nil), f.got...)
}

func (f *dispatchFake) count() int { return len(f.calls()) }

// dispatchOnlyCall asserts exactly one request reached the fake and returns it.
func dispatchOnlyCall(t *testing.T, f *dispatchFake) dispatchReq {
	t.Helper()
	got := f.calls()
	if len(got) != 1 {
		t.Fatalf("want exactly 1 upstream request, got %d: %+v", len(got), got)
	}
	return got[0]
}

// dispatchBool reads a bool out of a builder result without panicking on a
// missing/other-typed key — a missing "ok" must read as false, never as true.
func dispatchBool(res M, key string) bool { b, _ := res[key].(bool); return b }

// dispatchDeadClient returns a client pointed at a server that has already been
// closed, so rest.Client.Write fails at the transport and reports status 0.
// Nothing leaves the loopback interface.
func dispatchDeadClient(t *testing.T) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("closed fake received a request: %s %s", r.Method, r.URL.Path)
	}))
	srv.Close()
	return newTestClient(srv)
}

// --- Delete ------------------------------------------------------------------

func TestDelete_SendsOneBodylessDeleteToExactlyTheGivenPath(t *testing.T) {
	// Delete takes an ALREADY-VALIDATED full path: every caller runs the id
	// through edit.ObjectPath first (server/edit.go:133, 214). This pins that
	// Delete adds nothing to that path — no query, no body, no second call —
	// because the path it is handed is the only thing standing between a
	// caller-supplied id and a live destructive request.
	f := dispatchStatic(t, 200, `{"result":{"id":"ipam/host/h-1"}}`)

	res, status := f.client().Delete("/api/ddi/v1/ipam/host/h-1")

	if !dispatchBool(res, "ok") || status != 200 {
		t.Fatalf("want ok/200, got ok=%v status=%d res=%+v", res["ok"], status, res)
	}
	call := dispatchOnlyCall(t, f)
	if call.Method != http.MethodDelete {
		t.Errorf("method: want DELETE, got %s", call.Method)
	}
	if call.Path != "/api/ddi/v1/ipam/host/h-1" {
		t.Errorf("path: want /api/ddi/v1/ipam/host/h-1, got %q", call.Path)
	}
	if call.Query != "" {
		t.Errorf("want no query string on a delete, got %q", call.Query)
	}
	if call.Body != "" {
		t.Errorf("want no request body on a delete, got %q", call.Body)
	}
}

func TestDelete_SuccessStatusesReportOk(t *testing.T) {
	// 200 with a body and 204 with no body at all are both "the object is gone".
	// The 204 case matters on its own: rest.Client.Write returns a nil parsed
	// body for an empty response (rest.go:371-373), so a status check written as
	// "resp != nil" would call a perfectly good delete a failure.
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"200 with body", 200, `{"result":{"id":"ipam/host/h-1"}}`},
		{"204 no body", 204, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := dispatchStatic(t, tc.status, tc.body)

			res, status := f.client().Delete("/api/ddi/v1/ipam/host/h-1")

			if !dispatchBool(res, "ok") {
				t.Errorf("upstream %d: want ok:true, got %+v", tc.status, res)
			}
			if status != 200 {
				t.Errorf("upstream %d: want returned status 200, got %d", tc.status, status)
			}
			if _, hasErr := res["error"]; hasErr {
				t.Errorf("upstream %d: a successful delete must carry no error, got %+v", tc.status, res)
			}
			if f.count() != 1 {
				t.Errorf("want exactly 1 upstream call, got %d", f.count())
			}
		})
	}
}

func TestDelete_404IsDeliberateIdempotencyNotAConflation(t *testing.T) {
	// PINS FINDING A-F1, and pins it as DELIBERATE. For a DELETE, "404 — no such
	// object" means the requested end state (object absent) already holds, so
	// reporting ok:true is idempotency, not a lie: re-running a teardown must not
	// fail on the objects the first run already removed. This is NOT the
	// read-failed-vs-read-found-nothing conflation this codebase refuses
	// elsewhere — a read that finds nothing has to stay distinguishable from a
	// read that broke, but a delete of something already gone genuinely
	// succeeded.
	//
	// The cost is real and is stated rather than hidden: server/edit.go:226-229
	// writes an audit row for any ok result, so a 404 delete is audited as a
	// deletion this system performed. If this line is ever changed, that audit
	// semantics changes with it.
	f := dispatchStatic(t, 404, `{"error":{"message":"not found"}}`)

	res, status := f.client().Delete("/api/ddi/v1/ipam/host/already-gone")

	if !dispatchBool(res, "ok") {
		t.Errorf("404 delete must be idempotent-ok, got %+v", res)
	}
	if status != 200 {
		t.Errorf("404 delete: want returned status 200, got %d", status)
	}
	if len(res) != 1 {
		t.Errorf("an idempotent delete returns exactly {ok:true}, got %+v", res)
	}
}

func TestDelete_RealFailuresAreNotReportedAsSuccess(t *testing.T) {
	// The whole point of the test file: a genuine upstream failure must never
	// come back as ok. 409 is in the list because "this object is still
	// referenced" is the most likely real-world refusal and is the one most
	// tempting to fold into the idempotent branch above.
	for _, upstream := range []int{400, 403, 409, 500, 502, 503} {
		t.Run(http.StatusText(upstream), func(t *testing.T) {
			f := dispatchStatic(t, upstream, `{"error":{"message":"nope"}}`)

			res, status := f.client().Delete("/api/ddi/v1/ipam/host/h-1")

			if dispatchBool(res, "ok") {
				t.Fatalf("upstream %d reported as a successful delete: %+v", upstream, res)
			}
			// statusOr passes a real HTTP status through untouched; only the
			// no-response case falls back to 502.
			if status != upstream {
				t.Errorf("upstream %d: want returned status %d, got %d", upstream, upstream, status)
			}
			wantMsg := "delete failed"
			if msg, _ := res["error"].(string); !strings.Contains(msg, wantMsg) {
				t.Errorf("upstream %d: want an error mentioning %q, got %q", upstream, wantMsg, msg)
			}
			// The parsed upstream body is carried through as `detail` — without
			// it the operator sees a bare status and cannot tell a permissions
			// refusal from a dependency refusal.
			detail := asMap(res["detail"])
			if detail == nil {
				t.Errorf("upstream %d: want the upstream body under detail, got %+v", upstream, res["detail"])
			}
		})
	}
}

func TestDelete_TransportErrorIs502AndSaysTheTenantWasNeverReached(t *testing.T) {
	// FINDING A-F2, now FIXED. When no HTTP response ever arrived,
	// rest.Client.Write reports status 0 (rest.go:344). The returned code was
	// always correct — statusOr(0, 502) — but the human-readable string used to
	// render "delete failed (status 0)", presenting 0 as if it were an HTTP
	// status the tenant sent back. "The request never completed" and "the tenant
	// answered 0" are different facts and that string made them look the same.
	// statusPhrase now renders the could-not-reach case in words; this test owns
	// the exact wording for Delete.
	res, status := dispatchDeadClient(t).Delete("/api/ddi/v1/ipam/host/h-1")

	if dispatchBool(res, "ok") {
		t.Fatalf("a delete that never reached the tenant reported success: %+v", res)
	}
	if status != 502 {
		t.Errorf("want 502 for a transport failure, got %d", status)
	}
	const want = "delete failed (could not reach the tenant — no request completed)"
	if msg, _ := res["error"].(string); msg != want {
		t.Errorf("error = %q, want %q", msg, want)
	}
}

// --- Resources ---------------------------------------------------------------

// dispatchWantTable is the dispatch table this package is contracted to expose,
// spelled out rather than derived from the code under test — a test that reads
// the table to build its expectation proves only that a map equals itself.
var dispatchWantTable = map[string]struct {
	ResultKey string
	Kind      string
	HasUpdate bool
}{
	"dns_zone":      {ResultKey: "zone", Kind: "dns/auth_zone", HasUpdate: true},
	"subnet":        {ResultKey: "subnet", Kind: "ipam/subnet", HasUpdate: true},
	"address_block": {ResultKey: "block", Kind: "ipam/address_block", HasUpdate: false},
	"dhcp_range":    {ResultKey: "range", Kind: "ipam/range", HasUpdate: true},
	"host":          {ResultKey: "host", Kind: "ipam/host", HasUpdate: true},
}

func TestResources_TableIsExactlyTheFiveKnownResources(t *testing.T) {
	// Asserting "the table is non-empty" would pass on a table with one entry or
	// six. Every name, ResultKey, Kind and the presence/absence of Update is
	// pinned, because server/edit.go 404s on an unknown name and reads Kind and
	// ResultKey out of whatever it finds.
	got := (&Client{}).Resources()

	if len(got) != len(dispatchWantTable) {
		t.Fatalf("want %d resources, got %d: %v", len(dispatchWantTable), len(got), dispatchNames(got))
	}
	for name, want := range dispatchWantTable {
		res, ok := got[name]
		if !ok {
			t.Errorf("resource %q missing from the dispatch table (routes would 404)", name)
			continue
		}
		if res.ResultKey != want.ResultKey {
			t.Errorf("%s: ResultKey = %q, want %q (audit id is read from this key)", name, res.ResultKey, want.ResultKey)
		}
		if res.Kind != want.Kind {
			t.Errorf("%s: Kind = %q, want %q (DELETE ids are validated against this)", name, res.Kind, want.Kind)
		}
		if res.Create == nil {
			t.Errorf("%s: Create is nil — POST /api/edit/%s would 404", name, name)
		}
		if want.HasUpdate && res.Update == nil {
			t.Errorf("%s: Update is nil — PATCH /api/edit/%s would 404", name, name)
		}
		if !want.HasUpdate && res.Update != nil {
			t.Errorf("%s: Update is non-nil, but this resource is create/delete only", name)
		}
	}
	for name := range got {
		if _, known := dispatchWantTable[name]; !known {
			t.Errorf("unexpected resource %q in the dispatch table — a new live write route nobody reviewed", name)
		}
	}
}

func TestResources_KindsAndResultKeysAreUniquePerResource(t *testing.T) {
	// A duplicated Kind or ResultKey is the copy-paste failure this table is
	// most exposed to, and it is invisible to a per-entry check: two resources
	// sharing "ipam/subnet" would let a host DELETE validate its id as a subnet.
	kinds := map[string]string{}
	keys := map[string]string{}
	for name, res := range (&Client{}).Resources() {
		if prev, dup := kinds[res.Kind]; dup {
			t.Errorf("Kind %q is shared by %q and %q — one of them validates ids against the wrong object type", res.Kind, prev, name)
		}
		kinds[res.Kind] = name
		if prev, dup := keys[res.ResultKey]; dup {
			t.Errorf("ResultKey %q is shared by %q and %q", res.ResultKey, prev, name)
		}
		keys[res.ResultKey] = name
	}
}

func TestResources_KindAcceptsItsOwnIDsAndRejectsForeignOnes(t *testing.T) {
	// This is what Kind is FOR: server/edit.go:214 calls
	// edit.ObjectPath(resDef.Kind, objID) to decide whether a DELETE may go out.
	// The check is done here the way the route does it, so a Kind that is merely
	// a plausible-looking string (but not the CSP object path) fails loudly.
	for name, res := range (&Client{}).Resources() {
		t.Run(name, func(t *testing.T) {
			ownID := res.Kind + "/dispatch-1"
			path, err := ObjectPath(res.Kind, ownID)
			if err != nil {
				t.Fatalf("Kind %q rejects its own full-form id %q: %v", res.Kind, ownID, err)
			}
			if want := "/api/ddi/v1/" + res.Kind + "/dispatch-1"; path != want {
				t.Errorf("path = %q, want %q", path, want)
			}
			// "ipam/address" belongs to no resource in this table, so it stands
			// in for any other object type a caller might smuggle in.
			if _, err := ObjectPath(res.Kind, "ipam/address/dispatch-1"); err == nil {
				t.Errorf("Kind %q accepted a foreign-type id — a DELETE would reach the wrong object type", res.Kind)
			}
		})
	}
}

func TestResources_KindMatchesTheKindItsUpdateBuilderValidatesAgainst(t *testing.T) {
	// The Resource doc says Kind "must match the kind each Update builder
	// validates its own id field against" (resources.go:391-394). Nothing
	// enforced that. If they drift, a full-form id that the DELETE route accepts
	// is rejected by the PATCH route (or vice versa) for the same object.
	// Driven through the builders on the dry path, so nothing reaches the wire.
	f := dispatchServer(t, func(r dispatchReq) (int, string) {
		t.Errorf("dry update reached the fake tenant: %s %s", r.Method, r.Path)
		return 500, `{}`
	})
	c := f.client()

	for name, res := range c.Resources() {
		if res.Update == nil {
			continue
		}
		t.Run(name, func(t *testing.T) {
			own, status := res.Update(M{"id": res.Kind + "/dispatch-1", "comment": "x", "dry": true})
			if status != 200 || !dispatchBool(own, "ok") {
				t.Errorf("Update rejected an id of its table Kind %q: status=%d res=%+v", res.Kind, status, own)
			}
			foreign, fstatus := res.Update(M{"id": "ipam/address/dispatch-1", "comment": "x", "dry": true})
			if fstatus != 400 {
				t.Errorf("Update accepted a foreign-type id: status=%d res=%+v", fstatus, foreign)
			}
		})
	}
	if f.count() != 0 {
		t.Errorf("dry updates must not touch the tenant, got %d calls", f.count())
	}
}

func TestResources_CreateIsWiredToTheBuilderForThatResource(t *testing.T) {
	// Two entries could easily point Create at the same builder. Each builder
	// names a different first-required field, so the refusal message identifies
	// which builder actually ran — with no request leaving the process.
	wantFirstError := map[string]string{
		"dns_zone":      "fqdn is required",
		"subnet":        "block_id is required",
		"address_block": "address is required",
		"dhcp_range":    "start is required",
		"host":          "name is required",
	}
	f := dispatchServer(t, func(r dispatchReq) (int, string) {
		t.Errorf("an empty create body reached the fake tenant: %s %s", r.Method, r.Path)
		return 500, `{}`
	})

	for name, res := range f.client().Resources() {
		out, status := res.Create(M{})
		if status != 400 {
			t.Errorf("%s: empty body should be refused with 400, got %d (%+v)", name, status, out)
		}
		if got, _ := out["error"].(string); got != wantFirstError[name] {
			t.Errorf("%s: Create is wired to the wrong builder — error = %q, want %q", name, got, wantFirstError[name])
		}
	}
	if f.count() != 0 {
		t.Errorf("validation refusals must not touch the tenant, got %d calls", f.count())
	}
}

func TestResources_ResultKeyNamesTheKeyItsCreateBuilderActuallyReturns(t *testing.T) {
	// ResultKey is only ever used to pull the new object's id out of a create
	// result for the audit row (server/edit.go:161). If it names a key the
	// builder does not return, the write still happens and the audit entry
	// records the deletion/creation of nothing — a silently id-less audit trail.
	// So the key is checked against a REAL create result, not against a
	// hand-written expectation.
	f := dispatchServer(t, dispatchCreateRoutes(t))
	c := f.client()
	resources := c.Resources()

	allKeys := map[string]bool{}
	for _, res := range resources {
		allKeys[res.ResultKey] = true
	}

	for name, res := range resources {
		t.Run(name, func(t *testing.T) {
			body := dispatchCreateBody(name)
			out, status := res.Create(body)
			if !dispatchBool(out, "ok") || (status != 200 && status != 201) {
				t.Fatalf("live create failed, so the ResultKey check would be vacuous: status=%d res=%+v", status, out)
			}
			if out[res.ResultKey] == nil {
				t.Fatalf("ResultKey %q is absent from the create result %+v — the audit id would be empty", res.ResultKey, out)
			}
			for key := range allKeys {
				if key == res.ResultKey {
					continue
				}
				if _, present := out[key]; present {
					t.Errorf("%s returned another resource's key %q as well: %+v", name, key, out)
				}
			}
		})
	}
}

// dispatchCreateBody is the minimum valid live-create body per resource. dry is
// explicitly false: the _edit_* builders default to a DRY PREVIEW (truthyDry),
// so omitting it would make every assertion above run against a preview that
// never touched the fake.
func dispatchCreateBody(resource string) M {
	switch resource {
	case "dns_zone":
		return M{"fqdn": "dispatch.example.com.", "view": "dns/view/v-1", "dry": false}
	case "subnet":
		return M{"block_id": "ipam/address_block/b-1", "cidr": float64(24), "dry": false}
	case "address_block":
		return M{"address": "10.9.0.0", "cidr": float64(16), "space": "ipam/ip_space/sp-1", "dry": false}
	case "dhcp_range":
		return M{"start": "10.9.0.10", "end": "10.9.0.20", "space": "ipam/ip_space/sp-1", "dry": false}
	case "host":
		return M{"name": "dispatch-host", "dry": false,
			"addresses": []any{M{"address": "10.9.0.5", "space": "ipam/ip_space/sp-1"}}}
	}
	return M{}
}

// dispatchCreateRoutes answers the create call each builder makes. Method first,
// then path — a substring-keyed handler would feed the subnet fixture to the
// address_block POST, since one path is a prefix of the other.
func dispatchCreateRoutes(t *testing.T) func(dispatchReq) (int, string) {
	t.Helper()
	return func(r dispatchReq) (int, string) {
		switch r.Method {
		case http.MethodPost:
			switch r.Path {
			case "/api/ddi/v1/dns/auth_zone":
				return 201, `{"result":{"id":"dns/auth_zone/z-1"}}`
			case "/api/ddi/v1/ipam/address_block/b-1/nextavailablesubnet":
				return 201, `{"results":[{"id":"ipam/subnet/s-1","address":"10.9.1.0"}]}`
			case "/api/ddi/v1/ipam/address_block":
				return 201, `{"result":{"id":"ipam/address_block/ab-1"}}`
			case "/api/ddi/v1/ipam/range":
				return 201, `{"result":{"id":"ipam/range/r-1"}}`
			case "/api/ddi/v1/ipam/host":
				return 201, `{"result":{"id":"ipam/host/h-1"}}`
			}
		case http.MethodPatch:
			// SubnetCreate tags the subnet it just carved out (resources.go:173).
			if r.Path == "/api/ddi/v1/ipam/subnet/s-1" {
				return 200, `{"result":{"id":"ipam/subnet/s-1","address":"10.9.1.0"}}`
			}
		}
		t.Errorf("unrouted request on the dispatch fake: %s %s", r.Method, r.Path)
		return 404, `{"error":"unrouted"}`
	}
}

func dispatchNames(m map[string]Resource) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// --- With --------------------------------------------------------------------

func TestWith_ReturnsADistinctClientAndLeavesTheReceiverAlone(t *testing.T) {
	// With must hand back a NEW Client bound to the caller's rest.Client. If it
	// returned the receiver (or mutated it), the request-scoped binding would be
	// a no-op and every write in that request would go out on the process-wide
	// client — which resolves the tenant key live, so a mid-request account
	// switch sends the rest of the request's writes to a DIFFERENT TENANT.
	// Mutating the receiver would be worse still: one request's tenant would
	// leak into every concurrent request in the process.
	base := dispatchStatic(t, 200, `{}`)
	other := dispatchStatic(t, 200, `{}`)
	c := base.client()
	original := c.Rest

	scopedRest := rest.New(other.srv.URL, rest.NewAuth("scoped-key", func() string { return "" }))
	scoped := c.With(scopedRest)

	if scoped == c {
		t.Fatal("With returned the receiver — the request-scoped binding is a no-op")
	}
	if scoped.Rest != scopedRest {
		t.Errorf("With bound %p, want the rest.Client it was given (%p)", scoped.Rest, scopedRest)
	}
	if c.Rest != original {
		t.Errorf("With mutated the receiver's rest.Client — one request's tenant would leak into all of them")
	}
}

func TestWith_WritesGoToTheScopedClientAndNotTheReceivers(t *testing.T) {
	// Identity assertions alone would still pass if a builder read c.Rest
	// instead of its own receiver. This drives a real destructive call and
	// checks which fake tenant it landed on.
	receiverTenant := dispatchStatic(t, 200, `{}`)
	scopedTenant := dispatchStatic(t, 200, `{}`)

	c := receiverTenant.client()
	scopedRest := rest.New(scopedTenant.srv.URL, rest.NewAuth("scoped-key", func() string { return "" }))

	res, status := c.With(scopedRest).Delete("/api/ddi/v1/ipam/host/h-1")

	if !dispatchBool(res, "ok") || status != 200 {
		t.Fatalf("scoped delete failed: status=%d res=%+v", status, res)
	}
	if receiverTenant.count() != 0 {
		t.Errorf("the receiver's tenant saw %d write(s) — the write landed in the WRONG TENANT: %+v",
			receiverTenant.count(), receiverTenant.calls())
	}
	call := dispatchOnlyCall(t, scopedTenant)
	if call.Method != http.MethodDelete || call.Path != "/api/ddi/v1/ipam/host/h-1" {
		t.Errorf("scoped tenant got %s %s, want DELETE /api/ddi/v1/ipam/host/h-1", call.Method, call.Path)
	}
	if call.Auth != "scoped-key" {
		t.Errorf("Authorization = %q, want the scoped client's key %q", call.Auth, "scoped-key")
	}
}

func TestWith_KeepsThePinnedTenantKeyAcrossAMidRequestAccountSwitch(t *testing.T) {
	// The scenario rest.Client.Pin was written for, end to end: a request starts
	// against tenant A, an account switch lands while it is still running, and
	// the request's remaining writes must still go to tenant A. That only holds
	// if With actually adopts the pinned client.
	f := dispatchStatic(t, 200, `{}`)

	activeKey := "tenant-A-key"
	auth := rest.NewAuth("env-fallback-key", func() string { return activeKey })
	shared := rest.New(f.srv.URL, auth)
	c := New(shared)

	scoped := c.With(shared.Pin()) // request begins: key frozen at tenant A

	activeKey = "tenant-B-key" // an account switch lands mid-request

	if _, status := scoped.Delete("/api/ddi/v1/ipam/host/h-1"); status != 200 {
		t.Fatalf("scoped delete returned %d", status)
	}
	// Contrast: the process-wide client follows the switch. Asserting both in
	// one test is what makes the first assertion meaningful — otherwise a fake
	// that never sees the switch would look identical.
	if _, status := c.Delete("/api/ddi/v1/ipam/host/h-2"); status != 200 {
		t.Fatalf("unpinned delete returned %d", status)
	}

	got := f.calls()
	if len(got) != 2 {
		t.Fatalf("want 2 upstream deletes, got %d: %+v", len(got), got)
	}
	if got[0].Auth != "tenant-A-key" {
		t.Errorf("request-scoped write used %q — it landed in the WRONG TENANT; want %q",
			got[0].Auth, "tenant-A-key")
	}
	if got[1].Auth != "tenant-B-key" {
		t.Errorf("process-wide write used %q, want the switched-in key %q", got[1].Auth, "tenant-B-key")
	}
}

// Guard on the fixtures themselves: every resource in the table must have a
// create fixture, and it must be JSON-encodable. rest.Client.Write marshals the
// body and returns early on a marshal error (rest.go:347-350), so a bad fixture
// would make a "live create" test pass without a request ever being sent.
func TestDispatchFixturesCoverEveryResource(t *testing.T) {
	for _, name := range dispatchNames((&Client{}).Resources()) {
		body := dispatchCreateBody(name)
		if len(body) == 0 {
			t.Errorf("%s: no create fixture", name)
			continue
		}
		if _, err := json.Marshal(body); err != nil {
			t.Errorf("%s: create fixture is not JSON-encodable: %v", name, err)
		}
	}
}
