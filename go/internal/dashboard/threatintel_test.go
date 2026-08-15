package dashboard

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"bloxsmith/internal/cache"
)

// --- DEFECT 1: TIDE dossier results fetch (threatintel.go FetchDossier) ----
//
// A 500/403/timeout on the results read used to be swallowed by
// `res, _, _ := s.Rest.GetEx(...)`, leaving normDossier to shape a nil
// results list into a zero-value summary (malicious:false,
// max_threat_level:0) — a green CLEAN verdict for a lookup that never
// actually completed, and that verdict got cached for 5 minutes.

// TestFetchDossier_ResultsFetchFailure_NoCleanVerdictCached pins the fix: a
// 500 on the TIDE results read must produce `unavailable` set and NO
// malicious/max_threat_level verdict fields at all (not even false/0), and
// the cached entry must be that same unavailable shape on a second read —
// never a fabricated clean result.
func TestFetchDossier_ResultsFetchFailure_NoCleanVerdictCached(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/lookup/indicator/"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"job_id":"job-1"}`))
		case strings.Contains(r.URL.Path, "/results"):
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusOK)
		}
	})

	got := s.FetchDossier("example.com", "host")

	if got["unavailable"] == nil {
		t.Fatalf("unavailable = nil, want a failure reason when the TIDE results read 500s")
	}
	summary, ok := got["summary"].(map[string]any)
	if !ok {
		t.Fatalf("summary missing or wrong type: %v", got["summary"])
	}
	if _, present := summary["malicious"]; present {
		t.Fatalf("summary[malicious] = %v present on a failed lookup: no verdict may be emitted at all", summary["malicious"])
	}
	if _, present := summary["max_threat_level"]; present {
		t.Fatalf("summary[max_threat_level] = %v present on a failed lookup", summary["max_threat_level"])
	}

	// Second call must read back the SAME unavailable shape from cache, not
	// a clean verdict — proves the failure, not a fabricated result, is
	// what got cached.
	cached := s.FetchDossier("example.com", "host")
	if cached["unavailable"] == nil {
		t.Fatalf("cached unavailable = nil, want the failure to still be what's cached")
	}
	if cs, ok := cached["summary"].(map[string]any); !ok || len(cs) != 0 {
		t.Fatalf("cached summary = %v, want empty (no verdict) on a cached failure", cached["summary"])
	}
}

// TestFetchDossier_ResultsFetchSuccess_CleanVerdictEmitted proves the fix
// didn't break the legitimate path: a real 200 whose sources WERE examined
// and found nothing malicious must still emit a genuine clean verdict
// (assessed:true, malicious:false, max_threat_level:0), not an unavailable
// marker.
//
// The fixture has been corrected TWICE, each time because "genuinely clean"
// turned out to mean less than it looked. It began as `{"results":[]}` — a
// lookup that examined nothing — which pinned the defect normDossier's
// len(sources) == 0 check closed (dossier_nosource_test.go). It then became
// one usable source with `records: []`, which is a source that reported no
// judgement: also not clean, just unmeasured, and #89 is the issue where that
// stopped rendering as CLEAN. It is now a source carrying a record GRADED
// ZERO, which is the only shape that means "somebody looked and found
// nothing".
func TestFetchDossier_ResultsFetchSuccess_CleanVerdictEmitted(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "/lookup/indicator/"):
			_, _ = w.Write([]byte(`{"job_id":"job-2"}`))
		case strings.Contains(r.URL.Path, "/results"):
			_, _ = w.Write([]byte(`{"results":[{"params":{"source":"atp"},"data":{"records":[{"class":"Policy","threat_level":0}]}}]}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	})

	got := s.FetchDossier("clean-example.com", "host")

	if got["unavailable"] != nil {
		t.Fatalf("unavailable = %v, want nil for a genuinely clean lookup", got["unavailable"])
	}
	summary, ok := got["summary"].(map[string]any)
	if !ok {
		t.Fatalf("summary missing or wrong type: %v", got["summary"])
	}
	if summary["malicious"] != false {
		t.Fatalf("summary[malicious] = %v, want false", summary["malicious"])
	}
	if summary["max_threat_level"] != float64(0) {
		t.Fatalf("summary[max_threat_level] = %v, want 0", summary["max_threat_level"])
	}
	// #89: a clean verdict is only meaningful if something actually graded the
	// indicator. Without this the assertion above passes for a lookup that
	// measured nothing.
	if summary["assessed"] != true {
		t.Fatalf("summary[assessed] = %v, want true — a CLEAN verdict requires an assessment", summary["assessed"])
	}
}

// --- DEFECT 2: FetchAssets nil-vs-empty cube (threatintel.go FetchAssets) --
//
// assembleAssetsResult is the pure function FetchAssets delegates its
// unavailable/genuine-zero decision to. It's exercised directly here (rather
// than through a full MCP wire fake) because QueryCube's own inline-result
// parser cannot produce a genuine non-nil-EMPTY row slice through the real
// wire format — an empty item list parses as ok=false there, same as a
// failure — so the only way to prove threatintel.go's OWN nil-check logic
// (not mcp.go's, which is out of scope for this fix) treats nil and
// non-nil-empty differently is to call the function with each shape
// directly, exactly as assetcounts_test.go/tiles_test.go do for
// scalarCubeTotal's twin fix.

func TestAssembleAssetsResult_NilCube_MarksUnavailableNotGenuineZero(t *testing.T) {
	// One of the three queries (invD) came back nil — a failure — even
	// though the other two "succeeded" with zero rows.
	result := assembleAssetsResult(true, nil, []map[string]any{}, []map[string]any{})

	unavailable, ok := result["unavailable"].(string)
	if !ok || unavailable == "" {
		t.Fatalf("unavailable = %v, want a failure reason when one cube query returned nil", result["unavailable"])
	}
	if strings.Contains(unavailable, "No security-action assets") {
		t.Fatalf("unavailable = %q must not be the genuine-zero wording for a failed query", unavailable)
	}
	if _, present := result["note"]; present {
		t.Fatalf("note = %v present on a failure result; the genuine-zero note must only appear on real success", result["note"])
	}
}

// TestAssembleAssetsResult_McpUnavailable_MarksUnavailable pins the mcpOK=false
// case (MCP absent, or its handshake failed) alongside the nil-cube case
// above — both must degrade, never read as "no assets for this tenant".
func TestAssembleAssetsResult_McpUnavailable_MarksUnavailable(t *testing.T) {
	result := assembleAssetsResult(false, nil, nil, nil)
	if result["unavailable"] == nil {
		t.Fatalf("unavailable = nil, want set when MCP itself is unavailable")
	}
}

// TestAssembleAssetsResult_NonNilEmptyCube_GenuineZero verifies the other
// half of the fix: when all three cube queries genuinely succeeded (each
// non-nil) and all three happen to be empty, that's a real zero — reported
// via `note`, with `unavailable` left nil, never confused with a failure.
func TestAssembleAssetsResult_NonNilEmptyCube_GenuineZero(t *testing.T) {
	result := assembleAssetsResult(true, []map[string]any{}, []map[string]any{}, []map[string]any{})

	if result["unavailable"] != nil {
		t.Fatalf("unavailable = %v, want nil when all three cube queries succeeded with zero rows", result["unavailable"])
	}
	note, ok := result["note"].(string)
	if !ok || !strings.Contains(note, "No security-action assets") {
		t.Fatalf("note = %v, want the genuine-zero wording", result["note"])
	}
}

// TestFetchAssets_McpQueryFailure_MarksUnavailableEndToEnd wires the fix
// through the actual public FetchAssets method (not just the pure helper),
// using the same fake-MCP helper tiles_test.go already built for the
// identical scalarCubeTotal fix: queryOK=false forces every
// infoblox-portal_query_cube call to fail at the transport level, so
// QueryCube returns nil for all three cube reads.
func TestFetchAssets_McpQueryFailure_MarksUnavailableEndToEnd(t *testing.T) {
	s := &Service{Mcp: scalarCubeServer(t, "", false), Cache: cache.New()}

	result := s.FetchAssets(context.Background())

	if result["unavailable"] == nil {
		t.Fatalf("unavailable = nil, want set when the cube query fails end-to-end")
	}
	assets, ok := result["assets"].([]any)
	if !ok || len(assets) != 0 {
		t.Fatalf("assets = %v, want empty slice on failure", result["assets"])
	}
}

// --- DEFECT 3: one-sided lookalike-domains failure (FetchLookalikes) ------
//
// The prior `switch` only degraded when BOTH lookalike_domains AND
// lookalike_targets failed. A one-sided failure (domains 403, targets 200)
// fell through to `default` and rendered "domains: [], unavailable: nil" —
// a dead feed reported as "0 detected".

// TestFetchLookalikes_DomainsFailWhileTargetsSucceed_MarksUnavailable is the
// regression guard for the one-sided case: domains 403s even though targets
// succeeds, and the whole response must still degrade to unavailable, with
// not_entitled reflecting the 403.
func TestFetchLookalikes_DomainsFailWhileTargetsSucceed_MarksUnavailable(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/tdlad/v1/lookalike_domains":
			w.WriteHeader(http.StatusForbidden)
		case "/api/tdlad/v1/lookalike_targets":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"results":{"items":["example.com"]}}`))
		default:
			w.WriteHeader(http.StatusOK)
		}
	})

	got := s.FetchLookalikes()

	if got["unavailable"] == nil {
		t.Fatalf("unavailable = nil, want set when domains 403s even though targets succeeded")
	}
	if got["not_entitled"] != true {
		t.Fatalf("not_entitled = %v, want true for a 403 on the domains read", got["not_entitled"])
	}
	domains, ok := got["domains"].([]any)
	if !ok || len(domains) != 0 {
		t.Fatalf("domains = %v, want empty slice on a failed domains read", got["domains"])
	}
}

// TestFetchLookalikes_BothSucceedZeroDomains_NoUnavailable is the control:
// a genuinely empty, healthy feed must never be marked unavailable.
func TestFetchLookalikes_BothSucceedZeroDomains_NoUnavailable(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/tdlad/v1/lookalike_domains":
			_, _ = w.Write([]byte(`{"results":[]}`))
		case "/api/tdlad/v1/lookalike_targets":
			_, _ = w.Write([]byte(`{"results":{"items":[]}}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	})

	got := s.FetchLookalikes()

	if got["unavailable"] != nil {
		t.Fatalf("unavailable = %v, want nil for a genuinely empty, successful feed", got["unavailable"])
	}
	domains, ok := got["domains"].([]any)
	if !ok || len(domains) != 0 {
		t.Fatalf("domains = %v, want empty slice", got["domains"])
	}
}
