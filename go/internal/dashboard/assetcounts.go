// Package dashboard: scalar-count tiles backed by measures-only cube queries.
//
// CORRECTION, 2026-08-06. This doc used to assert two things about the
// upstream cube API, and BOTH were wrong. They are written out here rather
// than deleted, because the wrong belief is why these tiles are shaped the
// way they are, and a reader who only sees the corrected text cannot tell
// which parts of the shape are still load-bearing.
//
// WHAT WAS BELIEVED (1): "dimensioned cube results land in an upstream store
// that cannot be read back (a broken MCP stored-data path)". WHAT IS TRUE:
// the readback works. See internal/mcp's maxRows comment for that
// correction and its measurement — the same 2026-08-06 probe covers both.
//
// WHAT WAS BELIEVED (2): "every filtered query returns 0 even though
// set/notSet confirm the column is fully populated — the breakdown is
// unobtainable upstream". WHAT IS TRUE: filtered measures-only counts work
// fine. The zeros were self-inflicted, by a wrong string literal in the
// probe that produced that sentence, not by anything upstream.
// AssetDiscoveryStatus.overall_status takes the values OK, ERROR and "" —
// upper case. The probe filtered on "Ok", which matches no row, so every
// filtered count came back 0 and the shape of the zero (every value, every
// time) read as an upstream refusal rather than as a typo.
//
// HOW IT WAS MEASURED: live, against the real tenant, via the
// infoblox-portal_query_cube MCP tool on 2026-08-06. equals "Ok" -> 0;
// equals "OK" -> 14. On the AssetDetails_ch_agg cube the same session got a
// filtered measures-only count of 125 for taxonomy_type_label equals
// "Laptop" against a real total of 2,620. A filtered measures-only count is
// therefore an ordinary working query.
//
// WHAT DID NOT CHANGE: these tiles still send no `dimensions` opt and still
// report breakdown_available:false. That is now a statement about this code
// — no breakdown is built here — and no longer a claim about upstream. The
// grep that backs "no live code carries the wrong literal": the string "Ok"
// appears nowhere in this repo outside this correction. The defect the wrong
// belief DID ship was the two note strings below, which stated the false
// upstream claim to operators on screen; they are fixed.
package dashboard

import (
	"context"

	"bloxsmith/internal/cache"
)

// scalarCubeTotal runs one unfiltered measures-only cube query and returns
// the scalar count plus whether the query itself succeeded. QueryCube
// returns a nil slice on any transport, HTTP, or parse failure (see
// internal/mcp.Client.QueryCube) and a non-nil slice on success — that nil
// check is the only signal available to tell "queried fine, answer is zero"
// apart from "the query failed", so callers must not infer failure from a
// zero total. Missing/unparseable measure values inside a successful
// response still coerce to 0 via toFloat.
func (s *Service) scalarCubeTotal(ctx context.Context, cube, measure string) (total int, ok bool) {
	rows := s.Mcp.QueryCube(ctx, cube, []string{measure}, map[string]any{})
	if rows == nil {
		return 0, false
	}
	if len(rows) == 0 {
		return 0, true
	}
	return int(toFloat(rows[0][measure])), true
}

// scalarCount fetches the real unfiltered total for one cube+measure. No
// per-value breakdown is attempted: not because upstream cannot serve one
// (it can — see the package doc's correction), but because none is built
// here. `note` is rendered on screen next to the tile, so it must describe
// THIS code, never make a claim about upstream that nothing measured. A
// failed
// cube query reuses the same "error" status as an MCP init failure, so a
// dead lookup is never reported to the UI as "empty" (a fact about the
// tenant's data) — see scalarCubeTotal.
func (s *Service) scalarCount(ctx context.Context, cube, measure, note string) map[string]any {
	if s.Mcp == nil || s.Mcp.Initialize(ctx) != nil {
		return map[string]any{"total": 0, "breakdown_available": false,
			"note": note, "status": "error"}
	}
	total, ok := s.scalarCubeTotal(ctx, cube, measure)
	if !ok {
		return map[string]any{"total": 0, "breakdown_available": false,
			"note": note, "status": "error"}
	}
	status := "ok"
	if total == 0 {
		status = "empty"
	}
	return map[string]any{
		"total":               total,
		"breakdown_available": false,
		"note":                note,
		"status":              status,
	}
}

// CSPDiscoveryStatus is the AssetDiscoveryStatus scalar-count tile.
func (s *Service) CSPDiscoveryStatus(ctx context.Context) map[string]any {
	ck := cache.Key("discovery-status", "", nil, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()
	// Old note: "Per-status breakdown is unavailable: filtered queries on
	// overall_status return 0 upstream." That was the false claim, printed at
	// operators, and it was the wrong-literal probe talking (package doc).
	// The replacement says only what is true: this tile asks for one number.
	result := s.scalarCount(ctx, "AssetDiscoveryStatus", "AssetDiscoveryStatus.count",
		"Total only — this tile does not request a per-status breakdown.")
	s.Cache.SetGen(ck, result, g)
	return result
}

// CSPAssetInsights is the AssetInsight scalar-count tile.
func (s *Service) CSPAssetInsights(ctx context.Context) map[string]any {
	ck := cache.Key("asset-insights", "", nil, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()
	// Same correction as CSPDiscoveryStatus above. Note that AssetInsight's
	// severity dimension was never itself probed — the 2026-08-06 session
	// measured AssetDiscoveryStatus.overall_status and AssetDetails_ch_agg —
	// so the honest note claims nothing about it either way.
	result := s.scalarCount(ctx, "AssetInsight", "AssetInsight.count",
		"Total only — this tile does not request a per-severity breakdown.")
	s.Cache.SetGen(ck, result, g)
	return result
}
