package server

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- the selfservice-allocate-orphaned entry, read back off disk -------------
//
// selfserviceAllocate audited only `resultOK(res) && !isDry(res)`. But
// edit.SelfserviceAllocate returns ok:false AFTER it has reserved real addresses
// whenever the DNS record write fails: it runs a compensating release, and every
// address it could not give back comes home in res["orphaned"], STILL RESERVED on
// the customer's tenant. That produced no audit row whatsoever — the same shape
// taggingFailed already closes for editCreate.
//
// The response is a clean, honest 502 either way, so only reading
// audit_log.jsonl separates "recorded the stranded addresses" from "leaked them
// silently".

// allocateUpstream answers the three calls the allocate path makes: the
// nextavailableip reservation succeeds with two addresses, the DNS record write
// is refused (the only way the compensating release runs), and the release
// DELETEs answer with releaseStatus — 500 strands both addresses, 204 gives them
// both back.
func allocateUpstream(releaseStatus int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "DELETE" && strings.Contains(path, "/ipam/address/"):
			w.WriteHeader(releaseStatus)
			if releaseStatus >= 400 {
				io.WriteString(w, `{"error":"release refused"}`)
			}
		case r.Method == "POST" && strings.HasSuffix(path, "/nextavailableip"):
			io.WriteString(w, `{"results":[{"id":"a-1111","address":"10.7.0.4"},{"id":"a-2222","address":"10.7.0.5"}]}`)
		case r.Method == "POST" && strings.HasSuffix(path, "/dns/record"):
			w.WriteHeader(500)
			io.WriteString(w, `{"error":"record create refused"}`)
		default:
			w.WriteHeader(500)
			fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, path)
		}
	}
}

// allocateRequest posts the body that reaches the compensating release: two
// reservations plus a DNS record, non-dry.
func allocateRequest(dry string) *http.Request {
	body := `{"subnet_id":"s-42","count":2,"dry":` + dry + `,"dns":{"zone_id":"z-1","name":"web"}}`
	r := httptest.NewRequest("POST", "/api/selfservice/allocate", strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	return r
}

func TestSelfserviceAllocate_OrphanedReservationsWriteAuditEntry(t *testing.T) {
	d, logPath := newDeleteDeps(t, allocateUpstream(500))

	rr := httptest.NewRecorder()
	d.body(d.selfserviceAllocate)(rr, allocateRequest("false"))

	if rr.Code != 502 {
		t.Fatalf("status = %d, want 502 (the DNS write was refused); body=%s", rr.Code, rr.Body.String())
	}
	// Guard the fixture itself: if the release ever succeeded, this test would be
	// asserting the absence of a leak rather than the recording of one.
	if body := decodeBody(t, rr); body["orphaned"] == nil {
		t.Fatalf("fixture produced no orphaned addresses, so the case under test never happened: %v", body)
	}

	entries := auditEntries(t, logPath, "selfservice-allocate-orphaned")
	if len(entries) != 1 {
		t.Fatalf("selfservice-allocate-orphaned entries on disk = %d, want 1 — two addresses are "+
			"still reserved on the customer's tenant and the ok:false gate wrote nothing, so nothing "+
			"records who created them", len(entries))
	}
	if entries[0]["actor"] != "loopback" {
		t.Fatalf("audit actor = %v, want \"loopback\" — an entry that cannot say who allocated the "+
			"stranded addresses is half a record", entries[0]["actor"])
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["subnet_id"] != "s-42" {
		t.Fatalf("audit subnet_id = %v, want s-42", detail["subnet_id"])
	}
	if detail["count"] != float64(2) {
		t.Fatalf("audit count = %v, want 2; detail=%v", detail["count"], detail)
	}
	list, ok := detail["orphaned"].([]any)
	if !ok {
		t.Fatalf("audit detail orphaned is %T, want a list: %v", detail["orphaned"], detail)
	}
	got := make([]string, 0, len(list))
	for _, v := range list {
		s, ok := v.(string)
		if !ok {
			t.Fatalf("orphaned entry is %T, want a string id: %v", v, v)
		}
		got = append(got, s)
	}
	if strings.Join(got, ",") != "a-1111,a-2222" {
		t.Fatalf("audit orphaned = %v, want [a-1111 a-2222] — the IDS are the point; a row that "+
			"only says addresses leaked cannot be acted on", got)
	}

	// It must NOT be filed as a successful allocation: anyone counting
	// selfservice-allocate rows would count this failure as one.
	if n := len(auditEntries(t, logPath, "selfservice-allocate")); n != 0 {
		t.Fatalf("selfservice-allocate (success) entries = %d, want 0 — nothing was allocated to the caller", n)
	}
}

// The counterpart: an ok:false whose compensating release gave every address
// back left nothing behind, so it must record nothing. Without this half,
// auditing every ok:false would pass the test above while filing clean rollbacks
// as leaks.
func TestSelfserviceAllocate_CleanReleaseWritesNoAuditEntry(t *testing.T) {
	d, logPath := newDeleteDeps(t, allocateUpstream(204))

	rr := httptest.NewRecorder()
	d.body(d.selfserviceAllocate)(rr, allocateRequest("false"))

	if rr.Code != 502 {
		t.Fatalf("status = %d, want 502 (the DNS write was still refused); body=%s", rr.Code, rr.Body.String())
	}
	if body := decodeBody(t, rr); body["orphaned"] != nil {
		t.Fatalf("fixture stranded an address, so this is not the clean-release case: %v", body)
	}
	if got := auditEntries(t, logPath, ""); len(got) != 0 {
		t.Fatalf("audit entries = %d, want 0 — every reservation was released, so a row naming "+
			"stranded addresses sends an operator after IPs that no longer exist; entries=%v", len(got), got)
	}
}

// And a dry run reserves nothing at all, so it stays unrecorded — the existing
// isDry gate, kept honest.
func TestSelfserviceAllocate_DryRunWritesNoAuditEntry(t *testing.T) {
	d, logPath := newDeleteDeps(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("a dry run must issue no upstream call, got %s %s", r.Method, r.URL.Path)
		w.WriteHeader(500)
	})

	rr := httptest.NewRecorder()
	d.body(d.selfserviceAllocate)(rr, allocateRequest("true"))

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200 on a preview; body=%s", rr.Code, rr.Body.String())
	}
	if got := auditEntries(t, logPath, ""); len(got) != 0 {
		t.Fatalf("audit entries = %d, want 0 (a preview reserves nothing); entries=%v", len(got), got)
	}
}
