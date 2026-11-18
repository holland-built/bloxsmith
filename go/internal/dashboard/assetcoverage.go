// Coverage gaps: devices seen on the network that a tool meant to know every
// device has never reported.
//
// HOW IT COUNTS, AND WHY THIS WAY. Each asset carries the list of sources that
// reported it (providers_label, a JSON list held as text). One grouped cube
// query returns every distinct list with its asset count; the live tenant had
// 9 lists on 2026-11-17, read in 0.3 s. Every gap count is then a sum over
// those lists, worked out here, so one cheap query answers every tile and the
// arithmetic is unit-tested. The cube's notContains filter gave the same
// answer when probed, but needs one query per tile.
//
// Clicking a tile filters the table with `equals` over the exact lists that
// were counted (gapCombos), so the table always holds the number on the tile.
// `contains` would match by substring, which is not the same rule.
//
// When the answer cannot be trusted (the query failed, it returned as many
// lists as it was allowed to so some may be missing, or a list would not
// read), a tile says "couldn't count" rather than showing a number.
package dashboard

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/mcp"
)

// coverageComboLimit caps the grouped query. A reply this long may have been
// cut off, so its counts are not used.
const coverageComboLimit = 500

// coverageNetwork are the sources that see devices on the network itself.
// "NIOS-X Discovery" is how the cube names the tenant's Network Insight
// source (the providers API calls it Network Insight).
var coverageNetwork = []string{"dhcp logs", "nios grid", "nios-x discovery", "network insight"}

// coverageInventory are the tools meant to know every device, matched by part
// of their name, with the plain word the page uses for each kind.
var coverageInventory = []struct{ match, role string }{
	{"infoblox endpoint", "Infoblox agent"},
	{"crowdstrike", "security agent"},
	{"sentinelone", "security agent"},
	{"defender", "security agent"},
	{"carbon black", "security agent"},
	{"servicenow", "asset register"},
	{"intune", "device management"},
	{"jamf", "device management"},
	{"workspace one", "device management"},
}

// coverageRole says whether a source sees the network ("network"), is meant
// to know every device ("inventory", with its kind), or neither (cloud
// sources such as AWS, whose assets are not devices on the network).
func coverageRole(label string) (kind, role string) {
	l := strings.ToLower(strings.TrimSpace(label))
	if slices.Contains(coverageNetwork, l) || strings.Contains(l, "dhcp") {
		return "network", ""
	}
	for _, c := range coverageInventory {
		if strings.Contains(l, c.match) {
			return "inventory", c.role
		}
	}
	return "", ""
}

type coverageCombo struct {
	raw    string
	labels []string
	count  int
}

// parseCombos reads the grouped rows. readable is false when any row's source
// list or count would not read; the rows that did read are still returned so
// the page can name the sources.
func parseCombos(rows []map[string]any) (combos []coverageCombo, readable bool) {
	readable = true
	for _, raw := range rows {
		r := flattenCubeRow(raw)
		text := getStr(r["providers_label"])
		var labels []string
		v, _ := firstPresent(r, "assetsCount", "count")
		n, ok := comboCount(v)
		if err := json.Unmarshal([]byte(text), &labels); err != nil {
			readable = false
			continue
		}
		// A list with no readable count still names its sources, so their
		// tiles show; readable false makes every count "couldn't count".
		if !ok {
			readable = false
		}
		combos = append(combos, coverageCombo{raw: text, labels: labels, count: n})
	}
	return combos, readable
}

// comboCount reads an asset count, which the cube sends as a string. Anything
// that is not a whole number of zero or more is unreadable, never 0: toFloat
// would turn "unknown" into 0 and a tile would show a gap of 0.
func comboCount(v any) (int, bool) {
	var f float64
	switch t := v.(type) {
	case string:
		p, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0, false
		}
		f = p
	case float64:
		f = t
	case int:
		f = float64(t)
	default:
		return 0, false
	}
	if f < 0 || f != math.Trunc(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return int(f), true
}

func (c coverageCombo) hasNetwork() bool {
	return slices.ContainsFunc(c.labels, func(l string) bool { k, _ := coverageRole(l); return k == "network" })
}

// assembleCoverage is pure: the grouped rows in, the tiles out.
func assembleCoverage(rows []map[string]any, err error) map[string]any {
	if rows == nil {
		reason := "the asset source query failed upstream"
		if r := mcp.Reason(err); r != "" {
			reason = r
		}
		return map[string]any{
			"availability": "error", "reason": reason, "total": nil,
			"network": []string{}, "gaps": []map[string]any{},
		}
	}
	combos, readable := parseCombos(rows)
	complete := readable && len(rows) < coverageComboLimit

	network, inventory := []string{}, map[string]string{}
	total := 0
	for _, c := range combos {
		total += c.count
		for _, l := range c.labels {
			switch kind, role := coverageRole(l); kind {
			case "network":
				if !slices.Contains(network, l) {
					network = append(network, l)
				}
			case "inventory":
				inventory[l] = role
			}
		}
	}
	sort.Strings(network)

	gaps := []map[string]any{}
	if len(network) > 0 {
		for source, role := range inventory {
			var count any
			if complete {
				n := 0
				for _, c := range combos {
					if c.hasNetwork() && !slices.Contains(c.labels, source) {
						n += c.count
					}
				}
				count = n
			}
			gaps = append(gaps, map[string]any{"source": source, "role": role, "count": count})
		}
	}
	// Largest gap first; an uncounted one after the counted, then by name.
	sort.Slice(gaps, func(i, j int) bool {
		a, aok := gaps[i]["count"].(int)
		b, bok := gaps[j]["count"].(int)
		if aok != bok {
			return aok
		}
		if a != b {
			return a > b
		}
		return gaps[i]["source"].(string) < gaps[j]["source"].(string)
	})

	out := map[string]any{"availability": "ok", "network": network, "gaps": gaps, "total": nil}
	if complete {
		out["total"] = total
	} else if !readable {
		out["reason"] = "couldn't count: a list of sources came back in a form this app could not read"
	} else {
		out["reason"] = "couldn't count: there were more combinations of sources than this app reads at once"
	}
	return out
}

// gapCombos is the exact source lists counted for source's tile, for the
// table filter. ok is false when that tile has no trustworthy count.
func gapCombos(rows []map[string]any, source string) ([]string, bool) {
	if rows == nil || len(rows) >= coverageComboLimit {
		return nil, false
	}
	combos, readable := parseCombos(rows)
	if !readable {
		return nil, false
	}
	present := false
	for _, c := range combos {
		for _, l := range c.labels {
			if k, _ := coverageRole(l); k == "inventory" && l == source {
				present = true
			}
		}
	}
	if !present {
		return nil, false
	}
	out := []string{}
	for _, c := range combos {
		if c.hasNetwork() && !slices.Contains(c.labels, source) {
			out = append(out, c.raw)
		}
	}
	return out, true
}

var errCoverageDegraded = errors.New("assets: source combination read failed — not cached")

// coverageRows is the grouped query, cached like the other asset reads. A
// failure is not cached, so the next visit asks again.
func (s *Service) coverageRows(ctx context.Context) ([]map[string]any, error) {
	if s.Mcp == nil {
		return nil, errors.New("the MCP session to Infoblox could not be opened")
	}
	v, err := s.Cache.DoFresh(cache.Key("assets", "coverage", nil, false), func() (any, error) {
		rows, err := s.Mcp.QueryCubeErr(ctx, assetsCube, []string{assetsMeasure}, map[string]any{
			"dimensions": []string{assetsCube + ".providers_label"},
			"order":      map[string]any{assetsMeasure: "desc"},
			"limit":      coverageComboLimit,
		})
		if rows == nil {
			if err == nil {
				err = errCoverageDegraded
			}
			return nil, err
		}
		return rows, nil
	})
	rows, _ := v.([]map[string]any)
	return rows, err
}

// FetchAssetCoverage is the /api/csp/asset-coverage read.
func (s *Service) FetchAssetCoverage(ctx context.Context) map[string]any {
	rows, err := s.coverageRows(ctx)
	return assembleCoverage(rows, err)
}

// gapFilter is the list filter for one gap tile. ok is false when the tile's
// assets cannot be worked out; the list must then say so rather than show
// every asset under the tile's name.
func (s *Service) gapFilter(ctx context.Context, source string) (filter map[string]any, none bool, ok bool) {
	rows, _ := s.coverageRows(ctx)
	combos, ok := gapCombos(rows, source)
	if !ok {
		return nil, false, false
	}
	if len(combos) == 0 {
		return nil, true, true
	}
	return map[string]any{
		"member": assetsCube + ".providers_label", "operator": "equals", "values": combos,
	}, false, true
}
