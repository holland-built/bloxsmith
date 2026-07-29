package server

import (
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// THE POINT OF THIS FILE: a write route that nobody classified must fail the
// build, not silently escape the per-tenant write lock.
//
// The lock in writelock.go works off two lists — tenantWritePaths (changes the
// customer's tenant, gated) and nonTenantWritePaths (does not, with the reason
// recorded for each). Two hand-maintained lists next to a growing route table is exactly the
// shape of every defect found this week: correct on the day it was written and
// quietly wrong three routes later. So this test enumerates what the server
// ACTUALLY registers and requires every state-changing route to be in exactly
// one list.
//
// *http.ServeMux cannot be read back, which is why register*Routes takes the
// `router` interface: this recorder is handed the real registration calls.

type recordingRouter struct{ patterns []string }

func (r *recordingRouter) HandleFunc(pattern string, _ func(http.ResponseWriter, *http.Request)) {
	r.patterns = append(r.patterns, pattern)
}

// allRoutes runs every registration function against the recorder. A Deps with
// nil dependencies is fine: registration only stores closures, it never calls
// them.
//
// If a new register*Routes function is added to server.New and NOT added here,
// this test cannot see its routes. That is the one gap this test has, and it is
// covered by asserting the count of registration calls in New against the count
// here — see TestRegistrationFunctionsAllEnumerated.
func allRoutes(t *testing.T) []string {
	t.Helper()
	d := &Deps{}
	rr := &recordingRouter{}
	d.registerVaultRoutes(rr)
	d.registerWriteLockRoutes(rr)
	d.registerStateRoutes(rr)
	d.registerDataRoutes(rr)
	d.registerCSPRoutes(rr)
	d.registerEditRoutes(rr)
	d.registerProvisionRoutes(rr)
	d.registerAIRoutes(rr)
	d.registerAccountRoutes(rr)
	d.registerThreatIntelRoutes(rr)
	d.registerIPAMReadRoutes(rr)
	d.registerNOCRoutes(rr)
	d.registerBrandRoutes(rr)
	d.registerSecurityWriteRoutes(rr)
	if len(rr.patterns) == 0 {
		t.Fatal("no routes recorded — the recorder is not being handed the real registrations, so this whole file proves nothing")
	}
	return rr.patterns
}

// splitPattern turns "POST /api/vault/init" into ("POST", "/api/vault/init").
// A pattern with no method (none exist today) is treated as every method, which
// is the strict reading.
func splitPattern(p string) (method, path string) {
	parts := strings.Fields(p)
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return "", parts[len(parts)-1]
}

// concretePath turns a ServeMux wildcard pattern into a path the classifier will
// actually see at runtime: "/api/actions/{id}/status" -> "/api/actions/x/status".
func concretePath(path string) string {
	out := []string{}
	for _, seg := range strings.Split(path, "/") {
		if strings.HasPrefix(seg, "{") {
			seg = "x"
		}
		out = append(out, seg)
	}
	return strings.Join(out, "/")
}

func isNonTenantWrite(path string) bool {
	if nonTenantWritePaths[path] {
		return true
	}
	for _, p := range nonTenantWritePrefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

// TestEveryWriteRouteIsClassified is the gate. Every registered route that can
// change state must be in exactly one of the two lists.
//
// "Can change state" is every non-GET verb, PLUS the SSE provision/teardown
// streams, which are GETs because EventSource cannot issue anything else — they
// are the most destructive routes in the program and the reason the classifier
// is keyed by path rather than by verb.
func TestEveryWriteRouteIsClassified(t *testing.T) {
	var unclassified, both []string

	for _, pattern := range allRoutes(t) {
		method, rawPath := splitPattern(pattern)
		path := concretePath(rawPath)

		stateChanging := method != http.MethodGet && method != http.MethodHead
		if !stateChanging {
			// A GET that is nevertheless a write: the five SSE streams. If a new
			// one appears it must be added to tenantWritePaths, and this branch
			// is what notices.
			if strings.Contains(path, "/provision/") || strings.Contains(path, "/teardown/") {
				stateChanging = true
			}
		}
		if !stateChanging {
			continue
		}

		tenant := isTenantWrite(path)
		local := isNonTenantWrite(path)
		switch {
		case tenant && local:
			both = append(both, pattern)
		case !tenant && !local:
			unclassified = append(unclassified, pattern)
		}
	}

	sort.Strings(unclassified)
	sort.Strings(both)

	if len(unclassified) > 0 {
		t.Errorf("these state-changing routes are in NEITHER tenantWritePaths nor nonTenantWritePaths, "+
			"so the per-tenant write lock does not gate them and nothing says that was deliberate:\n  %s\n"+
			"Add each to internal/server/writelock.go: tenantWritePaths if it changes data in the customer's "+
			"tenant, nonTenantWritePaths (with the reason, checked not assumed) if it does not.",
			strings.Join(unclassified, "\n  "))
	}
	if len(both) > 0 {
		t.Errorf("these routes are classified as BOTH tenant-changing and local-only, which cannot be true:\n  %s",
			strings.Join(both, "\n  "))
	}
}

// TestKnownDestructiveRoutesAreGated is the belt to the braces above. The list
// test proves nothing was FORGOTTEN; this proves the classifier actually says
// "gate it" for the specific routes whose whole reason for existing is to delete
// live DNS zones, subnets and address blocks. A refactor that made
// isTenantWrite() return false for everything would pass the test above (every
// route would then be reported as unclassified — but a refactor that made
// isNonTenantWrite return true for everything would pass it).
func TestKnownDestructiveRoutesAreGated(t *testing.T) {
	mustGate := []string{
		"/api/teardown/site/stream",
		"/api/teardown/seed-demo/stream",
		"/api/teardown/block",
		"/api/provision/stream",
		"/api/provision/site/stream",
		"/api/provision/seed-demo/stream",
		"/api/provision/block",
		"/api/retag/block",
		"/api/selfservice/allocate",
		"/api/dns/records",
		"/api/dns/records/some-record-id",
		"/api/ipam/addresses/some-address-id",
		"/api/edit/dns_zone/some-id",
		"/api/edit/", // empty id: must be gated, not fall through as a route miss
		"/api/block-domain",
		"/api/unblock-domain",
		"/api/actions/some-action-id/status",
	}
	for _, p := range mustGate {
		if !isTenantWrite(p) {
			t.Errorf("%s changes data in the customer's tenant but isTenantWrite() says it does not — it would bypass the write lock entirely", p)
		}
	}

	// And the other direction: a read must not be gated, or the lock would break
	// reading a tenant you are only looking at.
	mustNotGate := []string{
		"/api/data",
		"/api/ipam/subnets",
		"/api/dns/zones",
		"/api/audit/log",
		"/api/views",
		"/api/views/my-view",
		"/api/alerts/snooze",
		"/api/vault/unlock",
		"/api/vault/tenant-writable",
		"/api/brand",
		"/api/update/apply",
		"/api/actions/some-action-id",
	}
	for _, p := range mustNotGate {
		if isTenantWrite(p) {
			t.Errorf("%s does not change the customer's tenant but isTenantWrite() says it does — the write lock would refuse a read or a local action", p)
		}
	}
}

// TestRegistrationFunctionsAllEnumerated closes the one gap in allRoutes(): if a
// future register*Routes is wired into server.New but not listed there, its
// routes are invisible to the gate above and nothing complains.
//
// It counts `d.register...(mux)` calls in server.go's New against the calls in
// allRoutes. Counting source lines is a blunt instrument, and it is used here
// precisely because the alternative — trusting two hand-kept lists to match — is
// the failure mode this file exists to prevent.
func TestRegistrationFunctionsAllEnumerated(t *testing.T) {
	inNew := registerCallsIn(t, "server.go")
	inTest := registerCallsIn(t, "writelock_routes_test.go")

	// registerWriteLockRoutes is called from New and from allRoutes, so both
	// sides see it; every other name must appear on both sides too.
	missing := []string{}
	for name := range inNew {
		if !inTest[name] {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("server.New registers these route groups but allRoutes() in this file does not, "+
			"so their routes are NOT checked by TestEveryWriteRouteIsClassified:\n  %s",
			strings.Join(missing, "\n  "))
	}
	if len(inNew) == 0 {
		t.Fatal("found no register*Routes calls in server.go — the scan is broken, so this test proves nothing")
	}
}

// registerCallsIn returns the set of register*Routes names called in a source
// file in this package. Reading the source is deliberate: it is the only way to
// notice a registration that exists in New and nowhere else.
func registerCallsIn(t *testing.T, file string) map[string]bool {
	t.Helper()
	src, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("read %s: %v", file, err)
	}
	re := regexp.MustCompile(`d\.(register\w*Routes)\(`)
	out := map[string]bool{}
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		out[m[1]] = true
	}
	return out
}
