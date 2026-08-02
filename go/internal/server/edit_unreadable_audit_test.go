package server

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// --- the created-but-unreadable outcome, read back off disk ------------------
//
// rest.Client.Write returns a nil body for an EMPTY 2xx response, and — because
// it discards the decode error — for a NON-JSON 2xx response too. Every create
// builder folded that nil into its failure arm, so a 201 whose body could not be
// read was reported to the operator as "create failed" and, being ok:false,
// written to the audit log nowhere. The object was live on the customer's tenant
// with the screen saying it did not exist and the log holding nothing that could
// find it.
//
// These tests assert on the FILE and on the SEQUENCE OF UPSTREAM CALLS, because
// neither the HTTP status nor the response body ever distinguished the bug from
// the fix on the allocate path: the release DELETEs were the damage, and only the
// recorded call list proves they did not run.

// recordedUpstream wraps an upstream handler and records every call made to it,
// so a test can assert on what was NOT sent as well as what was.
type recordedUpstream struct {
	mu    sync.Mutex
	calls []string
}

func (u *recordedUpstream) handler(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.calls = append(u.calls, r.Method+" "+r.URL.Path)
		u.mu.Unlock()
		h(w, r)
	}
}

func (u *recordedUpstream) seen() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.calls...)
}

func (u *recordedUpstream) deletes() []string {
	var out []string
	for _, c := range u.seen() {
		if strings.HasPrefix(c, "DELETE ") {
			out = append(out, c)
		}
	}
	return out
}

// unreadable2xx is the pair of upstream replies that produce the state under
// test. Both are a real 201 — the write was ACCEPTED — with a body
// rest.Client.Write turns into nil.
var unreadable2xx = []struct {
	name  string
	reply func(w http.ResponseWriter)
}{
	{"empty body", func(w http.ResponseWriter) { w.WriteHeader(201) }},
	{"non-JSON body", func(w http.ResponseWriter) {
		w.WriteHeader(201)
		io.WriteString(w, "<html><body>201 Created</body></html>")
	}},
}

func editCreateRequest(resource, body string) *http.Request {
	r := httptest.NewRequest("POST", "/api/edit/"+resource, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	return r
}

func dnsRecordCreateRequest(body string) *http.Request {
	r := httptest.NewRequest("POST", "/api/dns/records", strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:12345"
	return r
}

// assertUnreadableResult pins the three-state contract on the response body: it
// says created-but-unreadable, and it claims NEITHER outcome — no ok:true (the
// caller cannot be handed a success with no id) and no ok:false (the lie that
// lost the object).
func assertUnreadableResult(t *testing.T, body map[string]any) {
	t.Helper()
	if body["created_unreadable"] != true {
		t.Fatalf("response has no created_unreadable marker: %v", body)
	}
	if v, present := body["ok"]; present {
		t.Fatalf("response carries ok=%v — the outcome is neither a success nor a failure, and "+
			"stating either is what loses the object: %v", v, body)
	}
	msg, _ := body["error"].(string)
	if !strings.Contains(msg, "EXISTS") || !strings.Contains(msg, "id is unknown") {
		t.Fatalf("operator message %q does not say plainly that the object was created and "+
			"cannot be read back", msg)
	}
}

// --- dns_zone create ---------------------------------------------------------

func zoneUpstream(reply func(http.ResponseWriter)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/dns/auth_zone") {
			reply(w)
			return
		}
		w.WriteHeader(500)
		fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, r.URL.Path)
	}
}

const zoneCreateBody = `{"fqdn":"lab.example.com.","view":"dns/view/v1","dry":false}`

func TestEditCreate_ZoneCreatedButUnreadableIsReportedAndAudited(t *testing.T) {
	for _, tc := range unreadable2xx {
		t.Run(tc.name, func(t *testing.T) {
			up := &recordedUpstream{}
			d, logPath := newDeleteDeps(t, up.handler(zoneUpstream(tc.reply)))

			rr := httptest.NewRecorder()
			d.body(d.editCreate)(rr, editCreateRequest("dns_zone", zoneCreateBody))

			assertUnreadableResult(t, decodeBody(t, rr))

			entries := auditEntries(t, logPath, "edit-dns_zone-create-unreadable")
			if len(entries) != 1 {
				t.Fatalf("edit-dns_zone-create-unreadable entries on disk = %d, want 1 — the zone is "+
					"live on the customer's tenant and no id for it exists anywhere, so the row naming "+
					"what was asked for is the only way back to it; entries=%v", len(entries), entries)
			}
			detail := residualAuditDetail(t, entries[0])
			if detail["fqdn"] != "lab.example.com." || detail["view"] != "dns/view/v1" {
				t.Fatalf("audit detail = %v, want the request fields that identify the zone "+
					"(fqdn, view) — a row that cannot be matched to an object on the tenant is not a record", detail)
			}
			if v, present := detail["id"]; present {
				t.Fatalf("audit detail carries id=%v — there is no id, and a placeholder in that key "+
					"reads as one", v)
			}
			if n := len(auditEntries(t, logPath, "edit-dns_zone-create")); n != 0 {
				t.Fatalf("edit-dns_zone-create (clean) entries = %d, want 0 — an idless create must "+
					"never be counted among the rows that are read for their id", n)
			}
		})
	}
}

// CONTROL. A genuine upstream refusal created nothing, so it must still report
// ok:false and write NO row. Without this, "treat every create as created" would
// pass the test above while filing failures as live objects.
func TestEditCreate_ZoneGenuineFailureStillFailsAndIsNotAudited(t *testing.T) {
	d, logPath := newDeleteDeps(t, zoneUpstream(func(w http.ResponseWriter) {
		w.WriteHeader(409)
		io.WriteString(w, `{"error":"zone already exists"}`)
	}))

	rr := httptest.NewRecorder()
	d.body(d.editCreate)(rr, editCreateRequest("dns_zone", zoneCreateBody))

	if rr.Code != 409 {
		t.Fatalf("status = %d, want 409 passed through; body=%s", rr.Code, rr.Body.String())
	}
	body := decodeBody(t, rr)
	if body["ok"] != false {
		t.Fatalf("response ok = %v, want false — upstream refused, nothing was created: %v", body["ok"], body)
	}
	if body["created_unreadable"] != nil {
		t.Fatalf("a refused create is marked created_unreadable: %v", body)
	}
	if got := auditEntries(t, logPath, ""); len(got) != 0 {
		t.Fatalf("audit entries = %d, want 0 — no zone exists, so a row sends an operator hunting "+
			"for something that was never made; entries=%v", len(got), got)
	}
}

// CONTROL. A normal 201 with a readable body behaves exactly as before: ok:true,
// the zone object, and the clean create row carrying its id.
func TestEditCreate_ZoneCleanSuccessUnchanged(t *testing.T) {
	d, logPath := newDeleteDeps(t, zoneUpstream(func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		io.WriteString(w, `{"result":{"id":"dns/auth_zone/z-9","fqdn":"lab.example.com."}}`)
	}))

	rr := httptest.NewRecorder()
	d.body(d.editCreate)(rr, editCreateRequest("dns_zone", zoneCreateBody))

	body := decodeBody(t, rr)
	if body["ok"] != true {
		t.Fatalf("response ok = %v, want true on a readable 201: %v", body["ok"], body)
	}
	if body["created_unreadable"] != nil {
		t.Fatalf("a readable 201 is marked created_unreadable: %v", body)
	}
	zone, _ := body["zone"].(map[string]any)
	if zone == nil || zone["id"] != "dns/auth_zone/z-9" {
		t.Fatalf("response zone = %v, want the created object with its id", body["zone"])
	}
	entries := auditEntries(t, logPath, "edit-dns_zone-create")
	if len(entries) != 1 {
		t.Fatalf("edit-dns_zone-create entries = %d, want 1", len(entries))
	}
	if detail := residualAuditDetail(t, entries[0]); detail["id"] != "dns/auth_zone/z-9" {
		t.Fatalf("audit id = %v, want dns/auth_zone/z-9", detail["id"])
	}
	if n := len(auditEntries(t, logPath, "edit-dns_zone-create-unreadable")); n != 0 {
		t.Fatalf("edit-dns_zone-create-unreadable entries = %d, want 0 on a clean create", n)
	}
}

// --- POST /api/dns/records ---------------------------------------------------

func recordUpstream(reply func(http.ResponseWriter)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/dns/record") {
			reply(w)
			return
		}
		w.WriteHeader(500)
		fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, r.URL.Path)
	}
}

const recordCreateBody = `{"zone_id":"z-1","name_in_zone":"web","type":"A","value":"10.7.0.9","dry":false}`

func TestDNSRecordCreate_CreatedButUnreadableIsReportedAndAudited(t *testing.T) {
	for _, tc := range unreadable2xx {
		t.Run(tc.name, func(t *testing.T) {
			d, logPath := newDeleteDeps(t, recordUpstream(tc.reply))

			rr := httptest.NewRecorder()
			d.body(d.dnsRecordCreate)(rr, dnsRecordCreateRequest(recordCreateBody))

			assertUnreadableResult(t, decodeBody(t, rr))

			entries := auditEntries(t, logPath, "dns-record-create-unreadable")
			if len(entries) != 1 {
				t.Fatalf("dns-record-create-unreadable entries on disk = %d, want 1 — the record is "+
					"answering queries in the customer's live DNS while the operator was told the create "+
					"failed; entries=%v", len(entries), entries)
			}
			detail := residualAuditDetail(t, entries[0])
			if detail["zone_id"] != "z-1" || detail["name_in_zone"] != "web" || detail["type"] != "A" {
				t.Fatalf("audit detail = %v, want the fields that identify the record (zone_id, "+
					"name_in_zone, type)", detail)
			}
			if v, present := detail["id"]; present {
				t.Fatalf("audit detail carries id=%v — no id was ever read back", v)
			}
			if n := len(auditEntries(t, logPath, "dns-record-create")); n != 0 {
				t.Fatalf("dns-record-create (clean) entries = %d, want 0", n)
			}
		})
	}
}

// CONTROL. Upstream refused: no record, ok:false, no row of any kind.
func TestDNSRecordCreate_GenuineFailureStillFailsAndIsNotAudited(t *testing.T) {
	d, logPath := newDeleteDeps(t, recordUpstream(func(w http.ResponseWriter) {
		w.WriteHeader(400)
		io.WriteString(w, `{"error":"bad rdata"}`)
	}))

	rr := httptest.NewRecorder()
	d.body(d.dnsRecordCreate)(rr, dnsRecordCreateRequest(recordCreateBody))

	if rr.Code != 400 {
		t.Fatalf("status = %d, want 400 passed through; body=%s", rr.Code, rr.Body.String())
	}
	body := decodeBody(t, rr)
	if body["ok"] != false {
		t.Fatalf("response ok = %v, want false — upstream refused the record: %v", body["ok"], body)
	}
	if got := auditEntries(t, logPath, ""); len(got) != 0 {
		t.Fatalf("audit entries = %d, want 0 — no record exists; entries=%v", len(got), got)
	}
}

// CONTROL. A readable 201 is untouched by this change.
func TestDNSRecordCreate_CleanSuccessUnchanged(t *testing.T) {
	d, logPath := newDeleteDeps(t, recordUpstream(func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		io.WriteString(w, `{"result":{"id":"dns/record/r-9","type":"A"}}`)
	}))

	rr := httptest.NewRecorder()
	d.body(d.dnsRecordCreate)(rr, dnsRecordCreateRequest(recordCreateBody))

	body := decodeBody(t, rr)
	if body["ok"] != true {
		t.Fatalf("response ok = %v, want true on a readable 201: %v", body["ok"], body)
	}
	rec, _ := body["record"].(map[string]any)
	if rec == nil || rec["id"] != "dns/record/r-9" {
		t.Fatalf("response record = %v, want the created object with its id", body["record"])
	}
	if n := len(auditEntries(t, logPath, "dns-record-create")); n != 1 {
		t.Fatalf("dns-record-create entries = %d, want 1", n)
	}
	if n := len(auditEntries(t, logPath, "dns-record-create-unreadable")); n != 0 {
		t.Fatalf("dns-record-create-unreadable entries = %d, want 0 on a clean create", n)
	}
}

// --- the allocate path's record create: the release must NOT run -------------

// allocateUnreadableUpstream reserves an address, then answers the DNS record
// write with an accepted-but-unreadable 201. The release DELETE is answered 204
// deliberately: it WOULD succeed if it ran, so a passing assertion below can only
// mean it was never sent, not that it failed.
func allocateUnreadableUpstream(reply func(http.ResponseWriter)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case r.Method == "DELETE" && strings.Contains(path, "/ipam/address/"):
			w.WriteHeader(204)
		case r.Method == "POST" && strings.HasSuffix(path, "/nextavailableip"):
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"results":[{"id":"ipam/address/a-1111","address":"10.7.0.4"}]}`)
		case r.Method == "POST" && strings.HasSuffix(path, "/dns/record"):
			reply(w)
		default:
			w.WriteHeader(500)
			fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, path)
		}
	}
}

func TestSelfserviceAllocate_UnreadableRecordKeepsReservationAndIsAudited(t *testing.T) {
	for _, tc := range unreadable2xx {
		t.Run(tc.name, func(t *testing.T) {
			up := &recordedUpstream{}
			d, logPath := newDeleteDeps(t, up.handler(allocateUnreadableUpstream(tc.reply)))

			rr := httptest.NewRecorder()
			d.body(d.selfserviceAllocate)(rr, allocateRequest("false"))

			body := decodeBody(t, rr)
			assertUnreadableResult(t, body)

			// The damage this fix exists to stop: releasing the addresses out from
			// under a record that exists. Asserted on the recorded upstream calls,
			// because the response body looked plausible either way.
			if dels := up.deletes(); len(dels) != 0 {
				t.Fatalf("upstream received %v — the record was ACCEPTED upstream, so releasing the "+
					"address(es) reserved for it strips a live record of its addresses; full call "+
					"sequence=%v", dels, up.seen())
			}
			if body["released"] != nil {
				t.Fatalf("response claims released=%v, but nothing may be released here", body["released"])
			}

			entries := auditEntries(t, logPath, "selfservice-allocate-record-unreadable")
			if len(entries) != 1 {
				t.Fatalf("selfservice-allocate-record-unreadable entries on disk = %d, want 1 — a live "+
					"record and a held reservation with nothing recording either; entries=%v", len(entries), entries)
			}
			detail := residualAuditDetail(t, entries[0])
			if detail["subnet_id"] != "s-42" {
				t.Fatalf("audit subnet_id = %v, want s-42", detail["subnet_id"])
			}
			addrs, ok := detail["addresses"].([]any)
			if !ok || len(addrs) != 1 {
				t.Fatalf("audit addresses = %v, want the one reservation being held — it IS known, "+
					"unlike the record's id", detail["addresses"])
			}
			if n := len(auditEntries(t, logPath, "selfservice-allocate")); n != 0 {
				t.Fatalf("selfservice-allocate (success) entries = %d, want 0 — no record id was returned "+
					"to the caller", n)
			}
			if n := len(auditEntries(t, logPath, "selfservice-allocate-orphaned")); n != 0 {
				t.Fatalf("selfservice-allocate-orphaned entries = %d, want 0 — the addresses are held "+
					"deliberately for a live record, which is not a leaked reservation", n)
			}
		})
	}
}
