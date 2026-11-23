package provision

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"bloxsmith/internal/freecheck"
)

// siteWithAnswer runs a site whose matching write gets a fixed answer.
func siteWithAnswer(t *testing.T, method, suffix string, st int, body string) (M, error) {
	t.Helper()
	_, f := newSiteRollbackHarness(t)
	inner := f.handler()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == method && strings.Contains(r.URL.Path, suffix) {
			w.WriteHeader(st)
			io.WriteString(w, body)
			return
		}
		inner.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	p := newTestEngine(srv).NewSiteProvisioner(siteRollbackConfig(false), func(M) {})
	p.free = freecheck.NewSnapshot(nil)
	return p.Provision()
}

func TestRollback_ResidualSaysWhichAreUnknown(t *testing.T) {
	for _, tc := range []struct {
		st      int
		unknown bool
	}{{202, true}, {500, true}, {403, false}, {409, false}} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.st) }))
		t.Cleanup(srv.Close)
		e := newTestEngine(srv)
		block := M{"blocks_created": []any{M{"id": "ipam/address_block/b1", "address": "10.0.0.0", "cidr": 16}}}
		(&BlockProvisioner{e: e, emit: func(M) {}}).rollback(block)
		site := M{"subnets": []any{M{"id": "ipam/subnet/s1", "address": "10.0.1.0/24"}}}
		(&SiteProvisioner{e: e, emit: func(M) {}}).rollback(site)
		for name, m := range map[string]M{"block": block, "site": site} {
			row := asMap(getList(m, "rollback_residual")[0])
			if (row["unknown"] == true) != tc.unknown {
				t.Fatalf("%s, status %d: residual = %v", name, tc.st, row)
			}
		}
	}
}

func TestSiteProvision_UnknownCreateIsNotNothingCreated(t *testing.T) {
	for _, tc := range []struct {
		st   int
		body string
	}{{503, ""}, {202, `{"results":[{"id":"ipam/subnet/x","address":"10.10.1.0"}]}`}, {200, `{"results":[]}`}, {200, `{}`}} {
		out, err := siteWithAnswer(t, "POST", "/nextavailablesubnet", tc.st, tc.body)
		if err == nil || !strings.Contains(err.Error(), "may or may not") {
			t.Fatalf("status %d %s: err = %v", tc.st, tc.body, err)
		}
		rb := asMap(out["rollback"])
		if rb["outcome"] != "unknown" || !strings.Contains(pyStr(rb["note"]), "may exist") {
			t.Fatalf("status %d %s: rollback = %v", tc.st, tc.body, rb)
		}
	}
	out, err := siteWithAnswer(t, "POST", "/nextavailablesubnet", 403, `{}`)
	if err == nil || asMap(out["rollback"])["outcome"] != "not_needed" {
		t.Fatalf("403: err %v, rollback %v", err, out["rollback"])
	}
}

// Cleanup removed what it knew about, but the create that stopped the run may
// have landed, so the page must not say nothing was left behind.
func TestSiteProvision_UnknownHostCreateIsNotComplete(t *testing.T) {
	e, f := newSiteRollbackHarness(t)
	f.hostStatus = 503
	p := e.NewSiteProvisioner(siteRollbackConfig(false), func(M) {})
	p.free = freecheck.NewSnapshot(nil)
	out, err := p.Provision()
	if rb := asMap(out["rollback"]); err == nil || rb["outcome"] != "unknown" || !strings.Contains(pyStr(rb["note"]), "may exist") {
		t.Fatalf("err %v, rollback %v", err, out["rollback"])
	}
}

func TestBlockProvision_UnknownCreateIsNotNothingCreated(t *testing.T) {
	for _, tc := range []struct {
		st      int
		outcome string
	}{{503, "unknown"}, {202, "unknown"}, {403, "not_needed"}} {
		e, f := newBlockAPIHarness(t)
		f.postStatus = tc.st
		out, err := e.NewBlockProvisioner(rollbackBlockConfig(false), func(M) {}).Provision(false)
		if err == nil || asMap(out["rollback"])["outcome"] != tc.outcome {
			t.Fatalf("status %d: err %v, rollback %v", tc.st, err, out["rollback"])
		}
	}
}

func TestSiteSubnetTagging_UnknownIsNotCalledFailed(t *testing.T) {
	for _, tc := range []struct {
		st     int
		failed bool
	}{{500, false}, {202, false}, {403, true}} {
		_, err := siteWithAnswer(t, "PATCH", "/ipam/subnet/", tc.st, `{}`)
		if err == nil || strings.Contains(err.Error(), "tagging failed") != tc.failed {
			t.Fatalf("status %d: err = %v", tc.st, err)
		}
		if !tc.failed && !strings.Contains(err.Error(), "may or may not") {
			t.Fatalf("status %d: err = %v", tc.st, err)
		}
	}
}
