package dashboard

import (
	"encoding/json"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// TestPanelSources_FactsHoldTogether: the kinds and verdicts are from a fixed
// set, an id appears once, a redraw comes with picks the builder allows, and
// anything short of an exact redraw says why.
func TestPanelSources_FactsHoldTogether(t *testing.T) {
	combos := ChartCombos()
	seen := map[string]bool{}
	kebab := regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	for _, p := range PanelSources() {
		if seen[p.ID] {
			t.Errorf("%s is listed twice", p.ID)
		}
		seen[p.ID] = true
		if !kebab.MatchString(p.ID) {
			t.Errorf("%q is not a panelId", p.ID)
		}
		if !slices.Contains([]string{"cube", "rest", "local", "vendor"}, p.Kind) {
			t.Errorf("%s: kind %q", p.ID, p.Kind)
		}
		if p.Page == "" || p.Name == "" || p.Source == "" {
			t.Errorf("%s: page, name and source are all required", p.ID)
		}
		switch p.Builder {
		case "exact", "copy":
			if p.Kind != "cube" {
				t.Errorf("%s: only a cube panel can be redrawn, this is %s", p.ID, p.Kind)
			}
			if p.Picks == nil || !slices.Contains(combos, *p.Picks) {
				t.Errorf("%s: picks %+v are not an allowed combination", p.ID, p.Picks)
			}
		case "no":
			if p.Picks != nil {
				t.Errorf("%s: can't be redrawn but carries picks", p.ID)
			}
		default:
			t.Errorf("%s: builder %q", p.ID, p.Builder)
		}
		if (p.Builder == "exact") == (p.Why != "") {
			t.Errorf("%s: an exact redraw has no why; anything else must say why (got %q)", p.ID, p.Why)
		}
		if strings.Contains(p.Source+p.Why, "|") {
			t.Errorf("%s: a | would break the docs table", p.ID)
		}
	}
	if len(seen) != 90 {
		t.Errorf("%d panels, want the 90 in panel-inventory.md", len(seen))
	}
}

// TestPanelSources_TheRedrawsMatchTheirPanels pins the four cube charts to the
// picks that draw them, written out here rather than read from the list.
func TestPanelSources_TheRedrawsMatchTheirPanels(t *testing.T) {
	want := map[string]struct {
		builder string
		picks   ChartPicks
	}{
		"dns-query-volume-7d":           {"exact", ChartPicks{Count: "dns", Split: "none", Window: "7d", Over: "day"}},
		"dns-hero":                      {"copy", ChartPicks{Count: "qps", Split: "none", Window: "24h", Over: "hour"}},
		"dns-query-rate":                {"copy", ChartPicks{Count: "qps", Split: "none", Window: "24h", Over: "hour"}},
		"security-threat-feed-activity": {"copy", ChartPicks{Count: "threats", Split: "action", Window: "7d", Over: "day"}},
	}
	for _, p := range PanelSources() {
		w, ok := want[p.ID]
		if !ok {
			if p.Builder != "no" {
				t.Errorf("%s: unexpected %s redraw", p.ID, p.Builder)
			}
			continue
		}
		if p.Builder != w.builder || p.Picks == nil || *p.Picks != w.picks {
			t.Errorf("%s: %s %+v, want %s %+v", p.ID, p.Builder, p.Picks, w.builder, w.picks)
		}
	}
}

// TestPanelSources_MatchTheUIFile keeps ui/src/lib/panelSources.json, which
// the About disclosure and panelHelp.test.js read, identical to this list.
// UPDATE_PANEL_SOURCES=1 rewrites it.
func TestPanelSources_MatchTheUIFile(t *testing.T) {
	const path = "../../../ui/src/lib/panelSources.json"
	want, err := json.MarshalIndent(PanelSources(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, '\n')
	if os.Getenv("UPDATE_PANEL_SOURCES") == "1" {
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run with UPDATE_PANEL_SOURCES=1 to write it)", err)
	}
	if string(got) != string(want) {
		t.Fatalf("%s is out of date; run with UPDATE_PANEL_SOURCES=1", path)
	}
}

// TestPanelSources_MatchTheDocs keeps the table in docs/TABS.md, between its
// two marker comments, identical to PanelSourcesTable. UPDATE_PANEL_SOURCES=1
// rewrites the part between the markers and nothing else.
func TestPanelSources_MatchTheDocs(t *testing.T) {
	const path = "../../../docs/TABS.md"
	const start, end = "<!-- panel-sources:start -->\n", "<!-- panel-sources:end -->"
	doc, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := string(doc)
	i, j := strings.Index(s, start), strings.Index(s, end)
	if i < 0 || j < i {
		t.Fatalf("%s has no %q ... %q section", path, strings.TrimSpace(start), end)
	}
	table := PanelSourcesTable()
	if os.Getenv("UPDATE_PANEL_SOURCES") == "1" {
		s = s[:i+len(start)] + table + s[j:]
		if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if got := s[i+len(start) : strings.Index(s, end)]; got != table {
		t.Fatalf("the table in %s is out of date; run with UPDATE_PANEL_SOURCES=1", path)
	}
}
