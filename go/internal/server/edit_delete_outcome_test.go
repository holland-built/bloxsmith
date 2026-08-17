package server

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"bloxsmith/internal/edit"
)

// --- DELETE /api/edit/<resource>/<id>: an unanswered delete is still a delete --
//
// edit.Client.Delete reports statusOr(status, 502), so a DELETE that went on the
// wire and was never answered — a client-side timeout, a dropped connection —
// arrives here as 502. deleteOutcomeUnknown names that case: the object may well
// be gone from the customer's tenant.
//
// dnsRecordDelete and ipamAddressDelete each recorded it. editDelete did not, and
// editDelete is the route that dispatches to all five editor resources, so the
// delete it lost could be a whole DNS zone or an address block. Proven side by
// side against one upstream that hangs up without answering: /api/dns/records/
// wrote dns-record-delete-error, /api/edit/dns_zone/… wrote nothing.

// editDeleteDeps wires a Deps with a real on-disk audit log, a real edit client
// pointed at the given upstream, and returns the log path. The log is read from
// DISK on purpose: a detail value canonicalJSON refuses makes auditAppend
// log-and-continue, so the HTTP response would still look right while nothing
// was recorded.
func editDeleteDeps(t *testing.T, upstream http.HandlerFunc) (*Deps, string) {
	t.Helper()
	d, logPath := newResidualDeps(t, upstream)
	d.Edit = edit.New(d.Rest)
	return d, logPath
}

func editDeleteRequest(path string) *http.Request {
	r := httptest.NewRequest("DELETE", path, nil)
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> admin, satisfying the operator gate
	return r
}

// hangUpUpstream accepts the connection and closes it without answering. That is
// what makes rest.Write report status 0, which edit.Client.Delete maps to 502.
func hangUpUpstream(t *testing.T) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Skip("ResponseWriter is not a Hijacker; cannot simulate an unanswered request")
		}
		conn, _, err := hj.Hijack()
		if err != nil {
			t.Fatalf("hijack: %v", err)
		}
		conn.Close()
	}
}

func statusUpstream(code int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		fmt.Fprintf(w, `{"error":"upstream said %d"}`, code)
	}
}

// editResources are every resource the editor's DELETE dispatches to, with the
// full-form id ObjectPath builds for it. Parameterised rather than one sample:
// the event name is assembled from the resource at run time, so "it works for
// dns_zone" is not evidence about the other four.
var editResources = []struct{ name, kind string }{
	{"dns_zone", "dns/auth_zone"},
	{"subnet", "ipam/subnet"},
	{"address_block", "ipam/address_block"},
	{"dhcp_range", "ipam/range"},
	{"host", "ipam/host"},
}

// The defect: an unanswered DELETE, for every resource, in both the short and
// the full id form ObjectPath accepts.
func TestEditDelete_UnansweredDelete_IsRecorded(t *testing.T) {
	for _, res := range editResources {
		for _, form := range []struct{ label, id string }{
			{"short id", "obj-123"},
			{"full-form id", res.kind + "/obj-123"},
		} {
			t.Run(res.name+"/"+form.label, func(t *testing.T) {
				d, logPath := editDeleteDeps(t, hangUpUpstream(t))
				rr := httptest.NewRecorder()
				d.editDelete(rr, editDeleteRequest("/api/edit/"+res.name+"/"+form.id))

				if rr.Code != 502 {
					t.Fatalf("status = %d, want 502 — without it this case is not the unanswered "+
						"delete it claims to be: %s", rr.Code, rr.Body.String())
				}
				if n := len(auditEntries(t, logPath, "edit-"+res.name+"-delete")); n != 0 {
					t.Fatalf("%d clean delete row(s) written for an outcome nobody knows", n)
				}
				detail := uaOnly(t, logPath, "edit-"+res.name+"-delete-error",
					"the DELETE was dispatched and never answered, so the object may be gone")
				if detail["id"] != form.id {
					t.Fatalf("audit id = %v, want %q — a row that does not name the object cannot be "+
						"reconciled against the tenant", detail["id"], form.id)
				}
				if detail["outcome"] != "unknown" {
					t.Fatalf("audit outcome = %v, want \"unknown\" — this row must not read as a deletion",
						detail["outcome"])
				}
				if msg, _ := detail["error"].(string); msg == "" {
					t.Fatalf("audit row carries no error text: %v", detail)
				}
			})
		}
	}
}

// A gateway that could not reach the backend is the same unknown, and its status
// passes through unchanged rather than becoming 502.
func TestEditDelete_GatewayTimeout_IsRecorded(t *testing.T) {
	d, logPath := editDeleteDeps(t, statusUpstream(504))
	rr := httptest.NewRecorder()
	d.editDelete(rr, editDeleteRequest("/api/edit/dns_zone/obj-123"))

	if rr.Code != 504 {
		t.Fatalf("status = %d, want 504 passed through unchanged", rr.Code)
	}
	detail := uaOnly(t, logPath, "edit-dns_zone-delete-error", "a gateway could not reach the backend")
	if detail["outcome"] != "unknown" {
		t.Fatalf("audit outcome = %v, want \"unknown\"", detail["outcome"])
	}
}

// The other direction, and the reason this is not "audit every failure": upstream
// ANSWERED and refused, so nothing was deleted and there is nothing to record.
func TestEditDelete_UpstreamRefused_RecordsNothing(t *testing.T) {
	for _, code := range []int{400, 403, 409, 500} {
		t.Run(fmt.Sprintf("%d", code), func(t *testing.T) {
			d, logPath := editDeleteDeps(t, statusUpstream(code))
			rr := httptest.NewRecorder()
			d.editDelete(rr, editDeleteRequest("/api/edit/dns_zone/obj-123"))

			if rr.Code != code {
				t.Fatalf("status = %d, want %d passed through unchanged", rr.Code, code)
			}
			body := decodeBody(t, rr)
			if ok, _ := body["ok"].(bool); ok {
				t.Fatalf("a refused delete reported ok:true: %s", rr.Body.String())
			}
			uaNone(t, logPath, "",
				"upstream answered and refused, so nothing was deleted and no row belongs in the log")
		})
	}
}

// The success paths are untouched: a real deletion and an already-gone one each
// still write exactly one clean row and no error row.
func TestEditDelete_Success_WritesOnlyTheCleanRow(t *testing.T) {
	cases := []struct {
		name      string
		status    int
		alreadyGo bool
	}{
		{"deleted", 204, false},
		{"already gone", 404, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d, logPath := editDeleteDeps(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				io.WriteString(w, "")
			})
			rr := httptest.NewRecorder()
			d.editDelete(rr, editDeleteRequest("/api/edit/dns_zone/obj-123"))

			if rr.Code != 200 {
				t.Fatalf("status = %d, want 200: %s", rr.Code, rr.Body.String())
			}
			detail := uaOnly(t, logPath, "edit-dns_zone-delete", "the delete resolved")
			if detail["already_gone"] != tc.alreadyGo {
				t.Fatalf("already_gone = %v, want %v", detail["already_gone"], tc.alreadyGo)
			}
			if n := len(auditEntries(t, logPath, "edit-dns_zone-delete-error")); n != 0 {
				t.Fatalf("%d error row(s) written for a resolved delete", n)
			}
		})
	}
}
