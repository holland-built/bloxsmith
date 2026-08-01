package edit

// Lane A1 — DNSRecordCreate plus the Rdata/fields arms it depends on.
//
// WHY a recording fake. Every pre-existing fake in this package answers a
// request and forgets it, so "the builder sent the right thing upstream" was
// unprovable: a test could only see the map the builder handed back, which is
// local bookkeeping. DNSRecordCreate writes DNS records into a live customer
// tenant, so the interesting assertions are all on the wire — the apex rewrite,
// the coerced ttl, the rdata shape — and none of them show up in the returned
// map. recordsServer therefore captures method + path + query + decoded JSON
// body for every request and the tests assert on THAT.
//
// Scope, honestly stated: these tests exercise DNSRecordCreate, Rdata and
// fields only. They never contact a real tenant (httptest only) and they do not
// claim parity with server.py, which is not present in this repo — every
// "matches Python" note below is inherited from the package doc comments and is
// ASSUMED, not verified.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"sync"
	"testing"
)

// --- recording fake -----------------------------------------------------------

// recordsCall is one captured outbound request.
type recordsCall struct {
	Method string
	Path   string
	Query  url.Values
	Body   M // decoded JSON object body, nil if there was no body / it wasn't an object
}

// recordsFake is an httptest server that records every request it receives and
// answers POSTs to /api/ddi/v1/dns/record with a caller-chosen status + body.
type recordsFake struct {
	t     *testing.T
	srv   *httptest.Server
	mu    sync.Mutex
	calls []recordsCall
}

// recordsServer starts the fake. status/resp are what the record-create POST is
// answered with; resp==nil sends an empty body (which is itself a case under
// test — rest.Write yields a nil payload for it).
func recordsServer(t *testing.T, status int, resp any) *recordsFake {
	t.Helper()
	f := &recordsFake{t: t}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		// Branch on the METHOD first, then the path: a path-keyed handler feeds
		// the wrong fixture the moment a second route shows up.
		switch r.Method {
		case http.MethodPost:
			if r.URL.Path != "/api/ddi/v1/dns/record" {
				t.Errorf("POST to unexpected path %q", r.URL.Path)
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			if resp != nil {
				_ = json.NewEncoder(w).Encode(resp)
			}
		default:
			// DNSRecordCreate must never issue anything but the one POST.
			t.Errorf("unexpected %s %s — the create path should only POST", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *recordsFake) record(r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	c := recordsCall{Method: r.Method, Path: r.URL.Path, Query: r.URL.Query()}
	if len(raw) > 0 {
		var parsed any
		if err := json.Unmarshal(raw, &parsed); err == nil {
			if m, ok := parsed.(map[string]any); ok {
				c.Body = M(m)
			}
		}
	}
	f.mu.Lock()
	f.calls = append(f.calls, c)
	f.mu.Unlock()
}

func (f *recordsFake) Calls() []recordsCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recordsCall{}, f.calls...)
}

// recordsOnlyCall asserts exactly one request was made and returns it.
func recordsOnlyCall(t *testing.T, f *recordsFake) recordsCall {
	t.Helper()
	calls := f.Calls()
	if len(calls) != 1 {
		t.Fatalf("want exactly 1 upstream call, got %d: %+v", len(calls), calls)
	}
	return calls[0]
}

// recordsNoCalls asserts nothing at all reached the tenant.
func recordsNoCalls(t *testing.T, f *recordsFake) {
	t.Helper()
	if calls := f.Calls(); len(calls) != 0 {
		t.Fatalf("want zero upstream calls, got %d: %+v", len(calls), calls)
	}
}

// --- DNSRecordCreate: what actually goes on the wire ---------------------------

func TestDNSRecordCreate_SendsTheDeclaredRecordUpstream(t *testing.T) {
	f := recordsServer(t, 201, M{"result": M{"id": "dns/record/new1"}})
	c := newTestClient(f.srv)

	res, status := c.DNSRecordCreate(M{
		"zone_id":      "dns/auth_zone/z1",
		"name_in_zone": "  host1  ",
		"type":         "a", // lower-case on the way in, upper-case on the wire
		"value":        "10.0.0.5",
		"ttl":          "300", // string form must coerce to a JSON number
		"comment":      "prod host",
		"dry":          false,
	})

	if status != 201 || !resultOK(res) {
		t.Fatalf("want ok/201, got ok=%v status=%d res=%+v", res["ok"], status, res)
	}
	call := recordsOnlyCall(t, f)
	if call.Method != http.MethodPost || call.Path != "/api/ddi/v1/dns/record" {
		t.Fatalf("want POST /api/ddi/v1/dns/record, got %s %s", call.Method, call.Path)
	}
	want := M{
		"name_in_zone": "host1",
		"zone":         "dns/auth_zone/z1",
		"type":         "A",
		"rdata":        map[string]any{"address": "10.0.0.5"},
		"ttl":          float64(300),
		"comment":      "prod host",
	}
	if !reflect.DeepEqual(map[string]any(call.Body), map[string]any(want)) {
		t.Fatalf("wrong body on the wire:\n got %#v\nwant %#v", call.Body, want)
	}
	// The response is unwrapped through resultOrSelf, not echoed whole.
	rec, _ := res["record"].(map[string]any)
	if rec == nil || rec["id"] != "dns/record/new1" {
		t.Fatalf("want the created record echoed back, got %#v", res["record"])
	}
}

func TestDNSRecordCreate_ApexRewritesToEmptyNameOnTheWire(t *testing.T) {
	// "@" is how a caller names the zone apex; CSP wants an EMPTY
	// name_in_zone for it. Without the rewrite the tenant grows a literal
	// record named "@" — a real, wrong record, not an error.
	// Mutation: delete edit.go:317-319 -> the body carries "@".
	for _, in := range []string{"@", "  @  "} {
		f := recordsServer(t, 201, M{"result": M{"id": "x"}})
		c := newTestClient(f.srv)

		if _, status := c.DNSRecordCreate(M{
			"zone_id": "dns/auth_zone/z1", "name_in_zone": in,
			"type": "A", "value": "10.0.0.5", "dry": false,
		}); status != 201 {
			t.Fatalf("in=%q: want 201, got %d", in, status)
		}
		call := recordsOnlyCall(t, f)
		got, present := call.Body["name_in_zone"]
		if !present {
			t.Fatalf("in=%q: name_in_zone missing from the body entirely: %#v", in, call.Body)
		}
		if got != "" {
			t.Fatalf("in=%q: apex must be sent as empty name_in_zone, got %q", in, got)
		}
	}
}

func TestDNSRecordCreate_OmittedDryIsRefusedNotALiveWrite(t *testing.T) {
	// WAS TestDNSRecordCreate_DryDefaultsLiveAndWrites, which pinned the
	// inherited trap: an omitted `dry` created a REAL DNS record because this
	// builder read the flag with boolPy (default false/live) while every other
	// write builder used truthyDry (default preview). Decision D1 / Option B
	// closed that: an omitted flag is now refused with a 400 and nothing
	// reaches the tenant.
	//
	// The refusal, not a flip to preview, is the point: a caller who was
	// relying on omitted-dry-meaning-live finds out loudly instead of having
	// their write silently swallowed as a preview.
	//
	// Mutation: restore `dry := boolPy(body["dry"])` in DNSRecordCreate ->
	// this returns 201 and the fake records a live POST -> RED on both
	// assertions.
	f := recordsServer(t, 201, M{"result": M{"id": "x"}})
	c := newTestClient(f.srv)

	res, status := c.DNSRecordCreate(M{
		"zone_id": "dns/auth_zone/z1", "name_in_zone": "host1",
		"type": "A", "value": "10.0.0.5",
		// no "dry" key at all
	})

	if status != 400 || resultOK(res) {
		t.Fatalf("omitted dry must be refused, got status=%d res=%+v", status, res)
	}
	if res["error"] != "dry must be true or false" {
		t.Fatalf("error = %q, want %q", res["error"], "dry must be true or false")
	}
	if _, isPreview := res["dry_run"]; isPreview {
		t.Fatalf("a refusal must not masquerade as a preview: %+v", res)
	}
	recordsNoCalls(t, f) // the tenant was never touched
}

func TestDNSRecordCreate_DryTrueSendsNothing(t *testing.T) {
	// Mutation: edit.go:338 `if dry` -> `if false` -> the fake sees a POST.
	f := recordsServer(t, 201, M{"result": M{"id": "x"}})
	c := newTestClient(f.srv)

	res, status := c.DNSRecordCreate(M{
		"zone_id": "dns/auth_zone/z1", "name_in_zone": "@",
		"type": "MX", "value": "10 mail.example.com.", "ttl": float64(60),
		"comment": "preview", "dry": true,
	})

	if status != 200 || !resultOK(res) || res["dry_run"] != true {
		t.Fatalf("want a 200 preview, got status=%d res=%+v", status, res)
	}
	recordsNoCalls(t, f)
	// The preview must be the exact body the live run would send, or the
	// preview is not a preview of anything.
	want := M{
		"name_in_zone": "",
		"zone":         "dns/auth_zone/z1",
		"type":         "MX",
		"rdata":        M{"preference": 10, "exchange": "mail.example.com."},
		"ttl":          60,
		"comment":      "preview",
	}
	if !reflect.DeepEqual(res["record"], want) {
		t.Fatalf("preview body:\n got %#v\nwant %#v", res["record"], want)
	}
}

func TestDNSRecordCreate_DryMustBeExplicitBoolean(t *testing.T) {
	// WAS TestDNSRecordCreate_DryStringFalseIsStillAPreview, which pinned the
	// other half of the same trap: under boolPy the STRING "false" (and "0",
	// and "no") previewed while the NUMBER 0 and the bool false wrote LIVE —
	// two spellings of one operator intent ("do it for real"), opposite
	// outcomes. Decision D1 / Option B refuses every ambiguous spelling instead
	// of picking a winner: only a JSON true or false is accepted.
	//
	// Every refusal asserts ZERO upstream calls. A 400 returned after the POST
	// already went out would still have created the record — the failure mode
	// this test exists for.
	//
	// Mutation: restore `dry := boolPy(body["dry"])` in DNSRecordCreate ->
	// the string cases return 200 dry_run:true and the numeric/null cases send
	// a live POST -> RED.
	for _, dry := range []any{
		"false", "0", "no", "true", "True", "", "  ", // strings, incl. the ones that used to preview
		float64(0), float64(1), // numbers, incl. the one that used to write live
		nil,          // explicit JSON null
		[]any{}, M{}, // collections, which boolPy also had an opinion about
	} {
		f := recordsServer(t, 201, M{"result": M{"id": "x"}})
		c := newTestClient(f.srv)
		res, status := c.DNSRecordCreate(M{
			"zone_id": "dns/auth_zone/z1", "name_in_zone": "host1",
			"type": "A", "value": "10.0.0.5", "dry": dry,
		})
		if status != 400 || resultOK(res) {
			t.Fatalf("dry=%#v: want a 400 refusal, got status=%d res=%+v", dry, status, res)
		}
		if res["error"] != "dry must be true or false" {
			t.Fatalf("dry=%#v: error = %q, want %q", dry, res["error"], "dry must be true or false")
		}
		if _, isPreview := res["dry_run"]; isPreview {
			t.Fatalf("dry=%#v: a refusal must not masquerade as a preview: %+v", dry, res)
		}
		recordsNoCalls(t, f)
	}

	// The two accepted spellings still behave exactly as before.
	f := recordsServer(t, 201, M{"result": M{"id": "x"}})
	c := newTestClient(f.srv)
	res, status := c.DNSRecordCreate(M{
		"zone_id": "dns/auth_zone/z1", "name_in_zone": "host1",
		"type": "A", "value": "10.0.0.5", "dry": true,
	})
	if status != 200 || res["dry_run"] != true {
		t.Fatalf("dry:true must preview, got status=%d res=%+v", status, res)
	}
	recordsNoCalls(t, f)

	f2 := recordsServer(t, 201, M{"result": M{"id": "x"}})
	c2 := newTestClient(f2.srv)
	res2, status2 := c2.DNSRecordCreate(M{
		"zone_id": "dns/auth_zone/z1", "name_in_zone": "host1",
		"type": "A", "value": "10.0.0.5", "dry": false,
	})
	if status2 != 201 || !resultOK(res2) || res2["dry_run"] != nil {
		t.Fatalf("dry:false must write live, got status=%d res=%+v", status2, res2)
	}
	recordsOnlyCall(t, f2) // exactly one POST
}

// updateFake is a recording fake for DNSRecordUpdate: it answers the
// pre-update GET with a fixed record and the PATCH with the same, and counts
// EVERY request — GET included. Counting only writes would let a refusal that
// happens after the read still pass, and the pre-update read is itself an
// upstream call this builder must not make on a refused request.
type updateFake struct {
	srv   *httptest.Server
	mu    sync.Mutex
	calls []recordsCall
}

func updateServer(t *testing.T) *updateFake {
	t.Helper()
	f := &updateFake{}
	current := map[string]any{
		"id": "dns/record/abc123", "type": "A", "dns_rdata": "10.0.0.1",
		"ttl": float64(28800), "comment": "prod host", "name_in_zone": "host1",
	}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		c := recordsCall{Method: r.Method, Path: r.URL.Path, Query: r.URL.Query()}
		if len(raw) > 0 {
			var parsed any
			if err := json.Unmarshal(raw, &parsed); err == nil {
				if m, ok := parsed.(map[string]any); ok {
					c.Body = M(m)
				}
			}
		}
		f.mu.Lock()
		f.calls = append(f.calls, c)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"result": current})
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *updateFake) Calls() []recordsCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recordsCall{}, f.calls...)
}

func TestDNSRecordUpdate_DryMustBeExplicitBoolean(t *testing.T) {
	// The Update twin of TestDNSRecordCreate_DryMustBeExplicitBoolean, and the
	// sharper of the two: DNSRecordUpdate used to read `dry` with boolPy as
	// well, so an omitted flag PATCHed a live customer record. Decision D1 /
	// Option B refuses anything that is not a JSON true/false.
	//
	// Zero upstream calls means zero — not even the pre-update GET, which is
	// why this fake counts reads too.
	//
	// Mutation: restore `dry := boolPy(body["dry"])` in DNSRecordUpdate ->
	// the omitted/numeric cases issue a GET plus a live PATCH and the string
	// cases issue a GET -> RED.
	for _, dry := range []any{"false", "0", "no", "true", "", float64(0), float64(1), nil, M{}} {
		f := updateServer(t)
		c := newTestClient(f.srv)
		body := M{"id": "abc123", "value": "10.0.0.9"}
		body["dry"] = dry
		res, status := c.DNSRecordUpdate(body)
		if status != 400 || resultOK(res) {
			t.Fatalf("dry=%#v: want a 400 refusal, got status=%d res=%+v", dry, status, res)
		}
		if res["error"] != "dry must be true or false" {
			t.Fatalf("dry=%#v: error = %q, want %q", dry, res["error"], "dry must be true or false")
		}
		if calls := f.Calls(); len(calls) != 0 {
			t.Fatalf("dry=%#v: want zero upstream calls, got %d: %+v", dry, len(calls), calls)
		}
	}

	// Omitted entirely — the case that used to PATCH the live record.
	f := updateServer(t)
	c := newTestClient(f.srv)
	res, status := c.DNSRecordUpdate(M{"id": "abc123", "value": "10.0.0.9"})
	if status != 400 || res["error"] != "dry must be true or false" {
		t.Fatalf("omitted dry: want a 400 refusal, got status=%d res=%+v", status, res)
	}
	if calls := f.Calls(); len(calls) != 0 {
		t.Fatalf("omitted dry: want zero upstream calls, got %d: %+v", len(calls), calls)
	}

	// dry:true reads the current record (needed to build the preview) but
	// never writes.
	f2 := updateServer(t)
	c2 := newTestClient(f2.srv)
	res2, status2 := c2.DNSRecordUpdate(M{"id": "abc123", "value": "10.0.0.9", "dry": true})
	if status2 != 200 || !resultOK(res2) {
		t.Fatalf("dry:true: want a 200 preview, got status=%d res=%+v", status2, res2)
	}
	for _, call := range f2.Calls() {
		if call.Method != http.MethodGet {
			t.Fatalf("dry:true must not write, got %s %s", call.Method, call.Path)
		}
	}

	// dry:false still writes exactly once.
	f3 := updateServer(t)
	c3 := newTestClient(f3.srv)
	res3, status3 := c3.DNSRecordUpdate(M{"id": "abc123", "value": "10.0.0.9", "dry": false})
	if status3 != 200 || !resultOK(res3) {
		t.Fatalf("dry:false: want a 200 live update, got status=%d res=%+v", status3, res3)
	}
	writes := 0
	for _, call := range f3.Calls() {
		if call.Method != http.MethodGet {
			writes++
		}
	}
	if writes != 1 {
		t.Fatalf("dry:false: want exactly 1 upstream write, got %d: %+v", writes, f3.Calls())
	}
}

func TestDNSRecordCreate_BadTTLRefusedBeforeTheWire(t *testing.T) {
	// A ttl the builder cannot coerce must never reach the tenant: CSP would
	// either 400 (noise) or, worse, accept a coerced value nobody asked for.
	// Mutation: edit.go:329 `if !ok` -> `if false` -> the bad ttl is POSTed.
	for _, bad := range []any{"abc", "5m", []any{1}, M{"a": 1}, nil} {
		f := recordsServer(t, 201, M{"result": M{"id": "x"}})
		c := newTestClient(f.srv)
		body := M{
			"zone_id": "dns/auth_zone/z1", "name_in_zone": "host1",
			"type": "A", "value": "10.0.0.5", "dry": false,
		}
		body["ttl"] = bad
		res, status := c.DNSRecordCreate(body)
		if bad == nil {
			// `has` treats an explicit null as absent, so the ttl key is simply
			// omitted — not an error. Distinct case, kept in the same table so
			// the difference is visible.
			if status != 201 {
				t.Fatalf("ttl:null should be treated as absent, got %d %+v", status, res)
			}
			if _, present := recordsOnlyCall(t, f).Body["ttl"]; present {
				t.Fatalf("ttl:null must not put a ttl on the wire")
			}
			continue
		}
		if status != 400 || res["error"] != "ttl must be an integer" {
			t.Fatalf("ttl=%#v: want 400 'ttl must be an integer', got %d %+v", bad, status, res)
		}
		recordsNoCalls(t, f)
	}

	// The forms that DO coerce, and what they become on the wire.
	for _, tc := range []struct {
		in   any
		want float64
	}{{float64(300), 300}, {"300", 300}, {" 300 ", 300}, {float64(3.9), 3}, {true, 1}} {
		f := recordsServer(t, 201, M{"result": M{"id": "x"}})
		c := newTestClient(f.srv)
		if _, status := c.DNSRecordCreate(M{
			"zone_id": "dns/auth_zone/z1", "name_in_zone": "host1",
			"type": "A", "value": "10.0.0.5", "ttl": tc.in, "dry": false,
		}); status != 201 {
			t.Fatalf("ttl=%#v: want 201, got %d", tc.in, status)
		}
		if got := recordsOnlyCall(t, f).Body["ttl"]; got != tc.want {
			t.Fatalf("ttl=%#v: wire value %#v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestDNSRecordCreate_ValidationRefusalsNeverReachTheWire(t *testing.T) {
	// Each refusal is a 400 with a distinct message AND zero upstream calls;
	// the order of the checks is pinned because a caller missing two fields
	// should be told about the first one consistently.
	base := func() M {
		return M{
			"zone_id": "dns/auth_zone/z1", "name_in_zone": "host1",
			"type": "A", "value": "10.0.0.5", "dry": false,
		}
	}
	cases := []struct {
		name  string
		mut   func(M)
		error string
	}{
		{"no type", func(b M) { delete(b, "type") }, "type is required"},
		{"blank type", func(b M) { b["type"] = "   " }, "type is required"},
		{"no zone_id", func(b M) { delete(b, "zone_id") }, "zone_id is required"},
		{"type wins over zone", func(b M) { delete(b, "type"); delete(b, "zone_id") }, "type is required"},
		{"no name_in_zone", func(b M) { delete(b, "name_in_zone") }, `name_in_zone is required (use "@" for the zone apex)`},
		{"null name_in_zone", func(b M) { b["name_in_zone"] = nil }, `name_in_zone is required (use "@" for the zone apex)`},
		{"blank name_in_zone", func(b M) { b["name_in_zone"] = "  " }, `name_in_zone is required (use "@" for the zone apex)`},
		{"no value", func(b M) { delete(b, "value") }, "value is required for A records"},
		{"blank value", func(b M) { b["value"] = "" }, "value is required for A records"},
		{"malformed rdata", func(b M) { b["type"] = "MX"; b["value"] = "ten mail.example.com." },
			"MX preference must be an integer, got: 'ten'"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := recordsServer(t, 201, M{"result": M{"id": "x"}})
			c := newTestClient(f.srv)
			b := base()
			tc.mut(b)
			res, status := c.DNSRecordCreate(b)
			if status != 400 {
				t.Fatalf("want 400, got %d (%+v)", status, res)
			}
			if resultOK(res) {
				t.Fatalf("a refusal must not report ok:true: %+v", res)
			}
			if res["error"] != tc.error {
				t.Fatalf("error = %q, want %q", res["error"], tc.error)
			}
			recordsNoCalls(t, f)
		})
	}
}

func TestDNSRecordCreate_UpstreamFailureSurfaces(t *testing.T) {
	// Mutation: edit.go:343 condition -> `if false` -> a 500 create reports
	// ok:true, i.e. the caller believes a record exists that does not.
	t.Run("500 with a detail body", func(t *testing.T) {
		f := recordsServer(t, 500, M{"error": "boom"})
		c := newTestClient(f.srv)
		res, status := c.DNSRecordCreate(M{
			"zone_id": "dns/auth_zone/z1", "name_in_zone": "host1",
			"type": "A", "value": "10.0.0.5", "dry": false,
		})
		if status != 500 || resultOK(res) {
			t.Fatalf("want ok:false/500, got %d %+v", status, res)
		}
		if res["error"] != "create failed (status 500)" {
			t.Fatalf("error = %q", res["error"])
		}
		// The upstream body is preserved rather than swallowed — without it
		// the operator cannot tell a quota rejection from an outage.
		detail, _ := res["detail"].(map[string]any)
		if detail == nil || detail["error"] != "boom" {
			t.Fatalf("upstream detail dropped: %#v", res["detail"])
		}
		recordsOnlyCall(t, f)
	})

	t.Run("200 with an empty body is not a success", func(t *testing.T) {
		// resp==nil means nothing came back to confirm the create. Reporting
		// ok:true here would claim a record exists on no evidence.
		f := recordsServer(t, 200, nil)
		c := newTestClient(f.srv)
		res, status := c.DNSRecordCreate(M{
			"zone_id": "dns/auth_zone/z1", "name_in_zone": "host1",
			"type": "A", "value": "10.0.0.5", "dry": false,
		})
		if status != 200 || resultOK(res) {
			t.Fatalf("want ok:false, got %d %+v", status, res)
		}
	})

	t.Run("transport error maps to 502", func(t *testing.T) {
		// FINDING A-F2, now FIXED: status 0 means "no HTTP response happened
		// at all" (could-not-reach). The returned code was always correctly
		// 502; the human string used to render `status 0` as if 0 were an HTTP
		// code the tenant sent. statusPhrase now spells the real fact out.
		f := recordsServer(t, 201, M{"result": M{"id": "x"}})
		c := newTestClient(f.srv)
		f.srv.Close() // nothing is listening now
		res, status := c.DNSRecordCreate(M{
			"zone_id": "dns/auth_zone/z1", "name_in_zone": "host1",
			"type": "A", "value": "10.0.0.5", "dry": false,
		})
		if status != 502 || resultOK(res) {
			t.Fatalf("want ok:false/502, got %d %+v", status, res)
		}
		const want = "create failed (could not reach the tenant — no request completed)"
		if pyStr(res["error"]) != want {
			t.Fatalf("error = %q, want %q", res["error"], want)
		}
	})
}

func TestDNSRecordCreate_MXRdataReachesTheWireAsNumbers(t *testing.T) {
	// The MX arm is the one that builds a non-string field; a regression that
	// stringified the preference would be invisible in the returned map.
	f := recordsServer(t, 200, M{"id": "dns/record/mx1"})
	c := newTestClient(f.srv)

	res, status := c.DNSRecordCreate(M{
		"zone_id": "dns/auth_zone/z1", "name_in_zone": "@",
		"type": "mx", "value": "  10   mail.example.com.  ", "dry": false,
	})
	if status != 200 || !resultOK(res) {
		t.Fatalf("want ok/200, got %d %+v", status, res)
	}
	rdata, _ := recordsOnlyCall(t, f).Body["rdata"].(map[string]any)
	want := map[string]any{"preference": float64(10), "exchange": "mail.example.com."}
	if !reflect.DeepEqual(rdata, want) {
		t.Fatalf("rdata on the wire:\n got %#v\nwant %#v", rdata, want)
	}
	// No "result" key upstream: resultOrSelf falls back to the whole body.
	rec, _ := res["record"].(map[string]any)
	if rec == nil || rec["id"] != "dns/record/mx1" {
		t.Fatalf("resultOrSelf fallback lost the body: %#v", res["record"])
	}
}

// --- Rdata arms that had never executed ---------------------------------------

func TestRdata_MXNeedsIntPreference(t *testing.T) {
	// Mutation: edit.go:246 `err != nil` -> `false` -> a non-integer
	// preference is accepted and pref silently becomes 0 (Atoi's zero value),
	// i.e. the highest-priority mail exchanger, chosen by accident.
	if _, err := Rdata("MX", "ten mail.example.com."); err == nil {
		t.Fatalf("non-integer MX preference must be refused")
	} else if err.Error() != "MX preference must be an integer, got: 'ten'" {
		t.Fatalf("message = %q", err.Error())
	}
	got, err := Rdata("MX", "10 mail.example.com.")
	if err != nil {
		t.Fatalf("valid MX refused: %v", err)
	}
	if !reflect.DeepEqual(got, M{"preference": 10, "exchange": "mail.example.com."}) {
		t.Fatalf("MX rdata = %#v", got)
	}
}

func TestRdata_UntestedArmsBuildTheAPIShapes(t *testing.T) {
	cases := []struct {
		rtype, value string
		want         M
	}{
		{"MX", "10 mail.example.com.", M{"preference": 10, "exchange": "mail.example.com."}},
		{"SRV", "10 0 443 host.example.com.", M{"priority": 10, "weight": 0, "port": 443, "target": "host.example.com."}},
		{"CAA", "0 issue letsencrypt.org", M{"flags": 0, "tag": "issue", "value": "letsencrypt.org"}},
		{"TXT", `"v=spf1 -all"`, M{"text": "v=spf1 -all"}}, // quotes stripped
		{"TXT", "v=spf1 -all", M{"text": "v=spf1 -all"}},   // already bare
		{"TXT", `""`, M{"text": ""}},                     // an empty TXT is legal
		{"TXT", `"unbalanced`, M{"text": `"unbalanced`}}, // only a matched pair is stripped
		{"txt", `"lower"`, M{"text": "lower"}},           // type is upper-cased first
		// Anything the switch does not know falls through to the raw
		// presentation-format escape hatch rather than being refused.
		{"NAPTR", `100 10 "u" "E2U+sip" "!^.*$!sip:x@y!" .`,
			M{"subfields": []any{M{"type": "PRESENTATION", "value": `100 10 "u" "E2U+sip" "!^.*$!sip:x@y!" .`}}}},
		{"SPF", "v=spf1 -all", M{"subfields": []any{M{"type": "PRESENTATION", "value": "v=spf1 -all"}}}},
	}
	for _, tc := range cases {
		got, err := Rdata(tc.rtype, tc.value)
		if err != nil {
			t.Fatalf("%s %q: unexpected error %v", tc.rtype, tc.value, err)
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%s %q:\n got %#v\nwant %#v", tc.rtype, tc.value, got, tc.want)
		}
	}
}

func TestRdata_MalformedArmsRefused(t *testing.T) {
	// Every one of these would otherwise reach a customer tenant as a
	// half-built record.
	cases := []struct {
		rtype, value string
		wantErr      string
	}{
		{"A", "  ", "rdata is required for A records"},
		{"MX", "10", `MX rdata must be "preference exchange" (e.g. "10 mail.example.com."), got: '10'`},
		{"SRV", "10 0 443", `SRV rdata must be "priority weight port target" (e.g. "10 0 443 host.example.com."), got: '10 0 443'`},
		{"SRV", "a 0 443 host.", "SRV rdata contains non-integer field"},
		{"SRV", "10 b 443 host.", "SRV rdata contains non-integer field"},
		{"SRV", "10 0 c host.", "SRV rdata contains non-integer field"},
		{"CAA", "0 issue", `CAA rdata must be "flags tag value" (e.g. "0 issue letsencrypt.org"), got: '0 issue'`},
		{"CAA", "x issue letsencrypt.org", "CAA flags must be an integer, got: 'x'"},
	}
	for _, tc := range cases {
		got, err := Rdata(tc.rtype, tc.value)
		if err == nil {
			t.Fatalf("%s %q: want an error, got %#v", tc.rtype, tc.value, got)
		}
		if err.Error() != tc.wantErr {
			t.Fatalf("%s %q: error = %q, want %q", tc.rtype, tc.value, err.Error(), tc.wantErr)
		}
		if got != nil {
			t.Fatalf("%s %q: a refused arm must return nil rdata, got %#v", tc.rtype, tc.value, got)
		}
	}
}

// --- fields (the maxsplit primitive under MX/SRV/CAA) --------------------------

func TestFields_MaxsplitPreservesTail(t *testing.T) {
	// Mutation: edit.go:283 `all[:max-1]` -> `all[:max]` -> the tail is split
	// one token too far, so an MX exchange (or CAA value) containing a space
	// arrives as an extra field and the arm rejects a legal value.
	cases := []struct {
		in   string
		max  int
		want []string
	}{
		{"10 mail.example.com. extra bits", 2, []string{"10", "mail.example.com. extra bits"}},
		{"0 issue letsencrypt.org; account=1 2", 3, []string{"0", "issue", "letsencrypt.org; account=1 2"}},
		{"10 0 443 host.example.com.", 4, []string{"10", "0", "443", "host.example.com."}},
		// Internal runs of spaces inside the tail survive verbatim; leading
		// and inter-field runs collapse. Trailing whitespace is part of the
		// tail. (Python-parity claim ASSUMED — server.py is not in this repo.)
		{"  0   issue   a  b   ", 3, []string{"0", "issue", "a  b   "}},
		{"a b", 2, []string{"a", "b"}},        // len(all) <= max: returned untouched
		{"a b c", 0, []string{"a", "b", "c"}}, // max <= 0: no split limit
		{"   ", 2, []string{}},
		{"", 2, []string{}},
		{"single", 2, []string{"single"}},
	}
	for _, tc := range cases {
		got := fields(tc.in, tc.max)
		if len(got) != len(tc.want) {
			t.Fatalf("fields(%q, %d) = %#v, want %#v", tc.in, tc.max, got, tc.want)
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Fatalf("fields(%q, %d)[%d] = %q, want %q", tc.in, tc.max, i, got[i], tc.want[i])
			}
		}
	}

	// The same behaviour seen through the arm that depends on it: an MX
	// exchange is the LAST field, so everything after the preference must stay
	// together or a legal-but-odd value is rejected.
	got, err := Rdata("MX", "10 mail.example.com. trailing")
	if err != nil {
		t.Fatalf("MX with a multi-token tail refused: %v", err)
	}
	if !reflect.DeepEqual(got, M{"preference": 10, "exchange": "mail.example.com. trailing"}) {
		t.Fatalf("MX tail: %#v", got)
	}
}
