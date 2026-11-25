package ai

import "testing"

// The Visibility Assessment tools are offered to the model, with short
// descriptions (the model pays for every word on every call).
func TestVisibilityToolsAdvertised(t *testing.T) {
	desc := map[string]string{}
	params := map[string]map[string]any{}
	for _, raw := range aiTools {
		fn := raw.(map[string]any)["function"].(map[string]any)
		name := fn["name"].(string)
		desc[name] = fn["description"].(string)
		p, _ := fn["parameters"].(map[string]any)["properties"].(map[string]any)
		params[name] = p
	}
	for _, name := range []string{"risky_dns_records", "asset_problems", "cmdb_gap", "visibility_counts"} {
		d, ok := desc[name]
		if !ok {
			t.Errorf("%s is not in the tool schema", name)
			continue
		}
		if len(d) > 220 {
			t.Errorf("%s description is %d characters, keep it under 220", name, len(d))
		}
	}
	for _, p := range []string{"max_utilization", "by_cloud"} {
		if _, ok := params["get_subnets"][p]; !ok {
			t.Errorf("get_subnets is missing %s", p)
		}
	}
}
