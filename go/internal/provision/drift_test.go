package provision

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// Tests for drift.go: QuerySiteLive (live read-only snapshot) and DetectDrift
// (pure comparison). Everything upstream is a net/http/httptest fake — these
// tests never touch a real tenant. Helper names are prefixed `drift` to stay
// out of the way of the other test files in this package.

// --- fake upstream ----------------------------------------------------------

// driftRecorder captures every request the engine makes, in order, under a
// mutex (httptest handlers run on the server's goroutines). The order matters:
// the "no subnets found" case must prove the host read never happened at all,
// and only a recorded request list can prove a call was *absent*.
type driftRecorder struct {
	mu   sync.Mutex
	seen []string
}

func (r *driftRecorder) add(entry string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seen = append(r.seen, entry)
}

func (r *driftRecorder) calls() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.seen))
	copy(out, r.seen)
	return out
}

func (r *driftRecorder) sawCall(entry string) bool {
	for _, got := range r.calls() {
		if got == entry {
			return true
		}
	}
	return false
}

// driftRoute is one canned upstream reply. status 0 means 200.
type driftRoute struct {
	status int
	body   string
}

// driftServer serves one canned reply per path and records "METHOD /path" for
// every request. Recording the method too is deliberate: QuerySiteLive is
// documented as read-only, so a write reaching the fake is itself a finding.
// Handler order is method-first, then path.
func driftServer(t *testing.T, rec *driftRecorder, routes map[string]driftRoute) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.add(r.Method + " " + r.URL.Path)
		if r.Method != http.MethodGet {
			// QuerySiteLive must never write. Anything but GET is a failure of
			// the code under test, not a case the fake should service.
			w.WriteHeader(http.StatusMethodNotAllowed)
			w.Write([]byte(`{"error":"QuerySiteLive issued a non-GET request"}`))
			return
		}
		route, ok := routes[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"error":"no fixture for this path"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if route.status != 0 {
			w.WriteHeader(route.status)
		}
		w.Write([]byte(route.body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

const (
	driftPathSpace  = "/api/ddi/v1/ipam/ip_space"
	driftPathView   = "/api/ddi/v1/dns/view"
	driftPathSubnet = "/api/ddi/v1/ipam/subnet"
	driftPathHost   = "/api/ddi/v1/ipam/host"
	driftPathZone   = "/api/ddi/v1/dns/auth_zone"
)

// driftRoutes returns a full happy-path fixture set that individual tests
// override one path at a time, so each test states only what it is varying.
func driftRoutes() map[string]driftRoute {
	return map[string]driftRoute{
		driftPathSpace: {body: `{"results":[{"id":"ipam/ip_space/space-1","name":"test-space"}]}`},
		driftPathView:  {body: `{"results":[{"id":"dns/view/view-1","name":"test-view"}]}`},
		driftPathSubnet: {body: `{"results":[{"id":"ipam/subnet/sub-1","address":"10.10.0.0","cidr":24,
			"name":"data","tags":{"Site":"site-a"}}]}`},
		driftPathHost: {body: `{"results":[
			{"name":"printer.site-a.example.com","addresses":[{"address":"10.10.0.25"}]},
			{"name":"elsewhere.other.example.com","addresses":[{"address":"10.99.0.9"}]}]}`},
		driftPathZone: {body: `{"results":[{"id":"dns/auth_zone/z-1","fqdn":"live.example.com."}]}`},
	}
}

// --- QuerySiteLive ----------------------------------------------------------

// A host belongs to a subnet only by IP containment (drift.go:79). The fixture
// deliberately contains one host inside 10.10.0.0/24 and one outside it, so an
// implementation that correlated by anything looser (or not at all) fails here.
func TestQuerySiteLive_HostsCorrelatedBySubnetContainment(t *testing.T) {
	rec := &driftRecorder{}
	e := newTestEngine(driftServer(t, rec, driftRoutes()))

	out, err := e.QuerySiteLive("site-a", "test-space", "test-view", "site-a.example.com")
	if err != nil {
		t.Fatalf("QuerySiteLive() error = %v, want nil", err)
	}
	if out["found"] != true {
		t.Fatalf("found = %v, want true", out["found"])
	}
	subnets := getList(out, "subnets")
	if len(subnets) != 1 {
		t.Fatalf("subnets len = %d, want 1", len(subnets))
	}
	hosts := getList(asMap(subnets[0]), "hosts")
	var names []string
	for _, h := range hosts {
		names = append(names, pyStr(asMap(h)["name"]))
	}
	want := []string{"printer.site-a.example.com"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("hosts = %v, want %v — only the host inside 10.10.0.0/24 belongs to this subnet", names, want)
	}
}

// A read that succeeded and found nothing must be reported as "found: false"
// WITHOUT the engine going on to fetch hosts it has nowhere to put. The
// recorded call list is the only way to prove that absence.
func TestQuerySiteLive_NoSubnets_FoundFalseAndNoHostRead(t *testing.T) {
	rec := &driftRecorder{}
	routes := driftRoutes()
	routes[driftPathSubnet] = driftRoute{body: `{"results":[]}`}
	e := newTestEngine(driftServer(t, rec, routes))

	out, err := e.QuerySiteLive("site-a", "test-space", "test-view", "site-a.example.com")
	if err != nil {
		t.Fatalf("QuerySiteLive() error = %v, want nil — an empty subnet list is a successful read", err)
	}
	if out["found"] != false {
		t.Fatalf("found = %v, want false", out["found"])
	}
	if len(getList(out, "subnets")) != 0 {
		t.Fatalf("subnets = %v, want empty", out["subnets"])
	}
	if rec.sawCall("GET " + driftPathHost) {
		t.Fatalf("hosts were fetched despite zero subnets; calls = %v", rec.calls())
	}
	// Sanity: the reads that SHOULD have happened did, so the assertion above
	// is proving a skipped call rather than a server that answered nothing.
	if !rec.sawCall("GET " + driftPathSubnet) {
		t.Fatalf("subnet read never happened; calls = %v", rec.calls())
	}
}

// The single most important test in this file: a FAILED subnet read must
// surface as an error. It must never be laundered into "found: false", which
// is the wire-identical shape of a site that genuinely has no subnets.
func TestQuerySiteLive_SubnetReadFails_IsErrorNotFoundFalse(t *testing.T) {
	rec := &driftRecorder{}
	routes := driftRoutes()
	routes[driftPathSubnet] = driftRoute{status: 500, body: `{"error":"upstream exploded"}`}
	e := newTestEngine(driftServer(t, rec, routes))

	out, err := e.QuerySiteLive("site-a", "test-space", "test-view", "site-a.example.com")
	if err == nil {
		t.Fatalf("QuerySiteLive() error = nil, out = %v — a failed subnet read must never render as found:false", out)
	}
	if out != nil {
		t.Fatalf("out = %v, want nil alongside the error", out)
	}
	if !IsError(err) {
		t.Fatalf("err = %v (%T), want a *provision.Error the HTTP layer can classify", err, err)
	}
	if !strings.Contains(err.Error(), "reading subnets") {
		t.Fatalf("err = %q, want it to name the failed read (\"reading subnets\")", err.Error())
	}
}

// "Read failed" and "read succeeded, found nothing" must not render the same
// way for the IP space lookup either. Both are errors here — the point is that
// an operator can tell a broken tenant from a misspelled space name.
func TestQuerySiteLive_SpaceReadFailedVsNotFound_DistinctMessages(t *testing.T) {
	failRoutes := driftRoutes()
	failRoutes[driftPathSpace] = driftRoute{status: 500, body: `{"error":"upstream exploded"}`}
	_, failErr := newTestEngine(driftServer(t, &driftRecorder{}, failRoutes)).
		QuerySiteLive("site-a", "test-space", "test-view", "site-a.example.com")

	emptyRoutes := driftRoutes()
	emptyRoutes[driftPathSpace] = driftRoute{body: `{"results":[]}`}
	_, emptyErr := newTestEngine(driftServer(t, &driftRecorder{}, emptyRoutes)).
		QuerySiteLive("site-a", "test-space", "test-view", "site-a.example.com")

	if failErr == nil || emptyErr == nil {
		t.Fatalf("failErr = %v, emptyErr = %v — both must be errors", failErr, emptyErr)
	}
	if failErr.Error() == emptyErr.Error() {
		t.Fatalf("a failed space read and a space that does not exist produced the same message %q", failErr.Error())
	}
	if !strings.Contains(failErr.Error(), "reading IP space") {
		t.Fatalf("failErr = %q, want it to name the failed read", failErr.Error())
	}
	if !strings.Contains(emptyErr.Error(), "not found") {
		t.Fatalf("emptyErr = %q, want it to say the space was not found", emptyErr.Error())
	}
}

// Every read in QuerySiteLive is load-bearing: if one fails, the snapshot is
// incomplete and must be refused, not returned with the missing part rendered
// as "absent". The subnet read has its own test above; this covers the rest.
func TestQuerySiteLive_ReadFailuresNeverRenderAsEmpty(t *testing.T) {
	cases := []struct {
		name, path, wantMsg string
	}{
		{name: "dns view", path: driftPathView, wantMsg: "reading DNS view"},
		{name: "auth zone", path: driftPathZone, wantMsg: "reading DNS zone"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			routes := driftRoutes()
			routes[tc.path] = driftRoute{status: 503, body: `{"error":"upstream unavailable"}`}
			out, err := newTestEngine(driftServer(t, &driftRecorder{}, routes)).
				QuerySiteLive("site-a", "test-space", "test-view", "site-a.example.com")
			if err == nil {
				t.Fatalf("error = nil, out = %v — a failed %s read must not be reported as a successful snapshot", out, tc.name)
			}
			if out != nil {
				t.Fatalf("out = %v, want nil alongside the error", out)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Fatalf("err = %q, want it to name the failed read (%q)", err.Error(), tc.wantMsg)
			}
		})
	}
}

// A DNS view that simply does not exist reads differently from one that could
// not be read at all — same distinction the IP space test above makes.
func TestQuerySiteLive_ViewNotFound_IsItsOwnMessage(t *testing.T) {
	routes := driftRoutes()
	routes[driftPathView] = driftRoute{body: `{"results":[]}`}
	_, err := newTestEngine(driftServer(t, &driftRecorder{}, routes)).
		QuerySiteLive("site-a", "test-space", "test-view", "site-a.example.com")
	if err == nil {
		t.Fatal("error = nil, want an error for a DNS view that does not exist")
	}
	if !strings.Contains(err.Error(), "DNS view not found") {
		t.Fatalf("err = %q, want it to say the view was not found", err.Error())
	}
	if strings.Contains(err.Error(), "reading DNS view") {
		t.Fatalf("err = %q — a missing view must not be phrased as a failed read", err.Error())
	}
}

// When the zone lookup succeeds but matches nothing, dns_zone_found is false
// and dns_zone_fqdn falls back to the fqdn that was ASKED for (drift.go:113).
// Scope note: this pins the fallback value only — it does not claim the zone
// exists, which is exactly what dns_zone_found reports separately.
func TestQuerySiteLive_ZoneAbsent_FqdnFallsBackToRequestedZone(t *testing.T) {
	routes := driftRoutes()
	routes[driftPathZone] = driftRoute{body: `{"results":[]}`}
	e := newTestEngine(driftServer(t, &driftRecorder{}, routes))

	out, err := e.QuerySiteLive("site-a", "test-space", "test-view", "site-a.example.com")
	if err != nil {
		t.Fatalf("QuerySiteLive() error = %v, want nil", err)
	}
	if out["dns_zone_found"] != false {
		t.Fatalf("dns_zone_found = %v, want false", out["dns_zone_found"])
	}
	if out["dns_zone_fqdn"] != "site-a.example.com" {
		t.Fatalf("dns_zone_fqdn = %q, want the requested zone name as the fallback", out["dns_zone_fqdn"])
	}
}

// The mirror of the fallback: when the API DOES return a zone, its fqdn wins.
// The fixture's live fqdn differs from the requested one so a hardcoded
// echo-the-request implementation cannot pass both this and the test above.
func TestQuerySiteLive_ZonePresent_FqdnComesFromAPI(t *testing.T) {
	e := newTestEngine(driftServer(t, &driftRecorder{}, driftRoutes()))

	out, err := e.QuerySiteLive("site-a", "test-space", "test-view", "site-a.example.com")
	if err != nil {
		t.Fatalf("QuerySiteLive() error = %v, want nil", err)
	}
	if out["dns_zone_found"] != true {
		t.Fatalf("dns_zone_found = %v, want true", out["dns_zone_found"])
	}
	if out["dns_zone_fqdn"] != "live.example.com." {
		t.Fatalf("dns_zone_fqdn = %q, want the API's fqdn", out["dns_zone_fqdn"])
	}
}

// --- DetectDrift helpers ----------------------------------------------------

type driftEntry struct{ category, severity, field, message string }

func driftEntries(t *testing.T, out M) []driftEntry {
	t.Helper()
	var got []driftEntry
	for _, d := range getList(out, "drifts") {
		m := asMap(d)
		if m == nil {
			t.Fatalf("drift entry %v is not a map", d)
		}
		got = append(got, driftEntry{
			category: pyStr(m["category"]), severity: pyStr(m["severity"]),
			field: pyStr(m["field"]), message: pyStr(m["message"]),
		})
	}
	return got
}

func driftByCategory(entries []driftEntry, category string) []driftEntry {
	var out []driftEntry
	for _, e := range entries {
		if e.category == category {
			out = append(out, e)
		}
	}
	return out
}

func driftSummary(t *testing.T, out M) (total, errs, warns int) {
	t.Helper()
	s := asMap(out["summary"])
	if s == nil {
		t.Fatalf("summary missing from %v", out)
	}
	total, _ = intCoerce(s["total"])
	errs, _ = intCoerce(s["errors"])
	warns, _ = intCoerce(s["warnings"])
	return total, errs, warns
}

// driftCleanTemplate/driftCleanLive are a matched pair that produce ZERO
// drifts. Each table case perturbs exactly one thing, so any drift a test sees
// is attributable to that perturbation.
func driftCleanTemplate() M {
	return M{
		"network": M{"subnets": []any{M{"name": "data"}}},
		"dns":     M{"create_zone": true},
		"tags":    M{"Owner": "net-team"},
		"hosts":   []any{M{"hostname": "printer"}},
	}
}

func driftCleanLive() M {
	return M{
		"site": "site-a", "found": true,
		"subnets": []any{M{
			"name": "data", "tags": M{"Owner": "net-team", "Site": "site-a"},
			"hosts": []any{M{"name": "printer.site-a.example.com"}},
		}},
		"dns_zone_found": true, "dns_zone_fqdn": "site-a.example.com.",
	}
}

// --- DetectDrift ------------------------------------------------------------

// The matched pair really is clean — without this, every "exactly one drift"
// assertion below could be passing for the wrong reason.
func TestDetectDrift_MatchedTemplateAndLive_NoDrift(t *testing.T) {
	out := DetectDrift(driftCleanTemplate(), driftCleanLive(), "site-a")
	if entries := driftEntries(t, out); len(entries) != 0 {
		t.Fatalf("drifts = %+v, want none for a matched pair", entries)
	}
	if out["drifted"] != false {
		t.Fatalf("drifted = %v, want false", out["drifted"])
	}
	if out["found"] != true {
		t.Fatalf("found = %v, want true", out["found"])
	}
	if got, _ := intCoerce(out["subnet_count"]); got != 1 {
		t.Fatalf("subnet_count = %d, want 1", got)
	}
}

// A site with no subnets short-circuits: one `error`-severity drift and no
// further comparison, because comparing tags/hosts against nothing would just
// manufacture noise on top of the one fact that matters.
func TestDetectDrift_NotProvisioned_ShortCircuitsAsError(t *testing.T) {
	live := M{"site": "site-a", "found": false, "subnets": []any{}}
	out := DetectDrift(driftCleanTemplate(), live, "")

	if out["site"] != "site-a" {
		t.Fatalf("site = %v, want the name resolved from live when siteName is empty", out["site"])
	}
	if out["found"] != false {
		t.Fatalf("found = %v, want false", out["found"])
	}
	if out["drifted"] != true {
		t.Fatalf("drifted = %v, want true", out["drifted"])
	}
	entries := driftEntries(t, out)
	want := []driftEntry{{
		category: "site", severity: "error", field: "site",
		message: "Site is not provisioned — no subnets found",
	}}
	if !reflect.DeepEqual(entries, want) {
		t.Fatalf("drifts = %+v, want exactly %+v", entries, want)
	}
	total, errs, warns := driftSummary(t, out)
	if total != 1 || errs != 1 || warns != 0 {
		t.Fatalf("summary total/errors/warnings = %d/%d/%d, want 1/1/0", total, errs, warns)
	}
}

// Direction matters and is asymmetric: a subnet the template expects but the
// API lacks is an `error` (something failed to build); a subnet the API has
// that the template does not is a `warning` (something extra, not broken).
// Two names per direction, so the sorted order is actually observable.
func TestDetectDrift_SubnetMissingIsErrorExtraIsWarning_SortedFields(t *testing.T) {
	template := M{
		"network": M{"subnets": []any{
			M{"name": "voice"}, M{"name": "data"}, M{"name": "shared"}}},
	}
	live := M{"site": "site-a", "found": true, "subnets": []any{
		M{"name": "shared"}, M{"name": "wifi"}, M{"name": "cameras"}}}

	entries := driftByCategory(driftEntries(t, DetectDrift(template, live, "site-a")), "subnet")
	want := []driftEntry{
		{category: "subnet", severity: "error", field: "network.subnets[data]",
			message: "Expected subnet 'data' not found in API"},
		{category: "subnet", severity: "error", field: "network.subnets[voice]",
			message: "Expected subnet 'voice' not found in API"},
		{category: "subnet", severity: "warning", field: "subnet:cameras",
			message: "Subnet 'cameras' exists in API but is not in the template"},
		{category: "subnet", severity: "warning", field: "subnet:wifi",
			message: "Subnet 'wifi' exists in API but is not in the template"},
	}
	if !reflect.DeepEqual(entries, want) {
		t.Fatalf("subnet drifts =\n%+v\nwant\n%+v", entries, want)
	}
}

func TestDetectDrift_Zone(t *testing.T) {
	cases := []struct {
		name           string
		createZone     any
		liveZoneFound  bool
		wantSeverity   string // "" means no dns drift at all
		wantMsgContain string
	}{
		{name: "wanted and present", createZone: true, liveZoneFound: true},
		{name: "wanted but missing", createZone: true, liveZoneFound: false,
			wantSeverity: "error", wantMsgContain: "no DNS zone was found"},
		{name: "present but unwanted", createZone: false, liveZoneFound: true,
			wantSeverity: "warning", wantMsgContain: "exists in API but template does not specify"},
		{name: "not wanted and absent", createZone: false, liveZoneFound: false},
		{name: "create_zone absent behaves as not wanted", createZone: nil, liveZoneFound: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			template := driftCleanTemplate()
			dns := M{}
			if tc.createZone != nil {
				dns["create_zone"] = tc.createZone
			}
			template["dns"] = dns
			live := driftCleanLive()
			live["dns_zone_found"] = tc.liveZoneFound

			out := DetectDrift(template, live, "site-a")
			// Pinned in every subtest, including the no-drift ones: a "no dns
			// drift" assertion alone is satisfied by any function that reports
			// nothing at all, so each case also checks the comparison really ran.
			if got, _ := intCoerce(out["subnet_count"]); got != 1 {
				t.Fatalf("subnet_count = %d, want 1 — the live subnet was not compared", got)
			}
			entries := driftByCategory(driftEntries(t, out), "dns")
			if tc.wantSeverity == "" {
				if len(entries) != 0 {
					t.Fatalf("dns drifts = %+v, want none", entries)
				}
				return
			}
			if len(entries) != 1 {
				t.Fatalf("dns drifts = %+v, want exactly 1", entries)
			}
			if entries[0].severity != tc.wantSeverity {
				t.Fatalf("severity = %q, want %q", entries[0].severity, tc.wantSeverity)
			}
			if entries[0].field != "dns.create_zone" {
				t.Fatalf("field = %q, want dns.create_zone", entries[0].field)
			}
			if !strings.Contains(entries[0].message, tc.wantMsgContain) {
				t.Fatalf("message = %q, want it to contain %q", entries[0].message, tc.wantMsgContain)
			}
		})
	}
}

// A tag that is absent and a tag that holds the wrong value are different
// operational problems and must not render as the same sentence. Both are
// `warning`, so severity alone cannot tell them apart — the message must.
func TestDetectDrift_TagMissingVsMismatch_DistinctMessages(t *testing.T) {
	template := driftCleanTemplate()
	template["tags"] = M{"Owner": "net-team", "Env": "prod"}
	live := driftCleanLive()
	live["subnets"] = []any{M{
		"name": "data", "tags": M{"Env": "dev"},
		"hosts": []any{M{"name": "printer.site-a.example.com"}},
	}}

	entries := driftByCategory(driftEntries(t, DetectDrift(template, live, "site-a")), "tags")
	want := []driftEntry{
		{category: "tags", severity: "warning", field: "subnet:data.tags.Env",
			message: "Tag 'Env' on subnet 'data': expected 'prod', live value is 'dev'"},
		{category: "tags", severity: "warning", field: "subnet:data.tags.Owner",
			message: "Tag 'Owner' missing from subnet 'data' tags (expected 'net-team')"},
	}
	if !reflect.DeepEqual(entries, want) {
		t.Fatalf("tag drifts =\n%+v\nwant\n%+v", entries, want)
	}
	// The missing-tag message must not claim a live value; an absent tag is
	// not the same finding as a tag set to the empty string.
	if strings.Contains(want[1].message, "live value") != strings.Contains(entries[1].message, "live value") {
		t.Fatalf("missing-tag message %q must not report a live value", entries[1].message)
	}
}

// Live hosts arrive as FQDNs; templates name the bare host. Matching is on the
// base name (drift.go:205), so `printer` matches `printer.site-a.example.com`.
// An unexpected live host is `info` — surfaced, but not treated as a fault.
func TestDetectDrift_HostBaseNameMatching_ExtraHostIsInfo(t *testing.T) {
	template := driftCleanTemplate()
	live := driftCleanLive()
	live["subnets"] = []any{M{
		"name": "data", "tags": M{"Owner": "net-team"},
		"hosts": []any{
			M{"name": "printer.site-a.example.com"},
			M{"name": "scanner.site-a.example.com"},
		},
	}}

	entries := driftByCategory(driftEntries(t, DetectDrift(template, live, "site-a")), "hosts")
	want := []driftEntry{{
		category: "hosts", severity: "info", field: "host:scanner",
		message: "Host 'scanner' exists in API but is not in the template",
	}}
	if !reflect.DeepEqual(entries, want) {
		t.Fatalf("host drifts =\n%+v\nwant\n%+v\n(the templated 'printer' must match 'printer.site-a.example.com')", entries, want)
	}
}

// A templated host with no live counterpart anywhere is a `warning`, and two
// of them prove the ordering is sorted rather than map-iteration order.
func TestDetectDrift_ExpectedHostsMissing_AreSortedWarnings(t *testing.T) {
	template := driftCleanTemplate()
	template["hosts"] = []any{M{"hostname": "scanner"}, M{"hostname": "printer"}, M{"hostname": "camera"}}
	live := driftCleanLive() // live has printer only

	entries := driftByCategory(driftEntries(t, DetectDrift(template, live, "site-a")), "hosts")
	want := []driftEntry{
		{category: "hosts", severity: "warning", field: "hosts[camera]",
			message: "Expected host 'camera' not found in any subnet"},
		{category: "hosts", severity: "warning", field: "hosts[scanner]",
			message: "Expected host 'scanner' not found in any subnet"},
	}
	if !reflect.DeepEqual(entries, want) {
		t.Fatalf("host drifts =\n%+v\nwant\n%+v", entries, want)
	}
}

// Summary arithmetic over one of each severity.
//
// KNOWN BEHAVIOUR, pinned deliberately and NOT blessed as correct: DetectDrift
// folds `info` drifts into summary.warnings (drift.go:222-224). So with 1
// error + 1 warning + 1 info the summary reads 3/1/2, not 3/1/1. The count of
// genuine `warning` entries is asserted separately below so this test states
// the real shape instead of hiding the discrepancy behind one number.
func TestDetectDrift_SummaryCounts_InfoFoldedIntoWarnings(t *testing.T) {
	template := M{
		"network": M{"subnets": []any{M{"name": "data"}, M{"name": "voice"}}}, // voice missing -> error
		"dns":     M{"create_zone": false},
		"tags":    M{"Owner": "net-team"}, // live says other-team -> warning
	}
	live := M{"site": "site-a", "found": true, "dns_zone_found": false,
		"subnets": []any{M{
			"name": "data", "tags": M{"Owner": "other-team"},
			"hosts": []any{M{"name": "scanner.site-a.example.com"}}, // extra host -> info
		}}}

	out := DetectDrift(template, live, "site-a")
	entries := driftEntries(t, out)
	counts := map[string]int{}
	for _, e := range entries {
		counts[e.severity]++
	}
	if counts["error"] != 1 || counts["warning"] != 1 || counts["info"] != 1 {
		t.Fatalf("severity counts = %v, want 1 error / 1 warning / 1 info; drifts = %+v", counts, entries)
	}
	total, errs, warns := driftSummary(t, out)
	if total != 3 {
		t.Fatalf("summary.total = %d, want 3", total)
	}
	if errs != 1 {
		t.Fatalf("summary.errors = %d, want 1", errs)
	}
	if warns != 2 {
		t.Fatalf("summary.warnings = %d, want 2 — info is counted here too (drift.go:222-224)", warns)
	}
	if out["drifted"] != true {
		t.Fatalf("drifted = %v, want true", out["drifted"])
	}
}

// siteName wins over live["site"] when supplied; live is only the fallback.
func TestDetectDrift_SiteNameOverridesLive(t *testing.T) {
	out := DetectDrift(driftCleanTemplate(), driftCleanLive(), "explicit-site")
	if out["site"] != "explicit-site" {
		t.Fatalf("site = %v, want explicit-site", out["site"])
	}
}

// --- sortedDiff / stringSet -------------------------------------------------

// sortedDiff is set subtraction (a - b), sorted. Four surviving elements, not
// one: a single-element result cannot detect an unsorted implementation, and
// Go randomises map iteration order.
func TestSortedDiff_ReturnsSortedAMinusB(t *testing.T) {
	a := map[string]bool{"delta": true, "alpha": true, "charlie": true, "bravo": true, "shared": true}
	b := map[string]bool{"shared": true, "onlyInB": true}

	got := sortedDiff(a, b)
	want := []string{"alpha", "bravo", "charlie", "delta"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sortedDiff(a, b) = %v, want %v (sorted, a-minus-b, excluding shared and onlyInB)", got, want)
	}
}

// The reverse direction is a different answer — proving the argument order is
// load-bearing, which is what makes missing-vs-extra classification correct.
func TestSortedDiff_IsDirectional(t *testing.T) {
	a := map[string]bool{"alpha": true, "bravo": true, "shared": true}
	b := map[string]bool{"shared": true, "xray": true, "yankee": true}

	if got, want := sortedDiff(a, b), []string{"alpha", "bravo"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sortedDiff(a, b) = %v, want %v", got, want)
	}
	if got, want := sortedDiff(b, a), []string{"xray", "yankee"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sortedDiff(b, a) = %v, want %v", got, want)
	}
}

func TestSortedDiff_NoDifferenceIsEmpty(t *testing.T) {
	a := map[string]bool{"alpha": true, "bravo": true}
	if got := sortedDiff(a, map[string]bool{"alpha": true, "bravo": true}); len(got) != 0 {
		t.Fatalf("sortedDiff(a, a) = %v, want empty", got)
	}
	if got := sortedDiff(map[string]bool{}, a); len(got) != 0 {
		t.Fatalf("sortedDiff(empty, a) = %v, want empty", got)
	}
}

// stringSet is the constructor every membership set in DetectDrift starts
// from; it must be usable (non-nil) and empty, not a shared instance.
func TestStringSet_ReturnsEmptyIndependentWritableSet(t *testing.T) {
	s := stringSet()
	if s == nil {
		t.Fatal("stringSet() = nil, want a usable map")
	}
	if len(s) != 0 {
		t.Fatalf("stringSet() = %v, want empty", s)
	}
	s["alpha"] = true
	if other := stringSet(); len(other) != 0 {
		t.Fatalf("a second stringSet() = %v, want empty — sets must not be shared", other)
	}
}

// --- tags across EVERY live subnet, in an order upstream does not choose -----
//
// Tags used to be compared against liveSubnets[0] alone while names and hosts
// were compared as sets. A site whose SECOND subnet had lost a tag reported
// "in sync" — a clean bill of health about an estate that had drifted — and
// swapping the two rows flipped the verdict. Nothing orders that list:
// QuerySiteLive keeps whatever CSP returned.
//
// Every case below therefore runs BOTH permutations and requires an identical
// report. Asserting one order proves nothing about a defect whose whole shape
// is order-dependence.

// driftTagsBothOrders runs DetectDrift over rows and over reverse(rows),
// returning the tag entries and failing if the two disagree.
func driftTagsBothOrders(t *testing.T, template M, rows []any) []driftEntry {
	t.Helper()
	live := func(in []any) M {
		return M{"site": "site-a", "found": true, "subnets": in,
			"dns_zone_found": true, "dns_zone_fqdn": "site-a.example.com."}
	}
	rev := make([]any, len(rows))
	for i, r := range rows {
		rev[len(rows)-1-i] = r
	}
	forward := driftByCategory(driftEntries(t, DetectDrift(template, live(rows), "site-a")), "tags")
	backward := driftByCategory(driftEntries(t, DetectDrift(template, live(rev), "site-a")), "tags")
	if !reflect.DeepEqual(forward, backward) {
		t.Fatalf("the report changed with upstream row order.\n forward =\n%+v\nbackward =\n%+v\n"+
			"the same estate cannot have two answers — that is the whole defect", forward, backward)
	}
	return forward
}

// driftTagsTemplate expects one tag on subnets named data and voice.
func driftTagsTemplate() M {
	return M{
		"network": M{"subnets": []any{M{"name": "data"}, M{"name": "voice"}}},
		"dns":     M{"create_zone": true},
		"tags":    M{"Owner": "net-team"},
	}
}

func TestDetectDrift_TagsCheckedOnEverySubnet(t *testing.T) {
	tagged := M{"name": "data", "tags": M{"Owner": "net-team", "Site": "site-a"}}
	untagged := M{"name": "voice", "tags": M{"Site": "site-a"}}

	got := driftTagsBothOrders(t, driftTagsTemplate(), []any{tagged, untagged})
	want := []driftEntry{{category: "tags", severity: "warning", field: "subnet:voice.tags.Owner",
		message: "Tag 'Owner' missing from subnet 'voice' tags (expected 'net-team')"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tag drifts =\n%+v\nwant\n%+v\n— the untagged subnet must be reported whichever "+
			"row upstream listed first; teardown selects subnets by tag, so an unreported one is "+
			"invisible to it", got, want)
	}
}

// The positive control. Without it every assertion above is satisfied by a
// function that reports tag drift for everything.
func TestDetectDrift_AllSubnetsTaggedIsClean(t *testing.T) {
	got := driftTagsBothOrders(t, driftTagsTemplate(), []any{
		M{"name": "data", "tags": M{"Owner": "net-team"}},
		M{"name": "voice", "tags": M{"Owner": "net-team"}},
	})
	if len(got) != 0 {
		t.Fatalf("tag drifts = %+v, want none — both subnets carry the expected tag", got)
	}
}

// Two subnets, two different faults. Both must be reported, and each row must
// name the subnet it is about — the old message said "missing from subnet
// tags", singular and unattributed, so the output never revealed that one
// subnet had been checked.
func TestDetectDrift_EachSubnetReportedSeparately(t *testing.T) {
	got := driftTagsBothOrders(t, driftTagsTemplate(), []any{
		M{"name": "data", "tags": M{"Owner": "someone-else"}},
		M{"name": "voice", "tags": M{"Site": "site-a"}},
	})
	want := []driftEntry{
		{category: "tags", severity: "warning", field: "subnet:data.tags.Owner",
			message: "Tag 'Owner' on subnet 'data': expected 'net-team', live value is 'someone-else'"},
		{category: "tags", severity: "warning", field: "subnet:voice.tags.Owner",
			message: "Tag 'Owner' missing from subnet 'voice' tags (expected 'net-team')"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tag drifts =\n%+v\nwant\n%+v", got, want)
	}
}

// The identity fallbacks, each under both orders. A label built from the row's
// POSITION would satisfy every test above and reintroduce the defect, so these
// pin that the name comes from the row's own content.
func TestDetectDrift_SubnetIdentityFallbacks(t *testing.T) {
	tmpl := M{"dns": M{"create_zone": true}, "tags": M{"Owner": "net-team"}}

	t.Run("no name falls back to the id", func(t *testing.T) {
		got := driftTagsBothOrders(t, tmpl, []any{
			M{"id": "ipam/subnet/aaa", "tags": M{"Owner": "net-team"}},
			M{"id": "ipam/subnet/bbb", "tags": M{}},
		})
		want := []driftEntry{{category: "tags", severity: "warning",
			field:   "subnet:ipam/subnet/bbb.tags.Owner",
			message: "Tag 'Owner' missing from subnet 'ipam/subnet/bbb' tags (expected 'net-team')"}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("tag drifts =\n%+v\nwant\n%+v", got, want)
		}
	})

	t.Run("no name and no id falls back to address/cidr", func(t *testing.T) {
		got := driftTagsBothOrders(t, tmpl, []any{
			M{"address": "10.1.0.0", "cidr": 24, "tags": M{"Owner": "net-team"}},
			M{"address": "10.2.0.0", "cidr": 24, "tags": M{}},
		})
		want := []driftEntry{{category: "tags", severity: "warning",
			field:   "subnet:10.2.0.0/24.tags.Owner",
			message: "Tag 'Owner' missing from subnet '10.2.0.0/24' tags (expected 'net-team')"}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("tag drifts =\n%+v\nwant\n%+v", got, want)
		}
	})

	// The template forbids duplicate subnet names; upstream does not. Two rows
	// sharing a name must not produce two rows a reader cannot tell apart.
	t.Run("a duplicated name is disambiguated by id", func(t *testing.T) {
		got := driftTagsBothOrders(t, tmpl, []any{
			M{"name": "data", "id": "ipam/subnet/aaa", "tags": M{}},
			M{"name": "data", "id": "ipam/subnet/bbb", "tags": M{}},
		})
		want := []driftEntry{
			{category: "tags", severity: "warning", field: "subnet:data (ipam/subnet/aaa).tags.Owner",
				message: "Tag 'Owner' missing from subnet 'data (ipam/subnet/aaa)' tags (expected 'net-team')"},
			{category: "tags", severity: "warning", field: "subnet:data (ipam/subnet/bbb).tags.Owner",
				message: "Tag 'Owner' missing from subnet 'data (ipam/subnet/bbb)' tags (expected 'net-team')"},
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("tag drifts =\n%+v\nwant\n%+v\n— two subnets with one name and two ids are two "+
				"objects an operator has to fix separately", got, want)
		}
	})

	// Same name, no id to tell them apart, DIFFERENT tags. The rows cannot be
	// labelled distinctly from the data, so the two findings are reported under
	// the same label — but the ORDER still must not depend on upstream's.
	t.Run("a duplicated name with no id still reports in a fixed order", func(t *testing.T) {
		got := driftTagsBothOrders(t, tmpl, []any{
			M{"name": "data", "tags": M{"Owner": "wrong-a"}},
			M{"name": "data", "tags": M{"Owner": "wrong-b"}},
		})
		want := []driftEntry{
			{category: "tags", severity: "warning", field: "subnet:data.tags.Owner",
				message: "Tag 'Owner' on subnet 'data': expected 'net-team', live value is 'wrong-a'"},
			{category: "tags", severity: "warning", field: "subnet:data.tags.Owner",
				message: "Tag 'Owner' on subnet 'data': expected 'net-team', live value is 'wrong-b'"},
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("tag drifts =\n%+v\nwant\n%+v\n— indistinguishable labels are acceptable; a "+
				"report whose ROW ORDER follows the API's is not", got, want)
		}
	})

	// Nothing to name it by at all. One row, so there is nothing to order, and
	// the label must still not be blank.
	t.Run("nothing to name it by", func(t *testing.T) {
		got := driftTagsBothOrders(t, tmpl, []any{M{"tags": M{}}})
		want := []driftEntry{{category: "tags", severity: "warning",
			field:   "subnet:(unnamed).tags.Owner",
			message: "Tag 'Owner' missing from subnet '(unnamed)' tags (expected 'net-team')"}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("tag drifts =\n%+v\nwant\n%+v", got, want)
		}
	})
}
