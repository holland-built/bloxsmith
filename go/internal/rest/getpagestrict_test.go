package rest

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestGetPageStrictResultsPresent pins the ordinary success path: rows AND
// the decoded envelope come back together with a nil error, in one request —
// this is the whole point of GetPageStrict over GetStrict+GetPage.
func TestGetPageStrictResultsPresent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[{"id":1},{"id":2}],"total_count":2}`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	rows, body, err := c.GetPageStrict("/x", nil)

	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %v, want 2 items", rows)
	}
	if body == nil {
		t.Fatal("body is nil, want the decoded envelope")
	}
	if got, ok := body["total_count"].(float64); !ok || got != 2 {
		t.Fatalf("body[total_count] = %v, want 2", body["total_count"])
	}
}

// TestGetPageStrictArrayResponse pins that a bare top-level array is legal:
// rows populate via Unwrap, and body is nil since there is no envelope object
// to expose.
func TestGetPageStrictArrayResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"id":1},{"id":2},{"id":3}]`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	rows, body, err := c.GetPageStrict("/x", nil)

	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if len(rows) != 3 {
		t.Fatalf("rows = %v, want 3 items", rows)
	}
	if body != nil {
		t.Fatalf("body = %v, want nil for a top-level array", body)
	}
}

// TestGetPageStrictResultsEmpty proves a genuinely empty result list is NOT
// reported as an error, matching GetStrict's contract.
func TestGetPageStrictResultsEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[]}`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	rows, body, err := c.GetPageStrict("/x", nil)

	if err != nil {
		t.Fatalf("err = %v, want nil for a genuinely empty result", err)
	}
	if len(rows) != 0 {
		t.Fatalf("rows = %v, want empty", rows)
	}
	if body == nil {
		t.Fatal("body is nil, want the decoded (empty-results) envelope")
	}
}

// TestGetPageStrictServerError500 proves a 500 surfaces as a typed error
// carrying a bounded snippet of the upstream body, with both rows and body
// nil — never a silent empty-slice success.
func TestGetPageStrictServerError500(t *testing.T) {
	const marker = "boom-marker-500"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"` + marker + `"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	rows, body, err := c.GetPageStrict("/x", nil)

	if rows != nil {
		t.Fatalf("rows = %v, want nil on error", rows)
	}
	if body != nil {
		t.Fatalf("body = %v, want nil on error", body)
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

// TestGetPageStrictMalformedBody proves a non-JSON 200 body is a decode
// error carrying a bounded snippet, not a silently-empty success.
func TestGetPageStrictMalformedBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`not json at all {{{`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	rows, body, err := c.GetPageStrict("/x", nil)

	if rows != nil {
		t.Fatalf("rows = %v, want nil on a decode failure", rows)
	}
	if body != nil {
		t.Fatalf("body = %v, want nil on a decode failure", body)
	}
	var ue *UpstreamError
	if !errors.As(err, &ue) {
		t.Fatalf("err = %v (%T), want *UpstreamError", err, err)
	}
	if ue.Category != "decode" {
		t.Fatalf("Category = %q, want %q", ue.Category, "decode")
	}
}

// TestGetPageStrictOversizedErrorBodyTruncates proves the snippet cap is
// enforced at read time on the failure path only.
func TestGetPageStrictOversizedErrorBodyTruncates(t *testing.T) {
	const marker = "start-marker"
	big := marker + strings.Repeat("x", 9<<10) // > 8KiB
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(big))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	_, _, err := c.GetPageStrict("/x", nil)

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
}

// TestGetPageStrictSuccessOverCapReadsInFull proves a SUCCESSFUL response
// well over the snippet cap is read in full (never truncated mid-JSON and
// misreported as a decode failure) — the snippet cap applies only to the
// failure path.
func TestGetPageStrictSuccessOverCapReadsInFull(t *testing.T) {
	const rowCount = 2000 // each row is well over 16 bytes -> body > 32KiB
	var b strings.Builder
	b.WriteString(`{"total_count":`)
	b.WriteString(strings.Repeat("9", 4))
	b.WriteString(`,"results":[`)
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
	rows, envelope, err := c.GetPageStrict("/x", nil)

	if err != nil {
		t.Fatalf("err = %v, want nil for a successful oversized body", err)
	}
	if len(rows) != rowCount {
		t.Fatalf("rows = %d, want all %d rows returned", len(rows), rowCount)
	}
	if envelope == nil {
		t.Fatal("envelope is nil, want the decoded object even for an oversized success body")
	}
}
