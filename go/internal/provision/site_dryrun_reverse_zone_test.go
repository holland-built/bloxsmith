package provision

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A DRY RUN THAT CANNOT PREVIEW ONE SUBNET MUST STILL FINISH.
//
// createSubnet's dry-run branch is explicit about this: a failed
// nextavailablesubnet lookup is recorded as "(unavailable)" so it is DETECTABLE,
// "but it must still never abort the dry run". createSubnets broke that promise
// one level up — the placeholder is non-empty, so it passed the reverse-zone
// guard, reached CidrToReverseZone, and killed the whole preview with
// `invalid CIDR address: (unavailable)/24`. A transient 500 on one lookup
// destroyed the safe mode operators are told to run first.
//
// SCOPE. These tests pin createSubnets, the level where the promise is broken.
// site_test.go already pins createSubnet's three preview states one level down —
// and that is exactly why the bug was invisible: the guarantee was only ever
// asserted below the layer that violated it.
//
// WHAT IS DELIBERATELY NOT SOFTENED: an address that is merely unparseable, with
// no address_preview marker on it, means the lookup SUCCEEDED and upstream
// returned something that is not an address. That still aborts — see
// TestCreateSubnets_UnmarkedGarbageAddressStillAborts below, and
// TestSiteProvisionDryRunFailureNeverRollsBack in site_rollback_test.go, which
// uses exactly that case as its failure injector.

// reverseZoneSiteConfig is testSiteConfig with the reverse-zone step turned on
// and a one-subnet plan, which is all any of these need.
func reverseZoneSiteConfig(dry bool) *SiteConfig {
	cfg := testSiteConfig()
	cfg.DryRun = dry
	cfg.CreateReverseZone = true
	cfg.SubnetPlan = []SubnetDef{testSubnetDef()}
	return cfg
}

func runCreateSubnets(t *testing.T, cfg *SiteConfig, h http.HandlerFunc) (M, []string, error) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	var steps []string
	p := newTestEngine(srv).NewSiteProvisioner(cfg, func(m M) {
		if s, ok := m["step"]; ok {
			steps = append(steps, pyStr(s))
		}
	})
	result := M{}
	_, err := p.createSubnets(M{"id": "ipam/address_block/b-1"}, result)
	return result, steps, err
}

func stepContaining(steps []string, want string) string {
	for _, s := range steps {
		if strings.Contains(s, want) {
			return s
		}
	}
	return ""
}

// The bug: the preview lookup fails outright.
func TestCreateSubnets_DryRun_FailedPreviewDoesNotAbortTheRun(t *testing.T) {
	result, steps, err := runCreateSubnets(t, reverseZoneSiteConfig(true),
		func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(500)
			w.Write([]byte(`{"error":"boom"}`))
		})

	if err != nil {
		t.Fatalf("createSubnets() error = %v, want nil — createSubnet promises a failed preview "+
			"never aborts the dry run, and this is the level that broke it", err)
	}
	msg := stepContaining(steps, "Cannot preview the reverse zone")
	if msg == "" {
		t.Fatalf("the skipped reverse zone was never mentioned; steps=%v", steps)
	}
	// The operator-safe upstream sentence, not the bare "unavailable" marker:
	// "could not be previewed" with no reason is a dead end.
	if strings.HasSuffix(strings.TrimSpace(msg), "unavailable") {
		t.Fatalf("step = %q, want the upstream reason rather than the bare marker", msg)
	}
	// Nothing may be recorded: a reverse_zones entry with no address behind it
	// would claim an object was planned that cannot be.
	if got := getList(result, "reverse_zones"); len(got) != 0 {
		t.Fatalf("reverse_zones = %v, want empty — no address, so no zone was planned", got)
	}
	// And the subnet preview itself is still recorded, so the run really did
	// carry on rather than skipping everything.
	if got := getList(result, "subnets"); len(got) != 1 {
		t.Fatalf("subnets = %v, want the one previewed subnet", got)
	}
}

// The sibling state: the lookup succeeds and the block is genuinely full. This
// one never aborted, but it skipped in total silence, so a preview under-
// reported what a real run would create and said nothing about it.
func TestCreateSubnets_DryRun_FullBlockSaysWhyTheZoneWasSkipped(t *testing.T) {
	_, steps, err := runCreateSubnets(t, reverseZoneSiteConfig(true),
		func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"results":[]}`))
		})

	if err != nil {
		t.Fatalf("createSubnets() error = %v, want nil", err)
	}
	msg := stepContaining(steps, "Cannot preview the reverse zone")
	if msg == "" {
		t.Fatalf("a silently skipped reverse zone; steps=%v", steps)
	}
	if !strings.Contains(msg, "none-available") {
		t.Fatalf("step = %q, want it to name the none-available state — a full block and a broken "+
			"lookup are different problems and must not read the same", msg)
	}
}

// The happy path must not move: a real preview address still produces a
// reverse_zones entry, marked as not-created so rollback keeps its hands off it.
func TestCreateSubnets_DryRun_GoodPreviewStillPlansTheReverseZone(t *testing.T) {
	result, _, err := runCreateSubnets(t, reverseZoneSiteConfig(true),
		func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"results":[{"address":"10.10.5.0","id":"addr-1"}]}`))
		})

	if err != nil {
		t.Fatalf("createSubnets() error = %v, want nil", err)
	}
	zones := getList(result, "reverse_zones")
	if len(zones) != 1 {
		t.Fatalf("reverse_zones = %v, want one entry", zones)
	}
	z := asMap(zones[0])
	if pyStr(z["fqdn"]) != "5.10.10.in-addr.arpa." {
		t.Fatalf("fqdn = %v, want 5.10.10.in-addr.arpa.", z["fqdn"])
	}
	if truthy(z["created"], true) {
		t.Fatalf("created = %v, want false on a dry run", z["created"])
	}
}

// An unparseable address with NO marker on it is a different thing entirely: the
// lookup succeeded and upstream returned something that is not an address. That
// is an upstream contract violation, and softening it would hide a real fault
// AND break TestSiteProvisionDryRunFailureNeverRollsBack, which relies on it.
func TestCreateSubnets_UnmarkedGarbageAddressStillAborts(t *testing.T) {
	_, _, err := runCreateSubnets(t, reverseZoneSiteConfig(true),
		func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"results":[{"address":"not-an-ip","id":"addr-1"}]}`))
		})

	if err == nil {
		t.Fatal("createSubnets() error = nil — a successful lookup returning a non-address must " +
			"still fail; only the two states createSubnet itself marks are skippable")
	}
	if !strings.Contains(err.Error(), "not-an-ip") {
		t.Fatalf("error = %v, want it to name the bad value", err)
	}
}
