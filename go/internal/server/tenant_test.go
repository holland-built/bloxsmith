package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/config"
	"bloxsmith/internal/dashboard"
	"bloxsmith/internal/edit"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/rest"
)

// The defect: auth.SetOverride wrote a single process-global slot that every
// outbound call re-read. One inbound request makes many outbound calls, so an
// account switch landing halfway through left the first half of a request on
// tenant A and the rest on tenant B — worst case, a teardown that starts
// deleting in one tenant and finishes deleting in another.
//
// These tests drive the real chassis (server.New) and flip the override from
// inside the upstream handler, between the first outbound call and the second.
// No sleeps, no timing luck: the switch is guaranteed to land mid-request.

// tenantSpy is an upstream that records the Authorization header of every call
// and runs a hook after the first one.
type tenantSpy struct {
	mu        sync.Mutex
	seen      []string
	afterCall func(n int)
	respond   func(w http.ResponseWriter, r *http.Request)
}

func (s *tenantSpy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.seen = append(s.seen, r.Header.Get("Authorization"))
	n := len(s.seen)
	s.mu.Unlock()
	if s.respond != nil {
		s.respond(w, r)
	} else {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[{"id":"dns/record/1","type":"A","name_in_zone":"a","zone":"z","rdata":{"address":"10.0.0.1"}}]}`))
	}
	if s.afterCall != nil {
		s.afterCall(n)
	}
}

func (s *tenantSpy) headers() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.seen...)
}

// newTenantChassis wires the full routed handler over a spy upstream, the way
// main.go does, so the request-scoped pin is exercised end to end.
func newTenantChassis(t *testing.T, spy *tenantSpy) (http.Handler, *rest.Auth, func()) {
	t.Helper()
	up := httptest.NewServer(spy)
	auth := rest.NewAuth("Token tenant-A", nil)
	rc := rest.New(up.URL, auth)
	d := &Deps{
		Cfg:   &config.Config{Port: "8080"},
		Rest:  rc,
		Auth:  auth,
		Guard: &httpx.Guard{Port: "8080", MutatingPaths: httpx.DefaultMutatingPaths()},
		Audit: audit.New(t.TempDir()+"/audit_log.jsonl", "app-v-test", "test-instance",
			audit.Options{TrustDir: t.TempDir()}),
		Dashboard: dashboard.New(rc, nil),
		Edit:      edit.New(rc),
		Static:    http.NotFoundHandler(),
	}
	return New(d), auth, up.Close
}

// TestSwitchMidRequestDoesNotMoveTenant is the headline regression. A PATCH to
// /api/edit/ reads the object then writes it — two outbound calls. The account
// switch lands between them. Before the fix the write went to the NEW tenant
// while the read came from the old one.
func TestSwitchMidRequestDoesNotMoveTenant(t *testing.T) {
	var auth *rest.Auth
	// The update path is PATCH-then-PUT: a 405 on the PATCH makes it retry with
	// PUT, so one inbound request provably makes two outbound calls with the
	// switch landing between them.
	spy := &tenantSpy{
		respond: func(w http.ResponseWriter, r *http.Request) {
			if r.Method == "PATCH" {
				w.WriteHeader(405)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"result":{"id":"ipam/subnet/1","address":"10.0.0.0","cidr":24,"comment":"renamed"}}`))
		},
	}
	spy.afterCall = func(n int) {
		if n == 1 {
			// The switch lands after the pre-update read and before the write.
			auth.SetOverride("Bearer tenant-B")
		}
	}
	h, a, closeUp := newTenantChassis(t, spy)
	auth = a
	defer closeUp()

	req := httptest.NewRequest("PATCH", "/api/edit/subnet/ipam%2Fsubnet%2F1",
		strings.NewReader(`{"comment":"renamed","dry":false}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	seen := spy.headers()
	if len(seen) < 2 {
		t.Fatalf("want at least 2 upstream calls (read then write), got %d: %v — the test cannot prove anything", len(seen), seen)
	}
	for i, got := range seen {
		if got != "Token tenant-A" {
			t.Fatalf("outbound call %d carried %q, want %q — the request changed tenant midway, which is the defect",
				i, got, "Token tenant-A")
		}
	}
	// And the switch really did land: the NEXT request must use tenant B.
	spy.afterCall = nil
	rr2 := httptest.NewRecorder()
	h.ServeHTTP(rr2, httptest.NewRequest("GET", "/api/ipam/addresses?subnet=10.0.0.0/24", nil))
	seen2 := spy.headers()
	if last := seen2[len(seen2)-1]; last != "Bearer tenant-B" {
		t.Fatalf("the request AFTER the switch carried %q, want the new tenant — pinning must not make a switch permanent", last)
	}
}

// TestPinIsResolvedOncePerRequest pins the mechanism directly: two requests get
// two different pinned clients, and one request gets one.
func TestPinIsResolvedOncePerRequest(t *testing.T) {
	auth := rest.NewAuth("Token tenant-A", nil)
	d := &Deps{Rest: rest.New("http://upstream.invalid", auth)}

	var first, second *rest.Client
	h := d.withPinnedTenant(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a, b := d.restFor(r), d.restFor(r)
		if a != b {
			t.Error("two lookups inside one request returned different clients")
		}
		if !a.Pinned() {
			t.Error("the request-scoped client is not pinned")
		}
		if first == nil {
			first = a
		} else {
			second = a
		}
	}))

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil))
	auth.SetOverride("Bearer tenant-B")
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil))

	if first == nil || second == nil {
		t.Fatal("handler did not run twice")
	}
	if first == second {
		t.Fatal("two separate requests shared one pinned client")
	}
}

// TestUnpinnedClientStillFollowsTheSwitch guards the other direction: work that
// belongs to no request — background pollers, the account manager's own calls —
// must keep resolving live. Pinning everything would freeze a switch out.
func TestUnpinnedClientStillFollowsTheSwitch(t *testing.T) {
	spy := &tenantSpy{}
	up := httptest.NewServer(spy)
	defer up.Close()

	auth := rest.NewAuth("Token tenant-A", nil)
	rc := rest.New(up.URL, auth)
	if rc.Pinned() {
		t.Fatal("the shared client must not be pinned")
	}
	rc.GetEx("/anything", nil)
	auth.SetOverride("Bearer tenant-B")
	rc.GetEx("/anything", nil)

	seen := spy.headers()
	if len(seen) != 2 || seen[0] != "Token tenant-A" || seen[1] != "Bearer tenant-B" {
		t.Fatalf("the shared client did not follow the switch: %v", seen)
	}
}

// TestMultiCallReadStaysOnOneTenant covers the read side. /api/csp/ctem-exposure
// makes three outbound calls for one inbound request; a switch landing after the
// first used to split the response across two tenants. Half a dashboard from
// each is worse than either, because nothing on screen says it happened.
//
// The route choice is load-bearing: an earlier version of this test used a
// single-call route, so it passed against the pre-fix code as well and proved
// nothing at all.
func TestMultiCallReadStaysOnOneTenant(t *testing.T) {
	var auth *rest.Auth
	spy := &tenantSpy{}
	spy.afterCall = func(n int) {
		if n == 1 {
			auth.SetOverride("Bearer tenant-B")
		}
	}
	h, a, closeUp := newTenantChassis(t, spy)
	auth = a
	defer closeUp()

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/csp/ctem-exposure", nil))

	seen := spy.headers()
	if len(seen) < 2 {
		t.Fatalf("want a route that makes several outbound calls, got %d: %v — the test proves nothing", len(seen), seen)
	}
	for i, got := range seen {
		if got != "Token tenant-A" {
			t.Fatalf("outbound call %d of one read carried %q, want tenant A — the response was assembled from two tenants", i, got)
		}
	}

	spy.afterCall = nil
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/csp/ctem-exposure", nil))
	seen2 := spy.headers()
	if last := seen2[len(seen2)-1]; last != "Bearer tenant-B" {
		t.Fatalf("the read AFTER the switch carried %q, want tenant B", last)
	}
}
