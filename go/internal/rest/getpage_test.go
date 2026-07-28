package rest

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestGetPageObjectResponse pins that a normal {"results":[...], meta} envelope
// unwraps rows correctly AND still exposes the metadata key via body, which
// Get() cannot do (it discards the envelope entirely).
func TestGetPageObjectResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[{"id":1},{"id":2}],"total_results":2}`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	rows, body, status := c.GetPage("/x", nil)

	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %v, want 2 items", rows)
	}
	if body == nil {
		t.Fatal("body is nil, want the decoded envelope")
	}
	if got, ok := body["total_results"].(float64); !ok || got != 2 {
		t.Fatalf("body[total_results] = %v, want 2 (pagination metadata must survive)", body["total_results"])
	}
}

// TestGetPageArrayResponse pins that a bare top-level array is legal: rows
// populate, and body is nil since there is no top-level object to expose.
func TestGetPageArrayResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"id":1},{"id":2},{"id":3}]`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	rows, body, status := c.GetPage("/x", nil)

	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	if len(rows) != 3 {
		t.Fatalf("rows = %v, want 3 items", rows)
	}
	if body != nil {
		t.Fatalf("body = %v, want nil for a top-level array", body)
	}
}

// TestGetPageServerError500 is the bug-class regression test: an upstream
// failure must NEVER be reported as an empty-slice success. Before this
// helper, Get() collapsed a 500 into []any{} indistinguishable from a
// genuinely empty result set.
func TestGetPageServerError500(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"boom"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	rows, body, status := c.GetPage("/x", nil)

	if status != 500 {
		t.Fatalf("status = %d, want 500", status)
	}
	if rows != nil {
		t.Fatalf("rows = %v, want nil (NOT an empty-slice success) on a 500", rows)
	}
	if body != nil {
		t.Fatalf("body = %v, want nil on a 500", body)
	}
}

// TestGetPageClientError400 mirrors the 500 case for a 400, confirming the
// status is passed through verbatim rather than swallowed.
func TestGetPageClientError400(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"bad filter"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	rows, body, status := c.GetPage("/x", nil)

	if status != 400 {
		t.Fatalf("status = %d, want 400", status)
	}
	if rows != nil {
		t.Fatalf("rows = %v, want nil on a 400", rows)
	}
	if body != nil {
		t.Fatalf("body = %v, want nil on a 400", body)
	}
}

// TestGetPageMalformedBody confirms a malformed/non-JSON 200 body never
// panics: json.Unmarshal fails silently (matching GetEx's existing
// _ = json.Unmarshal convention), leaving raw nil and rows empty.
func TestGetPageMalformedBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`not json at all {{{`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("GetPage panicked on malformed body: %v", r)
		}
	}()

	rows, body, status := c.GetPage("/x", nil)

	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	if len(rows) != 0 {
		t.Fatalf("rows = %v, want empty on malformed body", rows)
	}
	if body != nil {
		t.Fatalf("body = %v, want nil on malformed body", body)
	}
}
