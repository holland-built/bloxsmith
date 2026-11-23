package server

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// The audit and allocate tests use a clear refusal for the release path. These
// keep the 500 path: the address stays, and a delete with no answer is recorded.
func TestSelfserviceAllocate_DNS500KeepsTheAddresses(t *testing.T) {
	var deletes atomic.Int32
	base := allocateUpstream(204)
	d, _ := newDeleteDeps(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "DELETE":
			deletes.Add(1)
			base(w, r)
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/dns/record"):
			w.WriteHeader(500)
			io.WriteString(w, `{"error":"no clear answer"}`)
		default:
			base(w, r)
		}
	})
	rr := httptest.NewRecorder()
	d.body(d.selfserviceAllocate)(rr, allocateRequest("false"))
	if n := deletes.Load(); n != 0 {
		t.Fatalf("%d address(es) released on a 500, want none: %s", n, rr.Body.String())
	}
	if body := decodeBody(t, rr); body["created_unreadable"] != true || rr.Code != 500 {
		t.Fatalf("= %d %v, want a may-exist result", rr.Code, body)
	}
}

func TestDirectDeletes_A500IsRecordedAsUnknown(t *testing.T) {
	for _, tc := range []struct {
		name, path, event string
		call              func(*Deps) http.HandlerFunc
	}{
		{"dns record", "/api/dns/records/dns/record/rec-1", "dns-record-delete-error",
			func(d *Deps) http.HandlerFunc { return d.dnsRecordDelete }},
		{"ipam address", "/api/ipam/addresses/ipam/address/a-1", "ipam-address-delete-error",
			func(d *Deps) http.HandlerFunc { return d.ipamAddressDelete }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, logPath := newDeleteDeps(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(500)
				fmt.Fprint(w, `{"error":"no clear answer"}`)
			})
			tc.call(d)(httptest.NewRecorder(), deleteRequest(tc.path))
			entries := auditEntries(t, logPath, tc.event)
			if len(entries) != 1 || residualAuditDetail(t, entries[0])["outcome"] != "unknown" {
				t.Fatalf("%s entries = %v, want one unknown row", tc.event, entries)
			}
		})
	}
}
