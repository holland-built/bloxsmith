package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"bloxsmith/internal/account"
	"bloxsmith/internal/audit"
	cachepkg "bloxsmith/internal/cache"
	"bloxsmith/internal/config"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/provision"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/vault"
)

// Behaviour tests for the per-tenant write lock. The list tests in
// writelock_routes_test.go prove nothing was forgotten; these prove the refusal
// actually happens, that it happens BEFORE anything is sent upstream, and that
// the opt-in works.
//
// Every refusal here was confirmed to fail with the lock removed from
// server.New's chain — a refusal nobody has watched fail is not a refusal.

// lockedTestServer builds a real routed handler over an unlocked vault holding
// one tenant ("Delta"), a real account.Manager pointed at a fake CSP that offers
// a second account ("HERE Technologies"), and a fake upstream that counts how
// many times it was reached.
//
// That upstream counter is the assertion that matters most: a refused teardown
// must not merely return 403, it must not have deleted anything. A control that
// refuses AFTER acting is worse than no control, because the 403 reads like it
// held.
func lockedTestServer(t *testing.T) (h http.Handler, d *Deps, upstreamHits *int) {
	t.Helper()
	hits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"results":[]}`))
	}))
	t.Cleanup(upstream.Close)

	// Fake CSP identity endpoints, exactly the three account.Manager uses.
	csp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/current_user/accounts":
			_, _ = w.Write([]byte(`{"results":[{"id":"acct-home","name":"Delta","state":"active"},{"id":"acct-here","name":"HERE Technologies","state":"active"}]}`))
		case "/v2/current_user":
			_, _ = w.Write([]byte(`{"result":{"account_id":"acct-home"}}`))
		case "/v2/session/account_switch":
			_, _ = w.Write([]byte(`{"jwt":"switched-in-jwt"}`))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(csp.Close)

	dir := t.TempDir()
	vlt := vault.New(filepath.Join(dir, "vault.json"))
	if err := vlt.Init("pass-phrase-for-test"); err != nil {
		t.Fatalf("vault init: %v", err)
	}
	if res := vlt.AddTenant("Delta", "abc123def456", nil); !res["ok"].(bool) {
		t.Fatalf("add tenant: %v", res)
	}

	auth := rest.NewAuth("", vlt.ActiveKey)
	cache := cachepkg.New()
	deps := &Deps{
		Cfg:     &config.Config{Port: "8080"},
		Vault:   vlt,
		Auth:    auth,
		Rest:    rest.New(upstream.URL, auth),
		Guard:   &httpx.Guard{Port: "8080", MutatingPaths: httpx.DefaultMutatingPaths()},
		Cache:   cache,
		Account: account.New(csp.URL, "abc123def456", auth, cache),
		Audit: audit.New(filepath.Join(dir, "audit_log.jsonl"), "app-v-test", "test-instance",
			audit.Options{TrustDir: t.TempDir()}),
		// A real (if empty) provisioning engine, not nil. With nil, disabling the
		// lock to prove its refusals are load-bearing makes the FIRST teardown
		// case panic in SiteTemplateRelPaths and kill the test binary, so the
		// remaining cases never get to demonstrate anything. That panic was a real
		// defect and is fixed separately — see recoverStream in provision.go and
		// stream_panic_test.go — but this test should be proving the lock, not
		// tripping over that.
		Provision: provision.New(rest.New(upstream.URL, auth), filepath.Join(dir, "templates")),
		Static:    http.NotFoundHandler(),
	}
	return New(deps), deps, &hits
}

func lockReq(method, path string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader("{}"))
	r.Header.Set("Content-Type", "application/json")
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> same-origin -> admin, tokenless
	// Sec-Fetch-Site is what the real UI's EventSource sends and what
	// httpx.WriteOKStrict requires of the five SSE provision/teardown streams —
	// they arrive as GETs, so the loopback fallback is deliberately not trusted
	// for them. Without this header those three cases never get past the CSRF
	// gate to reach the write lock at all, and the test would be asserting the
	// wrong refusal. (Found exactly that way: the first run returned
	// "forbidden — write not authorized" instead of the write lock's reason.)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	return r
}

func bodyOf(t *testing.T, rr *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode body %q: %v", rr.Body.String(), err)
	}
	return m
}

// TestWriteRefusedByDefault is the whole point: a brand-new tenant is read-only.
// Nobody has to remember to lock it.
func TestWriteRefusedByDefault(t *testing.T) {
	h, _, hits := lockedTestServer(t)

	for _, tc := range []struct{ method, path string }{
		{"GET", "/api/teardown/seed-demo/stream?confirm=DELETE&dry=0"},
		{"GET", "/api/teardown/site/stream?confirm=DELETE&dry=0"},
		{"GET", "/api/provision/seed-demo/stream"},
		{"POST", "/api/teardown/block"},
		{"POST", "/api/provision/block"},
		{"POST", "/api/dns/records"},
		{"DELETE", "/api/dns/records/some-id"},
		{"DELETE", "/api/ipam/addresses/some-id"},
		{"DELETE", "/api/edit/dns_zone/some-id"},
		{"POST", "/api/selfservice/allocate"},
		{"POST", "/api/block-domain"},
		{"POST", "/api/actions/some-id/status"},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			before := *hits
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, lockReq(tc.method, tc.path))

			if rr.Code != http.StatusForbidden {
				t.Fatalf("want 403 for a read-only tenant, got %d: %s", rr.Code, rr.Body.String())
			}
			// The refusal must be attributable, not a bare "forbidden".
			b := bodyOf(t, rr)
			if reason, _ := b["reason"].(string); reason != "tenant-read-only" {
				t.Errorf("want reason tenant-read-only, got %q (body %s)", reason, rr.Body.String())
			}
			if msg, _ := b["error"].(string); !strings.Contains(msg, "Delta") {
				t.Errorf("refusal should name the tenant so an operator can act on it, got %q", msg)
			}
			// THE ASSERTION THAT MATTERS. 403 with the delete already sent would
			// be worse than no control at all.
			if *hits != before {
				t.Errorf("refused request still reached the upstream (%d -> %d calls) — it refused AFTER acting", before, *hits)
			}
		})
	}
}

// TestReadsAndLocalWritesStillWork guards the opposite error: a lock that is so
// eager it stops you reading a tenant, or saving a local view, is a broken
// dashboard rather than a safe one. Without this, "refuse everything" would pass
// the test above.
func TestReadsAndLocalWritesStillWork(t *testing.T) {
	h, _, _ := lockedTestServer(t)

	for _, tc := range []struct {
		method, path string
	}{
		{"GET", "/api/ipam/subnets"},
		{"GET", "/api/dns/zones"},
		{"GET", "/api/audit/log"},
		{"GET", "/api/vault/status"},
		{"POST", "/api/alerts/snooze"},
		{"POST", "/api/vault/refresh-names"},
		{"POST", "/api/templates/validate"},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, lockReq(tc.method, tc.path))
			if rr.Code == http.StatusForbidden {
				if b := bodyOf(t, rr); b["reason"] == "tenant-read-only" || b["reason"] == "tenant-unknown" {
					t.Fatalf("the write lock refused %s %s, which does not change the customer's tenant: %s",
						tc.method, tc.path, rr.Body.String())
				}
			}
		})
	}
}

// TestOptInThenWriteReaches proves the permission actually opens the door — a
// lock that refuses even after being opted in is indistinguishable from a lock
// that is simply broken, and would make the whole feature untrustworthy.
func TestOptInThenWriteReaches(t *testing.T) {
	h, d, hits := lockedTestServer(t)
	id := vault.WriteID(d.Vault.ActiveTenantID(), vault.NoSwitch)

	if res := d.Vault.SetWritable(id, true); !res["ok"].(bool) {
		t.Fatalf("SetWritable: %v", res)
	}

	before := *hits
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, lockReq("POST", "/api/dns/records"))

	if rr.Code == http.StatusForbidden {
		if b := bodyOf(t, rr); b["reason"] == "tenant-read-only" {
			t.Fatalf("tenant was marked writable but the lock still refused: %s", rr.Body.String())
		}
	}
	// The handler beyond the lock may 400 on an empty body — what this asserts is
	// that the request got PAST the lock and was allowed to act.
	if *hits == before && rr.Code >= 500 {
		t.Fatalf("request never reached the upstream and failed with %d: %s", rr.Code, rr.Body.String())
	}
}

// TestRevokeClosesItAgain — the permission has to be removable, and removing it
// has to take effect immediately rather than at the next restart.
func TestRevokeClosesItAgain(t *testing.T) {
	h, d, _ := lockedTestServer(t)
	id := vault.WriteID(d.Vault.ActiveTenantID(), vault.NoSwitch)

	d.Vault.SetWritable(id, true)
	if !d.Vault.WriteAllowed(id) {
		t.Fatal("SetWritable(true) did not take")
	}
	d.Vault.SetWritable(id, false)

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, lockReq("GET", "/api/teardown/seed-demo/stream?confirm=DELETE&dry=0"))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("want 403 after revoking, got %d: %s", rr.Code, rr.Body.String())
	}
}

// TestSwitchedAccountDoesNotInheritPermission is the hole that keying the
// permission on the stored connection alone would leave, and the reason the
// identity is a (connection, CSP account) pair.
//
// Marking "Delta" writable must NOT make writes land in HERE Technologies just
// because someone used the portal account switcher. The switch is performed by
// the real account.Manager against a fake CSP, not simulated — a test that
// stubbed the mechanism would prove nothing about the mechanism.
func TestSwitchedAccountDoesNotInheritPermission(t *testing.T) {
	h, d, hits := lockedTestServer(t)
	home := vault.WriteID(d.Vault.ActiveTenantID(), vault.NoSwitch)
	if res := d.Vault.SetWritable(home, true); !res["ok"].(bool) {
		t.Fatalf("SetWritable: %v", res)
	}

	// Precondition: with no switch in force, the home identity is writable.
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, lockReq("POST", "/api/dns/records"))
	if rr.Code == http.StatusForbidden {
		if b := bodyOf(t, rr); b["reason"] == "tenant-read-only" {
			t.Fatalf("precondition failed: the home tenant should be writable, got %s", rr.Body.String())
		}
	}

	// Switch to a DIFFERENT CSP account through the real Manager.
	if res, err := d.Account.SwitchAccount("acct-here"); err != nil || !res["ok"].(bool) {
		t.Fatalf("SwitchAccount: %v %v", res, err)
	}
	if !d.Auth.OverrideActive() {
		t.Fatal("the switch did not set the auth override, so this test is not exercising a switch at all")
	}

	before := *hits
	rr2 := httptest.NewRecorder()
	h.ServeHTTP(rr2, lockReq("POST", "/api/dns/records"))

	if rr2.Code != http.StatusForbidden {
		t.Fatalf("a write into a switched-in account nobody opted in must refuse, got %d: %s", rr2.Code, rr2.Body.String())
	}
	b2 := bodyOf(t, rr2)
	if reason, _ := b2["reason"].(string); reason != "tenant-read-only" {
		t.Errorf("want reason tenant-read-only, got %q (body %s)", reason, rr2.Body.String())
	}
	if tenant, _ := b2["tenant"].(string); !strings.HasSuffix(tenant, "/acct-here") {
		t.Errorf("the refusal should name the switched-in account, got tenant=%q", tenant)
	}
	if *hits != before {
		t.Errorf("refused request still reached the upstream (%d -> %d) — it refused after acting", before, *hits)
	}

	// And opting THAT identity in specifically must open it, without ever having
	// touched the home tenant's permission.
	switched := vault.WriteID(d.Vault.ActiveTenantID(), "acct-here")
	d.Vault.SetWritable(switched, true)
	rr3 := httptest.NewRecorder()
	h.ServeHTTP(rr3, lockReq("POST", "/api/dns/records"))
	if rr3.Code == http.StatusForbidden {
		if b := bodyOf(t, rr3); b["reason"] == "tenant-read-only" {
			t.Fatalf("the switched-in account was opted in but the lock still refused: %s", rr3.Body.String())
		}
	}
}

// TestUnattributableSwitchRefuses covers the other switch case: an override is in
// force but this process cannot say which account it belongs to. "I do not know
// where this write would land" is the strongest possible reason to refuse, and it
// must not degrade into using the home tenant's permission.
func TestUnattributableSwitchRefuses(t *testing.T) {
	h, d, hits := lockedTestServer(t)
	d.Vault.SetWritable(vault.WriteID(d.Vault.ActiveTenantID(), vault.NoSwitch), true)

	// An override with no resolved account behind it — what a partially completed
	// switch, or a future caller setting the slot directly, would leave.
	d.Account = nil
	d.Auth.SetOverride("Bearer some-switched-in-jwt")

	before := *hits
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, lockReq("POST", "/api/dns/records"))

	if rr.Code != http.StatusForbidden {
		t.Fatalf("want 403 when the write target cannot be identified, got %d: %s", rr.Code, rr.Body.String())
	}
	b := bodyOf(t, rr)
	if reason, _ := b["reason"].(string); reason != "tenant-unknown" {
		t.Errorf("want reason tenant-unknown, got %q (body %s)", reason, rr.Body.String())
	}
	// A read that failed and a read that succeeded and found nothing must never
	// look the same: this must not claim the tenant is merely read-only.
	if msg, _ := b["error"].(string); !strings.Contains(msg, "cannot determine") {
		t.Errorf("the refusal must say the target is unknown, not that it is read-only; got %q", msg)
	}
	if *hits != before {
		t.Errorf("refused request still reached the upstream (%d -> %d)", before, *hits)
	}
}
