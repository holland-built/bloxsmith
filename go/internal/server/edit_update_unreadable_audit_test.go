package server

// The route-layer half of issue #76, read back off DISK.
//
// A PATCH that upstream ACCEPTED but could not be read back is neither a success
// nor a failure, so the builder's result carries no "ok" key — and both audit
// rows in this file used to be gated on ok:true. The consequence was that a live
// change to a customer's DNS record or IPAM object was made with NOTHING
// recording who asked for it: the response said "update failed (status 200)" and
// the log said nothing at all.
//
// These tests assert on the file rather than on the response, because the
// response was never the part that went missing.

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// unreadableUpdate2xx is the set of upstream replies that produce the state
// under test. Each is an accepted write whose body rest.Client.Write turns into
// nil (or into something that is not the updated object).
var unreadableUpdate2xx = []struct {
	name  string
	reply func(w http.ResponseWriter)
}{
	{"empty 200", func(w http.ResponseWriter) { w.WriteHeader(200) }},
	{"204 no content", func(w http.ResponseWriter) { w.WriteHeader(204) }},
	{"non-JSON 200", func(w http.ResponseWriter) {
		w.WriteHeader(200)
		io.WriteString(w, "<html>updated</html>")
	}},
}

// updateUpstream answers the pre-update GET with a real record and every write
// with the case's reply.
func updateUpstream(reply func(http.ResponseWriter)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w,
				`{"result":{"id":"dns/record/r-1","type":"A","dns_rdata":"10.0.0.1","ttl":300}}`)
			return
		}
		if r.Method == "PATCH" || r.Method == "PUT" {
			reply(w)
			return
		}
		w.WriteHeader(500)
		fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, r.URL.Path)
	}
}

func dnsRecordUpdateRequest(body string) *http.Request {
	r := httptest.NewRequest("PATCH", "/api/dns/records", strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	return r
}

func editUpdateRequest(resource, id, body string) *http.Request {
	r := httptest.NewRequest("PATCH", "/api/edit/"+resource+"/"+id, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:12345"
	return r
}

// assertUnreadableUpdateResult pins the three-state contract on the response:
// the marker is set and NEITHER outcome is claimed. The message must also be
// present — both UI tabs branch on j.error, so it is the only thing stopping the
// screen from painting an unconfirmed change green.
func assertUnreadableUpdateResult(t *testing.T, body map[string]any) {
	t.Helper()
	if body["updated_unreadable"] != true {
		t.Fatalf("response has no updated_unreadable marker: %v", body)
	}
	if v, present := body["ok"]; present {
		t.Fatalf("response carries ok=%v — the change landed and cannot be confirmed, so "+
			"stating either outcome is a lie: %v", v, body)
	}
	msg, _ := body["error"].(string)
	if !strings.Contains(msg, "ACCEPTED") || !strings.Contains(msg, "LIVE") {
		t.Fatalf("operator message %q does not say plainly that the change landed and cannot "+
			"be confirmed here", msg)
	}
	if strings.Contains(msg, "update failed") {
		t.Fatalf("operator message still reports a failure: %q", msg)
	}
}

const recordUpdateBody = `{"id":"dns/record/r-1","ttl":60,"comment":"c","dry":false}`

// TestDNSRecordUpdate_AcceptedButUnreadableIsReportedAndAudited. The record is
// answering queries with its NEW values; without this row nothing anywhere says
// so.
func TestDNSRecordUpdate_AcceptedButUnreadableIsReportedAndAudited(t *testing.T) {
	for _, tc := range unreadableUpdate2xx {
		t.Run(tc.name, func(t *testing.T) {
			up := &recordedUpstream{}
			d, logPath := newDeleteDeps(t, up.handler(updateUpstream(tc.reply)))

			rr := httptest.NewRecorder()
			d.body(d.dnsRecordUpdate)(rr, dnsRecordUpdateRequest(recordUpdateBody))

			if rr.Code == 204 {
				t.Fatalf("route answered 204 with a body — 204 means no content: %s", rr.Body.String())
			}
			assertUnreadableUpdateResult(t, decodeBody(t, rr))

			entries := auditEntries(t, logPath, "dns-record-update-unreadable")
			if len(entries) != 1 {
				t.Fatalf("dns-record-update-unreadable rows on disk = %d, want 1 — the record "+
					"carries its new values on the customer's tenant; entries=%v", len(entries), entries)
			}
			detail := residualAuditDetail(t, entries[0])
			if detail["id"] != "dns/record/r-1" {
				t.Fatalf("audit id = %v, want dns/record/r-1 — without it the row cannot be "+
					"traced to an object", detail["id"])
			}
			if detail["updated_unreadable"] != true {
				t.Fatalf("audit detail = %v, want the marker so this is never counted as a "+
					"confirmed update", detail)
			}
			fields, _ := detail["fields"].([]any)
			if len(fields) != 2 {
				t.Fatalf("audit fields = %v, want the two fields the caller asked to change — "+
					"the row must say WHAT was changed, not just that something was", detail["fields"])
			}
			if rows := auditEntries(t, logPath, "dns-record-update"); len(rows) != 0 {
				t.Fatalf("%d clean dns-record-update rows, want 0 — an unconfirmed change must "+
					"never be counted as a completed one", len(rows))
			}
		})
	}
}

// TestEditUpdate_AcceptedButUnreadableIsReportedAndAudited covers the generic
// /api/edit/<resource>/<id> half.
func TestEditUpdate_AcceptedButUnreadableIsReportedAndAudited(t *testing.T) {
	for _, tc := range unreadableUpdate2xx {
		t.Run(tc.name, func(t *testing.T) {
			up := &recordedUpstream{}
			d, logPath := newDeleteDeps(t, up.handler(updateUpstream(tc.reply)))

			rr := httptest.NewRecorder()
			d.body(d.editUpdate)(rr, editUpdateRequest("host", "ipam/host/h-1", `{"name":"after","dry":false}`))

			if rr.Code == 204 {
				t.Fatalf("route answered 204 with a body: %s", rr.Body.String())
			}
			assertUnreadableUpdateResult(t, decodeBody(t, rr))

			entries := auditEntries(t, logPath, "edit-host-update-unreadable")
			if len(entries) != 1 {
				t.Fatalf("edit-host-update-unreadable rows on disk = %d, want 1; entries=%v",
					len(entries), entries)
			}
			detail := residualAuditDetail(t, entries[0])
			if detail["id"] != "ipam/host/h-1" || detail["updated_unreadable"] != true {
				t.Fatalf("audit detail = %v, want the id and the marker", detail)
			}
			if detail["resource"] != "host" {
				t.Fatalf("audit resource = %v, want \"host\"", detail["resource"])
			}
			if rows := auditEntries(t, logPath, "edit-host-update"); len(rows) != 0 {
				t.Fatalf("%d clean edit-host-update rows, want 0", len(rows))
			}
		})
	}
}

// TestUpdateUnreadable_WritesNoRowForAPreviewOrARefusal is the other side: this
// row must not degenerate into "audit everything". A dry run changed nothing,
// and a 4xx is upstream having answered and refused.
func TestUpdateUnreadable_WritesNoRowForAPreviewOrARefusal(t *testing.T) {
	cases := []struct {
		name  string
		body  string
		reply func(http.ResponseWriter)
	}{
		{"dry run", `{"id":"dns/record/r-1","ttl":60,"dry":true}`,
			func(w http.ResponseWriter) { w.WriteHeader(200) }},
		{"upstream refused", recordUpdateBody, func(w http.ResponseWriter) {
			w.WriteHeader(400)
			io.WriteString(w, `{"error":"bad request"}`)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			up := &recordedUpstream{}
			d, logPath := newDeleteDeps(t, up.handler(updateUpstream(tc.reply)))
			rr := httptest.NewRecorder()
			d.body(d.dnsRecordUpdate)(rr, dnsRecordUpdateRequest(tc.body))

			if rows := auditEntries(t, logPath, "dns-record-update-unreadable"); len(rows) != 0 {
				t.Fatalf("%d unreadable rows for %s, want 0 — nothing was accepted", len(rows), tc.name)
			}
		})
	}
}
