// Asset inventory: the searchable, filterable, paged asset list behind the
// Assets tab.
//
// WHY A NEW FILE RATHER THAN MORE OF threatintel.go. threatintel.go's
// FetchAssets reads the SecurityActionAssets cube — assets that a security
// ACTION touched. That is a different population from "every asset discovery
// found", it is capped at 500 rows in one shot, and it has no paging, no
// search and no filter. Nothing there is reusable for an inventory; only the
// pure-assembler SHAPE is, and that is copied deliberately (see
// assembleAssetInventory).
//
// WHICH CUBE, AND WHY NOT THE OBVIOUS ONE. AssetDetailsOnly looks like the
// asset-registry cube and its own description forbids exactly this use: "Do
// NOT use this cube for general asset enumeration ... use AssetDetails_ch_agg
// for those." AssetDetails_ch is one row per asset-INSIGHT, so an asset with
// three findings appears three times and every count is wrong. AssetDetails_ch_agg
// is one row per asset (CQID), which is the grain a list needs.
//
// THE FACTS THIS FILE IS BUILT ON were measured live against the real tenant
// on 2026-08-06 through infoblox-portal_query_cube. They are written down
// because several of them are surprising and none is discoverable from the
// cube schema:
//
//   - Real total: 2,620 assets (assetsCount == count).
//   - limit/offset paging works and does not overlap: offset 2500 returned
//     50 rows, offset 2600 returned 20, neither sharing a row with page 1.
//   - filters `contains` works and is case-insensitive; it even works on the
//     JSON-array dimensions (ip_addresses contains "100.100.100." -> 252).
//   - filters `equals` works (taxonomy_type_label equals "Laptop" -> 125).
//   - MAX 6 DIMENSIONS PER QUERY. A seventh is refused outright with "Query
//     blocked by guardrail". This is the single hardest constraint here and
//     it is what dictates the column split below.
//   - ROWS ARE GROUPED BY THE DIMENSION TUPLE, not one row per asset. Without
//     cqid in the dimension set, distinct assets collapse into one row — the
//     probe saw name "default" come back as a single row carrying
//     assetsCount 145. cqid is therefore not a display column, it is the
//     thing that makes a row mean one asset. Never drop it to free a slot.
//   - Column fill rates over all 2,620: taxonomy_type_label 100%,
//     providers_label 100%, last_seen 99.3%, name 84.4%, vendor 81.1%,
//     ip_addresses 61.3%, os 27.9%.
//
// WHY os IS NOT IN THE TABLE. It is blank on 72% of assets. A column that is
// empty in three rows out of four spends real width to tell you nothing, and
// DataTable would auto-hide it on most pages anyway (see visibleColumns),
// which would make the column set flicker between pages. It moves to the
// per-row detail read, along with ip_addresses/mac_addresses/model/location —
// a second query keyed on cqid, which is what buys the second budget of six
// dimensions. That read fires on a row click, so an operator only pays for it
// on the rows they actually ask about.
//
// WHY NOT MERGE THE TWO DIMENSION SETS INTO ONE PAGED PAIR OF QUERIES. Issuing
// list-dims and detail-dims as two queries with the same filter/order/offset
// and zipping them by position was the cheaper-looking option and it is
// wrong: ties in the sort key have no defined resolution, so two queries can
// order tied rows differently and the zip silently attaches one asset's OS to
// another asset's row. Keying the detail read on cqid cannot do that.
package dashboard

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"bloxsmith/internal/cache"
)

const (
	assetsCube = "AssetDetails_ch_agg"
	// assetsMeasure counts ASSETS, not rows. Both were 2,620 on the probe, so
	// they agree at the unfiltered top level; they are not the same thing once
	// a filter narrows the set, and "how many assets match" is the question a
	// list header is asking.
	assetsMeasure = assetsCube + ".assetsCount"
	// assetsPageSize is deliberately small. The cube's own hard ceiling is far
	// higher and internal/mcp caps a stored read at maxRows=5000, but a page is
	// a screenful an operator scrolls, not a bulk export — and every page costs
	// two upstream calls, so a big page is not free.
	assetsPageSize = 50
	// assetTypeLimit bounds the filter dropdown. The tenant had far fewer than
	// this many distinct taxonomy types; the cap exists so a pathological
	// tenant cannot turn a dropdown into a 10,000-entry payload.
	assetTypeLimit = 200
	// assetCqidMax bounds a client-supplied cqid before it is sent upstream.
	// The value travels as a JSON array element, so there is no string to
	// inject into — this is only about refusing an absurd body early.
	assetCqidMax = 200
	// assetQueryMax mirrors internal/mcp.Search's 256-char cap on user text.
	assetQueryMax = 256
)

// assetListDims is EXACTLY six — the guardrail ceiling — and every slot is
// spent on purpose:
//
//	cqid                  the grain. Without it rows collapse (see file doc).
//	name                  what an operator searches by. 84.4% filled.
//	taxonomy_type_label   the filter facet. 100% filled.
//	providers_label       where the asset was discovered. 100% filled.
//	vendor                81.1% filled.
//	last_seen             the default sort. 99.3% filled.
//
// Adding a seventh does not degrade, it fails the whole query. Anything else
// worth showing goes in assetDetailDims.
var assetListDims = []string{
	assetsCube + ".cqid",
	assetsCube + ".name",
	assetsCube + ".taxonomy_type_label",
	assetsCube + ".providers_label",
	assetsCube + ".vendor",
	assetsCube + ".last_seen",
}

// assetDetailDims is the second budget of six, spent on the fields that are
// too sparse or too wide for a table cell but are the first thing anyone asks
// once they have picked a row. cqid is here for the same reason as above:
// it is the filter target AND the grain.
var assetDetailDims = []string{
	assetsCube + ".cqid",
	assetsCube + ".os",
	assetsCube + ".ip_addresses",
	assetsCube + ".mac_addresses",
	assetsCube + ".model",
	assetsCube + ".location",
}

// assetSortDims is the SORT WHITELIST, and it is the only reason a client
// string may reach the cube's `order` argument. The sort key arrives from a
// query string; mapping it through this table means an unknown key becomes
// the default rather than a dimension name of the caller's choosing. Nothing
// is interpolated — the value used is always one of these constants.
//
// The keys are the UI's column names, not the cube's dimension names, so the
// wire contract does not leak the cube's schema into the browser.
var assetSortDims = map[string]string{
	"name":      assetsCube + ".name",
	"type":      assetsCube + ".taxonomy_type_label",
	"provider":  assetsCube + ".providers_label",
	"vendor":    assetsCube + ".vendor",
	"last_seen": assetsCube + ".last_seen",
}

// assetDefaultSort is last_seen desc: the most recently seen assets first.
// Recency is the only ordering that is useful before the operator has said
// anything about what they are looking for — an alphabetical list of 2,620
// machine names answers no question.
const (
	assetDefaultSort = "last_seen"
	assetDefaultDir  = "desc"
)

// errAssetFeedDegraded is handed back to cache.Do so a FAILED read is not
// stored. cache.Do skips SetGen on a non-nil error but still returns the
// value, which is exactly the behaviour wanted here: the caller gets the
// honest "could not look" payload to render, and the next request retries
// instead of serving that failure for the next five minutes.
var errAssetFeedDegraded = errors.New("assets: upstream read failed — not cached")

// AssetQuery is one normalised, already-validated list request. Handlers build
// it through normalizeAssetQuery and never construct it by hand, so there is
// exactly one place where an untrusted string becomes a safe one.
type AssetQuery struct {
	Q    string // free-text, matched with `contains` against name
	Type string // exact taxonomy_type_label, or "" for all
	Sort string // a KEY of assetSortDims, never a raw dimension
	Dir  string // "asc" or "desc", never anything else
	Page int    // zero-based
}

// normalizeAssetQuery turns raw query-string values into an AssetQuery that
// is safe to send upstream. Every field is either clamped to a known-good
// value or replaced by a default — this function never returns an error and
// never rejects a request, because a dashboard that answers "400" to a
// mistyped sort key is worse than one that shows the default order.
func normalizeAssetQuery(q, typ, sort, dir string, page int) AssetQuery {
	aq := AssetQuery{
		Q:    clampLen(strings.TrimSpace(q), assetQueryMax),
		Type: clampLen(strings.TrimSpace(typ), assetQueryMax),
		Sort: assetDefaultSort,
		Dir:  assetDefaultDir,
	}
	// Whitelist, not sanitise: membership in assetSortDims is the check.
	if _, ok := assetSortDims[sort]; ok {
		aq.Sort = sort
	}
	if dir == "asc" || dir == "desc" {
		aq.Dir = dir
	}
	if page > 0 {
		aq.Page = page
	}
	return aq
}

// clampLen truncates by BYTES, which can split a multi-byte rune. That is
// acceptable here and nowhere else: the result is only ever used as a
// `contains` needle or an `equals` value, so a truncated tail matches fewer
// rows rather than corrupting anything. It is not used for display.
func clampLen(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// assetFilters builds the cube `filters` array for one query. Returns nil when
// nothing is filtered, and the caller then omits the argument entirely rather
// than sending an empty array — an empty filters array is a shape the probe
// never exercised, and sending an argument nobody tested is how a working
// unfiltered query turns into a mystery.
func assetFilters(aq AssetQuery) []map[string]any {
	var out []map[string]any
	if aq.Q != "" {
		// `contains` on name only. It is tempting to OR this across name and
		// ip_addresses (contains works on the JSON-array dims too, measured),
		// but cube filters at the top level AND together — an OR needs a
		// nested `or` group that was never probed, so it is not guessed at
		// here. Search means "by name" until an OR group is measured.
		out = append(out, map[string]any{
			"member": assetsCube + ".name", "operator": "contains", "values": []string{aq.Q},
		})
	}
	if aq.Type != "" {
		out = append(out, map[string]any{
			"member": assetsCube + ".taxonomy_type_label", "operator": "equals", "values": []string{aq.Type},
		})
	}
	return out
}

// --- the honesty shapes ------------------------------------------------------
//
// This package's three-word status vocabulary is defined at the top of
// dashboard.go: "ok" (the read worked, rows or not), "empty" (it worked and
// genuinely found nothing) and "error" (it failed). List payloads use the
// section-level spelling — availability + reason — because the UI needs the
// reason to put on screen, and because "the job could not look" must never
// render like "the job looked and found nothing".

// assetsUnavailable is the could-not-look payload. Note what it does NOT
// contain: a zero total. total is explicitly nil, because 0 is a fact about
// the tenant and this payload knows no facts about the tenant.
func assetsUnavailable(aq AssetQuery, reason string) map[string]any {
	return map[string]any{
		"rows":         []any{},
		"total":        nil,
		"has_more":     false,
		"page":         aq.Page,
		"page_size":    assetsPageSize,
		"sort":         aq.Sort,
		"dir":          aq.Dir,
		"availability": "error",
		"reason":       reason,
	}
}

// --- list --------------------------------------------------------------------

// FetchAssetInventory is the /api/csp/assets read: one page of the asset list
// plus the total the page is drawn from.
//
// CACHING. The key carries every parameter that changes the answer, so two
// different searches cannot serve each other's rows — that sounds obvious and
// is the exact bug a key built from the route path alone produces. It goes
// through Cache.Do rather than Get/SetGen so N concurrent callers on a cold
// key (two browser tabs, a refresh landing on a first load) collapse into one
// pair of upstream calls instead of 2N.
//
// NO POLLING backs this endpoint by design. Asset data changes on discovery
// sync cycles, not second to second, so Security.jsx's 30s poll would spend
// two upstream calls every 30 seconds per open tab to redraw identical rows.
// The tab has a manual Refresh instead.
func (s *Service) FetchAssetInventory(ctx context.Context, q, typ, sort, dir string, page int) map[string]any {
	aq := normalizeAssetQuery(q, typ, sort, dir, page)
	ck := cache.Key("assets", "list", map[string]string{
		"q": aq.Q, "type": aq.Type, "sort": aq.Sort, "dir": aq.Dir,
		"page": strconv.Itoa(aq.Page),
	}, false)

	v, _ := s.Cache.Do(ck, func() (any, error) {
		res := s.assetInventoryUncached(ctx, aq)
		if res["availability"] == "error" {
			return res, errAssetFeedDegraded
		}
		return res, nil
	})
	out, ok := v.(map[string]any)
	if !ok {
		// Only reachable if Do returned a nil value, which today means the
		// fetch panicked and cache.Do converted that into an error. Render it
		// as could-not-look rather than letting a nil map reach the encoder.
		return assetsUnavailable(aq, "the asset inventory read did not complete")
	}
	return out
}

// assetInventoryUncached issues the two upstream reads. It is split from the
// assembler on purpose: Service.Mcp is a concrete *mcp.Client, not an
// interface, so this half cannot be faked in a unit test — which is exactly
// why every decision worth testing lives in assembleAssetInventory instead.
func (s *Service) assetInventoryUncached(ctx context.Context, aq AssetQuery) map[string]any {
	if s.Mcp == nil || s.Mcp.Initialize(ctx) != nil {
		return assetsUnavailable(aq, "the MCP session to Infoblox could not be opened")
	}
	filters := assetFilters(aq)

	listOpts := map[string]any{
		"dimensions": assetListDims,
		"order":      map[string]any{assetSortDims[aq.Sort]: aq.Dir},
		"limit":      assetsPageSize,
		"offset":     aq.Page * assetsPageSize,
	}
	if filters != nil {
		listOpts["filters"] = filters
	}
	listRows := s.Mcp.QueryCube(ctx, assetsCube, []string{assetsMeasure}, listOpts)

	// The total is a SEPARATE measures-only query, not a number derived from
	// the page. A page can only ever tell you about its own 50 rows; the
	// header says "N assets", which is a claim about the whole filtered set.
	countOpts := map[string]any{}
	if filters != nil {
		countOpts["filters"] = filters
	}
	countRows := s.Mcp.QueryCube(ctx, assetsCube, []string{assetsMeasure}, countOpts)

	return assembleAssetInventory(aq, listRows, countRows)
}

// assembleAssetInventory is the pure assembler — no network, no clock, no
// service state — so the rules below are unit-testable, and they are the
// rules that matter.
//
// QueryCube returns a NIL slice on any transport, HTTP or parse failure and a
// NON-NIL slice on success (internal/mcp.Client.QueryCube). That nil check is
// the only signal that separates "the query failed" from "the query ran and
// this tenant has nothing matching" — the same distinction assembleAssetsResult
// and scalarCubeTotal are built on. Two rules follow, and they are different
// rules on purpose:
//
//  1. listRows == nil degrades the WHOLE payload to could-not-look. There are
//     no trustworthy rows, so there is nothing to show.
//
//  2. countRows == nil does NOT. The rows are still trustworthy — one query
//     failed and it was not the one that produced them. Throwing away a good
//     page because a header number is missing is the failure this file is
//     supposed to prevent, in the other direction. total goes to nil and the
//     UI must render no number at all; it must never fall back to 0, and it
//     must never print len(rows) as if it were the total.
//
// has_more exists FOR that second case. With total nil the browser cannot work
// out whether a next page exists, and "a full page came back" is the only
// honest signal available. It can be one page pessimistic — a set whose size
// is an exact multiple of the page size reports has_more on its last page, and
// the next page then comes back empty — which is the safe direction to be
// wrong in: offering a page that turns out to be empty costs a click, hiding
// a page that has rows in it loses data.
func assembleAssetInventory(aq AssetQuery, listRows, countRows []map[string]any) map[string]any {
	if listRows == nil {
		return assetsUnavailable(aq, "the asset inventory query failed upstream")
	}
	rows := normAssetRows(listRows)
	out := map[string]any{
		"rows":         rows,
		"total":        assetTotal(countRows),
		"has_more":     len(rows) == assetsPageSize,
		"page":         aq.Page,
		"page_size":    assetsPageSize,
		"sort":         aq.Sort,
		"dir":          aq.Dir,
		"availability": "ok",
	}
	return out
}

// assetTotal reads the scalar out of a measures-only count response, or nil
// when there is no trustworthy number to report.
//
// nil is returned for BOTH a failed query (countRows == nil) and an
// unrecognised-but-successful shape (no rows at all, where a measures-only
// cube query is documented to return exactly one). The second case is the
// less obvious one and it is deliberate: an empty response is not evidence of
// zero assets, it is evidence that this code does not understand the reply,
// and "0 assets" is far too confident a thing to say on that basis. A genuine
// zero arrives as one row carrying 0 and is reported as 0.
// Both cases collapse into one length check — len(nil) is 0 — which is safe
// here precisely BECAUSE they get the same answer. Anywhere the two must be
// told apart (assembleAssetInventory, assembleAssetDetail) the nil check is
// written out separately and must stay that way.
func assetTotal(countRows []map[string]any) any {
	if len(countRows) == 0 {
		return nil
	}
	r := flattenCubeRow(countRows[0])
	v, ok := firstPresent(r, "assetsCount", "count")
	if !ok {
		return nil
	}
	return int(toFloat(v))
}

// cubeList flattens the cube's JSON-ARRAY dimensions into something a cell can
// hold. Several dimensions here are arrays, not scalars — providers_label,
// ip_addresses and mac_addresses all are — and the cube hands them over as a
// JSON string rather than a JSON value: measured live 2026-08-06, an asset
// discovered by AWS returns providers_label as the six characters ["AWS"],
// and an asset with no addresses returns the two characters [].
//
// Passing that through untouched puts the literal text ["AWS"] in a table cell
// and the literal text [] where "not recorded" belongs — [] is the worst of
// the two, because it is not empty, so every downstream emptiness check (the
// UI's `value || 'not recorded'`, DataTable's own auto-hide) sees a present
// value and renders punctuation at the operator.
//
// Anything that does not parse as a JSON array is returned UNCHANGED. That is
// the important half: a plain scalar (vendor, name, os) must survive
// untouched, and so must an array-shaped value this function guesses wrong
// about — a failed parse degrades to showing the raw value, never to showing
// nothing.
func cubeList(v any) string {
	s := getStr(v)
	if !strings.HasPrefix(s, "[") {
		return s
	}
	var items []any
	if err := json.Unmarshal([]byte(s), &items); err != nil {
		return s
	}
	parts := make([]string, 0, len(items))
	for _, it := range items {
		if t := strings.TrimSpace(getStr(it)); t != "" {
			parts = append(parts, t)
		}
	}
	// An empty array becomes an empty string, which is the same "nothing
	// recorded" signal every other blank field in this package uses. That is
	// the point of the conversion.
	return strings.Join(parts, ", ")
}

// normAssetRows shapes cube rows into the wire contract. It returns a non-nil
// empty slice for an empty input, which is the whole "looked and found
// nothing" half of the contract — a nil here would encode as JSON null and
// the browser would have to guess which of the two states it was looking at.
//
// Keys are the UI's names, not the cube's. flattenCubeRow strips the
// "AssetDetails_ch_agg." prefix that QueryCube leaves behind; it also passes
// bare column names through untouched, which is what makes this work whether
// the row arrived inline or through the stored-parquet readback.
func normAssetRows(rows []map[string]any) []any {
	out := make([]any, 0, len(rows))
	for _, raw := range rows {
		r := flattenCubeRow(raw)
		out = append(out, map[string]any{
			"cqid":      orStr(r["cqid"], ""),
			"name":      orStr(r["name"], ""),
			"type":      orStr(r["taxonomy_type_label"], ""),
			"provider":  cubeList(r["providers_label"]),
			"vendor":    orStr(r["vendor"], ""),
			"last_seen": orStr(r["last_seen"], ""),
		})
	}
	return out
}

// --- filters -----------------------------------------------------------------

// FetchAssetFilters is the /api/csp/asset-filters read: the total plus the
// distinct asset types, with a count each, for the tab's chips and dropdown.
//
// WHY NOT AssetCategories. There is a cube called AssetCategories holding 191
// id/name pairs and it is the obvious source for a type dropdown. It is a
// GLOBAL catalog, not tenant-scoped: offering all 191 would mean a dropdown
// where most choices filter to zero rows in this tenant, which reads as a
// broken filter rather than as an empty category. The distinct
// taxonomy_type_label values the tenant actually has are fewer, all non-empty,
// and each arrives with the count it will produce.
func (s *Service) FetchAssetFilters(ctx context.Context) map[string]any {
	ck := cache.Key("assets", "filters", nil, false)
	v, _ := s.Cache.Do(ck, func() (any, error) {
		res := s.assetFiltersUncached(ctx)
		if res["availability"] == "error" {
			return res, errAssetFeedDegraded
		}
		return res, nil
	})
	out, ok := v.(map[string]any)
	if !ok {
		return assetFiltersUnavailable("the asset filter read did not complete")
	}
	return out
}

func assetFiltersUnavailable(reason string) map[string]any {
	return map[string]any{
		"types": []any{}, "total": nil,
		"availability": "error", "reason": reason,
	}
}

func (s *Service) assetFiltersUncached(ctx context.Context) map[string]any {
	if s.Mcp == nil || s.Mcp.Initialize(ctx) != nil {
		return assetFiltersUnavailable("the MCP session to Infoblox could not be opened")
	}
	typeRows := s.Mcp.QueryCube(ctx, assetsCube, []string{assetsMeasure}, map[string]any{
		"dimensions": []string{assetsCube + ".taxonomy_type_label"},
		"order":      map[string]any{assetsMeasure: "desc"},
		"limit":      assetTypeLimit,
	})
	countRows := s.Mcp.QueryCube(ctx, assetsCube, []string{assetsMeasure}, map[string]any{})
	return assembleAssetFilters(typeRows, countRows)
}

// assembleAssetFilters follows the same split verdict as the list: a failed
// TYPE query kills the payload (there are no chips to draw), a failed COUNT
// query only nils the total. A tenant that genuinely has no assets yields
// availability "ok" with an empty types list and total 0 — the chips row
// renders as empty, not as broken.
func assembleAssetFilters(typeRows, countRows []map[string]any) map[string]any {
	if typeRows == nil {
		return assetFiltersUnavailable("the asset type query failed upstream")
	}
	types := make([]any, 0, len(typeRows))
	for _, raw := range typeRows {
		r := flattenCubeRow(raw)
		label := orStr(r["taxonomy_type_label"], "")
		if label == "" {
			// A blank label is a real row upstream (assets whose taxonomy is
			// unset), but it cannot be a filter: `equals ""` was never probed
			// and a chip with no text is unclickable. Dropping it keeps every
			// chip on screen one that actually narrows the list. The assets
			// behind it are still in the unfiltered view and still counted in
			// the total, so nothing disappears — the probe measured
			// taxonomy_type_label at 100% filled, so on this tenant the branch
			// is not expected to fire at all.
			continue
		}
		n, ok := firstPresent(r, "assetsCount", "count")
		types = append(types, map[string]any{
			"label": label,
			// nil, not 0, when the measure is missing: same rule as the list
			// total. A chip saying "Laptop 0" next to a filter that returns
			// 125 rows is worse than a chip with no number.
			"count": chipCount(n, ok),
		})
	}
	return map[string]any{
		"types": types, "total": assetTotal(countRows), "availability": "ok",
	}
}

func chipCount(v any, ok bool) any {
	if !ok {
		return nil
	}
	return int(toFloat(v))
}

// --- row detail --------------------------------------------------------------

// FetchAssetDetail is the /api/csp/asset-detail read: the second budget of six
// dimensions for ONE asset, fetched when a row is opened. See the file doc for
// why these fields are not in the table.
func (s *Service) FetchAssetDetail(ctx context.Context, cqid string) map[string]any {
	cqid = clampLen(strings.TrimSpace(cqid), assetCqidMax)
	if cqid == "" {
		// Not an upstream failure — the caller asked for nothing. Still shaped
		// as "error" rather than as an empty detail, because an empty detail
		// panel would read as "this asset has no OS, no IPs, no location",
		// which is a claim about an asset nobody named.
		return assetDetailUnavailable("no asset id was supplied")
	}
	ck := cache.Key("assets", "detail", map[string]string{"cqid": cqid}, false)
	v, _ := s.Cache.Do(ck, func() (any, error) {
		res := s.assetDetailUncached(ctx, cqid)
		if res["availability"] == "error" {
			return res, errAssetFeedDegraded
		}
		return res, nil
	})
	out, ok := v.(map[string]any)
	if !ok {
		return assetDetailUnavailable("the asset detail read did not complete")
	}
	return out
}

func assetDetailUnavailable(reason string) map[string]any {
	return map[string]any{"detail": nil, "availability": "error", "reason": reason}
}

func (s *Service) assetDetailUncached(ctx context.Context, cqid string) map[string]any {
	if s.Mcp == nil || s.Mcp.Initialize(ctx) != nil {
		return assetDetailUnavailable("the MCP session to Infoblox could not be opened")
	}
	rows := s.Mcp.QueryCube(ctx, assetsCube, []string{assetsMeasure}, map[string]any{
		"dimensions": assetDetailDims,
		"filters": []map[string]any{{
			"member": assetsCube + ".cqid", "operator": "equals", "values": []string{cqid},
		}},
		"limit": 1,
	})
	return assembleAssetDetail(rows)
}

// assembleAssetDetail distinguishes three outcomes, not two:
//
//	nil rows        -> the query failed            -> availability "error"
//	zero rows       -> it ran, the asset is gone   -> availability "empty"
//	one or more     -> the asset                   -> availability "ok"
//
// The middle case is real: an asset can be deleted between the page load and
// the click. "This asset no longer exists" and "we could not ask" are
// different things to tell an operator, and collapsing them would leave
// someone staring at a red failure banner for a machine that was simply
// decommissioned.
func assembleAssetDetail(rows []map[string]any) map[string]any {
	if rows == nil {
		return assetDetailUnavailable("the asset detail query failed upstream")
	}
	if len(rows) == 0 {
		return map[string]any{"detail": nil, "availability": "empty"}
	}
	r := flattenCubeRow(rows[0])
	return map[string]any{
		"detail": map[string]any{
			"cqid":          orStr(r["cqid"], ""),
			"os":            orStr(r["os"], ""),
			"ip_addresses":  cubeList(r["ip_addresses"]),
			"mac_addresses": cubeList(r["mac_addresses"]),
			"model":         orStr(r["model"], ""),
			"location":      orStr(r["location"], ""),
		},
		"availability": "ok",
	}
}
