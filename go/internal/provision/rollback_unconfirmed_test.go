package provision

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A rollback delete answered 202 was taken but not confirmed, so the object
// stays on the list of things left to check. A plain 200 or 204 is done.
func TestRollback_AcceptedDeleteIsNotCountedAsDeleted(t *testing.T) {
	for _, tc := range []struct {
		st      int
		unknown bool
	}{{202, true}, {200, false}, {204, false}} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.st)
		}))
		t.Cleanup(srv.Close)
		e := newTestEngine(srv)

		var blockSteps, siteSteps []string
		blockResult := M{"blocks_created": []any{M{"id": "ipam/address_block/b1", "address": "10.0.0.0", "cidr": 16}}}
		(&BlockProvisioner{e: e, emit: collectSteps(&blockSteps)}).rollback(blockResult)
		sitePartial := M{"subnets": []any{M{"id": "ipam/subnet/s1", "address": "10.0.1.0/24"}}}
		(&SiteProvisioner{e: e, emit: collectSteps(&siteSteps)}).rollback(sitePartial)

		for name, got := range map[string]struct {
			residual []any
			steps    []string
		}{
			"block": {getList(blockResult, "rollback_residual"), blockSteps},
			"site":  {getList(sitePartial, "rollback_residual"), siteSteps},
		} {
			if (len(got.residual) == 1) != tc.unknown {
				t.Fatalf("%s, status %d: residual = %v", name, tc.st, got.residual)
			}
			log := strings.Join(got.steps, "\n")
			if strings.Contains(log, "may or may not") != tc.unknown || strings.Contains(log, "failed to delete") {
				t.Fatalf("%s, status %d: steps = %s", name, tc.st, log)
			}
		}
	}
}
