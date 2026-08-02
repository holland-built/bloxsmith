package server

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/edit"
	"bloxsmith/internal/httpx"
)

// --- the dns-record-delete / ipam-address-delete entries, read back off disk --
//
// Both routes remove an object from the customer's live tenant and called
// auditAppend ZERO times, while their non-destructive sibling dnsRecordUpdate
// audited a mere TTL change. The response was a clean 200 either way, so every
// test that asserted on status code passed straight through the gap — which is
// exactly how it survived. Only reading audit_log.jsonl separates "recorded"
// from "deleted and forgot".

// deleteUpstream answers the one call a delete-by-id makes and refuses anything
// else, so a handler that wanders off the delete-by-id path fails loudly.
func deleteUpstream(wantPath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "DELETE" && r.URL.Path == wantPath {
			io.WriteString(w, `{"result":{}}`)
			return
		}
		w.WriteHeader(500)
		fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, r.URL.Path)
	}
}

// newDeleteDeps wires a Deps with a real edit client, a loopback Guard and a
// real audit.Log on a scratch file, whose path it returns for on-disk asserts.
func newDeleteDeps(t *testing.T, upstream http.HandlerFunc) (*Deps, string) {
	t.Helper()
	d, closeSrv := newTestDeps(t, upstream)
	t.Cleanup(closeSrv)
	d.Guard = &httpx.Guard{Port: "8080"} // loopback -> SameOrigin -> admin
	d.Edit = edit.New(d.Rest)
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	d.Audit = audit.New(logPath, "app-v-test", "test-instance", audit.Options{TrustDir: t.TempDir()})
	return d, logPath
}

func deleteRequest(path string) *http.Request {
	r := httptest.NewRequest("DELETE", path, nil)
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	return r
}

// A successful DNS record delete must leave its entry ON DISK naming the record
// it destroyed. Before this change the handler wrote the 200 and returned.
func TestDNSRecordDelete_SuccessWritesAuditEntry(t *testing.T) {
	d, logPath := newDeleteDeps(t, deleteUpstream("/api/ddi/v1/dns/record/rec-1"))

	rr := httptest.NewRecorder()
	d.dnsRecordDelete(rr, deleteRequest("/api/dns/records/dns/record/rec-1"))

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}

	entries := auditEntries(t, logPath, "dns-record-delete")
	if len(entries) != 1 {
		t.Fatalf("dns-record-delete entries on disk = %d, want 1 — the record is gone from the "+
			"customer's live DNS and the 200 says so; the log is the only place that can still say who did it", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["id"] != "dns/record/rec-1" {
		t.Fatalf("audit id = %v, want dns/record/rec-1 — an entry that does not name the object "+
			"records that A delete happened, not WHICH", detail["id"])
	}
}

// The same gap on the IPAM half: an address released from the tenant with
// nothing recording which one.
func TestIPAMAddressDelete_SuccessWritesAuditEntry(t *testing.T) {
	d, logPath := newDeleteDeps(t, deleteUpstream("/api/ddi/v1/ipam/address/addr-1"))

	rr := httptest.NewRecorder()
	d.ipamAddressDelete(rr, deleteRequest("/api/ipam/addresses/ipam/address/addr-1"))

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}

	entries := auditEntries(t, logPath, "ipam-address-delete")
	if len(entries) != 1 {
		t.Fatalf("ipam-address-delete entries on disk = %d, want 1 — the address was released "+
			"upstream with no record of it", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["id"] != "ipam/address/addr-1" {
		t.Fatalf("audit id = %v, want ipam/address/addr-1", detail["id"])
	}
}

// droppedAfterDispatch answers the DELETE by taking the connection away without
// writing a response — the wire shape of a client-side timeout or a dropped
// connection. rest.Client.Write reports status 0 for it, and edit.Client.Delete
// turns that into ok:false. Crucially the request WAS delivered here: upstream
// may have executed the delete and only the reply was lost, which is precisely
// the outcome the route cannot distinguish and therefore must record.
func droppedAfterDispatch(t *testing.T) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Errorf("test server does not support hijacking; cannot model a lost reply")
			return
		}
		conn, _, err := hj.Hijack()
		if err != nil {
			t.Errorf("hijack: %v", err)
			return
		}
		conn.Close()
	}
}

// A delete whose reply never arrived must leave an ERROR entry on disk. The
// ok-only gate recorded nothing here, so a record that may be gone from the
// customer's live DNS had no trace at all — the exact hole the success entry
// above was added to close, one branch over.
func TestDNSRecordDelete_UnknownOutcomeWritesErrorEntry(t *testing.T) {
	d, logPath := newDeleteDeps(t, droppedAfterDispatch(t))

	rr := httptest.NewRecorder()
	d.dnsRecordDelete(rr, deleteRequest("/api/dns/records/dns/record/rec-1"))

	if rr.Code == 200 {
		t.Fatalf("status = 200 with no upstream reply; body=%s", rr.Body.String())
	}
	if got := auditEntries(t, logPath, "dns-record-delete"); len(got) != 0 {
		t.Fatalf("dns-record-delete entries = %d, want 0 — nobody knows the record was deleted, so "+
			"the success event must not claim it; entries=%v", len(got), got)
	}
	entries := auditEntries(t, logPath, "dns-record-delete-error")
	if len(entries) != 1 {
		t.Fatalf("dns-record-delete-error entries on disk = %d, want 1 — the DELETE was on the wire "+
			"before the reply was lost, so the record may be gone from the live tenant with nothing "+
			"recording who asked", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["id"] != "dns/record/rec-1" {
		t.Fatalf("audit id = %v, want dns/record/rec-1 — a row that does not name the object cannot "+
			"be reconciled against the tenant", detail["id"])
	}
	if detail["outcome"] != "unknown" {
		t.Fatalf("audit outcome = %v, want \"unknown\" — the row must not read as a completed delete "+
			"nor as a refused one", detail["outcome"])
	}
}

// The same lost reply on the IPAM half: the address may already be released.
func TestIPAMAddressDelete_UnknownOutcomeWritesErrorEntry(t *testing.T) {
	d, logPath := newDeleteDeps(t, droppedAfterDispatch(t))

	rr := httptest.NewRecorder()
	d.ipamAddressDelete(rr, deleteRequest("/api/ipam/addresses/ipam/address/addr-1"))

	if rr.Code == 200 {
		t.Fatalf("status = 200 with no upstream reply; body=%s", rr.Body.String())
	}
	entries := auditEntries(t, logPath, "ipam-address-delete-error")
	if len(entries) != 1 {
		t.Fatalf("ipam-address-delete-error entries on disk = %d, want 1 — the release may have "+
			"happened upstream and the reply been lost", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["id"] != "ipam/address/addr-1" {
		t.Fatalf("audit id = %v, want ipam/address/addr-1", detail["id"])
	}
	if detail["outcome"] != "unknown" {
		t.Fatalf("audit outcome = %v, want \"unknown\"", detail["outcome"])
	}
}

// The counterpart that keeps the two above honest: a FAILED delete removed
// nothing, so it must NOT claim a deletion. Without this, "audit unconditionally"
// would pass the tests above while writing rows for deletes that never happened.
// It also pins the error entry's boundary: upstream answered with a real status,
// so the object is provably still there and not even the *-error row is allowed.
func TestDNSRecordDelete_FailureWritesNoAuditEntry(t *testing.T) {
	d, logPath := newDeleteDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		io.WriteString(w, `{"error":"delete refused"}`)
	})

	rr := httptest.NewRecorder()
	d.dnsRecordDelete(rr, deleteRequest("/api/dns/records/dns/record/rec-1"))

	if rr.Code == 200 {
		t.Fatalf("status = 200 on a refused delete; body=%s", rr.Body.String())
	}
	if got := auditEntries(t, logPath, ""); len(got) != 0 {
		t.Fatalf("audit entries = %d, want 0 — the record still exists upstream, so a row "+
			"saying it was deleted is a false claim; entries=%v", len(got), got)
	}
}
