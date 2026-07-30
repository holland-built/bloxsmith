package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"bloxsmith/internal/rest"
)

// ACTUALLY RE-CREATING WHAT A TEARDOWN DELETED.
//
// restorecli_test.go covers the plan half, which never touches a network.
// --apply does, so every test here drives applyRestore against an
// httptest.Server standing in for the tenant — never a real one — and the
// central assertion on every refusal test is that the fake upstream received
// ZERO writes: a refusal that already wrote is worse than no refusal at all.

// applyFixtureDoc builds a hand-authored site-teardown export whose object ids
// match applyFakeUpstream below exactly, so tests can control precisely which
// objects "already exist" and which do not. Hand-authored rather than driven
// through the real ExportWriter (as realSiteExport in restorecli_test.go is):
// what is under test here is applyRestore's behavior given a plan, not whether
// planFromExport agrees with the writer — that is already covered, and this
// needs ids it can predict, which a live-generated fixture would not give it.
func applyFixtureDoc(tenantID, target string) *exportDoc {
	tenant := map[string]any{}
	if tenantID != "" {
		tenant = map[string]any{"id": tenantID, "label": "Fake Tenant"}
	}
	return &exportDoc{
		Format: exportFormatKnown,
		Kind:   "teardown-site",
		Target: target,
		Tenant: tenant,
		Plan: map[string]any{
			"ip_space_object": map[string]any{"id": "ipam/ip_space/sp-1", "name": "default"},
			"dns_view_object": map[string]any{"id": "dns/view/v-1", "name": "default"},
			"subnets": []any{
				map[string]any{"id": "ipam/subnet/sn-1", "address": "10.20.0.0", "cidr": float64(24), "name": "ams-general"},
			},
			"dhcp_ranges": []any{
				map[string]any{"id": "ipam/range/r-1", "start": "10.20.0.100", "end": "10.20.0.200", "name": "ams-pool"},
			},
			"forward_zone": map[string]any{
				"fqdn": "site-ams.example.com.",
				"object": map[string]any{
					"id": "dns/auth_zone/z-1", "fqdn": "site-ams.example.com.",
				},
			},
			"reverse_zones": []any{},
			"hosts": []any{
				map[string]any{"id": "ipam/host/h-1", "name": "printer.site-ams.example.com"},
			},
		},
	}
}

// applyFakeUpstream is the tenant --apply talks to. existing marks which
// recorded ids GETs should report as already there (200); everything else is
// 404. fail maps a create PATH to the status code it should fail with. Every
// non-GET request is counted, so a refusal test can assert zero of them fired.
func applyFakeUpstream(t *testing.T, existing map[string]bool, fail map[string]int) (client *rest.Client, postPaths *[]string, writes *int) {
	t.Helper()
	var paths []string
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodGet:
			id := strings.TrimPrefix(r.URL.Path, "/api/ddi/v1/")
			if existing[id] {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"id":"` + id + `"}`))
				return
			}
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"not found"}`))
		case http.MethodPost:
			n++
			paths = append(paths, r.URL.Path)
			if code, ok := fail[r.URL.Path]; ok {
				w.WriteHeader(code)
				_, _ = w.Write([]byte(`{"error":"boom"}`))
				return
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"new-id"}`))
		default:
			// PATCH/DELETE/PUT: nothing under test should ever send one of
			// these through --apply, but if it did it would be a write too.
			n++
			paths = append(paths, r.URL.Path)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(srv.Close)
	auth := rest.NewAuth("test-key", func() string { return "" })
	return rest.New(srv.URL, auth), &paths, &n
}

const fixtureTenant = "conn-abc/-"
const fixtureTarget = "ams"

// steps in dependency order, matching applyFixtureDoc: prereqs first (never
// created), then subnet, dhcp_range, dns_zone, host — the same order
// planFromExport already computes and restorecli_test.go already proves.
var fixtureCreatePaths = []string{
	"/api/ddi/v1/ipam/subnet",
	"/api/ddi/v1/ipam/range",
	"/api/ddi/v1/dns/auth_zone",
	"/api/ddi/v1/ipam/host",
}

// prereqsExist is the "existing" set every non-refusal test needs: both
// prerequisites present, nothing else.
func prereqsExist() map[string]bool {
	return map[string]bool{"ipam/ip_space/sp-1": true, "dns/view/v-1": true}
}

func planSteps(t *testing.T, doc *exportDoc) []restoreStep {
	t.Helper()
	steps, err := planFromExport(doc)
	if err != nil {
		t.Fatalf("planFromExport: %v", err)
	}
	return steps
}

// --- refusals: every one of these must write NOTHING to the fake upstream ---

func TestApplyRefusesOnTenantMismatch(t *testing.T) {
	doc := applyFixtureDoc(fixtureTenant, fixtureTarget)
	steps := planSteps(t, doc)
	client, _, writes := applyFakeUpstream(t, prereqsExist(), nil)

	out := applyRestore(client, doc, steps, "some-other-tenant/-", true, fixtureTarget)
	if out.Refused == "" {
		t.Fatal("expected a refusal on tenant mismatch, got none")
	}
	if !strings.Contains(out.Refused, fixtureTenant) || !strings.Contains(out.Refused, "some-other-tenant/-") {
		t.Fatalf("refusal does not name both tenants: %q", out.Refused)
	}
	if *writes != 0 {
		t.Fatalf("tenant mismatch wrote %d time(s) to the fake upstream, want 0", *writes)
	}
	if len(out.Created) != 0 {
		t.Fatalf("tenant mismatch reports %d created, want 0", len(out.Created))
	}
}

func TestApplyRefusesWhenExportHasNoRecordedTenant(t *testing.T) {
	doc := applyFixtureDoc("", fixtureTarget) // no tenant recorded at all
	steps := planSteps(t, doc)
	client, _, writes := applyFakeUpstream(t, prereqsExist(), nil)

	out := applyRestore(client, doc, steps, fixtureTenant, true, fixtureTarget)
	if out.Refused == "" {
		t.Fatal("expected a refusal for an export with no recorded tenant, got none")
	}
	if !strings.Contains(out.Refused, "does not record") {
		t.Fatalf("refusal does not say the tenant is unrecorded: %q", out.Refused)
	}
	if *writes != 0 {
		t.Fatalf("missing-tenant export wrote %d time(s), want 0", *writes)
	}
}

func TestApplyRefusesWhenTenantIsNotWritable(t *testing.T) {
	doc := applyFixtureDoc(fixtureTenant, fixtureTarget)
	steps := planSteps(t, doc)
	client, _, writes := applyFakeUpstream(t, prereqsExist(), nil)

	out := applyRestore(client, doc, steps, fixtureTenant, false /* not writable */, fixtureTarget)
	if out.Refused == "" {
		t.Fatal("expected a refusal for a non-writable tenant, got none")
	}
	if !strings.Contains(out.Refused, "not marked writable") {
		t.Fatalf("refusal does not say why: %q", out.Refused)
	}
	if *writes != 0 {
		t.Fatalf("non-writable tenant wrote %d time(s), want 0", *writes)
	}
}

func TestApplyRefusesWithoutConfirm(t *testing.T) {
	doc := applyFixtureDoc(fixtureTenant, fixtureTarget)
	steps := planSteps(t, doc)
	client, _, writes := applyFakeUpstream(t, prereqsExist(), nil)

	// No confirm at all.
	out := applyRestore(client, doc, steps, fixtureTenant, true, "")
	if out.Refused == "" {
		t.Fatal("expected a refusal with no --confirm, got none")
	}
	if *writes != 0 {
		t.Fatalf("missing --confirm wrote %d time(s), want 0", *writes)
	}

	// Wrong confirm.
	out = applyRestore(client, doc, steps, fixtureTenant, true, "not-"+fixtureTarget)
	if out.Refused == "" {
		t.Fatal("expected a refusal with a mismatched --confirm, got none")
	}
	if *writes != 0 {
		t.Fatalf("mismatched --confirm wrote %d time(s), want 0", *writes)
	}
}

func TestApplyRefusesWhenPrerequisiteMissing(t *testing.T) {
	doc := applyFixtureDoc(fixtureTenant, fixtureTarget)
	steps := planSteps(t, doc)
	// Neither prerequisite exists upstream.
	client, _, writes := applyFakeUpstream(t, map[string]bool{}, nil)

	out := applyRestore(client, doc, steps, fixtureTenant, true, fixtureTarget)
	if out.Refused == "" {
		t.Fatal("expected a refusal for a missing prerequisite, got none")
	}
	if !strings.Contains(out.Refused, "ip_space") {
		t.Fatalf("refusal does not name which prerequisite is missing: %q", out.Refused)
	}
	if *writes != 0 {
		t.Fatalf("missing prerequisite wrote %d time(s), want 0", *writes)
	}
	if len(out.Created) != 0 {
		t.Fatalf("missing prerequisite reports %d created, want 0", len(out.Created))
	}
}

// --- the actual creation behavior ------------------------------------------

func TestApplyHappyPathCreatesInDependencyOrder(t *testing.T) {
	doc := applyFixtureDoc(fixtureTenant, fixtureTarget)
	steps := planSteps(t, doc)
	client, posted, writes := applyFakeUpstream(t, prereqsExist(), nil)

	out := applyRestore(client, doc, steps, fixtureTenant, true, fixtureTarget)
	if out.Refused != "" {
		t.Fatalf("happy path refused: %s", out.Refused)
	}
	if out.StoppedAt != nil {
		t.Fatalf("happy path stopped at %+v: %v", out.StoppedAt, out.StoppedErr)
	}
	if len(out.Created) != 4 {
		t.Fatalf("created %d objects, want 4 (subnet, dhcp_range, dns_zone, host): %+v", len(out.Created), out.Created)
	}
	if *writes != 4 {
		t.Fatalf("fake upstream saw %d writes, want 4", *writes)
	}
	if len(*posted) != len(fixtureCreatePaths) {
		t.Fatalf("posted %d paths, want %d", len(*posted), len(fixtureCreatePaths))
	}
	for i, want := range fixtureCreatePaths {
		if (*posted)[i] != want {
			t.Fatalf("POST %d was %s, want %s (order: %v) — dependency order was not followed",
				i, (*posted)[i], want, *posted)
		}
	}
}

func TestApplySkipsWhatAlreadyExists(t *testing.T) {
	doc := applyFixtureDoc(fixtureTenant, fixtureTarget)
	steps := planSteps(t, doc)
	existing := prereqsExist()
	existing["ipam/subnet/sn-1"] = true // the subnet is already back
	client, posted, writes := applyFakeUpstream(t, existing, nil)

	out := applyRestore(client, doc, steps, fixtureTenant, true, fixtureTarget)
	if out.Refused != "" {
		t.Fatalf("refused: %s", out.Refused)
	}
	if len(out.Skipped) != 1 || out.Skipped[0].Kind != "subnet" {
		t.Fatalf("skipped = %+v, want exactly the subnet", out.Skipped)
	}
	if len(out.Created) != 3 {
		t.Fatalf("created %d objects, want 3 (dhcp_range, dns_zone, host — subnet skipped): %+v", len(out.Created), out.Created)
	}
	if *writes != 3 {
		t.Fatalf("fake upstream saw %d writes, want 3 (the subnet must not be duplicated)", *writes)
	}
	for _, p := range *posted {
		if p == "/api/ddi/v1/ipam/subnet" {
			t.Fatal("the already-existing subnet was POSTed anyway — it would be duplicated")
		}
	}
}

func TestApplyStopsOnFirstFailureAndReportsWhatWasCreated(t *testing.T) {
	doc := applyFixtureDoc(fixtureTenant, fixtureTarget)
	steps := planSteps(t, doc)
	// The DHCP range create fails; subnet (which comes before it) must still
	// have been created, and nothing after it (dns_zone, host) attempted.
	client, posted, _ := applyFakeUpstream(t, prereqsExist(), map[string]int{
		"/api/ddi/v1/ipam/range": http.StatusInternalServerError,
	})

	out := applyRestore(client, doc, steps, fixtureTenant, true, fixtureTarget)
	if out.Refused != "" {
		t.Fatalf("this should stop partway, not refuse outright: %s", out.Refused)
	}
	if out.StoppedAt == nil {
		t.Fatal("expected the run to stop, but it reports no stopping point")
	}
	if out.StoppedAt.Kind != "dhcp_range" {
		t.Fatalf("stopped at %s, want dhcp_range", out.StoppedAt.Kind)
	}
	if out.StoppedErr == nil {
		t.Fatal("stopped with no error recorded")
	}
	if len(out.Created) != 1 || out.Created[0].Kind != "subnet" {
		t.Fatalf("created = %+v, want exactly the subnet (created before the failure)", out.Created)
	}
	if len(*posted) != 2 {
		t.Fatalf("fake upstream saw %d POSTs, want exactly 2 (subnet, then the failed range) — "+
			"anything after the failure must not have been attempted: %v", len(*posted), *posted)
	}
	for _, p := range *posted {
		if p == "/api/ddi/v1/dns/auth_zone" || p == "/api/ddi/v1/ipam/host" {
			t.Fatalf("a step AFTER the failure (%s) was attempted — stop-on-first-failure was not honored", p)
		}
	}
}
