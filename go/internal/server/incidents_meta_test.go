package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/config"
	"bloxsmith/internal/dashboard"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/store"
)

// This file is the regression suite for the "failure looks like fact" defect:
// /api/incidents used to forward "signals: []" with no way to tell "the
// subnet/zone/lease feeds were read and are clean" apart from "those feeds
// 5xx'd and nothing was evaluated" — the Triage panel then rendered a
// confident "no issues detected" for a genuinely unreadable estate. The fix
// (dashboard.SignalsMeta + noc.go's incidents handler) attaches "_meta"
// (per-feed "ok"/"empty"/"error") and "signals_degraded" (true when any of
// subnets/zones/leases errored) to the response. incidentsCategory has no
// consumer and does not carry this indicator — see its doc comment.

// incidentsTestDeps wires a Deps whose Dashboard hits an httptest fake for
// every /api/data feed, and a real (tempdir-backed) Store — StampFirstSeen
// and ActiveSnoozes both touch disk, same as ipam_list_test.go's newTestDeps
// wires Rest directly for handlers that don't go through dashboard.Service.
func incidentsTestDeps(t *testing.T, handler http.HandlerFunc) *Deps {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	c := rest.New(srv.URL, rest.NewAuth("test-key", nil))
	return &Deps{
		Cfg:       &config.Config{Port: "8080"},
		Dashboard: dashboard.New(c, cache.New()),
		Store:     store.New(t.TempDir()),
	}
}

func writeIncidentsResults(w http.ResponseWriter, rows []map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"results": rows})
}

func writeIncidentsResultsWithPage(w http.ResponseWriter, rows []map[string]any, page any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"results": rows, "page": page})
}

// healthyEmptyFeedsHandler answers every /api/data feed with a genuinely
// empty (not failed) result, including the count/at-risk queries fetchCount
// and fetchAtRiskSubnets issue against the subnet/hosts endpoints (mirrors
// dashboard/feed_status_test.go's feedStatusHandler).
func healthyEmptyFeedsHandler(overrides map[string]http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h, ok := overrides[r.URL.Path]; ok {
			h(w, r)
			return
		}
		q := r.URL.Query()
		if r.URL.Path == "/api/ddi/v1/ipam/subnet" || r.URL.Path == "/api/infra/v1/detail_hosts" {
			if q.Get("_limit") == "1" || q.Get("_filter") == "utilization.utilization>=70" {
				writeIncidentsResultsWithPage(w, nil, map[string]any{"total_size": "0"})
				return
			}
		}
		writeIncidentsResults(w, nil)
	}
}

func decodeIncidentsBody(t *testing.T, rr *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode response body %q: %v", rr.Body.String(), err)
	}
	return m
}

// TestIncidents_AllFeedsHealthyZeroSignals covers the legitimate all-clear:
// every feed reads fine and produces zero signals -> the response must say
// the feeds were read (no "error" status) and must not raise the degraded
// indicator.
func TestIncidents_AllFeedsHealthyZeroSignals(t *testing.T) {
	d := incidentsTestDeps(t, healthyEmptyFeedsHandler(nil))

	req := httptest.NewRequest("GET", "/api/incidents", nil)
	rr := httptest.NewRecorder()
	d.incidents(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	body := decodeIncidentsBody(t, rr)

	signals, ok := body["signals"].([]any)
	if !ok || len(signals) != 0 {
		t.Fatalf("signals = %v, want an empty list", body["signals"])
	}
	if body["signals_degraded"] != false {
		t.Fatalf("signals_degraded = %v, want false when every feed read cleanly", body["signals_degraded"])
	}
	meta, ok := body["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("_meta missing or wrong type: %v", body["_meta"])
	}
	for _, feed := range []string{"subnets", "zones", "leases"} {
		if meta[feed] != "empty" {
			t.Fatalf("_meta[%s] = %v, want \"empty\" for a genuinely empty feed", feed, meta[feed])
		}
	}
}

// TestIncidents_FeedErrorSurfacesMetaAndDegraded covers the actual defect:
// subnets/zones/leases all 5xx -> BuildSignals still returns zero signals,
// but the response must carry each feed's "error" status plus the top-level
// degraded flag, NOT present a bare empty signals array as an all-clear.
func TestIncidents_FeedErrorSurfacesMetaAndDegraded(t *testing.T) {
	fail := func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusInternalServerError) }
	d := incidentsTestDeps(t, healthyEmptyFeedsHandler(map[string]http.HandlerFunc{
		"/api/ddi/v1/ipam/subnet":   fail,
		"/api/ddi/v1/dns/auth_zone": fail,
		"/api/ddi/v1/dhcp/lease":    fail,
	}))

	req := httptest.NewRequest("GET", "/api/incidents", nil)
	rr := httptest.NewRecorder()
	d.incidents(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200 (the route degrades, it does not 5xx); body=%s", rr.Code, rr.Body.String())
	}
	body := decodeIncidentsBody(t, rr)

	signals, ok := body["signals"].([]any)
	if !ok || len(signals) != 0 {
		t.Fatalf("signals = %v, want an empty list (BuildSignals still sees nothing to alert on)", body["signals"])
	}
	if body["signals_degraded"] != true {
		t.Fatalf("signals_degraded = %v, want true when subnets/zones/leases all errored", body["signals_degraded"])
	}
	meta, ok := body["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("_meta missing or wrong type: %v", body["_meta"])
	}
	for _, feed := range []string{"subnets", "zones", "leases"} {
		if meta[feed] != "error" {
			t.Fatalf("_meta[%s] = %v, want \"error\"", feed, meta[feed])
		}
	}
}

// TestIncidents_PartialFeedErrorKeepsSignalsAndDegraded covers a feed erroring
// while ANOTHER feed still produces real signals: both the signals and the
// error indicator must be present simultaneously — a partial failure must
// not hide the real signals, and must not hide the fact that a feed failed.
func TestIncidents_PartialFeedErrorKeepsSignalsAndDegraded(t *testing.T) {
	fail := func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusInternalServerError) }
	d := incidentsTestDeps(t, healthyEmptyFeedsHandler(map[string]http.HandlerFunc{
		"/api/ddi/v1/dns/auth_zone": fail,
		"/api/ddi/v1/dhcp/lease": func(w http.ResponseWriter, r *http.Request) {
			writeIncidentsResults(w, []map[string]any{
				{"addr": "10.0.0.5", "host": "h1", "state": "expired"},
			})
		},
	}))

	req := httptest.NewRequest("GET", "/api/incidents", nil)
	rr := httptest.NewRecorder()
	d.incidents(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	body := decodeIncidentsBody(t, rr)

	signals, ok := body["signals"].([]any)
	if !ok || len(signals) != 1 {
		t.Fatalf("signals = %v, want exactly 1 (the expired lease), lost alongside the zone-feed error", body["signals"])
	}
	if body["signals_degraded"] != true {
		t.Fatalf("signals_degraded = %v, want true — the zone feed errored even though leases produced a signal", body["signals_degraded"])
	}
	meta, ok := body["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("_meta missing or wrong type: %v", body["_meta"])
	}
	if meta["zones"] != "error" {
		t.Fatalf("_meta[zones] = %v, want \"error\"", meta["zones"])
	}
	if meta["leases"] != "ok" {
		t.Fatalf("_meta[leases] = %v, want \"ok\" (it produced a real row)", meta["leases"])
	}
}

// TestIncidents_FailedAndCleanResponsesAreNotByteIdentical is the direct
// regression test for the bug being closed: before this fix, "all feeds
// failed" and "all feeds genuinely clean" both serialized to the exact same
// bytes (empty signals/incidents, no meta at all) — that equivalence IS the
// false-positive "no issues detected" defect. After the fix the two bodies
// must differ.
func TestIncidents_FailedAndCleanResponsesAreNotByteIdentical(t *testing.T) {
	clean := incidentsTestDeps(t, healthyEmptyFeedsHandler(nil))
	fail := func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusInternalServerError) }
	failed := incidentsTestDeps(t, healthyEmptyFeedsHandler(map[string]http.HandlerFunc{
		"/api/ddi/v1/ipam/subnet":   fail,
		"/api/ddi/v1/dns/auth_zone": fail,
		"/api/ddi/v1/dhcp/lease":    fail,
	}))

	req1 := httptest.NewRequest("GET", "/api/incidents", nil)
	rr1 := httptest.NewRecorder()
	clean.incidents(rr1, req1)

	req2 := httptest.NewRequest("GET", "/api/incidents", nil)
	rr2 := httptest.NewRecorder()
	failed.incidents(rr2, req2)

	if rr1.Code != 200 || rr2.Code != 200 {
		t.Fatalf("status codes = %d, %d, want both 200", rr1.Code, rr2.Code)
	}
	cleanBody := decodeIncidentsBody(t, rr1)
	failedBody := decodeIncidentsBody(t, rr2)

	// Both legitimately have empty signals — that's not the bug. The bug is
	// the two being indistinguishable overall.
	if cleanSig, _ := cleanBody["signals"].([]any); len(cleanSig) != 0 {
		t.Fatalf("clean signals = %v, want empty", cleanBody["signals"])
	}
	if failedSig, _ := failedBody["signals"].([]any); len(failedSig) != 0 {
		t.Fatalf("failed signals = %v, want empty", failedBody["signals"])
	}
	if rr1.Body.String() == rr2.Body.String() {
		t.Fatalf("clean and failed /api/incidents responses are byte-identical — the defect under test: %s", rr1.Body.String())
	}
	if cleanBody["signals_degraded"] == failedBody["signals_degraded"] {
		t.Fatalf("signals_degraded must differ between a clean read (%v) and an all-feeds-failed read (%v)",
			cleanBody["signals_degraded"], failedBody["signals_degraded"])
	}
}
