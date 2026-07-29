package dashboard

import (
	"net/http"
	"testing"
)

// TestCSPLicenseAlerts_UpstreamFailure_YieldsErrorEmptyLists pins the failure
// branch (csp.go:788): either sub-fetch erroring must report status="error"
// with BOTH lists empty (not nil, not omitted) — this is what tells a caller
// "we don't know" rather than "there is nothing to show".
func TestCSPLicenseAlerts_UpstreamFailure_YieldsErrorEmptyLists(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/licensing/v1/licenses" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":[]}`))
	})

	got := s.CSPLicenseAlerts()

	if got["status"] != "error" {
		t.Fatalf("status = %v, want error", got["status"])
	}
	lic, ok := got["licenses"].([]any)
	if !ok || len(lic) != 0 {
		t.Fatalf("licenses = %v (%T), want empty slice", got["licenses"], got["licenses"])
	}
	al, ok := got["alerts"].([]any)
	if !ok || len(al) != 0 {
		t.Fatalf("alerts = %v (%T), want empty slice", got["alerts"], got["alerts"])
	}
}

// TestCSPLicenseAlerts_GenuineEmpty_YieldsEmptyStatusNotError pins the
// distinction the failure branch above depends on: a well-formed upstream
// response with zero licenses and zero alerts is a genuinely empty feed, not
// a failure, and must report status="empty" — never "error", which would
// make an operator think the fetch itself broke.
func TestCSPLicenseAlerts_GenuineEmpty_YieldsEmptyStatusNotError(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":[]}`))
	})

	got := s.CSPLicenseAlerts()

	if got["status"] != "empty" {
		t.Fatalf("status = %v, want empty (genuinely empty feed must be distinct from error)", got["status"])
	}
	lic, ok := got["licenses"].([]map[string]any)
	if !ok || len(lic) != 0 {
		t.Fatalf("licenses = %v (%T), want empty slice", got["licenses"], got["licenses"])
	}
	al, ok := got["alerts"].([]map[string]any)
	if !ok || len(al) != 0 {
		t.Fatalf("alerts = %v (%T), want empty slice", got["alerts"], got["alerts"])
	}
}

// TestCSPLicenseAlerts_WithLicensesAndAlerts_YieldsOkWithPayload pins the
// normal success path: real rows on both sub-fetches produce status="ok" and
// the shaped payload (see normLicenseAlerts / TestNormLicenseAlertsRealColumns
// for the field-level shaping contract).
func TestCSPLicenseAlerts_WithLicensesAndAlerts_YieldsOkWithPayload(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/licensing/v1/licenses":
			_, _ = w.Write([]byte(`{"result":[{"id":"lic-1","name":"BloxOne DDI","state":"active"}]}`))
		case "/atlas-notifications-mailbox/v1/user_alerts":
			_, _ = w.Write([]byte(`{"result":[{"id":"alert-1","title":"Expiring soon","severity":"warning"}]}`))
		default:
			_, _ = w.Write([]byte(`{"result":[]}`))
		}
	})

	got := s.CSPLicenseAlerts()

	if got["status"] != "ok" {
		t.Fatalf("status = %v, want ok", got["status"])
	}
	lic, ok := got["licenses"].([]map[string]any)
	if !ok || len(lic) != 1 {
		t.Fatalf("licenses = %v (%T), want 1 row", got["licenses"], got["licenses"])
	}
	if lic[0]["name"] != "BloxOne DDI" {
		t.Fatalf("license name = %v, want BloxOne DDI", lic[0]["name"])
	}
	al, ok := got["alerts"].([]map[string]any)
	if !ok || len(al) != 1 {
		t.Fatalf("alerts = %v (%T), want 1 row", got["alerts"], got["alerts"])
	}
	if al[0]["title"] != "Expiring soon" {
		t.Fatalf("alert title = %v, want Expiring soon", al[0]["title"])
	}
}

// TestNormLicenseAlertsRealColumns locks the live payload's real nested
// shape: "sku" is an OBJECT ({sku, end_date, start_date, quantity,
// evaluation, ...}), not a string, and "packages" is a list of OBJECTS
// ({id, name, properties}), not strings. Expiry lives at sku.end_date — the
// flat top-level columns (account_id, amended_at, guardrails, id, name,
// packages, security_facets, sku, state) omit it only because it's nested.
// One row has sku absent entirely and packages null, proving those paths
// degrade to empty values instead of panicking.
func TestNormLicenseAlertsRealColumns(t *testing.T) {
	licenses := []any{
		map[string]any{
			"account_id": "acct-1",
			"amended_at": nil,
			"guardrails": nil,
			"id":         "lic-1",
			"name":       "BloxOne Threat Defense Advanced",
			"packages": []any{
				map[string]any{
					"id":         "pkg-1",
					"name":       "BloxOne Threat Defense Advanced",
					"properties": map[string]any{},
				},
				map[string]any{
					"id":   "pkg-2",
					"name": "DNS",
				},
			},
			"security_facets": nil,
			"sku": map[string]any{
				"sku":        "IB-SUB-THREAT-ADV",
				"end_date":   "2099-04-23T00:00:00Z",
				"start_date": "2020-01-01T00:00:00Z",
				"quantity":   float64(1000),
				"evaluation": false,
			},
			"state": "active",
		},
		map[string]any{
			"account_id": "acct-1",
			"id":         "lic-2",
			"name":       "BloxOne DDI Eval",
			"packages":   nil,
			"state":      "active",
			// sku absent entirely
		},
	}

	lic, _ := normLicenseAlerts(licenses, nil)
	if len(lic) != 2 {
		t.Fatalf("expected 2 license rows, got %d", len(lic))
	}

	r0 := lic[0]
	if r0["name"] != "BloxOne Threat Defense Advanced" {
		t.Fatalf("name: got %v", r0["name"])
	}
	if r0["sku"] != "IB-SUB-THREAT-ADV" {
		t.Fatalf("sku should come from nested sku.sku: got %v", r0["sku"])
	}
	if r0["expiry"] != "2099-04-23T00:00:00Z" {
		t.Fatalf("expiry should come from sku.end_date: got %v", r0["expiry"])
	}
	if r0["quantity"] != 1000 {
		t.Fatalf("quantity should come from sku.quantity: got %v", r0["quantity"])
	}
	if r0["evaluation"] != false {
		t.Fatalf("evaluation should come from sku.evaluation: got %v", r0["evaluation"])
	}
	if r0["packages"] != "BloxOne Threat Defense Advanced, DNS" {
		t.Fatalf("packages should join each object's name: got %q", r0["packages"])
	}
	if r0["state"] != "active" {
		t.Fatalf("state: got %v", r0["state"])
	}
	if r0["amended_at"] != "" {
		t.Fatalf("null amended_at should degrade to empty string: got %v", r0["amended_at"])
	}

	r1 := lic[1]
	if r1["sku"] != "" {
		t.Fatalf("absent sku should degrade to empty string, not panic: got %v", r1["sku"])
	}
	if r1["expiry"] != "" {
		t.Fatalf("absent sku.end_date should degrade to empty string: got %v", r1["expiry"])
	}
	if r1["quantity"] != 0 {
		t.Fatalf("absent sku.quantity should degrade to 0: got %v", r1["quantity"])
	}
	if r1["evaluation"] != false {
		t.Fatalf("absent sku.evaluation should degrade to false: got %v", r1["evaluation"])
	}
	if r1["packages"] != "" {
		t.Fatalf("null packages should degrade to empty string: got %q", r1["packages"])
	}
}

// TestJoinPackagesVariants covers plain-string passthrough, a list of plain
// strings, a list of package objects, and nil — none should panic or emit
// Go's default map/slice formatting.
func TestJoinPackagesVariants(t *testing.T) {
	if got := joinPackages("ddi"); got != "ddi" {
		t.Fatalf("string passthrough: got %q", got)
	}
	if got := joinPackages(nil); got != "" {
		t.Fatalf("nil should default to empty string: got %q", got)
	}
	if got := joinPackages([]any{"ddi", "dns"}); got != "ddi, dns" {
		t.Fatalf("list of strings should join as-is: got %q", got)
	}
	if got := joinPackages([]any{map[string]any{"name": "DNS"}, map[string]any{"name": "DHCP"}}); got != "DNS, DHCP" {
		t.Fatalf("list of objects should join on name: got %q", got)
	}
}
