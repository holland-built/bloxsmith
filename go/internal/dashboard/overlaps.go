package dashboard

import (
	"errors"
	"fmt"
	"log"
	"net/netip"
	"sort"
	"strconv"
	"strings"

	"bloxsmith/internal/rest"
)

// Overlapping ranges: address ranges that more than one IP space uses. It is a
// read-only answer to "do we show overlapping address spaces?", served at
// GET /api/ipam/overlaps for the Network page and as the AI tool
// get_overlapping_ranges. Nothing in Infoblox changes.
//
// What is read (checked live 2026-11-16 on a tenant with 848 spaces, 4,679
// blocks and 72,599 subnets): every address block, and only the subnets with no
// parent (11,080 there). A subnet inside a block is covered by that block, and
// reading all 72,599 subnets was too slow. `parent~"..."` answers 500;
// `parent==null` works.
//
// NEVER A PARTIAL ANSWER. A list that cannot be shown to be whole is an error,
// because a missing block could hide an overlap and the page would say there is
// none. Subnets report page.total_size, so they are read until the distinct ids
// read equal it. address_block reports no total at all, so blocks (and spaces)
// are read with _offset until a page comes back EMPTY. That is one request more
// than stopping at a short page, and it is what rules out a page cap below our
// _limit: a capped page looks short, but the next offset then still has rows.

// overlapPage is the _limit of each read. A subnet page this size took about
// 3.4 s live, so the subnet pages after the first are read side by side.
const overlapPage = 2000

// overlapMaxPages stops a read that never ends (an upstream ignoring _offset
// would repeat page one forever). 200 pages of 2,000 is 400,000 rows.
const overlapMaxPages = 200

// overlapParallel is how many subnet pages are read at once.
const overlapParallel = 4

// SpacePrefix is one block or top-level subnet: the IP space it is in and its
// range, and the object's own id and kind ("address_block" or "subnet") so the
// card can open it in the Editor.
type SpacePrefix struct {
	Space  string
	Prefix netip.Prefix
	ID     string
	Kind   string
}

// OverlapRange is one of a member's ranges and the object it came from.
type OverlapRange struct {
	Prefix string `json:"prefix"`
	ID     string `json:"id"`
	Kind   string `json:"kind"`
}

// OverlapMember is one IP space in a group, with its own outermost ranges in
// it. Prefixes is the ranges alone (the AI tool reads it); Ranges is the same
// ranges in the same order, each with its object.
type OverlapMember struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Prefixes []string       `json:"prefixes"`
	Ranges   []OverlapRange `json:"ranges"`
}

// OverlapGroup is a run of ranges that touch, used by 2 or more IP spaces.
// Range is the widest member, which covers the whole group. A group is ranges
// that touch, not the same range everywhere: A 10.0.0.0/8, B 10.1.0.0/16 and
// C 10.2.0.0/16 are one group of 3 spaces although B and C do not overlap, so
// every member lists its own ranges.
type OverlapGroup struct {
	Range   string          `json:"range"`
	Spaces  int             `json:"spaces"`
	Members []OverlapMember `json:"members"`
}

// PrefixOf reads Infoblox's {"address": "10.0.0.0", "cidr": 24} pair. It is
// the one copy; server's prefixOf (provision_preview.go) calls it.
func PrefixOf(m map[string]any) (netip.Prefix, bool) {
	a, _ := m["address"].(string)
	addr, err := netip.ParseAddr(strings.TrimSpace(a))
	if err != nil {
		return netip.Prefix{}, false
	}
	var bits int
	switch v := m["cidr"].(type) {
	case float64:
		bits = int(v)
	case string:
		n, err := strconv.Atoi(v)
		if err != nil {
			return netip.Prefix{}, false
		}
		bits = n
	default:
		return netip.Prefix{}, false
	}
	p, err := addr.Prefix(bits)
	return p, err == nil
}

// prefixLess orders by family (IPv4 first, netip.Addr.Compare does that), then
// start address, then widest first, so an equal-start /8 comes before its /16.
func prefixLess(a, b netip.Prefix) bool {
	if c := a.Addr().Compare(b.Addr()); c != 0 {
		return c < 0
	}
	return a.Bits() < b.Bits()
}

// Outermost keeps, for each space, only the ranges no other range of that same
// space contains, so nested blocks and subnets in one space are not counted
// twice. A duplicate counts as contained.
func Outermost(items []SpacePrefix) []SpacePrefix {
	sorted := append([]SpacePrefix(nil), items...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].Space != sorted[j].Space {
			return sorted[i].Space < sorted[j].Space
		}
		return prefixLess(sorted[i].Prefix, sorted[j].Prefix)
	})
	var out []SpacePrefix
	for _, it := range sorted {
		// Sorted by start, widest first, CIDRs either nest or miss each other,
		// so the last range kept is the only one that can contain this one.
		if n := len(out); n > 0 && out[n-1].Space == it.Space && out[n-1].Prefix.Contains(it.Prefix.Addr()) &&
			out[n-1].Prefix.Bits() <= it.Prefix.Bits() {
			continue
		}
		out = append(out, it)
	}
	return out
}

// GroupOverlaps sweeps every space's outermost ranges in address order, merges
// the ones that overlap, and keeps the groups used by 2 or more spaces, the
// most spaces first. names maps space id to name; an id with no name shows the
// id. Spaces are kept apart by id, so two spaces with one name are two members.
func GroupOverlaps(items []SpacePrefix, names map[string]string) []OverlapGroup {
	outer := Outermost(items)
	sort.SliceStable(outer, func(i, j int) bool { return prefixLess(outer[i].Prefix, outer[j].Prefix) })

	var groups []OverlapGroup
	flush := func(run []SpacePrefix) {
		bySpace := map[string][]string{}
		ranges := map[string][]OverlapRange{}
		var order []string
		for _, it := range run {
			if _, seen := bySpace[it.Space]; !seen {
				order = append(order, it.Space)
			}
			bySpace[it.Space] = append(bySpace[it.Space], it.Prefix.String())
			ranges[it.Space] = append(ranges[it.Space], OverlapRange{Prefix: it.Prefix.String(), ID: it.ID, Kind: it.Kind})
		}
		if len(order) < 2 {
			return
		}
		g := OverlapGroup{Range: run[0].Prefix.String(), Spaces: len(order)}
		for _, id := range order {
			name := names[id]
			if strings.TrimSpace(name) == "" {
				name = id
			}
			g.Members = append(g.Members, OverlapMember{ID: id, Name: name, Prefixes: bySpace[id], Ranges: ranges[id]})
		}
		sort.SliceStable(g.Members, func(i, j int) bool {
			if a, b := strings.ToLower(g.Members[i].Name), strings.ToLower(g.Members[j].Name); a != b {
				return a < b
			}
			return g.Members[i].ID < g.Members[j].ID
		})
		groups = append(groups, g)
	}

	var run []SpacePrefix
	for _, it := range outer {
		// run[0] starts lowest and is widest at that start, so anything that
		// starts inside it nests inside it, and its range is the group's range.
		if len(run) > 0 && run[0].Prefix.Contains(it.Prefix.Addr()) {
			run = append(run, it)
			continue
		}
		if len(run) > 0 {
			flush(run)
		}
		run = []SpacePrefix{it}
	}
	if len(run) > 0 {
		flush(run)
	}
	// Ties stay in address order (the sweep's order) because the sort is stable.
	sort.SliceStable(groups, func(i, j int) bool { return groups[i].Spaces > groups[j].Spaces })
	return groups
}

// overlapError is a read that could not be shown to be whole. msg is the
// plain sentence the card and the AI show.
type overlapError struct{ msg, detail string }

func (e *overlapError) Error() string { return e.msg + " (" + e.detail + ")" }

func overlapFail(msg, format string, a ...any) error {
	return &overlapError{msg: msg, detail: fmt.Sprintf(format, a...)}
}

const (
	msgSubnets = "Couldn't read every subnet, so the list could be wrong."
	msgBlocks  = "Couldn't read every address block, so the list could be wrong."
	msgSpaces  = "Couldn't read the IP space names, so the list could be wrong."
)

// readCounted reads a list that reports page.total_size, overlapPage rows at a
// time, the pages after the first side by side, and returns it only when the
// distinct ids read equal that total.
func readCounted(c *rest.Client, path string, params map[string]string, msg string) ([]any, error) {
	get := func(offset int) ([]any, int, error) {
		p := map[string]string{"_limit": strconv.Itoa(overlapPage), "_offset": strconv.Itoa(offset),
			"_is_total_size_needed": "true", "_order_by": "id"}
		for k, v := range params {
			p[k] = v
		}
		rows, body, err := c.GetPageStrict(path, p)
		if err != nil {
			return nil, 0, err
		}
		page, _ := body["page"].(map[string]any)
		s, _ := page["total_size"].(string)
		total, err := strconv.Atoi(strings.TrimSpace(s))
		if err != nil || total < 0 {
			return nil, 0, errors.New("no total reported")
		}
		return rows, total, nil
	}
	first, total, err := get(0)
	if err != nil {
		return nil, overlapFail(msg, "%s: %v", path, err)
	}
	pages := (total + overlapPage - 1) / overlapPage
	if pages > overlapMaxPages {
		return nil, overlapFail(msg, "%s: %d rows is more than this reads", path, total)
	}
	later := make([][]any, pages)
	errs := make([]error, pages)
	var tasks []func()
	for i := 1; i < pages; i++ {
		tasks = append(tasks, func() {
			rows, t, err := get(i * overlapPage)
			if err == nil && t != total {
				err = fmt.Errorf("the total changed from %d to %d while reading", total, t)
			}
			later[i], errs[i] = rows, err
		})
	}
	if fanOut(overlapParallel, tasks...) > 0 {
		return nil, overlapFail(msg, "%s: a page read failed unexpectedly", path)
	}
	all := first
	for i := 1; i < pages; i++ {
		if errs[i] != nil {
			return nil, overlapFail(msg, "%s: %v", path, errs[i])
		}
		all = append(all, later[i]...)
	}
	if n := distinctIDs(all); n != total || len(all) != total {
		return nil, overlapFail(msg, "%s: read %d rows (%d distinct) of %d", path, len(all), n, total)
	}
	return all, nil
}

// readToEmpty reads a list that reports no total, page after page, until a page
// comes back empty. Repeated ids mean the list moved under the read.
func readToEmpty(c *rest.Client, path string, params map[string]string, msg string) ([]any, error) {
	var all []any
	for i := 0; i < overlapMaxPages; i++ {
		p := map[string]string{"_limit": strconv.Itoa(overlapPage), "_offset": strconv.Itoa(len(all)), "_order_by": "id"}
		for k, v := range params {
			p[k] = v
		}
		rows, body, err := c.GetPageStrict(path, p)
		if err != nil {
			return nil, overlapFail(msg, "%s: %v", path, err)
		}
		// GetStrict-style unwrapping reads {} (or any body with no results
		// array) as zero rows. Only a results array that is really empty is the
		// end of the list; anything else would end the read early and hide
		// overlaps.
		if _, ok := body["results"].([]any); !ok {
			return nil, overlapFail(msg, "%s: a page came back with no results list", path)
		}
		if len(rows) == 0 {
			if n := distinctIDs(all); n != len(all) {
				return nil, overlapFail(msg, "%s: %d rows but %d distinct", path, len(all), n)
			}
			return all, nil
		}
		all = append(all, rows...)
	}
	return nil, overlapFail(msg, "%s: still not at the end after %d pages", path, overlapMaxPages)
}

func distinctIDs(rows []any) int {
	seen := map[string]bool{}
	for _, r := range rows {
		seen[getStr(asMap(r)["id"])] = true
	}
	return len(seen)
}

// spacePrefixes turns rows into SpacePrefix values. A row with no readable
// range, or no space, is an error, never skipped: skipping it could hide an
// overlap.
func spacePrefixes(rows []any, kind, noun, msg string) ([]SpacePrefix, error) {
	out := make([]SpacePrefix, 0, len(rows))
	for _, r := range rows {
		m := asMap(r)
		p, ok := PrefixOf(m)
		if !ok {
			return nil, overlapFail(msg, "a %s (%s) has no readable address", noun, getStr(m["id"]))
		}
		space := strings.TrimSpace(getStr(m["space"]))
		if space == "" {
			return nil, overlapFail(msg, "a %s (%s) has no IP space", noun, getStr(m["id"]))
		}
		out = append(out, SpacePrefix{Space: space, Prefix: p, ID: getStr(m["id"]), Kind: kind})
	}
	return out, nil
}

// FetchOverlaps reads blocks, top-level subnets and space names at once and
// groups them. It answers {"status":"ok","groups":[]OverlapGroup,"portal":...} or
// {"status":"error","error":"<plain sentence>"} with no groups at all. The
// answer is shared for TileTTL across callers (the card and the AI tool) and a
// failure is not kept.
func (s *Service) FetchOverlaps() map[string]any {
	return s.CachedRead("ipam-overlaps", func() map[string]any {
		var (
			blocks, subnets, spaces []any
			bErr, sErr, nErr        error
		)
		mustFanOut(
			func() {
				blocks, bErr = readToEmpty(s.Rest, "/api/ddi/v1/ipam/address_block",
					map[string]string{"_fields": "id,space,address,cidr"}, msgBlocks)
			},
			func() {
				subnets, sErr = readCounted(s.Rest, "/api/ddi/v1/ipam/subnet",
					map[string]string{"_fields": "id,space,address,cidr", "_filter": "parent==null"}, msgSubnets)
			},
			func() {
				spaces, nErr = readToEmpty(s.Rest, "/api/ddi/v1/ipam/ip_space",
					map[string]string{"_fields": "id,name"}, msgSpaces)
			},
		)
		fail := func(err error) map[string]any {
			log.Printf("[overlaps] %v", err)
			msg := err.Error()
			var oe *overlapError
			if errors.As(err, &oe) {
				msg = oe.msg
			}
			return map[string]any{"status": "error", "error": msg}
		}
		for _, err := range []error{sErr, bErr, nErr} {
			if err != nil {
				return fail(err)
			}
		}
		items, err := spacePrefixes(blocks, "address_block", "address block", msgBlocks)
		if err != nil {
			return fail(err)
		}
		more, err := spacePrefixes(subnets, "subnet", "subnet", msgSubnets)
		if err != nil {
			return fail(err)
		}
		items = append(items, more...)
		names := map[string]string{}
		for _, r := range spaces {
			m := asMap(r)
			names[getStr(m["id"])] = getStr(m["name"])
		}
		groups := GroupOverlaps(items, names)
		if groups == nil {
			groups = []OverlapGroup{}
		}
		// portal is this server's Infoblox address (INFOBLOX_URL), so a space
		// link opens the tenant's own region, as Build a chart's links do.
		return map[string]any{"status": "ok", "groups": groups,
			"blocks": len(blocks), "subnets": len(subnets), "spaces": len(spaces), "portal": s.Rest.BaseURL()}
	})
}

// The AI tool's caps: the 20 biggest groups, 25 spaces in each and 5 ranges per
// space, each with a count of what was left out.
const (
	aiOverlapGroups   = 20
	aiOverlapSpaces   = 25
	aiOverlapPrefixes = 5
)

// overlapMeaning travels inside the tool result so the model cannot report a
// group as one range shared everywhere.
const overlapMeaning = "A group is address ranges that touch, not the same range in every space: " +
	"10.0.0.0/8 in one space, 10.1.0.0/16 in a second and 10.2.0.0/16 in a third is one group of 3 spaces, " +
	"although the second and third do not overlap each other. range is the widest range in the group. " +
	"Each entry in spaces is a space name and that space's own ranges in the group. Counted from every " +
	"address block and every subnet not inside one; ranges nested inside another range of the same space are not counted again."

type aiOverlapGroup struct {
	Range      string   `json:"range"`
	SpaceCount int      `json:"space_count"`
	Spaces     []string `json:"spaces"`
	MoreSpaces int      `json:"more_spaces_not_listed,omitempty"`
}

// aiOverlaps leads with summary, like toolPayload, so ai.toolFact shows it.
type aiOverlaps struct {
	Summary     string           `json:"summary"`
	Untrusted   string           `json:"UNTRUSTED_DATA_NOTICE"`
	Meaning     string           `json:"meaning"`
	TotalGroups int              `json:"total_groups"`
	MoreGroups  int              `json:"more_groups_not_listed"`
	Groups      []aiOverlapGroup `json:"groups"`
}

func overlapsForAI(groups []OverlapGroup) aiOverlaps {
	shown := groups
	if len(shown) > aiOverlapGroups {
		shown = shown[:aiOverlapGroups]
	}
	out := aiOverlaps{Untrusted: untrustedNotice, Meaning: overlapMeaning,
		TotalGroups: len(groups), MoreGroups: len(groups) - len(shown), Groups: []aiOverlapGroup{}}
	for _, g := range shown {
		ag := aiOverlapGroup{Range: g.Range, SpaceCount: g.Spaces}
		for i, m := range g.Members {
			if i == aiOverlapSpaces {
				ag.MoreSpaces = len(g.Members) - i
				break
			}
			ps := m.Prefixes
			extra := ""
			if len(ps) > aiOverlapPrefixes {
				extra = fmt.Sprintf(" and %d more", len(ps)-aiOverlapPrefixes)
				ps = ps[:aiOverlapPrefixes]
			}
			ag.Spaces = append(ag.Spaces, m.Name+": "+strings.Join(ps, ", ")+extra)
		}
		out.Groups = append(out.Groups, ag)
	}
	switch {
	case len(groups) == 1:
		out.Summary = "1 address range group is used in more than one IP space."
	case out.MoreGroups > 0:
		out.Summary = fmt.Sprintf("%d address range groups are each used in more than one IP space; the %d with the most spaces are listed.", len(groups), len(shown))
	default:
		out.Summary = fmt.Sprintf("%d address range groups are each used in more than one IP space.", len(groups))
	}
	return out
}

// overlapsTool is the get_overlapping_ranges AI tool. A failed or partial read
// is a lookup failure, never "none".
func (s *Service) overlapsTool() string {
	res := s.FetchOverlaps()
	groups, ok := res["groups"].([]OverlapGroup)
	if res["status"] != "ok" || !ok {
		return aiLookupFailed("overlapping address ranges", getStr(res["error"]))
	}
	if len(groups) == 0 {
		return "No address range is used in more than one IP space."
	}
	return jstr(overlapsForAI(groups))
}
