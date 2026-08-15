package ai

import (
	"strconv"
	"strings"
	"testing"
)

// The model is TOLD a range in the tool schema and HELD to one by the clamp in
// dashboard.RunAITool. If those two ever disagree, the model spends its calls
// asking for values that are silently rewritten, which is the failure the shared
// constants exist to prevent. This reads the range out of the schema the model
// actually receives and checks it against the constants dashboard imports.
func TestToolSchemaAdvertisesTheEnforcedBounds(t *testing.T) {
	bound := func(tool, param string) (lo, hi int) {
		t.Helper()
		for _, entry := range aiTools {
			m, _ := entry.(map[string]any)
			fn, _ := m["function"].(map[string]any)
			if name, _ := fn["name"].(string); name != tool {
				continue
			}
			params, _ := fn["parameters"].(map[string]any)
			props, _ := params["properties"].(map[string]any)
			p, ok := props[param].(map[string]any)
			if !ok {
				t.Fatalf("%s has no %q parameter in the schema", tool, param)
			}
			min, minOK := p["minimum"].(float64)
			max, maxOK := p["maximum"].(float64)
			if !minOK || !maxOK {
				t.Fatalf("%s.%s declares no minimum/maximum — the model is given no range at all "+
					"and only finds out by having its value rewritten: %v", tool, param, p)
			}
			// The description has to agree too: the model reads prose far more
			// reliably than it honours a JSON Schema keyword.
			desc, _ := p["description"].(string)
			for _, want := range []string{strconv.Itoa(int(min)), strconv.Itoa(int(max))} {
				if !strings.Contains(desc, want) {
					t.Fatalf("%s.%s description %q does not state the %s bound", tool, param, desc, want)
				}
			}
			return int(min), int(max)
		}
		t.Fatalf("tool %q is not in the schema", tool)
		return 0, 0
	}

	for _, c := range []struct {
		tool, param string
		lo, hi      int
	}{
		{"get_audit_logs", "limit", AuditLogLimitMin, AuditLogLimitMax},
		{"get_dns_analytics", "days", AnalyticsDaysMin, AnalyticsDaysMax},
		{"get_dns_analytics", "limit", AnalyticsLimitMin, AnalyticsLimitMax},
	} {
		lo, hi := bound(c.tool, c.param)
		if lo != c.lo || hi != c.hi {
			t.Fatalf("%s.%s schema says %d..%d, the clamp enforces %d..%d",
				c.tool, c.param, lo, hi, c.lo, c.hi)
		}
	}
}
