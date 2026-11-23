package provision

import (
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"

	"bloxsmith/internal/freecheck"
)

// A create that got no clear answer must not be logged as failed.
func TestSiteHostCreate_NoClearAnswerIsNotCalledFailed(t *testing.T) {
	for _, tc := range []struct {
		st     int
		failed bool
	}{{500, false}, {503, false}, {202, false}, {400, true}, {403, true}} {
		e, f := newSiteRollbackHarness(t)
		f.hostStatus = tc.st
		p := e.NewSiteProvisioner(siteRollbackConfig(false), func(M) {})
		p.free = freecheck.NewSnapshot(nil)
		_, err := p.Provision()
		if err == nil {
			t.Fatalf("status %d: want an error", tc.st)
		}
		if got := strings.Contains(err.Error(), "Failed to create host"); got != tc.failed {
			t.Fatalf("status %d: error = %q, want Failed=%v", tc.st, err, tc.failed)
		}
		if !tc.failed && !strings.Contains(err.Error(), "may or may not") {
			t.Fatalf("status %d: error = %q", tc.st, err)
		}
	}
}

func TestBlockTeardown_NoClearAnswerIsNotCalledFailed(t *testing.T) {
	_, err, _, _ := runBlockTeardown(t, partialParentID) // the fake answers 500
	if err == nil || strings.Contains(err.Error(), "Failed to delete") || !strings.Contains(err.Error(), "may or may not") {
		t.Fatalf("error = %v, want an unknown result", err)
	}
}

// Every create, delete and retag failure in these files goes through the one
// helper, so a new line cannot quietly say Failed on a 500.
func TestProvisionWriteFailuresUseTheHelper(t *testing.T) {
	direct := regexp.MustCompile(`perr\("Failed to (create|delete|retag)`)
	for _, name := range []string{"block.go", "site.go", "decommission.go"} {
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if m := direct.Find(src); m != nil {
			t.Fatalf("%s still builds %q by hand", name, m)
		}
	}
}

func TestRollbackIncompleteStep_CountsEachKind(t *testing.T) {
	got := rollbackIncompleteStep([]any{
		M{"id": "a", "status": 500}, M{"id": "b", "status": 0},
		M{"id": "c", "status": 403},
		M{"id": "", "status": 0, "reason": "no id"},
	})
	for _, want := range []string{"2 may or may not be deleted", "1 refused by Infoblox", "1 never sent"} {
		if !strings.Contains(got, want) {
			t.Fatalf("step = %q, want %q", got, want)
		}
	}
}

func TestSiteSharedPick_CleanupWithNoAnswerIsNotCalledFailed(t *testing.T) {
	for _, tc := range []struct {
		st   int
		want string
	}{
		{500, "may or may not have been removed"},
		{403, "could not be removed"},
	} {
		e, f := newSiteRollbackHarness(t)
		f.inventorySubnets = sharedSubnet
		f.deleteStatus = func(string) int { return tc.st }
		cfg := siteRollbackConfig(false)
		cfg.CreateReverseZone = false
		_, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("status %d: error = %v, want %q", tc.st, err, tc.want)
		}
	}
}

func TestSiteCleanCreate_NoClearAnswerIsNotCalledFailed(t *testing.T) {
	for _, tc := range []struct {
		st     int
		failed bool
	}{{500, false}, {501, false}, {202, false}, {403, true}} {
		e, f := newSiteRollbackHarness(t)
		f.inventorySubnets = sharedSubnet
		f.createStatus = tc.st
		cfg := siteRollbackConfig(false)
		cfg.CreateReverseZone = false
		_, err := e.NewSiteProvisioner(cfg, func(M) {}).Provision()
		if err == nil {
			t.Fatalf("status %d: want an error", tc.st)
		}
		if got := strings.Contains(err.Error(), "instead failed"); got != tc.failed {
			t.Fatalf("status %d: error = %q, want failed=%v", tc.st, err, tc.failed)
		}
		if !tc.failed && !strings.Contains(err.Error(), "No clear answer to create the clean subnet 10.10.0.0/24") {
			t.Fatalf("status %d: error = %q, want the shared message", tc.st, err)
		}
	}
}

// The tests that used to read "Failed to ..." on a 500 now read the unknown
// wording, so this keeps the refused wording pinned for every action.
func TestFailedWrite_OnlyAClearRefusalSaysFailed(t *testing.T) {
	for _, action := range []string{"create host", "delete block", "retag block"} {
		for _, st := range []int{400, 401, 403, 404, 409} {
			if got := failedWrite(action, "x", st).Error(); !strings.HasPrefix(got, "Failed to "+action+" x: status") {
				t.Fatalf("%s %d = %q", action, st, got)
			}
		}
		for _, st := range []int{0, 500, 502, 503, 504, 200, 202, 204} {
			if got := failedWrite(action, "x", st).Error(); !strings.HasPrefix(got, "No clear answer to "+action+" x") {
				t.Fatalf("%s %d = %q", action, st, got)
			}
		}
	}
}

func unconfirmedIDs(result M) []string {
	ids := []string{}
	for _, u := range getList(result, "unconfirmed") {
		ids = append(ids, pyStr(asMap(u)["id"]))
	}
	return ids
}

// A 202 on a teardown delete is not called done, and the teardown carries on
// exactly as it did.
func TestSiteTeardown_AcceptedDeleteIsUnknownAndCarriesOn(t *testing.T) {
	all := []string{failFwdZoneID, failRange1ID, failRange2ID, failRevZone1, failRevZone2,
		failSubnet1ID, failSubnet2ID, failHost1ID, failHost2ID}
	for _, tc := range []struct{ id, key string }{
		{failFwdZoneID, "dns_zone_deleted"}, {failRange2ID, "dhcp_ranges_deleted"},
		{failRevZone2, "reverse_zones_deleted"}, {failSubnet2ID, "subnets_deleted"}, {failHost2ID, "hosts_deleted"},
	} {
		e, ft := newFailingHarness(t, tc.id)
		ft.failStatus = 202
		var steps []string
		result, err := e.NewSiteDecommissioner(teardownCfg(false), collectSteps(&steps)).Decommission()
		if err != nil {
			t.Fatalf("%s: %v, want the teardown to carry on", tc.id, err)
		}
		if got := ft.deletedIDs(); !equalStrings(got, all) {
			t.Fatalf("%s: deletes = %v, want every planned delete", tc.id, got)
		}
		if got := unconfirmedIDs(result); !equalStrings(got, []string{tc.id}) {
			t.Fatalf("%s: unconfirmed = %v", tc.id, got)
		}
		if tc.key == "dns_zone_deleted" {
			if result[tc.key] != false {
				t.Fatalf("zone with a 202 reported as deleted: %v", result[tc.key])
			}
		} else if n := len(getList(result, tc.key)); n != 1 {
			t.Fatalf("%s: %s has %d rows, want only the confirmed one", tc.id, tc.key, n)
		}
		if !strings.Contains(strings.Join(steps, "\n"), "may or may not") {
			t.Fatalf("%s: no step says the result is unknown: %v", tc.id, steps)
		}
	}
}

func TestSiteTeardown_Plain200And204StaySuccess(t *testing.T) {
	for _, st := range []int{200, 204} {
		e, ft := newFailingHarness(t, failSubnet2ID)
		ft.failStatus = st
		result, err := e.NewSiteDecommissioner(teardownCfg(false), func(M) {}).Decommission()
		if err != nil || len(getList(result, "subnets_deleted")) != 2 || has(result, "unconfirmed") {
			t.Fatalf("status %d: err %v, result %v", st, err, result)
		}
	}
}

func has(m M, k string) bool { _, ok := m[k]; return ok }

func TestBlockTeardown_AcceptedDeleteIsUnknownAndCarriesOn(t *testing.T) {
	for _, tc := range []struct {
		st      int
		deleted int
		unknown bool
	}{{202, 1, true}, {200, 2, false}, {204, 2, false}} {
		tenant := &partialBlockTenant{failDeleteID: partialChildID, failStatus: tc.st}
		srv := httptest.NewServer(tenant.handler())
		t.Cleanup(srv.Close)
		e := newTestEngine(srv)
		e.Export = &ExportWriter{Dir: t.TempDir()}
		var steps []string
		out, err := e.NewBlockDecommissioner("regional-blocks", "default", false, collectSteps(&steps)).Decommission()
		if err != nil || len(tenant.deletes) != 2 {
			t.Fatalf("status %d: err %v, deletes %v", tc.st, err, tenant.deletes)
		}
		if n := len(getList(out, "blocks_deleted")); n != tc.deleted {
			t.Fatalf("status %d: blocks_deleted = %d, want %d", tc.st, n, tc.deleted)
		}
		if has(out, "unconfirmed") != tc.unknown || strings.Contains(strings.Join(steps, "\n"), "may or may not") != tc.unknown {
			t.Fatalf("status %d: out %v, steps %v", tc.st, out, steps)
		}
	}
}

func TestRetagBlock_AcceptedPatchIsUnknown(t *testing.T) {
	for _, tc := range []struct {
		st      int
		unknown bool
	}{{202, true}, {200, false}, {201, false}, {204, false}} {
		e, f := newBlockAPIHarness(t)
		f.patchStatus = tc.st
		out, err := e.RetagBlock(retagBlockFixture(), "available", false)
		if err != nil {
			t.Fatalf("status %d: %v", tc.st, err)
		}
		if (out["unconfirmed"] == true) != tc.unknown {
			t.Fatalf("status %d: out = %v", tc.st, out)
		}
	}
}
