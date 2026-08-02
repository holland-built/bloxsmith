package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// These cover the CSRF hole in the five GET-verb SSE mutating streams and the
// DNS-rebinding gate. The exploit under test:
//
//	fetch("http://127.0.0.1:8080/api/teardown/seed-demo/stream?confirm=DELETE&dry=0",
//	      {mode:"no-cors", referrerPolicy:"no-referrer"})
//
// sends NO Origin (no-cors GET) and NO Referer (policy), from the victim's own
// machine — so the old Origin/Referer/loopback ladder ended at "loopback ->
// trusted" and really decommissioned zones, subnets and address blocks.

const testPort = "8080"

func testGuard() *Guard {
	return &Guard{Port: testPort, Host: "localhost", MutatingPaths: DefaultMutatingPaths()}
}

// req builds a loopback request with the given headers. Loopback is the point:
// every case here comes from 127.0.0.1, because the victim's browser does.
func req(method, target string, headers map[string]string) *http.Request {
	r := httptest.NewRequest(method, target, nil)
	r.RemoteAddr = "127.0.0.1:54321"
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

// guarded runs the request through WriteGuard and reports whether it was
// allowed through (false = 403'd).
func guarded(g *Guard, r *http.Request) bool {
	w := httptest.NewRecorder()
	return !g.WriteGuard(w, r)
}

const teardownStream = "/api/teardown/seed-demo/stream?confirm=DELETE&dry=0"

// --- the exploit -------------------------------------------------------------

// The exploit at the top of this file, reproduced exactly as it arrives.
//
// The decisive detail is what the request does NOT carry: mode:"no-cors" on a
// safe verb means fetch sends no Origin, referrerPolicy:"no-referrer" strips the
// Referer, and it comes from 127.0.0.1 because the victim's browser genuinely
// runs on the operator's machine. That is the ladder that used to end at
// "loopback -> trusted" and really decommissioned zones.
//
// This test used to set Sec-Fetch-Site: cross-site and nothing else, which
// SameOrigin already rejected before the fix existed — so it passed with the fix
// reverted and proved nothing about the hole it is named for. Both rungs are
// asserted below; the first is the one the fix added.
func TestWriteGuard_HostilePageNoCorsGET_Rejected(t *testing.T) {
	g := testGuard()

	// Rung one — no Origin, no Referer, no Sec-Fetch-Site to fall back on
	// (a browser predating Fetch Metadata, or any client that omits it).
	// Loopback is all that is left, and loopback must no longer be proof.
	if guarded(g, req("GET", teardownStream, nil)) {
		t.Fatal("the hostile page's no-cors GET — no Origin, no Referer, from loopback — was authorized " +
			"on loopback trust alone; a page the operator visits can decommission production DNS")
	}

	// Rung two — the same page on a browser that DOES send Fetch Metadata, which
	// names the initiator as someone else's site. Page script cannot forge or
	// strip this header.
	if guarded(g, req("GET", teardownStream, map[string]string{
		"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "empty"})) {
		t.Fatal("cross-site no-cors GET to a mutating SSE stream was authorized — " +
			"a hostile page can decommission production DNS")
	}
}

// Same-site is a sibling host under the registrable domain, not us.
func TestWriteGuard_SameSiteGET_Rejected(t *testing.T) {
	g := testGuard()
	if guarded(g, req("GET", teardownStream, map[string]string{"Sec-Fetch-Site": "same-site"})) {
		t.Fatal("same-site GET to a mutating SSE stream was authorized")
	}
}

// The loopback fallback itself: no Origin, no Referer, no fetch metadata at all
// (an old browser, or a bare script). Loopback must no longer be proof.
func TestWriteGuard_NoEvidenceLoopbackGET_Rejected(t *testing.T) {
	g := testGuard()
	if guarded(g, req("GET", teardownStream, nil)) {
		t.Fatal("mutating GET with no Origin/Referer/Sec-Fetch-Site was authorized on loopback trust alone")
	}
}

// A hostile page that also strips Referer AND happens to reach a browser that
// omits Sec-Fetch-Site is covered by the case above; here the browser names an
// origin the allowlist rejects.
func TestWriteGuard_ForeignOriginGET_Rejected(t *testing.T) {
	g := testGuard()
	r := req("GET", teardownStream, map[string]string{"Origin": "https://evil.example"})
	if guarded(g, r) {
		t.Fatal("mutating GET from a foreign Origin was authorized")
	}
}

// A browser that says same-origin but names a foreign Origin cannot happen, but
// the stated origin still has to win — belt and braces.
func TestWriteGuard_ForeignOriginWithSameOriginMetadata_Rejected(t *testing.T) {
	g := testGuard()
	r := req("GET", teardownStream, map[string]string{
		"Origin": "https://evil.example", "Sec-Fetch-Site": "same-origin"})
	if guarded(g, r) {
		t.Fatal("a foreign Origin was authorized because Sec-Fetch-Site claimed same-origin")
	}
}

// --- the real UI must keep working -------------------------------------------

func TestWriteGuard_RealUIEventSource_Allowed(t *testing.T) {
	g := testGuard()
	// What Chrome/Firefox/Safari actually send for `new EventSource('/api/...')`
	// from the dashboard's own page: no Origin (safe verb), Sec-Fetch-Site
	// same-origin.
	r := req("GET", "/api/provision/stream?dry=1", map[string]string{
		"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"})
	if !guarded(g, r) {
		t.Fatal("the dashboard's own EventSource was rejected — provisioning is broken")
	}
}

// All five GET-verb mutating streams behave identically.
func TestWriteGuard_AllSSEStreams_ExploitRejectedUIAllowed(t *testing.T) {
	streams := []string{
		"/api/provision/stream", "/api/provision/site/stream",
		"/api/provision/seed-demo/stream", "/api/teardown/site/stream",
		"/api/teardown/seed-demo/stream",
	}
	for _, p := range streams {
		g := testGuard()
		if guarded(g, req("GET", p+"?dry=0", map[string]string{"Sec-Fetch-Site": "cross-site"})) {
			t.Errorf("%s: cross-site GET authorized", p)
		}
		if guarded(g, req("GET", p+"?dry=0", nil)) {
			t.Errorf("%s: no-evidence loopback GET authorized", p)
		}
		if !guarded(g, req("GET", p+"?dry=0", map[string]string{"Sec-Fetch-Site": "same-origin"})) {
			t.Errorf("%s: same-origin EventSource rejected", p)
		}
	}
}

// A user-typed URL / bookmark reports "none".
func TestWriteGuard_UserTypedURL_Allowed(t *testing.T) {
	g := testGuard()
	if !guarded(g, req("GET", teardownStream, map[string]string{"Sec-Fetch-Site": "none"})) {
		t.Fatal("a user-initiated (Sec-Fetch-Site: none) request was rejected")
	}
}

// The UI's own page as Referer, with no fetch metadata (older browser).
func TestWriteGuard_AllowlistedReferer_Allowed(t *testing.T) {
	g := testGuard()
	r := req("GET", teardownStream, map[string]string{"Referer": "http://localhost:8080/"})
	if !guarded(g, r) {
		t.Fatal("an allowlisted Referer was rejected")
	}
}

// --- the CLI / token path ----------------------------------------------------

func TestWriteGuard_QueryTokenNoFetchMetadata_Allowed(t *testing.T) {
	g := testGuard()
	g.Token = "s3cret"
	r := req("GET", "/api/provision/stream?dry=1&token=s3cret", nil)
	if !guarded(g, r) {
		t.Fatal("a valid ?token= on a mutating GET was rejected — curl/EventSource token path is broken")
	}
}

func TestWriteGuard_QueryTokenBeatsCrossSite_False(t *testing.T) {
	// A hostile page cannot know the token, but if it did, the token is the
	// credential — this documents that a token deployment gates on the token
	// alone, exactly as before.
	g := testGuard()
	g.Token = "s3cret"
	if guarded(g, req("GET", "/api/provision/stream?dry=1&token=wrong", nil)) {
		t.Fatal("a wrong ?token= was authorized")
	}
}

func TestWriteGuard_HeaderTokenOnMutatingGET_Allowed(t *testing.T) {
	g := testGuard()
	g.Token = "s3cret"
	r := req("GET", "/api/provision/stream?dry=1", map[string]string{"X-Auth-Token": "s3cret"})
	if !guarded(g, r) {
		t.Fatal("X-Auth-Token on a mutating GET was rejected")
	}
}

// Tokenless, a script must opt in with an Origin the allowlist accepts —
// forgeable by curl (fine, curl is not the threat) but NOT by page script,
// which cannot set Origin.
func TestWriteGuard_CLIWithExplicitOrigin_Allowed(t *testing.T) {
	g := testGuard()
	r := req("GET", teardownStream, map[string]string{"Origin": "http://127.0.0.1:8080"})
	if !guarded(g, r) {
		t.Fatal("a script supplying an allowlisted Origin was rejected")
	}
}

// --- non-mutating reads are untouched ----------------------------------------

func TestWriteGuard_NonMutatingGET_AlwaysAllowed(t *testing.T) {
	cases := []map[string]string{
		nil,
		{"Sec-Fetch-Site": "cross-site"},
		{"Sec-Fetch-Site": "same-origin"},
		{"Origin": "https://evil.example"},
		{"Referer": "https://evil.example/x"},
	}
	for _, h := range cases {
		g := testGuard()
		if !guarded(g, req("GET", "/api/dashboard", h)) {
			t.Errorf("non-mutating GET rejected with headers %v", h)
		}
	}
}

// --- non-safe verbs keep their existing (looser) gate ------------------------

func TestWriteGuard_LoopbackPOST_StillAllowed(t *testing.T) {
	// A browser ALWAYS sends Origin on POST, so the allowlist already covers
	// the cross-origin case; tokenless CLI scripting keeps working.
	g := testGuard()
	if !guarded(g, req("POST", "/api/retag/block", nil)) {
		t.Fatal("a tokenless loopback POST was rejected — CLI writes are broken")
	}
}

func TestWriteGuard_ForeignOriginPOST_Rejected(t *testing.T) {
	g := testGuard()
	if guarded(g, req("POST", "/api/retag/block", map[string]string{"Origin": "https://evil.example"})) {
		t.Fatal("a cross-origin POST was authorized")
	}
}

func TestWriteGuard_CrossSitePOST_Rejected(t *testing.T) {
	g := testGuard()
	if guarded(g, req("POST", "/api/vault/activate", map[string]string{"Sec-Fetch-Site": "cross-site"})) {
		t.Fatal("a cross-site POST was authorized")
	}
}

// --- SameOrigin / role resolution --------------------------------------------

func TestSameOrigin_CrossSiteNeverTrusted(t *testing.T) {
	g := testGuard()
	if g.SameOrigin(req("GET", "/api/whoami", map[string]string{"Sec-Fetch-Site": "cross-site"})) {
		t.Fatal("SameOrigin trusted a cross-site request from loopback")
	}
	if got := g.ResolveRole(req("GET", "/api/whoami", map[string]string{"Sec-Fetch-Site": "cross-site"})); got == "admin" {
		t.Fatalf("ResolveRole granted admin to a cross-site request, got %q", got)
	}
}

func TestSameOrigin_LoopbackStillAdminForLocalTools(t *testing.T) {
	// Read-side behavior is unchanged: a bare loopback client (the Go tests,
	// curl, health probes) still resolves to admin in a tokenless deployment.
	g := testGuard()
	if !g.SameOrigin(req("GET", "/api/whoami", nil)) {
		t.Fatal("SameOrigin stopped trusting a bare loopback client")
	}
	if got := g.ResolveRole(req("GET", "/api/whoami", nil)); got != "admin" {
		t.Fatalf("tokenless loopback role = %q, want admin", got)
	}
}

// --- DNS rebinding: Host allowlist -------------------------------------------

func hostReq(host string) *http.Request {
	r := httptest.NewRequest("GET", "http://"+host+"/api/dashboard", nil)
	r.Host = host
	r.RemoteAddr = "127.0.0.1:54321"
	return r
}

func TestHostAllowed(t *testing.T) {
	g := testGuard()
	allowed := []string{"localhost:8080", "127.0.0.1:8080", "[::1]:8080", "localhost", "LOCALHOST:8080"}
	for _, h := range allowed {
		if !g.HostAllowed(hostReq(h)) {
			t.Errorf("Host %q rejected, want allowed", h)
		}
	}
	// A rebound attacker domain resolving to 127.0.0.1 still says its own name.
	denied := []string{"evil.com:8080", "evil.com", "rebind.attacker.test:8080", "127.0.0.1.nip.io:8080", ""}
	for _, h := range denied {
		if g.HostAllowed(hostReq(h)) {
			t.Errorf("Host %q allowed, want rejected — DNS rebinding is open", h)
		}
	}
}

func TestHostGuard_RejectsRebindWith421(t *testing.T) {
	g := testGuard()
	reached := false
	h := g.HostGuard(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))

	w := httptest.NewRecorder()
	h.ServeHTTP(w, hostReq("evil.com:8080"))
	if reached {
		t.Fatal("HostGuard passed a rebound Host through to the handler")
	}
	if w.Code != http.StatusMisdirectedRequest {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusMisdirectedRequest)
	}

	w = httptest.NewRecorder()
	h.ServeHTTP(w, hostReq("localhost:8080"))
	if !reached {
		t.Fatal("HostGuard blocked the legitimate Host")
	}
}

func TestHostAllowed_BindHostAndExtras(t *testing.T) {
	g := &Guard{Port: "8090", Host: "noc.internal", AllowedHosts: []string{"dash.example.com"}}
	for _, h := range []string{"noc.internal:8090", "noc.internal", "dash.example.com:8090", "localhost:8090"} {
		if !g.HostAllowed(hostReq(h)) {
			t.Errorf("Host %q rejected, want allowed", h)
		}
	}
	if g.HostAllowed(hostReq("evil.com:8090")) {
		t.Error("foreign Host allowed")
	}
}

func TestHostAllowed_WildcardBindStandsDown(t *testing.T) {
	// HOST=0.0.0.0 (the Docker image) is reached through names the server
	// cannot enumerate, so the gate is off until ALLOWED_HOSTS names them.
	g := &Guard{Port: "8080", Host: "0.0.0.0"}
	if !g.HostAllowed(hostReq("anything.example:8080")) {
		t.Error("wildcard bind with no ALLOWED_HOSTS should not gate on Host")
	}
	g.AllowedHosts = []string{"dash.example.com"}
	if !g.HostAllowed(hostReq("dash.example.com:8080")) {
		t.Error("declared Host rejected on a wildcard bind")
	}
	if g.HostAllowed(hostReq("anything.example:8080")) {
		t.Error("ALLOWED_HOSTS did not re-arm the gate on a wildcard bind")
	}
}
