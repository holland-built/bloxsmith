package provision

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"bloxsmith/internal/rest"
)

// newTestEngine wires an Engine to a rest.Client pointed at the given
// httptest server, mirroring edit package's newTestClient helper.
func newTestEngine(srv *httptest.Server) *Engine {
	auth := rest.NewAuth("test-key", func() string { return "" })
	return New(rest.New(srv.URL, auth), "")
}

func testSiteConfig() *SiteConfig {
	return &SiteConfig{
		Site: "test", Region: "east", Environment: "prod", Owner: "network-team",
		SubnetSize: 24, DryRun: true, ExtraTags: M{},
	}
}

func testSubnetDef() SubnetDef {
	return SubnetDef{Name: "test-net", Purpose: "general", Dhcp: "false"}
}

// --- createSubnet dry-run preview: success / genuine-empty / failed lookup --

func TestCreateSubnet_DryRun_PreviewSucceeds_NoMarker(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[{"address":"10.0.5.0","id":"addr-1"}]}`))
	}))
	defer srv.Close()

	e := newTestEngine(srv)
	p := e.NewSiteProvisioner(testSiteConfig(), func(M) {})
	result := M{}

	out, err := p.createSubnet("block-1", testSubnetDef(), result)
	if err != nil {
		t.Fatalf("createSubnet() error = %v, want nil", err)
	}
	if out["address"] != "10.0.5.0" {
		t.Fatalf("address = %v, want 10.0.5.0", out["address"])
	}
	if _, present := out["address_preview"]; present {
		t.Fatalf("address_preview = %v, want absent on a successful preview", out["address_preview"])
	}
	subnets := result["subnets"].([]any)
	entry := subnets[0].(M)
	if entry["address"] != "10.0.5.0/24" {
		t.Fatalf("plan address = %v, want 10.0.5.0/24", entry["address"])
	}
}

func TestCreateSubnet_DryRun_PreviewGenuinelyEmpty_NoneAvailableMarker(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[]}`))
	}))
	defer srv.Close()

	e := newTestEngine(srv)
	p := e.NewSiteProvisioner(testSiteConfig(), func(M) {})
	result := M{}

	out, err := p.createSubnet("block-1", testSubnetDef(), result)
	if err != nil {
		t.Fatalf("createSubnet() error = %v, want nil (a full block must never abort a dry run)", err)
	}
	if out["dry_run"] != true {
		t.Fatalf("dry_run = %v, want true", out["dry_run"])
	}
	if out["address_preview"] != "none-available" {
		t.Fatalf("address_preview = %v, want none-available", out["address_preview"])
	}
	if _, present := out["reason"]; present {
		t.Fatalf("reason = %v, want absent — a genuinely empty block is not a broken lookup", out["reason"])
	}
	if out["address"] != "" {
		t.Fatalf("address = %v, want empty string (legitimate empty)", out["address"])
	}
}

func TestCreateSubnet_DryRun_PreviewLookupFails_UnavailableMarkerNoAbort(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
	}))
	defer srv.Close()

	e := newTestEngine(srv)
	p := e.NewSiteProvisioner(testSiteConfig(), func(M) {})
	result := M{}

	out, err := p.createSubnet("block-1", testSubnetDef(), result)
	if err != nil {
		t.Fatalf("createSubnet() error = %v, want nil — a failed preview must never abort the dry run", err)
	}
	if out["dry_run"] != true {
		t.Fatalf("dry_run = %v, want true", out["dry_run"])
	}
	if out["address_preview"] != "unavailable" {
		t.Fatalf("address_preview = %v, want unavailable", out["address_preview"])
	}
	reason, _ := out["reason"].(string)
	if reason == "" {
		t.Fatalf("reason = %q, want a non-empty operator-safe explanation", reason)
	}
	if addr, _ := out["address"].(string); addr == "" || addr == "10.0.5.0" {
		t.Fatalf("address = %q, want a non-blank, non-fabricated placeholder", addr)
	}
	subnets := result["subnets"].([]any)
	entry := subnets[0].(M)
	if planAddr, _ := entry["address"].(string); planAddr == "/24" {
		t.Fatalf("plan address = %q, must not render as a blank-left-side %q", planAddr, "/24")
	}
}

// TestCreateSubnet_DryRun_FailedPreviewNeverMatchesSuccess is the regression
// test for the bug being closed: a failed preview lookup used to produce the
// exact same shape (empty address, no marker) as a genuinely-successful-but-
// empty preview, and was indistinguishable from a real address once formatted
// into the plan string. Failure must now be observably different from both
// a real success AND a genuine empty result.
func TestCreateSubnet_DryRun_FailedPreviewNeverMatchesSuccess(t *testing.T) {
	successSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[{"address":"10.0.5.0","id":"addr-1"}]}`))
	}))
	defer successSrv.Close()
	failSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
	}))
	defer failSrv.Close()
	emptySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[]}`))
	}))
	defer emptySrv.Close()

	successOut, err := newTestEngine(successSrv).NewSiteProvisioner(testSiteConfig(), func(M) {}).
		createSubnet("block-1", testSubnetDef(), M{})
	if err != nil {
		t.Fatalf("success path: unexpected error %v", err)
	}
	failOut, err := newTestEngine(failSrv).NewSiteProvisioner(testSiteConfig(), func(M) {}).
		createSubnet("block-1", testSubnetDef(), M{})
	if err != nil {
		t.Fatalf("failure path: unexpected error %v (must still succeed as a dry run)", err)
	}
	emptyOut, err := newTestEngine(emptySrv).NewSiteProvisioner(testSiteConfig(), func(M) {}).
		createSubnet("block-1", testSubnetDef(), M{})
	if err != nil {
		t.Fatalf("empty path: unexpected error %v", err)
	}

	if reflect.DeepEqual(failOut, successOut) {
		t.Fatalf("a failed preview produced the exact same payload as a successful one: %v", failOut)
	}
	if reflect.DeepEqual(failOut, emptyOut) {
		t.Fatalf("a failed preview produced the exact same payload as a genuine empty result: %v", failOut)
	}
	if reflect.DeepEqual(emptyOut, successOut) {
		t.Fatalf("sanity check failed: genuine-empty and success fixtures must differ: %v", emptyOut)
	}
}
