package provision

import (
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
