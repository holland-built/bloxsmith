package server

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/runs"
)

// Any delete with no clear answer is recorded as unknown, not only 502 and 504.
func TestEditDelete_EveryNoClearAnswerIsRecorded(t *testing.T) {
	for _, code := range []int{500, 501, 503, 505, 202} {
		t.Run(fmt.Sprintf("%d", code), func(t *testing.T) {
			d, logPath := editDeleteDeps(t, statusUpstream(code))
			d.editDelete(httptest.NewRecorder(), editDeleteRequest("/api/edit/dns_zone/obj-123"))
			detail := uaOnly(t, logPath, "edit-dns_zone-delete-error", "the delete got no clear answer")
			if detail["outcome"] != "unknown" {
				t.Fatalf("audit outcome = %v, want unknown", detail["outcome"])
			}
		})
	}
}

func removeNetworkRun(t *testing.T, set func(*fakeTenant)) (string, runs.Object) {
	t.Helper()
	d, f, _ := newDeskDeps(t)
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+networkInput+`,"dry":false}`)
	run := onlyRun(t, d)
	set(f)
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	got := onlyRun(t, d)
	if got.Status != runs.RemoveFailed || len(got.Objects) != 1 {
		t.Fatalf("run = %+v, want one failed object", got)
	}
	return got.Error, got.Objects[0]
}

func TestDeskRemove_SummaryNamesUnknownRefusedAndBlocked(t *testing.T) {
	for _, tc := range []struct {
		name, outcome, want string
		set                 func(*fakeTenant)
	}{
		{"no clear answer", "unknown", "1 item(s) may or may not have been removed",
			func(f *fakeTenant) { f.refuseDelete = true }},
		{"refused", "refused", "1 item(s) were refused by Infoblox",
			func(f *fakeTenant) { f.refuseDelete, f.refuseStatus = true, 403 }},
		{"blocked", "not-sent", "1 item(s) were not removed because the delete was never sent",
			func(f *fakeTenant) { f.inSubnet = []string{"10.9.0.3"} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			summary, obj := removeNetworkRun(t, tc.set)
			if !strings.Contains(summary, tc.want) {
				t.Fatalf("summary = %q, want %q", summary, tc.want)
			}
			if obj.Outcome != tc.outcome {
				t.Fatalf("object outcome = %q, want %q", obj.Outcome, tc.outcome)
			}
		})
	}
}

func TestSubnetStream_CleanupWithNoAnswerIsNotCalledFailed(t *testing.T) {
	own := subnetRow("other", "172.16.128.0", "ipam/ip_space/sp-1")
	for _, tc := range []struct {
		st   int
		want string
	}{
		{500, "may or may not have been removed. Check it in the Editor"},
		{403, "could not be removed"},
	} {
		d, _ := newInventoryDeps(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			q := r.URL.Query()
			switch {
			case r.Method == http.MethodDelete:
				w.WriteHeader(tc.st)
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/nextavailablesubnet"):
				io.WriteString(w, `{"results":[{"id":"ipam/subnet/new-1","address":"172.16.128.0","cidr":24}]}`)
			case strings.HasSuffix(r.URL.Path, "/"+uaBlockID):
				io.WriteString(w, `{"result":{"address":"172.16.128.0","cidr":21,"space":"ipam/ip_space/sp-1"}}`)
			case q.Get("_order_by") != "" && q.Get("_offset") != "0":
				io.WriteString(w, `{"results":[]}`)
			case strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
				io.WriteString(w, `{"results":[`+own+`,{"id":"ipam/subnet/new-1","address":"172.16.128.0","cidr":24,"space":"ipam/ip_space/sp-1"}],"page":{"total_size":"2"}}`)
			default:
				io.WriteString(w, `{"results":[]}`)
			}
		})
		rr := httptest.NewRecorder()
		d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=0"))
		if body := rr.Body.String(); !strings.Contains(body, tc.want) {
			t.Fatalf("status %d: want %q in %s", tc.st, tc.want, body)
		}
	}
}

// A retry whose pre-delete check cannot read the object must not say the
// delete was never sent, because the first one may have landed.
func TestDeskRemove_RetryKeepsAnEarlierUnknown(t *testing.T) {
	for _, tc := range []struct {
		name, outcome, err string
		first              bool // whether the first delete got a 504
		set                func(*fakeTenant)
	}{
		{"unknown then the object cannot be read", "unknown", rest.OutcomeUnknown, true,
			func(f *fakeTenant) { f.readStatus = 503 }},
		{"unknown then the object is read and holds something", "not-sent", "1 address", true,
			func(f *fakeTenant) { f.inSubnet = []string{"10.9.0.3"} }},
		{"unknown then the object is read but its contents are not", "not-sent", "could not check", true,
			func(f *fakeTenant) { f.failAddrList = true }},
		{"nothing in doubt and the object cannot be read", "not-sent", "could not check", false,
			func(f *fakeTenant) { f.readStatus = 503 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, f, _ := newDeskDeps(t)
			deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+networkInput+`,"dry":false}`)
			run := onlyRun(t, d)
			if tc.first {
				f.refuseDelete, f.refuseStatus = true, 504
				deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
			}
			sent := len(f.deletes)
			tc.set(f)
			deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
			got := onlyRun(t, d).Objects[0]
			if got.Outcome != tc.outcome || !strings.Contains(got.Error, tc.err) {
				t.Fatalf("object = %+v, want outcome %q and error with %q", got, tc.outcome, tc.err)
			}
			if len(f.deletes) != sent {
				t.Fatalf("the check stopped the delete before, but %d more were sent", len(f.deletes)-sent)
			}
		})
	}
}

func TestDeskRemove_ZoneRetryKeepsAnEarlierUnknown(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	f.exists["dns/auth_zone/z-1"] = true
	run := runs.Run{ID: "r-zone", Job: "branch", Status: runs.Built, Created: "2026-11-05T00:00:00Z",
		Objects: []runs.Object{{ID: "dns/auth_zone/z-1", Kind: "dns_zone", Label: "z", State: runs.Created}}}
	if err := d.ledger().Add(run); err != nil {
		t.Fatal(err)
	}
	f.refuseDelete, f.refuseStatus = true, 504
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"r-zone","dry":false}`)
	f.readStatus = 503
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"r-zone","dry":false}`)
	if got := onlyRun(t, d).Objects[0]; got.Outcome != "unknown" || got.Error != rest.OutcomeUnknown {
		t.Fatalf("object = %+v, want the earlier unknown kept", got)
	}
}

func TestDeskRemove_AuditRowNamesTheOutcome(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	d.Audit = audit.New(logPath, "app-v-test", "test-instance", audit.Options{TrustDir: t.TempDir()})
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+networkInput+`,"dry":false}`)
	run := onlyRun(t, d)
	f.refuseDelete, f.refuseStatus = true, 504
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	entries := auditEntries(t, logPath, "desk-remove")
	if len(entries) != 1 {
		t.Fatalf("%d desk-remove rows, want 1", len(entries))
	}
	objs, _ := residualAuditDetail(t, entries[0])["objects"].([]any)
	if len(objs) != 1 || objs[0].(map[string]any)["outcome"] != "unknown" {
		t.Fatalf("objects = %v, want the unknown outcome recorded", objs)
	}
}

func TestReserveCreate_NoClearAnswerIsAudited(t *testing.T) {
	for _, st := range []int{500, 501, 505, 202, 204} {
		t.Run(fmt.Sprint(st), func(t *testing.T) {
			base := reserveUpstream(201)
			d, logPath := newDeleteDeps(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/dhcp/fixed_address") {
					w.WriteHeader(st)
					return
				}
				base(w, r)
			})
			rr := httptest.NewRecorder()
			d.body(d.selfserviceAllocate)(rr, reserveRequest())
			if rr.Code < 500 {
				t.Fatalf("answered %d, which a browser reads as success: %s", rr.Code, rr.Body.String())
			}
			if !strings.Contains(rr.Body.String(), "MAY EXIST") {
				t.Fatalf("body = %s", rr.Body.String())
			}
			detail := uaOnly(t, logPath, "selfservice-allocate-record-unreadable", "the reservation may exist")
			if _, claimed := detail["still_reserved"]; claimed {
				t.Fatalf("audit says the address is still reserved, which is not known: %v", detail)
			}
		})
	}
}

func TestRetagRoute_AcceptedPatchIsNotReportedAsChanged(t *testing.T) {
	base := partialRetagUpstream(false)
	var patches atomic.Int32
	d, logPath := newResidualDeps(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PATCH" && patches.Add(1) == 2 {
			w.WriteHeader(202)
			return
		}
		base(w, r)
	})
	rr := httptest.NewRecorder()
	d.retagBlock(rr, retagRequest(""), map[string]any{"template": retagTemplate, "status": "reserved", "dry": "0"})
	if rr.Code < 500 || patches.Load() != 2 {
		t.Fatalf("= %d after %d patches: %s", rr.Code, patches.Load(), rr.Body.String())
	}
	detail := uaOnly(t, logPath, "retag-block", "one block was re-tagged and one is unknown")
	if detail["count"] != float64(1) || detail["unconfirmed"] != float64(1) {
		t.Fatalf("audit detail = %v, want count 1 and unconfirmed 1", detail)
	}
}

func TestTeardownBlockRoute_AcceptedDeleteIsAudited(t *testing.T) {
	base := partialBlockTeardownUpstream()
	d, logPath := newResidualDeps(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		base(w, r)
	})
	d.StateDir = t.TempDir()
	r := httptest.NewRequest("POST", "/api/teardown/block", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	d.teardownBlock(httptest.NewRecorder(), r, map[string]any{
		"template": blocksTeardownTemplate, "dry": "0", "confirm": blocksTeardownTemplate})
	detail := uaOnly(t, logPath, "teardown-block", "both deletes got a 202")
	if detail["unconfirmed"] != float64(2) {
		t.Fatalf("audit detail = %v, want unconfirmed 2", detail)
	}
}

func TestReplaceSharedPick_NoClearAnswerDoesNotSayNothingWasCreated(t *testing.T) {
	for _, tc := range []struct {
		st      int
		nothing bool
	}{{500, false}, {501, false}, {505, false}, {403, true}} {
		d, _ := newInventoryDeps(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			q := r.URL.Query()
			switch {
			case r.Method == http.MethodDelete:
				io.WriteString(w, `{}`)
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/nextavailablesubnet"):
				io.WriteString(w, `{"results":[{"id":"ipam/subnet/new-1","address":"172.16.128.0","cidr":24}]}`)
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
				w.WriteHeader(tc.st)
				io.WriteString(w, `{"error":"answer"}`)
			case strings.HasSuffix(r.URL.Path, "/"+uaBlockID):
				io.WriteString(w, `{"result":{"address":"172.16.128.0","cidr":21,"space":"ipam/ip_space/sp-1"}}`)
			case q.Get("_order_by") != "" && q.Get("_offset") != "0":
				io.WriteString(w, `{"results":[]}`)
			case strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
				io.WriteString(w, `{"results":[`+subnetRow("other", "172.16.128.0", "ipam/ip_space/sp-2")+`],"page":{"total_size":"1"}}`)
			default:
				io.WriteString(w, `{"results":[]}`)
			}
		})
		rr := httptest.NewRecorder()
		d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=0"))
		body := rr.Body.String()
		if strings.Contains(body, "Nothing was created") != tc.nothing {
			t.Fatalf("status %d: %s", tc.st, body)
		}
		if !tc.nothing && !strings.Contains(body, "No clear answer to create the clean subnet 172.16.129.0/24") {
			t.Fatalf("status %d: want the shared wording, got %s", tc.st, body)
		}
	}
}
