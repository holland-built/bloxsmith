package rest

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestGetExMalformedBody proves a non-JSON 200 body (a proxy/gateway
// interstitial) is now a decode error, not the silently-empty
// (body=nil, status=200, err=nil) that let a maintenance-check failure read
// as a legitimate "disabled" state (csp.go CSPMaintenance).
func TestGetExMalformedBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`not json at all {{{`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	body, status, err := c.GetEx("/x", nil)

	if err == nil {
		t.Fatal("err = nil, want a decode error for a non-JSON 200 body")
	}
	if body != nil {
		t.Fatalf("body = %v, want nil on a decode failure", body)
	}
	if status != 200 {
		t.Fatalf("status = %d, want 200 (the HTTP layer succeeded; only the body was bad)", status)
	}
}

// TestGetExScalarShape proves a syntactically valid JSON scalar (which
// json.Unmarshal happily decodes) is rejected as the wrong shape — GetEx's
// callers all expect an object or an array, never a bare number/string/bool.
func TestGetExScalarShape(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`3`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	body, status, err := c.GetEx("/x", nil)

	if err == nil {
		t.Fatal("err = nil, want a shape error for a bare JSON scalar")
	}
	if body != nil {
		t.Fatalf("body = %v, want nil on a shape failure", body)
	}
	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
}

// TestGetExEmptyBodyNotDecodeFailure is the core regression guard: a
// genuinely empty body (204 No Content, or a 200 with zero bytes) must NOT
// be reported as a decode failure — it is a legitimate no-op result.
func TestGetExEmptyBodyNotDecodeFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	body, status, err := c.GetEx("/x", nil)

	if err != nil {
		t.Fatalf("err = %v, want nil for a genuinely empty 204 body", err)
	}
	if body != nil {
		t.Fatalf("body = %v, want nil for an empty body", body)
	}
	if status != 204 {
		t.Fatalf("status = %d, want 204", status)
	}
}

// TestGetExEmpty200BodyNotDecodeFailure covers the same "empty is not a
// decode failure" contract when the empty body arrives on a plain 200
// (rather than a 204), since GetEx checks length before status code.
func TestGetExEmpty200BodyNotDecodeFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Write nothing: an explicit 200 with a zero-length body.
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	body, status, err := c.GetEx("/x", nil)

	if err != nil {
		t.Fatalf("err = %v, want nil for an empty 200 body", err)
	}
	if body != nil {
		t.Fatalf("body = %v, want nil for an empty body", body)
	}
	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
}

// TestGetExResultsPresent pins the ordinary success path is unchanged: a
// well-formed object body decodes and is returned as-is.
func TestGetExResultsPresent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[{"id":1},{"id":2}]}`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	body, status, err := c.GetEx("/x", nil)

	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	rows := Unwrap(body)
	if len(rows) != 2 {
		t.Fatalf("rows = %v, want 2 items", rows)
	}
}

// TestGetExStatusErrorStillNilErr pins the pre-existing 4xx/5xx behavior:
// GetEx does not itself turn a bad HTTP status into a non-nil error (callers
// check status directly) — this fix only concerns the 2xx decode/shape path.
func TestGetExStatusErrorStillNilErr(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"boom"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, NewAuth("key", nil))
	body, status, err := c.GetEx("/x", nil)

	if err != nil {
		t.Fatalf("err = %v, want nil on a 5xx (status alone signals the failure)", err)
	}
	if body != nil {
		t.Fatalf("body = %v, want nil on a 5xx", body)
	}
	if status != 500 {
		t.Fatalf("status = %d, want 500", status)
	}
}
