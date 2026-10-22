package dashboard

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// A chart saved from Build a chart onto a page. It is kept in the saved-view
// store as a view named __chart_<id>, holding only the picks, so it is
// redrawn from whichever tenant is active each time the page opens.

// SavedChartPrefix marks a saved chart's view name.
const SavedChartPrefix = "__chart_"

// The id is random, never a slug of the title: the store shortens and
// sanitises names (store.viewPath), so two titles could become one file.
var savedChartName = regexp.MustCompile(`^__chart_[a-z0-9]{8,32}$`)

// SavedChartPages are the pages a chart can be added to.
var SavedChartPages = []string{"overview", "dns", "security", "network", "infra"}

const savedChartTitleMax = 80

// ValidSavedChart checks a saved chart's name and body {v, title, tab, picks}
// and returns the body as it should be stored. Picks must be a combination
// the builder itself allows, so a saved chart can never run a query the
// menus couldn't.
func ValidSavedChart(name string, raw any) (map[string]any, error) {
	if !savedChartName.MatchString(name) {
		return nil, fmt.Errorf("a saved chart's name is %s and a random id", SavedChartPrefix)
	}
	c, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("a saved chart needs its chart")
	}
	if v, _ := c["v"].(float64); v != 1 {
		return nil, fmt.Errorf("unknown saved chart version")
	}
	title, _ := c["title"].(string)
	title = strings.TrimSpace(title)
	if title == "" || len([]rune(title)) > savedChartTitleMax {
		return nil, fmt.Errorf("a saved chart needs a name of 1 to %d characters", savedChartTitleMax)
	}
	tab, _ := c["tab"].(string)
	if !slices.Contains(SavedChartPages, tab) {
		return nil, fmt.Errorf("a chart can't be added to that page")
	}
	pm, _ := c["picks"].(map[string]any)
	str := func(k string) string { s, _ := pm[k].(string); return s }
	top, _ := pm["top"].(float64)
	if top != float64(int(top)) {
		return nil, fmt.Errorf("that combination of choices isn't available")
	}
	p := ChartPicks{Count: str("count"), Split: str("split"), Window: str("window"), Over: str("over"), Top: int(top)}
	if _, _, err := BuildChartQuery(p); err != nil {
		return nil, err
	}
	out := map[string]any{"v": 1, "title": title, "tab": tab, "picks": p}
	// replaces: the built-in panel this chart stands in for. Only one Build a
	// chart draws exactly, and only on that panel's own page.
	if r, ok := c["replaces"]; ok {
		id, _ := r.(string)
		if !replaceable(id, tab) {
			return nil, fmt.Errorf("a chart can only replace a panel Build a chart draws exactly, on its own page")
		}
		out["replaces"] = id
	}
	return out, nil
}

func replaceable(panelID, tab string) bool {
	for _, s := range panelSources {
		if s.ID == panelID {
			return s.Builder == "exact" && strings.ToLower(s.Page) == tab
		}
	}
	return false
}
