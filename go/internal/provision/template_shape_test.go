package provision

import "testing"

// The regression this file covers (#92): asList returns nil for any non-list
// and a nil list iterates zero times, so `subnets: web` and no `subnets` key
// at all produced byte-identical validation output — clean, no error, no
// warning. Only one of those is a template bug. TemplateToSiteConfig
// (site.go) reads the same key through the same helper, so a mis-typed
// subnets validated clean AND provisioned a site with zero subnets.
//
// Every fixture carries an explicit `type`. TemplateType dispatches on which
// discriminator key is non-nil, so `zones: null` or a string `address_blocks`
// would otherwise silently route to a different validator than the one under
// test, and the row would pass for the wrong reason.

// hasField reports whether the validator recorded field+message. The
// assertions below are about ONE field: an otherwise-incomplete fixture
// legitimately produces unrelated errors, and demanding an empty error list
// would make these tests about the fixture instead of the field.
func hasField(result M, field, message string) bool {
	items, _ := result["errors"].([]M)
	for _, e := range items {
		if e["field"] == field && e["message"] == message {
			return true
		}
	}
	return false
}

func fieldMessages(result M, field string) []string {
	var out []string
	items, _ := result["errors"].([]M)
	for _, e := range items {
		if e["field"] == field {
			out = append(out, pyStr(e["message"]))
		}
	}
	return out
}

// shapeCase is one (field, value) pair dropped into a template of the right
// type. build returns the whole template so a nested field can be placed.
type shapeCase struct {
	field string      // the field name in the error message
	build func(any) M // template carrying `value` at that field
	omit  func() M    // the same template with the key absent entirely
	empty string      // the message an EMPTY list must produce, "" if none
}

func TestValidateTemplate_ListFieldsRejectTheWrongShape(t *testing.T) {
	cases := []shapeCase{
		{
			field: "network.subnets",
			build: func(v any) M {
				return M{"type": "site", "site": M{"name": "hq"}, "network": M{"subnets": v}}
			},
			omit: func() M { return M{"type": "site", "site": M{"name": "hq"}, "network": M{}} },
		},
		{
			field: "hosts",
			build: func(v any) M {
				return M{"type": "site", "site": M{"name": "hq"}, "network": M{}, "hosts": v}
			},
			omit: func() M { return M{"type": "site", "site": M{"name": "hq"}, "network": M{}} },
		},
		{
			field: "address_blocks",
			build: func(v any) M { return M{"type": "address-block", "name": "b", "address_blocks": v} },
			omit:  func() M { return M{"type": "address-block", "name": "b"} },
			empty: "Required and must be a non-empty list",
		},
		{
			field: "zones",
			build: func(v any) M { return M{"type": "dns", "zones": v} },
			omit:  func() M { return M{"type": "dns"} },
			empty: "Required and must be a non-empty list",
		},
		{
			field: "address_blocks[0].children",
			build: func(v any) M {
				return M{"type": "address-block", "name": "b", "address_blocks": []any{
					M{"address": "10.0.0.0", "cidr": 8, "region": "emea", "environment": "prod", "children": v},
				}}
			},
			omit: func() M {
				return M{"type": "address-block", "name": "b", "address_blocks": []any{
					M{"address": "10.0.0.0", "cidr": 8, "region": "emea", "environment": "prod"},
				}}
			},
		},
		{
			field: "zones[0].records",
			build: func(v any) M {
				return M{"type": "dns", "zones": []any{M{"fqdn": "corp.example.com", "records": v}}}
			},
			omit: func() M {
				return M{"type": "dns", "zones": []any{M{"fqdn": "corp.example.com"}}}
			},
		},
	}

	// The seven shapes. A proper list and an empty list are the two that must
	// keep working; absent and null are the two that must stay silent; the
	// last three are the bug.
	wrong := []struct {
		name  string
		value any
	}{
		{"a string", "web"},
		{"a mapping", M{"name": "web"}},
		{"a number", 3},
	}

	for _, tc := range cases {
		t.Run(tc.field, func(t *testing.T) {
			for _, w := range wrong {
				t.Run(w.name+" is reported", func(t *testing.T) {
					got := ValidateTemplate(tc.build(w.value), "t.yaml")
					if !hasField(got, tc.field, "Must be a list") {
						t.Fatalf("%s = %#v produced no \"Must be a list\" error; errors were %v",
							tc.field, w.value, got["errors"])
					}
					// Mutually exclusive: a wrong-shaped required field must not
					// ALSO be told to add entries. "Add some zones" is useless
					// advice for a key whose problem is that it is a string.
					for _, m := range fieldMessages(got, tc.field) {
						if m == "Required and must be a non-empty list" {
							t.Errorf("%s got both the shape error and %q — the two are different answers", tc.field, m)
						}
					}
					if got["valid"] != false {
						t.Errorf("valid = %v, want false", got["valid"])
					}
				})
			}

			t.Run("a proper list is accepted", func(t *testing.T) {
				got := ValidateTemplate(tc.build([]any{}), "t.yaml")
				if hasField(got, tc.field, "Must be a list") {
					t.Fatalf("an empty list was reported as the wrong shape: %v", got["errors"])
				}
			})

			t.Run("an empty list keeps the rule it always had", func(t *testing.T) {
				got := ValidateTemplate(tc.build([]any{}), "t.yaml")
				msgs := fieldMessages(got, tc.field)
				if tc.empty == "" {
					if len(msgs) != 0 {
						t.Fatalf("an empty list produced %v; this field has never treated empty as an error", msgs)
					}
					return
				}
				if !hasField(got, tc.field, tc.empty) {
					t.Fatalf("an empty list produced %v, want %q — this fix must not move the empty rule", msgs, tc.empty)
				}
			})

			t.Run("an absent key is unchanged", func(t *testing.T) {
				got := ValidateTemplate(tc.omit(), "t.yaml")
				if hasField(got, tc.field, "Must be a list") {
					t.Fatalf("an ABSENT key was reported as the wrong shape: %v", got["errors"])
				}
			})

			t.Run("an explicit null is absent, not wrong-shaped", func(t *testing.T) {
				got := ValidateTemplate(tc.build(nil), "t.yaml")
				if hasField(got, tc.field, "Must be a list") {
					t.Fatalf("`%s:` with no value was reported as a type error; that is how a person leaves a key out: %v",
						tc.field, got["errors"])
				}
			})
		})
	}
}

// TestValidateTemplate_WrongSubnetsShapeDoesNotAccuseTheHosts: when the subnet
// list itself is unreadable, subnetNames is empty for a reason that has nothing
// to do with any host. Reporting every host as referencing an unknown subnet
// would bury the one error that matters under N derived ones.
func TestValidateTemplate_WrongSubnetsShapeDoesNotAccuseTheHosts(t *testing.T) {
	got := ValidateTemplate(M{
		"type":    "site",
		"site":    M{"name": "hq"},
		"network": M{"subnets": "web"},
		"hosts":   []any{M{"hostname": "web01", "subnet": "web"}, M{"hostname": "web02", "subnet": "web"}},
	}, "t.yaml")

	if !hasField(got, "network.subnets", "Must be a list") {
		t.Fatalf("the one error that matters is missing: %v", got["errors"])
	}
	if msgs := fieldMessages(got, "hosts[0].subnet"); len(msgs) != 0 {
		t.Errorf("hosts[0].subnet was accused of referencing an unknown subnet (%v) because the subnet LIST was unreadable", msgs)
	}
	if msgs := fieldMessages(got, "hosts[1].subnet"); len(msgs) != 0 {
		t.Errorf("hosts[1].subnet likewise: %v", msgs)
	}
}

// TestValidateTemplate_GoodSubnetsStillCatchUnknownReferences is the other half
// — the guard above must not have switched the real check off.
func TestValidateTemplate_GoodSubnetsStillCatchUnknownReferences(t *testing.T) {
	got := ValidateTemplate(M{
		"type":    "site",
		"site":    M{"name": "hq"},
		"network": M{"subnets": []any{M{"name": "web", "cidr": 24, "purpose": "app"}}},
		"hosts":   []any{M{"hostname": "db01", "subnet": "database"}},
	}, "t.yaml")

	if len(fieldMessages(got, "hosts[0].subnet")) == 0 {
		t.Fatalf("a host referencing a subnet that really is undefined went unreported: %v", got["errors"])
	}
}
