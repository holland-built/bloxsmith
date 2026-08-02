package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"bloxsmith/internal/vault"
)

// THE DEFECT THIS FILE PINS DOWN: the write lock classified by PATH alone, so
// GET /api/dns/records — the record list the Self-Service tab renders, wired in
// ipam.go as dnsRecordsGet — was refused 403 on every tenant nobody had marked
// writable, with a body that said "Nothing was changed" about a request that
// never tried to change anything. Confirmed live before the fix.
//
// The fix is a verb, not a deletion. /api/dns/records has to stay in
// tenantWritePaths because edit.go registers POST and PATCH on the same path,
// and the five provision/teardown SSE streams have to stay gated on GET because
// EventSource cannot issue anything else. So the interesting cases are all on
// the boundary, and all four are here:
//
//	GET  /api/dns/records          read   -> through
//	POST/PATCH /api/dns/records    write  -> refused
//	GET  /api/{provision,teardown}/*/stream  write -> refused (the CSRF/SSE case)
//	DELETE /api/dns/records/{id} and the other prefixes -> refused
//
// Mutation-tested both ways: reverting the fix fails the first, and widening it
// to "a GET is never a tenant write" fails the third.

// refusalRows counts the write-lock refusals ON DISK. The status code alone
// cannot tell "was not refused" from "was refused and the row was lost", and the
// row is the only durable evidence an operator was ever stopped — so a read that
// is let through must leave none, and a write that is stopped must leave one.
func refusalRows(t *testing.T, d *Deps) int {
	t.Helper()
	entries, skipped, err := d.Audit.Read()
	if err != nil {
		t.Fatalf("read audit log: %v", err)
	}
	if skipped > 0 {
		t.Fatalf("audit log dropped %d line(s) on read — the count below would be a guess", skipped)
	}
	n := 0
	for _, e := range entries {
		if ev, _ := e["event"].(string); ev == "write-refused-read-only" {
			n++
		}
	}
	return n
}

// assertLockRefused sends one request through the REAL chain server.New builds
// and requires the WRITE LOCK to be what turned it away — the reason is checked,
// not just the 403, because the CSRF guard's own 403 would otherwise stand in
// for a refusal that never happened.
func assertLockRefused(t *testing.T, h http.Handler, d *Deps, hits *int, method, path string) {
	t.Helper()
	beforeHits, beforeRows := *hits, refusalRows(t, d)

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, lockReq(method, path))

	if rr.Code != http.StatusForbidden {
		t.Fatalf("%s %s changes the customer's tenant but the server answered %d instead of refusing: %s",
			method, path, rr.Code, rr.Body.String())
	}
	if reason, _ := bodyOf(t, rr)["reason"].(string); reason != "tenant-read-only" {
		t.Fatalf("%s %s was refused with reason %q, not by the write lock — this case proves nothing about the lock: %s",
			method, path, reason, rr.Body.String())
	}
	if *hits != beforeHits {
		t.Errorf("%s %s was refused but still reached the upstream (%d -> %d) — it refused AFTER acting",
			method, path, beforeHits, *hits)
	}
	if got := refusalRows(t, d); got != beforeRows+1 {
		t.Errorf("%s %s was refused but the audit log gained %d write-refused-read-only rows, want 1 — "+
			"a refusal nobody can prove afterwards", method, path, got-beforeRows)
	}
}

// TestRecordListReadIsAllowedOnReadOnlyTenant is the regression. A GET that
// shares its path with a write must reach its handler, and must leave no
// refusal behind.
func TestRecordListReadIsAllowedOnReadOnlyTenant(t *testing.T) {
	h, d, hits := lockedTestServer(t)
	if d.Vault.WriteAllowed(vault.WriteID(d.Vault.ActiveTenantID(), vault.NoSwitch)) {
		t.Fatal("precondition: the tenant must be read-only, or this asserts nothing")
	}
	beforeRows := refusalRows(t, d)

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, lockReq("GET", "/api/dns/records?zone=example.com"))

	if rr.Code == http.StatusForbidden {
		if reason, _ := bodyOf(t, rr)["reason"].(string); reason == "tenant-read-only" || reason == "tenant-unknown" {
			t.Fatalf("the write lock refused GET /api/dns/records, which only LISTS a zone's records — "+
				"the Self-Service tab's record list is broken on every tenant nobody opted in: %s", rr.Body.String())
		}
	}
	if rr.Code != http.StatusOK {
		t.Fatalf("GET /api/dns/records: want 200 from the read handler, got %d: %s", rr.Code, rr.Body.String())
	}
	// Reaching the upstream is the difference between "not refused" and
	// "actually served": a 200 short-circuited by some other gate would satisfy
	// the check above and still leave the tab empty.
	if *hits == 0 {
		t.Error("GET /api/dns/records answered 200 without ever calling upstream — it was not served, only not refused")
	}
	if got := refusalRows(t, d); got != beforeRows {
		t.Errorf("a read left %d new write-refused-read-only row(s) in the audit log — "+
			"the log now claims an operator was stopped from changing something they never asked to change", got-beforeRows)
	}
}

// TestWritesOnTheRecordPathAreStillRefused is the other half of the same path.
// Dropping /api/dns/records from tenantWritePaths would fix the read by
// unlocking the writes, which is the failure this forbids.
func TestWritesOnTheRecordPathAreStillRefused(t *testing.T) {
	h, d, hits := lockedTestServer(t)
	for _, method := range []string{"POST", "PATCH"} {
		t.Run(method, func(t *testing.T) {
			assertLockRefused(t, h, d, hits, method, "/api/dns/records")
		})
	}
}

// TestSSEStreamsStillRefusedAsGET is the case that must never regress. All five
// provision/teardown streams arrive as GETs because EventSource cannot issue
// anything else, and they are the routes that destroy live sites and demo data.
// A verb rule that let GETs through would unlock exactly these.
func TestSSEStreamsStillRefusedAsGET(t *testing.T) {
	h, d, hits := lockedTestServer(t)
	for _, path := range []string{
		"/api/provision/stream",
		"/api/provision/site/stream",
		"/api/provision/seed-demo/stream",
		"/api/teardown/site/stream?confirm=DELETE&dry=0",
		"/api/teardown/seed-demo/stream?confirm=DELETE&dry=0",
	} {
		t.Run(path, func(t *testing.T) {
			assertLockRefused(t, h, d, hits, "GET", path)
		})
	}
}

// TestPrefixWriteRoutesStillRefused covers tenantWritePrefixes: the subtree
// routes, including the empty-id case that must be gated rather than falling
// through as a route miss.
func TestPrefixWriteRoutesStillRefused(t *testing.T) {
	h, d, hits := gatedRouteServer(t)
	for _, tc := range []struct{ method, path string }{
		{"DELETE", "/api/dns/records/some-record-id"},
		{"DELETE", "/api/ipam/addresses/some-address-id"},
		{"DELETE", "/api/edit/dns_zone/some-id"},
		{"POST", "/api/edit/"},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			assertLockRefused(t, h, d, hits, tc.method, tc.path)
		})
	}
}
