package server

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/edit"
	"bloxsmith/internal/httpx"
)

// newEditTestDeps wires a Deps for editDelete/editUpdate route tests: an
// httptest upstream standing in for CSP, a tokenless Guard (loopback ->
// admin, satisfying the "operator" gate), a real audit.Log on a scratch
// file, and an edit.Client bound to the same Rest client as the upstream.
func newEditTestDeps(t *testing.T, upstream http.HandlerFunc) *Deps {
	t.Helper()
	d, closeSrv := newTestDeps(t, upstream)
	t.Cleanup(closeSrv)
	d.Guard = &httpx.Guard{Port: "8080"}
	d.Audit = audit.New(filepath.Join(t.TempDir(), "audit_log.jsonl"), "app-v-test", "test-instance",
		// Trust root in its own directory, as it is in production — the key
		// must never sit beside the log it signs.
		audit.Options{TrustDir: t.TempDir()})
	d.Edit = edit.New(d.Rest)
	return d
}

// editRequest builds a request whose URL.Path is set directly to the
// already-decoded form the real ServeMux would hand the handler — Go's
// net/http decodes %2f in a request path before a handler ever sees
// r.URL.Path, so a client sending
// "DELETE /api/edit/dns_zone/..%2f..%2f..%2fatlas%2fv1%2f<id>" arrives here
// with literal ".." segments already in place.
func editRequest(method, path string) *http.Request {
	r := httptest.NewRequest(method, "/api/edit/", nil)
	r.URL.Path = path
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	return r
}

// --- editDelete: path-traversal-escapes-the-allowlist regression ------------

// TestEditDelete_PathTraversalID_Rejected is the regression test for the bug
// this migration fixes: editDelete used to build
// "/api/ddi/v1/" + objID directly with no validation, so a traversal id could
// reach an arbitrary CSP API path under the server's own tenant key. It must
// now 400 via edit.ObjectPath and must never reach the upstream at all.
func TestEditDelete_PathTraversalID_Rejected(t *testing.T) {
	calls := 0
	d := newEditTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(200)
	})

	r := editRequest("DELETE", "/api/edit/dns_zone/../../../atlas/v1/some-id")
	rr := httptest.NewRecorder()
	d.editDelete(rr, r)

	if rr.Code != 400 {
		t.Fatalf("status = %d, want 400: body=%s", rr.Code, rr.Body.String())
	}
	body := decodeBody(t, rr)
	if body["error"] != "invalid object id" {
		t.Fatalf("error = %v, want %q", body["error"], "invalid object id")
	}
	if calls != 0 {
		t.Fatalf("upstream calls = %d, want 0 (no DELETE issued for a rejected id)", calls)
	}
}

// TestEditDelete_EncodedTraversalID_Rejected covers the id arriving still
// percent-encoded (e.g. a proxy or client that doesn't pre-decode) — the
// literal "%2f"/".." substring checks in edit.ObjectPath must catch this form
// too, independent of Go's own request-path decoding.
func TestEditDelete_EncodedTraversalID_Rejected(t *testing.T) {
	calls := 0
	d := newEditTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(200)
	})

	r := editRequest("DELETE", "/api/edit/dns_zone/..%2f..%2fatlas%2fv1%2fsome-id")
	rr := httptest.NewRecorder()
	d.editDelete(rr, r)

	if rr.Code != 400 {
		t.Fatalf("status = %d, want 400: body=%s", rr.Code, rr.Body.String())
	}
	if calls != 0 {
		t.Fatalf("upstream calls = %d, want 0 (no DELETE issued for a rejected id)", calls)
	}
}

// TestEditDelete_LegitimateFullFormID_UnchangedBehavior pins the working
// case: a real full-form id (as returned by every list endpoint) must still
// resolve to the same upstream path it always did.
func TestEditDelete_LegitimateFullFormID_UnchangedBehavior(t *testing.T) {
	var gotPath string
	d := newEditTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(200)
	})

	r := editRequest("DELETE", "/api/edit/dns_zone/dns/auth_zone/abc123")
	rr := httptest.NewRecorder()
	d.editDelete(rr, r)

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200: body=%s", rr.Code, rr.Body.String())
	}
	want := "/api/ddi/v1/dns/auth_zone/abc123"
	if gotPath != want {
		t.Fatalf("upstream path = %q, want %q", gotPath, want)
	}
}

// TestEditDelete_BareUUID_UnchangedBehavior pins the other working case: a
// bare id gets the resource's kind prefixed, exactly as before.
func TestEditDelete_BareUUID_UnchangedBehavior(t *testing.T) {
	var gotPath string
	d := newEditTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(200)
	})

	r := editRequest("DELETE", "/api/edit/dns_zone/abc123")
	rr := httptest.NewRecorder()
	d.editDelete(rr, r)

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200: body=%s", rr.Code, rr.Body.String())
	}
	want := "/api/ddi/v1/dns/auth_zone/abc123"
	if gotPath != want {
		t.Fatalf("upstream path = %q, want %q", gotPath, want)
	}
}

// TestEditDelete_UnknownResource_404sBeforeTouchingID confirms the resource
// lookup still gates first — an unknown resource must 404 regardless of id
// shape, and never reach the upstream.
func TestEditDelete_UnknownResource_404sBeforeTouchingID(t *testing.T) {
	calls := 0
	d := newEditTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(200)
	})

	r := editRequest("DELETE", "/api/edit/not_a_real_resource/abc123")
	rr := httptest.NewRecorder()
	d.editDelete(rr, r)

	if rr.Code != 404 {
		t.Fatalf("status = %d, want 404: body=%s", rr.Code, rr.Body.String())
	}
	if calls != 0 {
		t.Fatalf("upstream calls = %d, want 0", calls)
	}
}

// --- editUpdate: the same id-validation gap, reached via PATCH --------------

// TestEditUpdate_PathTraversalID_Rejected: editUpdate copies the path id into
// body["id"] and hands it to the resource's Update builder. Those builders
// (edit.ZoneUpdate/SubnetUpdate/RangeUpdate/HostUpdate) used to build
// "/api/ddi/v1/"+id directly too — the same traversal gap, reachable via
// PATCH instead of DELETE. Must 400 and never reach the upstream.
func TestEditUpdate_PathTraversalID_Rejected(t *testing.T) {
	calls := 0
	d := newEditTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(200)
	})

	r := editRequest("PATCH", "/api/edit/dns_zone/../../../atlas/v1/some-id")
	rr := httptest.NewRecorder()
	d.editUpdate(rr, r, map[string]any{"comment": "x"})

	if rr.Code != 400 {
		t.Fatalf("status = %d, want 400: body=%s", rr.Code, rr.Body.String())
	}
	body := decodeBody(t, rr)
	if body["error"] != "invalid object id" {
		t.Fatalf("error = %v, want %q", body["error"], "invalid object id")
	}
	if calls != 0 {
		t.Fatalf("upstream calls = %d, want 0 (no PATCH/PUT issued for a rejected id)", calls)
	}
}

// TestEditUpdate_LegitimateFullFormID_UnchangedBehavior pins the working
// PATCH case through the same builder.
func TestEditUpdate_LegitimateFullFormID_UnchangedBehavior(t *testing.T) {
	var gotPath string
	d := newEditTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"result":{"id":"dns/auth_zone/abc123"}}`))
	})

	r := editRequest("PATCH", "/api/edit/dns_zone/dns/auth_zone/abc123")
	rr := httptest.NewRecorder()
	d.editUpdate(rr, r, map[string]any{"comment": "updated", "dry": false})

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200: body=%s", rr.Code, rr.Body.String())
	}
	want := "/api/ddi/v1/dns/auth_zone/abc123"
	if gotPath != want {
		t.Fatalf("upstream path = %q, want %q", gotPath, want)
	}
}
