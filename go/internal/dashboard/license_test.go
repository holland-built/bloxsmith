package dashboard

import "testing"

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
