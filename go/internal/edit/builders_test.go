package edit

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// Lane A3 — the live create/update builders in resources.go, plus the
// patchThenPut PATCH->PUT-on-405 fallback in edit.go.
//
// Scope, stated honestly: this file covers the NON-DRY halves of the five
// _edit_* create builders and the four update builders, the ObjectPath
// traversal gate they all share, and the 405 fallback. SubnetCreate's dry-run
// preview three-way split is owned by resources_test.go and is deliberately
// NOT re-tested here. DNSRecord*, SelfserviceAllocate, Resources/Delete/With
// belong to the sibling lanes.
//
// Everything runs against net/http/httptest. No test in this file may ever
// reach a real tenant.

// --- the recording fake ------------------------------------------------------

// builderReq is one captured OUTBOUND request — what the customer tenant would
// actually have received, not what the builder returned locally. Asserting on
// the returned map only proves local bookkeeping; before this file no edit fake
// recorded outgoing bodies at all, so "the right thing was sent upstream" was
// unprovable for every create path.
type builderReq struct {
	Method string
	Path   string
	Query  url.Values
	Raw    string // exact request body bytes ("" when the builder sent none)
	Body   M      // Raw decoded as a JSON object; nil if absent or not an object
}

// builderFake is a recording upstream. Its route func MUST branch on
// r.Method first and only then on path: POST, PATCH and PUT share the same
// object paths in this package (SubnetCreate POSTs then PATCHes, patchThenPut
// PATCHes then PUTs the identical path), so a path-keyed fake would answer the
// wrong verb with the right-looking fixture and the test would go green for the
// wrong reason.
type builderFake struct {
	t    *testing.T
	mu   sync.Mutex
	reqs []builderReq
	srv  *httptest.Server
}

// builderFakeServer starts a recording fake. route returns (status, bodyJSON);
// an empty bodyJSON writes no body at all (the 204-shaped case).
func builderFakeServer(t *testing.T, route func(builderReq) (int, string)) *builderFake {
	t.Helper()
	f := &builderFake{t: t}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		req := builderReq{Method: r.Method, Path: r.URL.Path, Query: r.URL.Query(), Raw: string(raw)}
		if len(raw) > 0 {
			var decoded any
			if err := json.Unmarshal(raw, &decoded); err == nil {
				req.Body = asMap(decoded)
			}
		}
		f.mu.Lock()
		f.reqs = append(f.reqs, req)
		f.mu.Unlock()

		status, body := route(req)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if body != "" {
			_, _ = io.WriteString(w, body)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// builderRefuseAll is the fixture for "this must never reach the wire": every
// request is recorded and answered 200 with a success-shaped body, so a build
// that wrongly calls upstream goes GREEN upstream and RED on the call count —
// the failure names the real problem instead of hiding behind a 500.
func builderRefuseAll(t *testing.T) *builderFake {
	t.Helper()
	return builderFakeServer(t, func(builderReq) (int, string) {
		return 200, `{"result":{"id":"should-never-be-reached"}}`
	})
}

func (f *builderFake) client() *Client { return newTestClient(f.srv) }

func (f *builderFake) calls() []builderReq {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]builderReq{}, f.reqs...)
}

func (f *builderFake) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.reqs)
}

// wantNoCalls fails with the offending method+path, not just a count, so a
// regression says WHICH request escaped.
func (f *builderFake) wantNoCalls(t *testing.T, why string) {
	t.Helper()
	if got := f.calls(); len(got) != 0 {
		t.Fatalf("%d upstream request(s) made, want 0 (%s): %+v", len(got), why, got)
	}
}

// wantOneCall asserts exactly one request and returns it.
func (f *builderFake) wantOneCall(t *testing.T) builderReq {
	t.Helper()
	got := f.calls()
	if len(got) != 1 {
		t.Fatalf("%d upstream requests, want exactly 1: %+v", len(got), got)
	}
	return got[0]
}

func builderWantMethodPath(t *testing.T, r builderReq, method, path string) {
	t.Helper()
	if r.Method != method || r.Path != path {
		t.Fatalf("upstream got %s %s, want %s %s", r.Method, r.Path, method, path)
	}
}

func builderWantField(t *testing.T, r builderReq, key string, want any) {
	t.Helper()
	if r.Body == nil {
		t.Fatalf("request %s %s carried no JSON object body (raw=%q)", r.Method, r.Path, r.Raw)
	}
	got, present := r.Body[key]
	if !present {
		t.Fatalf("request body missing %q; body = %#v", key, r.Body)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("request body %q = %#v, want %#v", key, got, want)
	}
}

// --- dns_zone: ZoneCreate ----------------------------------------------------

// TestZoneCreate_SendsCloudPrimaryTypeUpstream pins the hardcoded
// primary_type:"cloud" (resources.go:35) on the WIRE. Mutation: "cloud" -> ""
// leaves the POST body's primary_type empty and this reddens.
func TestZoneCreate_SendsCloudPrimaryTypeUpstream(t *testing.T) {
	f := builderFakeServer(t, func(r builderReq) (int, string) {
		if r.Method == http.MethodPost && r.Path == "/api/ddi/v1/dns/auth_zone" {
			return 201, `{"result":{"id":"dns/auth_zone/z1","fqdn":"example.com."}}`
		}
		return 500, `{"error":"unrouted request"}`
	})

	res, status := f.client().ZoneCreate(M{
		"fqdn": "example.com.", "view": "view-1",
		"comment": "prod zone", "tags": M{"Owner": "noc"},
		"dry": false,
	})

	if status != 201 || res["ok"] != true {
		t.Fatalf("ZoneCreate = (%v, %d), want ok:true 201", res, status)
	}
	req := f.wantOneCall(t)
	builderWantMethodPath(t, req, http.MethodPost, "/api/ddi/v1/dns/auth_zone")
	builderWantField(t, req, "primary_type", "cloud")
	builderWantField(t, req, "fqdn", "example.com.")
	builderWantField(t, req, "view", "view-1")
	builderWantField(t, req, "comment", "prod zone")
	builderWantField(t, req, "tags", map[string]any{"Owner": "noc"})

	zone := asMap(res["zone"])
	if zone == nil || zone["id"] != "dns/auth_zone/z1" {
		t.Fatalf("zone = %#v, want the upstream result object", res["zone"])
	}
}

// TestZoneCreate_OptionalFieldsOmittedWhenFalsy proves the two conditional
// fields are ABSENT (not empty-valued) when the caller omits them — an empty
// comment/tags sent upstream would blank an existing value on some CSP paths.
func TestZoneCreate_OptionalFieldsOmittedWhenFalsy(t *testing.T) {
	f := builderFakeServer(t, func(builderReq) (int, string) {
		return 200, `{"result":{"id":"dns/auth_zone/z1"}}`
	})

	_, status := f.client().ZoneCreate(M{"fqdn": "example.com.", "view": "view-1", "comment": "", "tags": M{}, "dry": false})
	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	req := f.wantOneCall(t)
	for _, k := range []string{"comment", "tags"} {
		if _, present := req.Body[k]; present {
			t.Fatalf("body carries %q = %#v, want the key absent when falsy", k, req.Body[k])
		}
	}
}

func TestZoneCreate_ValidationRefusedBeforeWire(t *testing.T) {
	cases := []struct {
		name string
		body M
		want string
	}{
		{"no fqdn", M{"view": "view-1", "dry": false}, "fqdn is required"},
		{"no view", M{"fqdn": "example.com.", "dry": false}, "view is required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := builderRefuseAll(t)
			res, status := f.client().ZoneCreate(tc.body)
			if status != 400 || res["error"] != tc.want {
				t.Fatalf("= (%v, %d), want 400 %q", res, status, tc.want)
			}
			f.wantNoCalls(t, "validation must refuse before any tenant write")
		})
	}
}

// TestZoneCreate_UpstreamFailureIsNotSuccess: a rejected create must never
// report ok:true. Mutation: resources.go:46 condition -> false.
func TestZoneCreate_UpstreamFailureIsNotSuccess(t *testing.T) {
	f := builderFakeServer(t, func(builderReq) (int, string) {
		return 500, `{"error":"tenant exploded"}`
	})
	res, status := f.client().ZoneCreate(M{"fqdn": "example.com.", "view": "v", "dry": false})
	if res["ok"] != false || status != 500 {
		t.Fatalf("= (%v, %d), want ok:false 500", res, status)
	}
	if !strings.Contains(pyStr(res["error"]), "create failed (status 500)") {
		t.Fatalf("error = %v, want it to name the upstream status", res["error"])
	}
	if res["detail"] == nil {
		t.Fatalf("detail = nil, want the upstream error body preserved for the operator")
	}
}

// --- update builders: shared gates (Zone/Subnet/Range/Host) ------------------

// builderUpdates is the four update builders as method expressions, each with a
// field set that is valid for it. Every gate below runs against all four: the
// ObjectPath traversal gate (resources.go:57-64) is documented only on
// ZoneUpdate but is carried by all four, and none was tested through a builder.
var builderUpdates = []struct {
	name   string
	update func(*Client, M) (M, int)
	fields M // one legitimate field, so the gate under test is the reason for the 400
}{
	{"ZoneUpdate", (*Client).ZoneUpdate, M{"comment": "c"}},
	{"SubnetUpdate", (*Client).SubnetUpdate, M{"comment": "c"}},
	{"RangeUpdate", (*Client).RangeUpdate, M{"comment": "c"}},
	{"HostUpdate", (*Client).HostUpdate, M{"comment": "c"}},
}

// TestUpdateBuilders_TraversalIdRefusedBeforeWire is the gate the plan calls
// out: a traversal-shaped id must be refused by the builder itself, not merely
// by whatever route happened to call it. Mutation (any builder): replace
// ObjectPath(kind, id) with "/api/ddi/v1/"+id, nil — the id reaches the fake
// and the call count assertion reddens.
func TestUpdateBuilders_TraversalIdRefusedBeforeWire(t *testing.T) {
	badIDs := []string{"../x", "foo/../../x", "%2fx", "..", "dns/auth_zone/../../x"}
	for _, u := range builderUpdates {
		for _, id := range badIDs {
			t.Run(u.name+"/"+id, func(t *testing.T) {
				f := builderRefuseAll(t)
				body := M{"id": id, "dry": false}
				for k, v := range u.fields {
					body[k] = v
				}
				res, status := u.update(f.client(), body)
				if status != 400 || res["error"] != "invalid object id" {
					t.Fatalf("%s(%q) = (%v, %d), want 400 \"invalid object id\"", u.name, id, res, status)
				}
				f.wantNoCalls(t, "a traversal id must never reach the tenant under the server's own API key")
			})
		}
	}
}

func TestUpdateBuilders_MissingIdIs400BeforeWire(t *testing.T) {
	for _, u := range builderUpdates {
		t.Run(u.name, func(t *testing.T) {
			f := builderRefuseAll(t)
			body := M{"dry": false}
			for k, v := range u.fields {
				body[k] = v
			}
			res, status := u.update(f.client(), body)
			if status != 400 || res["error"] != "id is required" {
				t.Fatalf("%s = (%v, %d), want 400 \"id is required\"", u.name, res, status)
			}
			f.wantNoCalls(t, "no id means nothing identifiable to write")
		})
	}
}

// TestUpdateBuilders_NoFieldsIs400BeforeWire: an update naming no field must
// not PATCH an empty body upstream. Mutation: delete the len(up)==0 guard in
// any builder (e.g. resources.go:369-371 for HostUpdate) and it PATCHes anyway.
func TestUpdateBuilders_NoFieldsIs400BeforeWire(t *testing.T) {
	for _, u := range builderUpdates {
		t.Run(u.name, func(t *testing.T) {
			f := builderRefuseAll(t)
			res, status := u.update(f.client(), M{"id": "obj1", "dry": false})
			if status != 400 {
				t.Fatalf("%s = (%v, %d), want 400", u.name, res, status)
			}
			if !strings.HasPrefix(pyStr(res["error"]), "no fields to update") {
				t.Fatalf("%s error = %v, want a \"no fields to update\" refusal", u.name, res["error"])
			}
			f.wantNoCalls(t, "an empty update must not be sent")
		})
	}
}

// TestEditBuilders_DryDefaultsPreviewAndSendsNothing states the dry default
// explicitly instead of assuming it: every _edit_* builder defaults dry to TRUE
// (truthyDry), unlike the two DNS-record paths which default to FALSE/live
// (boolPy, edit.go:300 — finding A-F3). SubnetCreate is excluded on purpose: its
// dry path legitimately issues a preview GET and is owned by resources_test.go.
// Mutation: truthyDry -> boolPy in any builder and the omitted-dry run hits the
// wire.
func TestEditBuilders_DryDefaultsPreviewAndSendsNothing(t *testing.T) {
	creates := []struct {
		name   string
		create func(*Client, M) (M, int)
		body   M
	}{
		{"ZoneCreate", (*Client).ZoneCreate, M{"fqdn": "example.com.", "view": "v"}},
		{"BlockCreate", (*Client).BlockCreate, M{"address": "10.0.0.0", "cidr": float64(16), "space": "sp1"}},
		{"RangeCreate", (*Client).RangeCreate, M{"start": "10.0.0.10", "end": "10.0.0.20", "space": "sp1"}},
		{"HostCreate", (*Client).HostCreate, M{"name": "h1", "addresses": []any{M{"address": "10.0.0.5"}}}},
	}
	for _, tc := range creates {
		t.Run(tc.name, func(t *testing.T) {
			f := builderRefuseAll(t)
			res, status := tc.create(f.client(), tc.body)
			if status != 200 || res["dry_run"] != true || res["would_create"] == nil {
				t.Fatalf("%s with dry omitted = (%v, %d), want a 200 dry_run preview", tc.name, res, status)
			}
			f.wantNoCalls(t, "dry defaults to true for every _edit_* builder")
		})
	}
	for _, u := range builderUpdates {
		t.Run(u.name, func(t *testing.T) {
			f := builderRefuseAll(t)
			body := M{"id": "obj1"}
			for k, v := range u.fields {
				body[k] = v
			}
			res, status := u.update(f.client(), body)
			if status != 200 || res["dry_run"] != true || res["would_update"] == nil {
				t.Fatalf("%s with dry omitted = (%v, %d), want a 200 dry_run preview", u.name, res, status)
			}
			if res["id"] != "obj1" {
				t.Fatalf("%s preview id = %v, want the id echoed back", u.name, res["id"])
			}
			f.wantNoCalls(t, "dry defaults to true for every _edit_* builder")
		})
	}
}

// TestUpdateBuilders_LivePatchSendsOnlyNamedFields walks each update builder's
// full field set onto the wire. A field silently dropped here is an edit the
// operator believes they made.
func TestUpdateBuilders_LivePatchSendsOnlyNamedFields(t *testing.T) {
	cases := []struct {
		name   string
		update func(*Client, M) (M, int)
		body   M
		path   string
		want   M
		key    string
	}{
		{
			"ZoneUpdate", (*Client).ZoneUpdate,
			M{"id": "z1", "comment": "c", "tags": M{"Env": "prod"}, "disabled": true, "dry": false},
			"/api/ddi/v1/dns/auth_zone/z1",
			M{"comment": "c", "tags": map[string]any{"Env": "prod"}, "disabled": true}, "zone",
		},
		{
			"SubnetUpdate", (*Client).SubnetUpdate,
			M{"id": "ipam/subnet/s1", "name": "n", "comment": "c", "tags": M{"Env": "prod"}, "disabled": false, "dry": false},
			"/api/ddi/v1/ipam/subnet/s1",
			M{"name": "n", "comment": "c", "tags": map[string]any{"Env": "prod"}, "disabled": false}, "subnet",
		},
		{
			"RangeUpdate", (*Client).RangeUpdate,
			M{"id": "r1", "start": "10.0.0.10", "end": "10.0.0.20", "comment": "c", "tags": M{"Env": "prod"}, "disabled": true, "dry": false},
			"/api/ddi/v1/ipam/range/r1",
			M{"start": "10.0.0.10", "end": "10.0.0.20", "comment": "c", "tags": map[string]any{"Env": "prod"}, "disabled": true}, "range",
		},
		{
			"HostUpdate", (*Client).HostUpdate,
			M{"id": "h1", "name": "n", "comment": "c", "addresses": []any{M{"address": "10.0.0.5"}}, "tags": M{"Env": "prod"}, "dry": false},
			"/api/ddi/v1/ipam/host/h1",
			M{"name": "n", "comment": "c", "addresses": []any{map[string]any{"address": "10.0.0.5"}}, "tags": map[string]any{"Env": "prod"}}, "host",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := builderFakeServer(t, func(r builderReq) (int, string) {
				if r.Method == http.MethodPatch && r.Path == tc.path {
					return 200, `{"result":{"id":"updated-1"}}`
				}
				return 500, `{"error":"unrouted request"}`
			})
			res, status := tc.update(f.client(), tc.body)
			if status != 200 || res["ok"] != true {
				t.Fatalf("%s = (%v, %d), want ok:true 200", tc.name, res, status)
			}
			if res["method"] != "PATCH" {
				t.Fatalf("%s method = %v, want PATCH", tc.name, res["method"])
			}
			obj := asMap(res[tc.key])
			if obj == nil || obj["id"] != "updated-1" {
				t.Fatalf("%s %s = %#v, want the upstream result object", tc.name, tc.key, res[tc.key])
			}
			req := f.wantOneCall(t)
			builderWantMethodPath(t, req, http.MethodPatch, tc.path)
			if !reflect.DeepEqual(req.Body, M(tc.want)) {
				t.Fatalf("%s PATCH body = %#v, want exactly %#v", tc.name, req.Body, tc.want)
			}
		})
	}
}

func TestUpdateBuilders_UpstreamFailureIsNotSuccess(t *testing.T) {
	for _, u := range builderUpdates {
		t.Run(u.name, func(t *testing.T) {
			f := builderFakeServer(t, func(builderReq) (int, string) {
				return 500, `{"error":"tenant exploded"}`
			})
			body := M{"id": "obj1", "dry": false}
			for k, v := range u.fields {
				body[k] = v
			}
			res, status := u.update(f.client(), body)
			if res["ok"] != false || status != 500 {
				t.Fatalf("%s = (%v, %d), want ok:false 500", u.name, res, status)
			}
			if res["method"] != "PATCH" {
				t.Fatalf("%s method = %v, want the attempted method reported on failure", u.name, res["method"])
			}
		})
	}
}

// --- patchThenPut: the PATCH -> PUT-on-405 fallback --------------------------

// TestPatchThenPut_FallsBackToPutOn405 needs a fake that answers PATCH with 405
// and PUT with 200 — the fixture that has never existed in this package. Driven
// through ZoneUpdate rather than calling patchThenPut directly, so the reported
// method:"PUT" is proven end to end. Mutation: edit.go:469 `status == 405` ->
// `false` — the method stays PATCH and the update reports failure.
func TestPatchThenPut_FallsBackToPutOn405(t *testing.T) {
	f := builderFakeServer(t, func(r builderReq) (int, string) {
		switch r.Method {
		case http.MethodPatch:
			return 405, `{"error":"method not allowed"}`
		case http.MethodPut:
			return 200, `{"result":{"id":"dns/auth_zone/z1","comment":"updated"}}`
		}
		return 500, `{"error":"unexpected method"}`
	})

	res, status := f.client().ZoneUpdate(M{"id": "z1", "comment": "updated", "dry": false})
	if status != 200 || res["ok"] != true {
		t.Fatalf("ZoneUpdate = (%v, %d), want ok:true 200 after the PUT fallback", res, status)
	}
	if res["method"] != "PUT" {
		t.Fatalf("method = %v, want PUT — the caller must be told which verb actually wrote", res["method"])
	}

	calls := f.calls()
	if len(calls) != 2 {
		t.Fatalf("%d upstream requests, want 2 (PATCH then PUT): %+v", len(calls), calls)
	}
	builderWantMethodPath(t, calls[0], http.MethodPatch, "/api/ddi/v1/dns/auth_zone/z1")
	builderWantMethodPath(t, calls[1], http.MethodPut, "/api/ddi/v1/dns/auth_zone/z1")
	if !reflect.DeepEqual(calls[0].Body, calls[1].Body) {
		t.Fatalf("the retried PUT body %#v differs from the PATCH body %#v — the fallback must resend the same update",
			calls[1].Body, calls[0].Body)
	}
	builderWantField(t, calls[1], "comment", "updated")
}

// TestPatchThenPut_DoesNotRetryOnNon405 keeps the fallback narrow: a 500 (or
// any non-405) must NOT be re-sent as a PUT. Mutation: `status == 405` ->
// `status >= 400` and a second write appears.
func TestPatchThenPut_DoesNotRetryOnNon405(t *testing.T) {
	f := builderFakeServer(t, func(builderReq) (int, string) {
		return 500, `{"error":"tenant exploded"}`
	})
	res, status := f.client().ZoneUpdate(M{"id": "z1", "comment": "updated", "dry": false})
	if status != 500 || res["ok"] != false {
		t.Fatalf("= (%v, %d), want ok:false 500", res, status)
	}
	req := f.wantOneCall(t)
	builderWantMethodPath(t, req, http.MethodPatch, "/api/ddi/v1/dns/auth_zone/z1")
}

// --- subnet: SubnetCreate's non-dry half ------------------------------------

// TestSubnetCreate_LiveCreateThenTagsForTeardown is the headline of this lane.
// The non-dry path is create-then-PATCH-tags and the code's own comment says the
// tags are "needed for teardown" — an untagged subnet silently survives every
// teardown, forever, in a customer tenant. Nothing proved the tags ever left the
// process. Mutations: (a) delete the PATCH block (resources.go:166-180) — the
// second call disappears; (b) delete the Name default (resources.go:105-108) —
// the PATCH tags lose "Name".
func TestSubnetCreate_LiveCreateThenTagsForTeardown(t *testing.T) {
	f := builderFakeServer(t, func(r builderReq) (int, string) {
		switch {
		case r.Method == http.MethodPost && r.Path == "/api/ddi/v1/block-1/nextavailablesubnet":
			return 201, `{"results":[{"id":"ipam/subnet/s1","address":"10.0.5.0"}]}`
		case r.Method == http.MethodPatch && r.Path == "/api/ddi/v1/ipam/subnet/s1":
			return 200, `{"result":{"id":"ipam/subnet/s1","address":"10.0.5.0","tags":{"Name":"test-subnet","Env":"prod"}}}`
		}
		return 500, `{"error":"unrouted request"}`
	})

	res, status := f.client().SubnetCreate(M{
		"block_id": "block-1", "cidr": float64(24),
		"name": "test-subnet", "comment": "noc subnet",
		"tags": M{"Env": "prod"}, "dry": false,
	})
	if status != 200 || res["ok"] != true {
		t.Fatalf("SubnetCreate = (%v, %d), want ok:true 200", res, status)
	}

	calls := f.calls()
	if len(calls) != 2 {
		t.Fatalf("%d upstream requests, want 2 (allocate then tag): %+v", len(calls), calls)
	}

	// 1. the allocation POST — no body, cidr/count in the query string.
	builderWantMethodPath(t, calls[0], http.MethodPost, "/api/ddi/v1/block-1/nextavailablesubnet")
	if calls[0].Raw != "" {
		t.Fatalf("allocation POST body = %q, want none", calls[0].Raw)
	}
	if got := calls[0].Query.Get("cidr"); got != "24" {
		t.Fatalf("cidr query = %q, want 24", got)
	}
	if got := calls[0].Query.Get("count"); got != "1" {
		t.Fatalf("count query = %q, want 1", got)
	}

	// 2. the tag PATCH — the teardown-critical half.
	builderWantMethodPath(t, calls[1], http.MethodPatch, "/api/ddi/v1/ipam/subnet/s1")
	builderWantField(t, calls[1], "tags", map[string]any{"Env": "prod", "Name": "test-subnet"})
	builderWantField(t, calls[1], "name", "test-subnet")
	builderWantField(t, calls[1], "comment", "noc subnet")

	subnet := asMap(res["subnet"])
	if subnet == nil || subnet["id"] != "ipam/subnet/s1" {
		t.Fatalf("subnet = %#v, want the PATCH result object", res["subnet"])
	}
}

// TestSubnetCreate_CallerTagsWinOverNameDefault: the Name default must not
// clobber an explicit Name the caller supplied (resources.go:106's exists check).
func TestSubnetCreate_CallerTagsWinOverNameDefault(t *testing.T) {
	f := builderFakeServer(t, func(r builderReq) (int, string) {
		if r.Method == http.MethodPost {
			return 201, `{"results":[{"id":"ipam/subnet/s1"}]}`
		}
		return 200, `{"result":{"id":"ipam/subnet/s1"}}`
	})
	_, status := f.client().SubnetCreate(M{
		"block_id": "block-1", "cidr": float64(24), "name": "arg-name",
		"tags": M{"Name": "explicit-name"}, "dry": false,
	})
	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	calls := f.calls()
	if len(calls) != 2 {
		t.Fatalf("%d upstream requests, want 2: %+v", len(calls), calls)
	}
	builderWantField(t, calls[1], "tags", map[string]any{"Name": "explicit-name"})
}

// TestSubnetCreate_TagPatchIsRetriedExactlyOnce is the D2 proof. The subnet is
// already live when the tag PATCH fails, and without those tags no teardown
// query (_tfilter Site==...) can ever see it — so a transient blip on the
// PATCH strands a real customer subnet. One retry of an idempotent PATCH clears
// exactly that case. Bounded to ONE extra attempt: two upstream writes, no
// more, and the second is the same body as the first.
// Mutation: delete the retry write in resources.go -> one PATCH, ok:false, red.
func TestSubnetCreate_TagPatchIsRetriedExactlyOnce(t *testing.T) {
	patches := 0
	f := builderFakeServer(t, func(r builderReq) (int, string) {
		if r.Method == http.MethodPost {
			return 201, `{"results":[{"id":"ipam/subnet/s1"}]}`
		}
		patches++
		if patches == 1 {
			return 500, `{"error":"transient tag write failure"}`
		}
		return 200, `{"result":{"id":"ipam/subnet/s1","tags":{"Name":"n","Site":"hq"}}}`
	})

	res, status := f.client().SubnetCreate(M{
		"block_id": "block-1", "cidr": float64(24), "name": "n",
		"tags": M{"Site": "hq"}, "dry": false,
	})
	if res["ok"] != true || status != 200 {
		t.Fatalf("= (%v, %d), want ok:true 200 — the retried PATCH succeeded", res, status)
	}

	calls := f.calls()
	if len(calls) != 3 {
		t.Fatalf("%d upstream requests, want 3 (allocate, tag, one retry): %+v", len(calls), calls)
	}
	builderWantMethodPath(t, calls[0], http.MethodPost, "/api/ddi/v1/block-1/nextavailablesubnet")
	for i := 1; i < 3; i++ {
		builderWantMethodPath(t, calls[i], http.MethodPatch, "/api/ddi/v1/ipam/subnet/s1")
		builderWantField(t, calls[i], "tags", map[string]any{"Site": "hq", "Name": "n"})
	}
	if !reflect.DeepEqual(calls[1].Body, calls[2].Body) {
		t.Fatalf("the retry body %#v differs from the first PATCH body %#v — the retry must resend the same tags",
			calls[2].Body, calls[1].Body)
	}
	if subnet := asMap(res["subnet"]); subnet == nil || subnet["id"] != "ipam/subnet/s1" {
		t.Fatalf("subnet = %#v, want the successful PATCH result object", res["subnet"])
	}
}

// TestSubnetCreate_TaggingFailureNamesTheId: the subnet EXISTS upstream but is
// untagged, so it is invisible to teardown. Reporting ok:true here would leak a
// customer subnet permanently; the id must be returned so an operator can go
// clean up. Post-D2 this arm is reached only after the retry ALSO failed — the
// retry is bounded, so exactly two PATCHes are attempted and never a third, and
// the just-created subnet is never deleted (no DELETE is issued at all).
// tagging_failed is what lets the route layer audit the orphan's id
// (server/edit.go editCreate). Mutation: resources.go's failure condition ->
// false.
func TestSubnetCreate_TaggingFailureNamesTheId(t *testing.T) {
	f := builderFakeServer(t, func(r builderReq) (int, string) {
		if r.Method == http.MethodPost {
			return 201, `{"results":[{"id":"ipam/subnet/s1"}]}`
		}
		return 500, `{"error":"tag write rejected"}`
	})

	res, status := f.client().SubnetCreate(M{"block_id": "block-1", "cidr": float64(24), "name": "n", "dry": false})
	if res["ok"] != false || status != 500 {
		t.Fatalf("= (%v, %d), want ok:false 500", res, status)
	}
	if res["id"] != "ipam/subnet/s1" {
		t.Fatalf("id = %v, want the created subnet's id so it can be cleaned up", res["id"])
	}
	if res["tagging_failed"] != true {
		t.Fatalf("tagging_failed = %v, want true so the route layer audits the orphan's id", res["tagging_failed"])
	}
	if !strings.Contains(pyStr(res["error"]), "needed for teardown") {
		t.Fatalf("error = %v, want it to say the tags were needed for teardown", res["error"])
	}

	calls := f.calls()
	if len(calls) != 3 {
		t.Fatalf("%d upstream requests, want 3 (allocate + PATCH + exactly one retry): %+v", len(calls), calls)
	}
	for _, c := range calls {
		if c.Method == http.MethodDelete {
			t.Fatalf("a just-created subnet was DELETEd on tag failure: %+v", c)
		}
	}
}

// TestSubnetCreate_NoFreeSubnetIsNotSuccess: a 200 carrying no rows is a real
// "the block is full" answer, not a created subnet — and nothing must be
// PATCHed afterwards.
func TestSubnetCreate_NoFreeSubnetIsNotSuccess(t *testing.T) {
	f := builderFakeServer(t, func(builderReq) (int, string) {
		return 201, `{"results":[]}`
	})
	res, status := f.client().SubnetCreate(M{"block_id": "block-1", "cidr": float64(24), "dry": false})
	if res["ok"] != false || status != 502 {
		t.Fatalf("= (%v, %d), want ok:false 502", res, status)
	}
	if res["error"] != "no free subnet available in block" {
		t.Fatalf("error = %v, want the block-full message", res["error"])
	}
	if got := f.count(); got != 1 {
		t.Fatalf("%d upstream requests, want 1 (nothing to tag)", got)
	}
}

func TestSubnetCreate_UpstreamFailureIsNotSuccess(t *testing.T) {
	f := builderFakeServer(t, func(builderReq) (int, string) {
		return 503, `{"error":"upstream down"}`
	})
	res, status := f.client().SubnetCreate(M{"block_id": "block-1", "cidr": float64(24), "dry": false})
	if res["ok"] != false || status != 503 {
		t.Fatalf("= (%v, %d), want ok:false 503", res, status)
	}
	if got := f.count(); got != 1 {
		t.Fatalf("%d upstream requests, want 1 (no tagging after a failed create)", got)
	}
}

func TestSubnetCreate_ValidationRefusedBeforeWire(t *testing.T) {
	cases := []struct {
		name string
		body M
		want string
	}{
		{"no block_id", M{"cidr": float64(24), "dry": false}, "block_id is required"},
		{"no cidr", M{"block_id": "block-1", "dry": false}, "cidr is required"},
		{"bad cidr", M{"block_id": "block-1", "cidr": "twenty-four", "dry": false}, "cidr must be an integer"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := builderRefuseAll(t)
			res, status := f.client().SubnetCreate(tc.body)
			if status != 400 || res["error"] != tc.want {
				t.Fatalf("= (%v, %d), want 400 %q", res, status, tc.want)
			}
			f.wantNoCalls(t, "validation must refuse before any tenant write")
		})
	}
}

// --- address_block: BlockCreate ---------------------------------------------

func TestBlockCreate_SendsAddressCidrSpaceUpstream(t *testing.T) {
	f := builderFakeServer(t, func(r builderReq) (int, string) {
		if r.Method == http.MethodPost && r.Path == "/api/ddi/v1/ipam/address_block" {
			return 201, `{"result":{"id":"ipam/address_block/b1"}}`
		}
		return 500, `{"error":"unrouted request"}`
	})

	res, status := f.client().BlockCreate(M{
		"address": "10.0.0.0", "cidr": "16", "space": "sp1",
		"comment": "core", "tags": M{"Env": "prod"}, "dry": false,
	})
	if status != 201 || res["ok"] != true {
		t.Fatalf("BlockCreate = (%v, %d), want ok:true 201", res, status)
	}
	req := f.wantOneCall(t)
	builderWantMethodPath(t, req, http.MethodPost, "/api/ddi/v1/ipam/address_block")
	builderWantField(t, req, "address", "10.0.0.0")
	// The string "16" must arrive as a JSON NUMBER — CSP rejects a string cidr.
	builderWantField(t, req, "cidr", float64(16))
	builderWantField(t, req, "space", "sp1")
	builderWantField(t, req, "comment", "core")
	builderWantField(t, req, "tags", map[string]any{"Env": "prod"})

	block := asMap(res["block"])
	if block == nil || block["id"] != "ipam/address_block/b1" {
		t.Fatalf("block = %#v, want the upstream result object", res["block"])
	}
}

// TestBlockCreate_MissingTagsBecomeAnEmptyObject pins tagsOf's nil-safety: the
// key is always present, never null (a null tags body is rejected by CSP).
func TestBlockCreate_MissingTagsBecomeAnEmptyObject(t *testing.T) {
	f := builderFakeServer(t, func(builderReq) (int, string) {
		return 200, `{"result":{"id":"ipam/address_block/b1"}}`
	})
	_, status := f.client().BlockCreate(M{"address": "10.0.0.0", "cidr": float64(16), "space": "sp1", "dry": false})
	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	req := f.wantOneCall(t)
	builderWantField(t, req, "tags", map[string]any{})
	builderWantField(t, req, "comment", "")
}

func TestBlockCreate_ValidationRefusedBeforeWire(t *testing.T) {
	cases := []struct {
		name string
		body M
		want string
	}{
		{"no address", M{"cidr": float64(16), "space": "sp1", "dry": false}, "address is required"},
		{"no cidr", M{"address": "10.0.0.0", "space": "sp1", "dry": false}, "cidr is required"},
		{"bad cidr", M{"address": "10.0.0.0", "cidr": "sixteen", "space": "sp1", "dry": false}, "cidr must be an integer"},
		{"no space", M{"address": "10.0.0.0", "cidr": float64(16), "dry": false}, "space is required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := builderRefuseAll(t)
			res, status := f.client().BlockCreate(tc.body)
			if status != 400 || res["error"] != tc.want {
				t.Fatalf("= (%v, %d), want 400 %q", res, status, tc.want)
			}
			f.wantNoCalls(t, "validation must refuse before any tenant write")
		})
	}
}

func TestBlockCreate_UpstreamFailureIsNotSuccess(t *testing.T) {
	f := builderFakeServer(t, func(builderReq) (int, string) {
		return 409, `{"error":"already exists"}`
	})
	res, status := f.client().BlockCreate(M{"address": "10.0.0.0", "cidr": float64(16), "space": "sp1", "dry": false})
	if res["ok"] != false || status != 409 {
		t.Fatalf("= (%v, %d), want ok:false 409", res, status)
	}
}

// --- dhcp_range: RangeCreate -------------------------------------------------

func TestRangeCreate_SendsStartEndSpaceUpstream(t *testing.T) {
	f := builderFakeServer(t, func(r builderReq) (int, string) {
		if r.Method == http.MethodPost && r.Path == "/api/ddi/v1/ipam/range" {
			return 201, `{"result":{"id":"ipam/range/r1"}}`
		}
		return 500, `{"error":"unrouted request"}`
	})

	res, status := f.client().RangeCreate(M{
		"start": "10.0.0.10", "end": "10.0.0.20", "space": "sp1",
		"comment": "dhcp pool", "tags": M{"Env": "prod"}, "dry": false,
	})
	if status != 201 || res["ok"] != true {
		t.Fatalf("RangeCreate = (%v, %d), want ok:true 201", res, status)
	}
	req := f.wantOneCall(t)
	builderWantMethodPath(t, req, http.MethodPost, "/api/ddi/v1/ipam/range")
	builderWantField(t, req, "start", "10.0.0.10")
	builderWantField(t, req, "end", "10.0.0.20")
	builderWantField(t, req, "space", "sp1")
	builderWantField(t, req, "comment", "dhcp pool")
	builderWantField(t, req, "tags", map[string]any{"Env": "prod"})

	rng := asMap(res["range"])
	if rng == nil || rng["id"] != "ipam/range/r1" {
		t.Fatalf("range = %#v, want the upstream result object", res["range"])
	}
}

func TestRangeCreate_ValidationRefusedBeforeWire(t *testing.T) {
	cases := []struct {
		name string
		body M
		want string
	}{
		{"no start", M{"end": "10.0.0.20", "space": "sp1", "dry": false}, "start is required"},
		{"no end", M{"start": "10.0.0.10", "space": "sp1", "dry": false}, "end is required"},
		{"no space", M{"start": "10.0.0.10", "end": "10.0.0.20", "dry": false}, "space is required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := builderRefuseAll(t)
			res, status := f.client().RangeCreate(tc.body)
			if status != 400 || res["error"] != tc.want {
				t.Fatalf("= (%v, %d), want 400 %q", res, status, tc.want)
			}
			f.wantNoCalls(t, "validation must refuse before any tenant write")
		})
	}
}

func TestRangeCreate_UpstreamFailureIsNotSuccess(t *testing.T) {
	f := builderFakeServer(t, func(builderReq) (int, string) {
		return 400, `{"error":"range overlaps"}`
	})
	res, status := f.client().RangeCreate(M{"start": "10.0.0.10", "end": "10.0.0.20", "space": "sp1", "dry": false})
	if res["ok"] != false || status != 400 {
		t.Fatalf("= (%v, %d), want ok:false 400", res, status)
	}
}

// --- host: HostCreate --------------------------------------------------------

func TestHostCreate_SendsAddressesAndAutoGenerateUpstream(t *testing.T) {
	f := builderFakeServer(t, func(r builderReq) (int, string) {
		if r.Method == http.MethodPost && r.Path == "/api/ddi/v1/ipam/host" {
			return 201, `{"result":{"id":"ipam/host/h1"}}`
		}
		return 500, `{"error":"unrouted request"}`
	})

	addresses := []any{M{"address": "10.0.0.5", "space": "sp1"}}
	res, status := f.client().HostCreate(M{
		"name": "host1", "comment": "app server", "addresses": addresses,
		"tags": M{"Env": "prod"}, "host_names": []any{M{"name": "alias1"}}, "dry": false,
	})
	if status != 201 || res["ok"] != true {
		t.Fatalf("HostCreate = (%v, %d), want ok:true 201", res, status)
	}
	req := f.wantOneCall(t)
	builderWantMethodPath(t, req, http.MethodPost, "/api/ddi/v1/ipam/host")
	builderWantField(t, req, "name", "host1")
	builderWantField(t, req, "comment", "app server")
	builderWantField(t, req, "addresses", []any{map[string]any{"address": "10.0.0.5", "space": "sp1"}})
	// Omitted auto_generate_records defaults to TRUE — the builder creates DNS
	// records as a side effect unless the caller opts out.
	builderWantField(t, req, "auto_generate_records", true)
	builderWantField(t, req, "tags", map[string]any{"Env": "prod"})
	builderWantField(t, req, "host_names", []any{map[string]any{"name": "alias1"}})
}

// TestHostCreate_AutoGenerateRecordsOptOutReachesTheWire: passing false must
// actually send false, not fall back to the default.
func TestHostCreate_AutoGenerateRecordsOptOutReachesTheWire(t *testing.T) {
	f := builderFakeServer(t, func(builderReq) (int, string) {
		return 200, `{"result":{"id":"ipam/host/h1"}}`
	})
	_, status := f.client().HostCreate(M{
		"name": "host1", "addresses": []any{M{"address": "10.0.0.5"}},
		"auto_generate_records": false, "dry": false,
	})
	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	req := f.wantOneCall(t)
	builderWantField(t, req, "auto_generate_records", false)
	for _, k := range []string{"tags", "host_names"} {
		if _, present := req.Body[k]; present {
			t.Fatalf("body carries %q = %#v, want the key absent when not supplied", k, req.Body[k])
		}
	}
}

func TestHostCreate_ValidationRefusedBeforeWire(t *testing.T) {
	cases := []struct {
		name string
		body M
		want string
	}{
		{"no name", M{"addresses": []any{M{"address": "10.0.0.5"}}, "dry": false}, "name is required"},
		{"no addresses", M{"name": "host1", "dry": false}, "addresses is required (list of {address, space})"},
		{"empty addresses", M{"name": "host1", "addresses": []any{}, "dry": false}, "addresses is required (list of {address, space})"},
		{"addresses not a list", M{"name": "host1", "addresses": "10.0.0.5", "dry": false}, "addresses is required (list of {address, space})"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := builderRefuseAll(t)
			res, status := f.client().HostCreate(tc.body)
			if status != 400 || res["error"] != tc.want {
				t.Fatalf("= (%v, %d), want 400 %q", res, status, tc.want)
			}
			f.wantNoCalls(t, "validation must refuse before any tenant write")
		})
	}
}

func TestHostCreate_UpstreamFailureIsNotSuccess(t *testing.T) {
	f := builderFakeServer(t, func(builderReq) (int, string) {
		return 422, `{"error":"address already in use"}`
	})
	res, status := f.client().HostCreate(M{"name": "host1", "addresses": []any{M{"address": "10.0.0.5"}}, "dry": false})
	if res["ok"] != false || status != 422 {
		t.Fatalf("= (%v, %d), want ok:false 422", res, status)
	}
}

// --- transport failure (finding A-F2, FIXED) ---------------------------------

// TestBuilders_TransportErrorReturns502 covers the status==0 arm of statusOr:
// no HTTP response at all. The RETURNED code is 502.
//
// FINDING A-F2 (fixed): the human-readable string used to read "create failed
// (status 0)", presenting 0 as though it were an HTTP status the tenant
// returned — a could-not-reach rendered like a rejection. statusPhrase now
// renders it in words, so this assertion pins the exact message instead of the
// old "non-empty is good enough" placeholder.
func TestBuilders_TransportErrorReturns502(t *testing.T) {
	f := builderFakeServer(t, func(builderReq) (int, string) { return 200, `{}` })
	c := f.client()
	f.srv.Close() // nothing is listening now: rest.Write returns status 0

	res, status := c.ZoneCreate(M{"fqdn": "example.com.", "view": "v", "dry": false})
	if status != 502 {
		t.Fatalf("status = %d, want 502 for an unreachable tenant", status)
	}
	if res["ok"] != false {
		t.Fatalf("ok = %v, want false", res["ok"])
	}
	const want = "create failed (could not reach the tenant — no request completed)"
	if pyStr(res["error"]) != want {
		t.Fatalf("error = %q, want %q", res["error"], want)
	}
}

// TestBuilders_TransportErrorNeverRendersStatusZero is the regression guard for
// FINDING A-F2 across EVERY write builder at once, not just the one ZoneCreate
// path above. Two facts must hold for all of them simultaneously:
//
//  1. the message never contains "status 0" — 0 is not an HTTP status, and
//     showing it presents "nothing answered" in the shape of "the tenant
//     answered", the exact confusion this package keeps closing elsewhere;
//  2. the returned code is still 502 — the fix is presentation-only and must
//     not have moved a status code.
//
// Every builder is driven against an already-closed httptest server, so no
// packet leaves loopback and no tenant is involved.
func TestBuilders_TransportErrorNeverRendersStatusZero(t *testing.T) {
	cases := []struct {
		name string
		call func(*Client) (M, int)
		want string
	}{
		{"ZoneCreate", func(c *Client) (M, int) {
			return c.ZoneCreate(M{"fqdn": "example.com.", "view": "v", "dry": false})
		}, "create failed (could not reach the tenant — no request completed)"},
		{"ZoneUpdate", func(c *Client) (M, int) {
			return c.ZoneUpdate(M{"id": "dns/auth_zone/z1", "comment": "c", "dry": false})
		}, "update failed (could not reach the tenant — no request completed)"},
		{"SubnetCreate", func(c *Client) (M, int) {
			return c.SubnetCreate(M{"block_id": "ipam/address_block/b1", "cidr": 24.0, "dry": false})
		}, "create failed (could not reach the tenant — no request completed)"},
		{"SubnetUpdate", func(c *Client) (M, int) {
			return c.SubnetUpdate(M{"id": "ipam/subnet/s1", "name": "n", "dry": false})
		}, "update failed (could not reach the tenant — no request completed)"},
		{"BlockCreate", func(c *Client) (M, int) {
			return c.BlockCreate(M{"address": "10.0.0.0", "cidr": 16.0, "space": "sp", "dry": false})
		}, "create failed (could not reach the tenant — no request completed)"},
		{"RangeCreate", func(c *Client) (M, int) {
			return c.RangeCreate(M{"start": "10.0.0.10", "end": "10.0.0.20", "space": "sp", "dry": false})
		}, "create failed (could not reach the tenant — no request completed)"},
		{"RangeUpdate", func(c *Client) (M, int) {
			return c.RangeUpdate(M{"id": "ipam/range/r1", "comment": "c", "dry": false})
		}, "update failed (could not reach the tenant — no request completed)"},
		{"HostCreate", func(c *Client) (M, int) {
			return c.HostCreate(M{"name": "h", "addresses": []any{M{"address": "10.0.0.5"}}, "dry": false})
		}, "create failed (could not reach the tenant — no request completed)"},
		{"HostUpdate", func(c *Client) (M, int) {
			return c.HostUpdate(M{"id": "ipam/host/h1", "name": "n", "dry": false})
		}, "update failed (could not reach the tenant — no request completed)"},
		{"DNSRecordCreate", func(c *Client) (M, int) {
			return c.DNSRecordCreate(M{"zone_id": "dns/auth_zone/z1", "name_in_zone": "h",
				"type": "A", "value": "10.0.0.5", "dry": false})
		}, "create failed (could not reach the tenant — no request completed)"},
		{"SelfserviceAllocate", func(c *Client) (M, int) {
			return c.SelfserviceAllocate(M{"subnet_id": "ipam/subnet/s1", "dry": false})
		}, "allocation failed (could not reach the tenant — no request completed)"},
		{"Delete", func(c *Client) (M, int) {
			return c.Delete("/api/ddi/v1/ipam/host/h-1")
		}, "delete failed (could not reach the tenant — no request completed)"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := builderFakeServer(t, func(builderReq) (int, string) {
				t.Errorf("%s reached a closed fake", tc.name)
				return 200, `{}`
			})
			c := f.client()
			f.srv.Close() // nothing is listening: rest.Write reports status 0

			res, status := tc.call(c)

			if status != 502 {
				t.Errorf("status = %d, want 502 for an unreachable tenant", status)
			}
			if res["ok"] != false {
				t.Errorf("ok = %v, want false", res["ok"])
			}
			msg := pyStr(res["error"])
			if strings.Contains(msg, "status 0") {
				t.Errorf("error renders a fake HTTP status: %q", msg)
			}
			if msg != tc.want {
				t.Errorf("error = %q, want %q", msg, tc.want)
			}
		})
	}
}
