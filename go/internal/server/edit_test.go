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

// --- D2: a subnet created but never tagged must not be invisible ------------

// auditRows reads the whole chain back off disk. Nothing else in these tests
// touches the log, so every row present was written by the handler under test.
func auditRows(t *testing.T, d *Deps) []map[string]any {
	t.Helper()
	rows, skipped, err := d.Audit.Read()
	if err != nil {
		t.Fatalf("read audit log: %v", err)
	}
	if skipped > 0 {
		t.Fatalf("audit log dropped %d unreadable line(s) — the rows below are not the whole chain", skipped)
	}
	return rows
}

// auditDetail returns the detail map of the one row with the given event, or
// fails. "Zero rows" and "a row whose detail is wrong" are reported apart.
func auditDetail(t *testing.T, rows []map[string]any, event string) map[string]any {
	t.Helper()
	var found []map[string]any
	for _, row := range rows {
		if row["event"] == event {
			detail, _ := row["detail"].(map[string]any)
			found = append(found, detail)
		}
	}
	if len(found) != 1 {
		t.Fatalf("%d audit rows for %q, want exactly 1: %+v", len(found), event, rows)
	}
	return found[0]
}

// TestEditCreate_SubnetTaggingFailure_AuditsTheOrphanId is the D2 route proof.
// The upstream creates the subnet and then refuses every tag PATCH, so the
// subnet is live but carries no Site tag — invisible to every teardown query.
// Before this change the route audited only ok results, so this left NO record
// at all that the subnet had ever been created. The row below is the only thing
// that makes the orphan recoverable.
// Mutation: drop the taggingFailed arm in editCreate -> no row -> red.
func TestEditCreate_SubnetTaggingFailure_AuditsTheOrphanId(t *testing.T) {
	patches := 0
	d := newEditTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			w.Write([]byte(`{"results":[{"id":"ipam/subnet/s-orphan"}]}`))
			return
		}
		patches++
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"tag write rejected"}`))
	})

	r := editRequest("POST", "/api/edit/subnet")
	rr := httptest.NewRecorder()
	d.editCreate(rr, r, map[string]any{
		"block_id": "block-1", "cidr": float64(24), "name": "n",
		"tags": map[string]any{"Site": "hq"}, "dry": false,
	})

	// The operator still gets the honest failure — this is not a success.
	if rr.Code != 500 {
		t.Fatalf("status = %d, want 500: body=%s", rr.Code, rr.Body.String())
	}
	if body := decodeBody(t, rr); body["ok"] != false {
		t.Fatalf("ok = %v, want false — an untagged subnet is not a completed create", body["ok"])
	}
	if patches != 2 {
		t.Fatalf("%d tag PATCHes, want exactly 2 (one attempt + one bounded retry)", patches)
	}

	detail := auditDetail(t, auditRows(t, d), "edit-subnet-create")
	if detail["id"] != "ipam/subnet/s-orphan" {
		t.Fatalf("audit id = %v, want the created subnet's id so teardown can find the orphan", detail["id"])
	}
	if detail["tagging_failed"] != true {
		t.Fatalf("tagging_failed = %v, want true — this row must never read as a clean create", detail["tagging_failed"])
	}
}

// TestEditCreate_UpstreamCreateFailure_WritesNoAuditRow keeps the new arm
// narrow: when the create itself fails, nothing exists upstream, so there is no
// orphan and no row to write. Only the created-but-untagged shape is audited.
func TestEditCreate_UpstreamCreateFailure_WritesNoAuditRow(t *testing.T) {
	d := newEditTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
	})

	rr := httptest.NewRecorder()
	d.editCreate(rr, editRequest("POST", "/api/edit/subnet"), map[string]any{
		"block_id": "block-1", "cidr": float64(24), "dry": false,
	})

	if rr.Code != 503 {
		t.Fatalf("status = %d, want 503: body=%s", rr.Code, rr.Body.String())
	}
	if rows := auditRows(t, d); len(rows) != 0 {
		t.Fatalf("%d audit rows, want 0 — nothing was created, so there is nothing to record: %+v", len(rows), rows)
	}
}

// --- D3: an already-gone delete must not read like a deletion we performed --

// TestEditDelete_AuditRowDistinguishesAlreadyGone is the D3 proof. Both cases
// return ok (the 404 -> ok idempotency mapping is unchanged and deliberate),
// but the rows they write must differ: already_gone true vs false, stated
// explicitly on both arms so a missing field can only mean "unknown".
// Mutation: drop the field copy in editDelete (or collapse edit.Delete's two ok
// arms) -> the two rows become identical again -> red.
func TestEditDelete_AuditRowDistinguishesAlreadyGone(t *testing.T) {
	for _, tc := range []struct {
		name     string
		upstream int
		want     bool
	}{
		{"upstream 404 — it was already gone", 404, true},
		{"upstream 200 — we removed it", 200, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newEditTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.upstream)
			})

			rr := httptest.NewRecorder()
			d.editDelete(rr, editRequest("DELETE", "/api/edit/host/ipam/host/h-1"))

			if rr.Code != 200 {
				t.Fatalf("status = %d, want 200 (404 -> ok is deliberate idempotency): body=%s", rr.Code, rr.Body.String())
			}
			detail := auditDetail(t, auditRows(t, d), "edit-host-delete")
			if detail["id"] != "ipam/host/h-1" {
				t.Fatalf("audit id = %v, want ipam/host/h-1", detail["id"])
			}
			gone, stated := detail["already_gone"].(bool)
			if !stated {
				t.Fatalf("audit row has no already_gone field: %+v — without it this row cannot be told from the other case", detail)
			}
			if gone != tc.want {
				t.Fatalf("already_gone = %v, want %v", gone, tc.want)
			}
		})
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
