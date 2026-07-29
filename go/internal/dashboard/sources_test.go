package dashboard

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/mcp"
	"bloxsmith/internal/rest"
)

// newSourcesTestService wires a Service to an httptest fake, mirroring
// newDashboardTestService/newAIToolsTestService's setup for the /api/sources
// surface under test here.
func newSourcesTestService(t *testing.T, handler http.HandlerFunc) *Service {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	c := rest.New(srv.URL, rest.NewAuth("test-key", nil))
	return New(c, cache.New())
}

// TestSourceRows_UpstreamFailureReportsError is the regression guard this
// file exists for: a source whose upstream read fails (5xx) must come back
// as an {error,...} object for that source only, not a silent empty result
// indistinguishable from a genuinely empty source.
func TestSourceRows_UpstreamFailureReportsError(t *testing.T) {
	s := newSourcesTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	out := s.SourceRows(context.Background(), "subnets", map[string]string{})

	errMsg, ok := out["error"].(string)
	if !ok || errMsg == "" {
		t.Fatalf("expected an error key for a failed upstream read, got %v", out)
	}
	rows, ok := out["rows"].([]any)
	if !ok || len(rows) != 0 {
		t.Fatalf("rows = %v, want empty slice", out["rows"])
	}
	if out["count"] != 0 {
		t.Fatalf("count = %v, want 0", out["count"])
	}
}

// TestSourceRows_GenuineEmptyIsNotAnError is the other half of the same
// regression: a source whose upstream succeeds with zero rows must NOT carry
// an "error" key. This is the exact distinction the fix protects — an empty
// result and a failed read must render differently.
func TestSourceRows_GenuineEmptyIsNotAnError(t *testing.T) {
	s := newSourcesTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, nil)
	})

	out := s.SourceRows(context.Background(), "subnets", map[string]string{})

	if _, present := out["error"]; present {
		t.Fatalf("a genuinely empty upstream result must not carry an error key, got %v", out)
	}
	rows, ok := out["rows"].([]any)
	if !ok || len(rows) != 0 {
		t.Fatalf("rows = %v, want empty slice", out["rows"])
	}
	if out["count"] != 0 {
		t.Fatalf("count = %v, want 0", out["count"])
	}
}

// TestSourceRows_HealthySourceUnchangedShape verifies a normal, successful
// fetch keeps the exact pre-existing shape: rows populated, count matching,
// fields populated from the registry, and no error key.
func TestSourceRows_HealthySourceUnchangedShape(t *testing.T) {
	s := newSourcesTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, []map[string]any{
			{"id": "1", "name": "sub1", "address": "10.0.0.0", "cidr": 24,
				"utilization": map[string]any{"total": 100, "used": 10}},
		})
	})

	out := s.SourceRows(context.Background(), "subnets", map[string]string{})

	if _, present := out["error"]; present {
		t.Fatalf("a healthy source must not carry an error key, got %v", out)
	}
	rows, ok := out["rows"].([]any)
	if !ok || len(rows) != 1 {
		t.Fatalf("rows = %v, want 1 row", out["rows"])
	}
	if out["count"] != 1 {
		t.Fatalf("count = %v, want 1", out["count"])
	}
	fields, ok := out["fields"].([]any)
	if !ok || len(fields) == 0 {
		t.Fatalf("fields = %v, want the subnets registry fields", out["fields"])
	}
}

// TestSourceRows_UnknownSourceUnchanged locks the pre-existing "unknown
// source" shape, which the migration to GetStrict must not disturb.
func TestSourceRows_UnknownSourceUnchanged(t *testing.T) {
	s := newSourcesTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError) // never actually hit
	})

	out := s.SourceRows(context.Background(), "not_a_real_source", map[string]string{})

	if out["error"] != "unknown source" {
		t.Fatalf("error = %v, want \"unknown source\"", out["error"])
	}
	rows, ok := out["rows"].([]any)
	if !ok || len(rows) != 0 {
		t.Fatalf("rows = %v, want empty slice", out["rows"])
	}
	if out["count"] != 0 {
		t.Fatalf("count = %v, want 0", out["count"])
	}
}

// TestSourceRows_RawPathMustStartWithAPIUnchanged locks the pre-existing
// __raw validation error, also undisturbed by the GetStrict migration.
func TestSourceRows_RawPathMustStartWithAPIUnchanged(t *testing.T) {
	s := newSourcesTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError) // never actually hit
	})

	out := s.SourceRows(context.Background(), "__raw", map[string]string{"path": "not-api"})

	if out["error"] != "path must start with /api/" {
		t.Fatalf("error = %v, want \"path must start with /api/\"", out["error"])
	}
}

// newSourcesTestServiceWithMCP is newSourcesTestService plus a wired fakeMCP
// (from actions_test.go), for the "incidents" and "entity_search" sources
// that go through s.Mcp (FetchActions, ThreatLookup) rather than pure REST.
func newSourcesTestServiceWithMCP(t *testing.T, restHandler http.HandlerFunc, f *fakeMCP) *Service {
	t.Helper()
	restSrv := httptest.NewServer(restHandler)
	t.Cleanup(restSrv.Close)
	c := rest.New(restSrv.URL, rest.NewAuth("test-key", nil))
	mcpSrv := httptest.NewServer(f.handler(t))
	t.Cleanup(mcpSrv.Close)
	client := mcp.New(mcpSrv.URL, func() string { return "Bearer test" })
	return &Service{Rest: c, Cache: cache.New(), Mcp: client}
}

// --- defect 3: incidents / anomaly_events / entity_search propagate failure -

// TestSourceRows_Incidents_FetcherUnavailableReportsError covers the
// "incidents" source (backed by FetchActions/IQ Actions over MCP), which was
// migrated to GetStrict-style fetchers elsewhere but discarded FetchActions'
// own availability:"unavailable" signal, returning a clean {rows:[],count:0}
// with no error key for what was actually a failed read.
func TestSourceRows_Incidents_FetcherUnavailableReportsError(t *testing.T) {
	// A 404 on the MCP handshake makes Initialize fail, so actionsAsync
	// returns ok=false -> FetchActions reports availability:"unavailable".
	badSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(badSrv.Close)
	restSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError) // never hit by this source
	}))
	t.Cleanup(restSrv.Close)
	s := &Service{
		Rest:  rest.New(restSrv.URL, rest.NewAuth("test-key", nil)),
		Cache: cache.New(),
		Mcp:   mcp.New(badSrv.URL, func() string { return "Bearer test" }),
	}

	out := s.SourceRows(context.Background(), "incidents", map[string]string{})

	errMsg, ok := out["error"].(string)
	if !ok || errMsg == "" {
		t.Fatalf("expected an error key when IQ Actions is unavailable, got %v", out)
	}
}

// TestSourceRows_Incidents_GenuineEmptyIsNotAnError confirms a real, healthy
// zero-actions tenant is NOT reported as an error.
func TestSourceRows_Incidents_GenuineEmptyIsNotAnError(t *testing.T) {
	f := &fakeMCP{
		listPages: map[float64]map[string]any{
			0: {"success": true, "actions": []any{},
				"pagination": map[string]any{"limit": float64(actionsPageSize), "offset": float64(0), "has_more": false}},
		},
	}
	s := newSourcesTestServiceWithMCP(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError) // never hit by this source
	}, f)

	out := s.SourceRows(context.Background(), "incidents", map[string]string{})

	if _, present := out["error"]; present {
		t.Fatalf("a genuinely empty IQ Actions result must not carry an error key, got %v", out)
	}
	rows, ok := out["rows"].([]any)
	if !ok || len(rows) != 0 {
		t.Fatalf("rows = %v, want empty slice", out["rows"])
	}
}

// TestSourceRows_AnomalyEvents_FetcherUnavailableReportsError covers the
// "anomaly_events" source (backed by FetchHubSecurity's dns_event REST read).
func TestSourceRows_AnomalyEvents_FetcherUnavailableReportsError(t *testing.T) {
	s := newSourcesTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	out := s.SourceRows(context.Background(), "anomaly_events", map[string]string{})

	errMsg, ok := out["error"].(string)
	if !ok || errMsg == "" {
		t.Fatalf("expected an error key when the dns_event feed is unavailable, got %v", out)
	}
}

// TestSourceRows_AnomalyEvents_GenuineEmptyIsNotAnError confirms a real,
// healthy zero-event window is NOT reported as an error.
func TestSourceRows_AnomalyEvents_GenuineEmptyIsNotAnError(t *testing.T) {
	s := newSourcesTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, nil)
	})

	out := s.SourceRows(context.Background(), "anomaly_events", map[string]string{})

	if _, present := out["error"]; present {
		t.Fatalf("a genuinely empty dns_event window must not carry an error key, got %v", out)
	}
}

// TestSourceRows_EntitySearch_FetcherUnavailableReportsError covers the
// "entity_search" source (backed by ThreatLookup/network_entity_search over
// MCP).
func TestSourceRows_EntitySearch_FetcherUnavailableReportsError(t *testing.T) {
	f := &fakeMCP{searchRawText: `{"unexpected":"shape"}`} // decodes fine but matches no known Search shape -> nil (failure)
	s := newSourcesTestServiceWithMCP(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError) // never hit by this source
	}, f)

	out := s.SourceRows(context.Background(), "entity_search", map[string]string{"q": "acme"})

	errMsg, ok := out["error"].(string)
	if !ok || errMsg == "" {
		t.Fatalf("expected an error key when entity search is unavailable, got %v", out)
	}
}

// TestSourceRows_EntitySearch_GenuineEmptyIsNotAnError confirms a real search
// that legitimately matches nothing is NOT reported as an error.
func TestSourceRows_EntitySearch_GenuineEmptyIsNotAnError(t *testing.T) {
	f := &fakeMCP{searchRawText: `[]`}
	s := newSourcesTestServiceWithMCP(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError) // never hit by this source
	}, f)

	out := s.SourceRows(context.Background(), "entity_search", map[string]string{"q": "acme"})

	if _, present := out["error"]; present {
		t.Fatalf("a genuinely empty entity search must not carry an error key, got %v", out)
	}
	rows, ok := out["rows"].([]any)
	if !ok || len(rows) != 0 {
		t.Fatalf("rows = %v, want empty slice", out["rows"])
	}
}

// TestSourceRows_RawPathUpstreamFailureReportsError covers the generic
// restPath fetch (the 12th read migrated to GetStrict alongside the 11
// named sources): a failing raw upstream must also surface an error, not an
// empty {rows:[]}.
func TestSourceRows_RawPathUpstreamFailureReportsError(t *testing.T) {
	s := newSourcesTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	out := s.SourceRows(context.Background(), "__raw", map[string]string{"path": "/api/whatever"})

	errMsg, ok := out["error"].(string)
	if !ok || errMsg == "" {
		t.Fatalf("expected an error key for a failed raw upstream read, got %v", out)
	}
	rows, ok := out["rows"].([]any)
	if !ok || len(rows) != 0 {
		t.Fatalf("rows = %v, want empty slice", out["rows"])
	}
}
