package dashboard

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"bloxsmith/internal/cache"
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
