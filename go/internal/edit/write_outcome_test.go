package edit

import (
	"fmt"
	"strings"
	"testing"

	"bloxsmith/internal/rest"
)

// A 2xx that is not the expected success is not a failure: the change may be
// under way.
func TestWriteFailed_AnyOther2xxIsUnknown(t *testing.T) {
	for _, st := range []int{200, 202, 204, 299} {
		if got := writeFailed("create", st); got != rest.OutcomeUnknown {
			t.Errorf("status %d: %q", st, got)
		}
	}
}

// When a release fails, the message must not say the addresses were released.
func TestAllocate_StillReservedAddressesAreCounted(t *testing.T) {
	for _, dns := range []int{400, 409} {
		t.Run(fmt.Sprint(dns), func(t *testing.T) {
			f := newAllocFake(t, allocConfig{allocBody: allocTwoAddresses, dnsStatus: dns, deleteStatuses: []int{204, 500}})
			res, _ := f.client().SelfserviceAllocate(M{
				"subnet_id": "s-42", "count": float64(2), "dry": false,
				"dns": M{"zone_id": "z-1", "name": "web"},
			})
			msg := fmt.Sprint(res["error"])
			if strings.Contains(msg, "released") {
				t.Fatalf("says released while one is still reserved: %q", msg)
			}
			if !strings.Contains(msg, "1 address(es) may still be reserved") || !strings.Contains(msg, "Editor") {
				t.Fatalf("must count what is still reserved and name the Editor: %q", msg)
			}
		})
	}
}
