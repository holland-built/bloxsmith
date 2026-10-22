package dashboard

import "testing"

// A saved chart may replace a built-in panel, but only one Build a chart
// draws exactly (panel_sources.go Builder "exact"), and only on its own page.
func TestValidSavedChart_Replaces(t *testing.T) {
	chart := func(tab string, replaces any) map[string]any {
		c := map[string]any{"v": float64(1), "title": "Queries by day", "tab": tab,
			"picks": map[string]any{"count": "dns", "split": "none", "window": "7d", "over": "day", "top": float64(0)}}
		if replaces != nil {
			c["replaces"] = replaces
		}
		return c
	}
	got, err := ValidSavedChart("__chart_k3x9q2m7", chart("dns", "dns-query-volume-7d"))
	if err != nil || got["replaces"] != "dns-query-volume-7d" {
		t.Fatalf("an exact panel on its own page: %v, %v", got, err)
	}
	if got, err := ValidSavedChart("__chart_k3x9q2m7", chart("dns", nil)); err != nil {
		t.Fatalf("no replaces: %v", err)
	} else if _, ok := got["replaces"]; ok {
		t.Fatalf("replaces appeared from nowhere: %v", got)
	}
	for name, c := range map[string]map[string]any{
		"a copy-only panel":          chart("overview", "dns-hero"),
		"a panel it can't redraw":    chart("dns", "dns-zones"),
		"the right panel, wrong tab": chart("overview", "dns-query-volume-7d"),
		"a panel that doesn't exist": chart("dns", "dns-nothing"),
		"not a string":               chart("dns", float64(3)),
	} {
		if _, err := ValidSavedChart("__chart_k3x9q2m7", c); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
