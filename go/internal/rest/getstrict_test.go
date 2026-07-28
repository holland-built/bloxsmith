package rest

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestGetStrictResultsPresent pins the ordinary success path: rows come back
// with a nil error, exactly like Get() today.
func TestGetStrictResultsPresent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[{"id":1},{"id":2}]}`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	rows, err := c.GetStrict("/x", nil)

	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %v, want 2 items", rows)
	}
}

// TestGetStrictResultsEmpty is the core contract of this migration: a
// genuinely empty result list must NOT be reported as an error.
func TestGetStrictResultsEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[]}`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	rows, err := c.GetStrict("/x", nil)

	if err != nil {
		t.Fatalf("err = %v, want nil for a genuinely empty result", err)
	}
	if len(rows) != 0 {
		t.Fatalf("rows = %v, want empty", rows)
	}
}

// TestGetStrictServerError500 proves a 500 surfaces as a typed error carrying
// the upstream body, instead of collapsing to an empty slice.
func TestGetStrictServerError500(t *testing.T) {
	const marker = "boom-marker-500"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"` + marker + `"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	rows, err := c.GetStrict("/x", nil)

	if rows != nil {
		t.Fatalf("rows = %v, want nil on error", rows)
	}
	var ue *UpstreamError
	if !errors.As(err, &ue) {
		t.Fatalf("err = %v (%T), want *UpstreamError", err, err)
	}
	if ue.Category != "status" {
		t.Fatalf("Category = %q, want %q", ue.Category, "status")
	}
	if ue.Status != 500 {
		t.Fatalf("Status = %d, want 500", ue.Status)
	}
	if !strings.Contains(ue.Snippet, marker) {
		t.Fatalf("Snippet = %q, want it to contain %q", ue.Snippet, marker)
	}
}

// TestGetStrictClientError400 mirrors the 500 case for a 400.
func TestGetStrictClientError400(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"bad filter"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	_, err := c.GetStrict("/x", nil)

	var ue *UpstreamError
	if !errors.As(err, &ue) {
		t.Fatalf("err = %v (%T), want *UpstreamError", err, err)
	}
	if ue.Category != "status" {
		t.Fatalf("Category = %q, want %q", ue.Category, "status")
	}
	if ue.Status != 400 {
		t.Fatalf("Status = %d, want 400", ue.Status)
	}
}

// TestGetStrictNetworkFailure proves a transport-level failure (server
// unreachable) surfaces as Category "network" with Status 0, never a panic
// or a silent empty slice.
func TestGetStrictNetworkFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close() // closed before the request: guarantees connection refused

	c := New(url, NewAuth("key", nil))
	rows, err := c.GetStrict("/x", nil)

	if rows != nil {
		t.Fatalf("rows = %v, want nil on a network failure", rows)
	}
	var ue *UpstreamError
	if !errors.As(err, &ue) {
		t.Fatalf("err = %v (%T), want *UpstreamError", err, err)
	}
	if ue.Category != "network" {
		t.Fatalf("Category = %q, want %q", ue.Category, "network")
	}
	if ue.Status != 0 {
		t.Fatalf("Status = %d, want 0", ue.Status)
	}
}

// TestGetStrictMalformedBody proves a non-JSON 200 body is a decode error,
// not a silently-empty success.
func TestGetStrictMalformedBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`not json at all {{{`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	rows, err := c.GetStrict("/x", nil)

	if rows != nil {
		t.Fatalf("rows = %v, want nil on a decode failure", rows)
	}
	var ue *UpstreamError
	if !errors.As(err, &ue) {
		t.Fatalf("err = %v (%T), want *UpstreamError", err, err)
	}
	if ue.Category != "decode" {
		t.Fatalf("Category = %q, want %q", ue.Category, "decode")
	}
}

// TestGetStrictScalarShape proves a syntactically valid JSON scalar (which
// json.Unmarshal happily decodes) is rejected as the wrong shape, since
// Unwrap has no results/result to extract from a bare number.
func TestGetStrictScalarShape(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`3`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	rows, err := c.GetStrict("/x", nil)

	if rows != nil {
		t.Fatalf("rows = %v, want nil on a shape failure", rows)
	}
	var ue *UpstreamError
	if !errors.As(err, &ue) {
		t.Fatalf("err = %v (%T), want *UpstreamError", err, err)
	}
	if ue.Category != "shape" {
		t.Fatalf("Category = %q, want %q", ue.Category, "shape")
	}
}

// TestGetStrictOversizedErrorBodyTruncates proves the snippet cap is enforced
// at read time (LimitReader), not by slicing a fully-read body — but ONLY on
// the failure path: an ERROR body bigger than 8KiB is capped and flagged
// Truncated.
func TestGetStrictOversizedErrorBodyTruncates(t *testing.T) {
	const marker = "start-marker"
	big := marker + strings.Repeat("x", 9<<10) // > 8KiB
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(big))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	_, err := c.GetStrict("/x", nil)

	var ue *UpstreamError
	if !errors.As(err, &ue) {
		t.Fatalf("err = %v (%T), want *UpstreamError", err, err)
	}
	if !ue.Truncated {
		t.Fatal("Truncated = false, want true for an error body over the 8KiB cap")
	}
	if len(ue.Snippet) > 8<<10 {
		t.Fatalf("Snippet length = %d, want capped at %d", len(ue.Snippet), 8<<10)
	}
	if !strings.HasPrefix(ue.Snippet, marker) {
		t.Fatalf("Snippet = %q, want it to start with %q", ue.Snippet, marker)
	}
}

// TestGetStrictSuccessOverCapReadsInFull is the regression this fix exists
// for: real list payloads (drift.go, decommission.go, dashboard/sources.go
// all page at _limit=1000+) routinely exceed 8KiB. A SUCCESSFUL response well
// over the snippet cap must return every row, not be truncated mid-JSON and
// misreported as a decode failure.
func TestGetStrictSuccessOverCapReadsInFull(t *testing.T) {
	const rowCount = 2000 // each row is well over 16 bytes -> body > 32KiB
	var b strings.Builder
	b.WriteString(`{"results":[`)
	for i := 0; i < rowCount; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"id":`)
		b.WriteString(strings.Repeat("9", 10))
		b.WriteString(`}`)
	}
	b.WriteString(`]}`)
	body := b.String()
	if len(body) <= 32<<10 {
		t.Fatalf("test setup bug: body is only %d bytes, want > 32KiB", len(body))
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(body))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	rows, err := c.GetStrict("/x", nil)

	if err != nil {
		t.Fatalf("err = %v, want nil for a successful oversized body", err)
	}
	if len(rows) != rowCount {
		t.Fatalf("rows = %d, want all %d rows returned", len(rows), rowCount)
	}
	var ue *UpstreamError
	if errors.As(err, &ue) {
		if ue.Truncated {
			t.Fatal("Truncated = true, want false on a successful read")
		}
		if ue.Snippet != "" {
			t.Fatalf("Snippet = %q, want empty on a successful read", ue.Snippet)
		}
	}
}

// TestGetStrictErrorNeverLeaksSnippet is the safety property that justifies
// having a separate Snippet field at all: Error() must be safe to log/print
// without accidentally spilling upstream response bodies (which may carry
// sensitive data) into general logs.
func TestGetStrictErrorNeverLeaksSnippet(t *testing.T) {
	const marker = "SENSITIVE-UPSTREAM-BODY-MARKER"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"` + marker + `"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	_, err := c.GetStrict("/x", nil)

	if err == nil {
		t.Fatal("err = nil, want an error")
	}
	if strings.Contains(err.Error(), marker) {
		t.Fatalf("Error() = %q, must never contain the upstream body", err.Error())
	}

	var ue *UpstreamError
	if !errors.As(err, &ue) || !strings.Contains(ue.Snippet, marker) {
		t.Fatalf("Snippet = %q, want it to contain the marker (sanity check on the test itself)", ue.Snippet)
	}
}
