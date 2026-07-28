// Package dashboard: scalar-count tiles backed by measures-only cube queries.
//
// Dimensioned cube results land in an upstream store that cannot be read back
// (a broken MCP stored-data path), so these tiles never send a `dimensions`
// opt. A per-value breakdown was tried via filtered measures-only queries
// (equals/contains on the dimension), but live probing showed every filtered
// query returns 0 even though set/notSet confirm the column is fully
// populated — the breakdown is unobtainable upstream. These tiles now return
// only the real unfiltered total and mark the breakdown unavailable rather
// than shipping buckets that are 100% "other".
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
// per-value breakdown is attempted — see the package doc for why. A failed
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
	result := s.scalarCount(ctx, "AssetDiscoveryStatus", "AssetDiscoveryStatus.count",
		"Per-status breakdown is unavailable: filtered queries on overall_status return 0 upstream.")
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
	result := s.scalarCount(ctx, "AssetInsight", "AssetInsight.count",
		"Per-severity breakdown is unavailable: filtered queries on severity return 0 upstream.")
	s.Cache.SetGen(ck, result, g)
	return result
}
