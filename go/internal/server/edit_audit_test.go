package server

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/edit"
	"bloxsmith/internal/httpx"
)

// --- the dns-record-update audit entry, read back off disk -------------------
//
// dnsRecordUpdate builds its "fields" list as a []string and handed it straight
// to auditAppend. audit.canonicalJSON's type switch has no []string case, so it
// rejected the whole entry, auditAppend log.Printf'd the error, and the handler
// still returned 200 with the record already changed upstream. Every successful
// non-dry DNS record update therefore went unrecorded.
//
// This test asserts on the FILE for that reason: the status code stayed 200
// through the entire life of the bug, so only reading audit_log.jsonl tells
// "recorded" apart from "logged an error and moved on".

// dnsRecordUpdateUpstream answers the two calls a clean non-dry record update
// makes: the pre-update read of the current record (needed for its type), and
// the PATCH that writes the new values.
func dnsRecordUpdateUpstream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/dns/record/rec-1"):
		io.WriteString(w, `{"result":{"id":"dns/record/rec-1","type":"A","dns_rdata":"10.0.0.1","ttl":300}}`)
	case r.Method == "PATCH" && strings.HasSuffix(r.URL.Path, "/dns/record/rec-1"):
		io.WriteString(w, `{"result":{"id":"dns/record/rec-1"}}`)
	default:
		w.WriteHeader(500)
		fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, r.URL.Path)
	}
}

func TestDNSRecordUpdate_SuccessWritesAuditEntryWithFields(t *testing.T) {
	d, closeSrv := newTestDeps(t, dnsRecordUpdateUpstream)
	t.Cleanup(closeSrv)
	d.Guard = &httpx.Guard{Port: "8080"} // loopback -> SameOrigin -> admin, clears the operator gate
	d.Edit = edit.New(d.Rest)
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	d.Audit = audit.New(logPath, "app-v-test", "test-instance", audit.Options{TrustDir: t.TempDir()})

	body := `{"id":"dns/record/rec-1","value":"10.0.0.2","ttl":600,"comment":"moved","disabled":false,"dry":false}`
	req := httptest.NewRequest("PATCH", "/api/dns/records", strings.NewReader(body))
	req.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	d.body(d.dnsRecordUpdate)(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}

	entries := auditEntries(t, logPath, "dns-record-update")
	if len(entries) != 1 {
		t.Fatalf("dns-record-update entries on disk = %d, want 1 — an entry canonicalJSON "+
			"refuses is only log.Printf'd, so the record changed upstream with nothing recorded", len(entries))
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["id"] != "dns/record/rec-1" {
		t.Fatalf("audit id = %v, want dns/record/rec-1", detail["id"])
	}
	raw, ok := detail["fields"]
	if !ok {
		t.Fatalf("audit detail carries no \"fields\" key: %v", detail)
	}
	list, ok := raw.([]any)
	if !ok {
		t.Fatalf("audit fields is %T, want a list: %v", raw, raw)
	}
	got := make([]string, 0, len(list))
	for _, v := range list {
		s, ok := v.(string)
		if !ok {
			t.Fatalf("audit fields entry is %T, want a string: %v", v, v)
		}
		got = append(got, s)
	}
	want := []string{"value", "ttl", "comment", "disabled"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("audit fields = %v, want %v — the field names AND their order are what say "+
			"which parts of the record this write touched", got, want)
	}
}
