package dashboard

import "testing"

// The three fabrications this file locks all shared one shape: an absence
// upstream was rendered as a specific, confident, actionable claim. Each test
// has two halves and BOTH matter — the unreported half proves the invented
// value is gone, and the reported half proves a real value still survives the
// journey byte-identically. Without the second half the "fix" could be a
// blanket "unknown", which is a different lie, not a cure.

// TestNormPoliciesUnreportedAction locks the security-policy action contract.
// The old default was "action_allow", so a policy whose action upstream never
// reported presented as a definite permit — the wrong direction to guess in on
// a security product.
func TestNormPoliciesUnreportedAction(t *testing.T) {
	cases := []struct {
		name   string
		policy map[string]any
		want   string
	}{
		{
			name:   "neither key reported",
			policy: map[string]any{"name": "p"},
			want:   "unknown",
		},
		{
			name:   "key present but JSON null",
			policy: map[string]any{"name": "p", "default_action": nil, "action": nil},
			want:   "unknown",
		},
		{
			name:   "key present but empty string names no action",
			policy: map[string]any{"name": "p", "default_action": ""},
			want:   "unknown",
		},
		{
			name:   "prefix with nothing after it names no action",
			policy: map[string]any{"name": "p", "default_action": "action_"},
			want:   "unknown",
		},
		// --- reported values must survive unchanged ---------------------------
		{
			name:   "reported block",
			policy: map[string]any{"name": "p", "default_action": "action_block"},
			want:   "block",
		},
		{
			name:   "reported allow is still allow",
			policy: map[string]any{"name": "p", "default_action": "action_allow"},
			want:   "allow",
		},
		{
			name:   "reported redirect",
			policy: map[string]any{"name": "p", "default_action": "action_redirect"},
			want:   "redirect",
		},
		{
			name:   "unprefixed value passes through verbatim",
			policy: map[string]any{"name": "p", "default_action": "log"},
			want:   "log",
		},
		{
			name:   "fallback key action is honoured",
			policy: map[string]any{"name": "p", "action": "action_block"},
			want:   "block",
		},
		{
			// Precedence is unchanged from the orStr chain it replaced:
			// default_action is first in the key list, so it wins.
			name:   "default_action wins over action when both reported",
			policy: map[string]any{"name": "p", "default_action": "action_block", "action": "action_allow"},
			want:   "block",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := normPolicies([]any{tc.policy})[0]["action"]
			if got != tc.want {
				t.Fatalf("action: got %q, want %q (policy=%v)", got, tc.want, tc.policy)
			}
		})
	}
}

// TestNormFeedsUnreportedConfidence locks the feed confidence contract. The old
// default was "MEDIUM", which was not merely one invented value: it was then
// run through the levels map to manufacture a second one, a derived
// threat_level of "high".
func TestNormFeedsUnreportedConfidence(t *testing.T) {
	cases := []struct {
		name      string
		feed      map[string]any
		wantConf  string
		wantLevel string
	}{
		{
			name:      "no confidence and no threat level: neither is invented",
			feed:      map[string]any{"name": "f"},
			wantConf:  "unknown",
			wantLevel: "unknown",
		},
		{
			name:      "confidence present but JSON null",
			feed:      map[string]any{"name": "f", "confidence_level": nil},
			wantConf:  "unknown",
			wantLevel: "unknown",
		},
		{
			name:      "confidence present but empty",
			feed:      map[string]any{"name": "f", "confidence_level": ""},
			wantConf:  "unknown",
			wantLevel: "unknown",
		},
		{
			// The second, separate fabrication: an unrecognised word used to be
			// silently rewritten to "medium", restating an unknown grade as a
			// known middling one, and that rewrite then fed the derivation too.
			name:      "unrecognised confidence word is not medium",
			feed:      map[string]any{"name": "f", "confidence_level": "VERY_HIGH"},
			wantConf:  "unknown",
			wantLevel: "unknown",
		},
		{
			name:      "unrecognised confidence derives no threat level",
			feed:      map[string]any{"name": "f", "confidence_level": "unrated"},
			wantConf:  "unknown",
			wantLevel: "unknown",
		},
		// --- reported values must survive unchanged ---------------------------
		{
			name:      "reported HIGH still derives critical",
			feed:      map[string]any{"name": "f", "confidence_level": "HIGH"},
			wantConf:  "high",
			wantLevel: "critical",
		},
		{
			name:      "reported MEDIUM still derives high",
			feed:      map[string]any{"name": "f", "confidence_level": "MEDIUM"},
			wantConf:  "medium",
			wantLevel: "high",
		},
		{
			name:      "reported LOW still derives medium",
			feed:      map[string]any{"name": "f", "confidence_level": "low"},
			wantConf:  "low",
			wantLevel: "medium",
		},
		{
			// A reported threat_level is a real value that does not depend on
			// confidence, so it is kept even when confidence is unknown.
			name:      "reported threat level survives an unreported confidence",
			feed:      map[string]any{"name": "f", "threat_level": "CRITICAL"},
			wantConf:  "unknown",
			wantLevel: "critical",
		},
		{
			name:      "reported threat level is never overridden by the derivation",
			feed:      map[string]any{"name": "f", "confidence_level": "LOW", "threat_level": "HIGH"},
			wantConf:  "low",
			wantLevel: "high",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			row := normFeeds([]any{tc.feed})[0]
			if got := row["conf"]; got != tc.wantConf {
				t.Fatalf("conf: got %q, want %q (feed=%v)", got, tc.wantConf, tc.feed)
			}
			if got := row["level"]; got != tc.wantLevel {
				t.Fatalf("level: got %q, want %q (feed=%v)", got, tc.wantLevel, tc.feed)
			}
		})
	}
}

// TestNormFeedsUntouchedFields guards the blast radius: the fields the fix was
// explicitly not allowed to disturb still behave exactly as before, so a future
// reader can tell the unknown-ing stopped where it was meant to.
func TestNormFeedsUntouchedFields(t *testing.T) {
	row := normFeeds([]any{map[string]any{"name": "f"}})[0]
	if got := row["cat"]; got != "Mixed" {
		t.Fatalf("cat default changed: got %v, want \"Mixed\"", got)
	}
	if got := row["entries"]; got != 0 {
		t.Fatalf("entries default changed: got %v, want 0", got)
	}
	if got := row["active"]; got != true {
		t.Fatalf("active changed: got %v, want true", got)
	}
}

// TestNormPoliciesUntouchedFields is the same guard for the policy row.
func TestNormPoliciesUntouchedFields(t *testing.T) {
	row := normPolicies([]any{map[string]any{
		"name":         "p",
		"rules":        []any{map[string]any{}, map[string]any{}},
		"created_time": "2026-01-02T03:04:05Z",
		"is_default":   true,
	}})[0]
	if got := row["rules"]; got != 2 {
		t.Fatalf("rules: got %v, want 2", got)
	}
	if got := row["created"]; got != "2026-01-02" {
		t.Fatalf("created: got %v, want \"2026-01-02\"", got)
	}
	if got := row["active"]; got != false {
		t.Fatalf("active: got %v, want false (is_default true)", got)
	}
}
