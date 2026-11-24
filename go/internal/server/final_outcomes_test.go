package server

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"bloxsmith/internal/edit"
	"bloxsmith/internal/runs"
)

// subnetStreamUpstream is a block with one free /24. answer may take over any
// write; shared makes the pick also used in another IP space.
func subnetStreamUpstream(shared bool, answer func(w http.ResponseWriter, r *http.Request) bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if answer(w, r) {
			return
		}
		q := r.URL.Query()
		switch {
		case r.Method == http.MethodDelete:
			io.WriteString(w, `{}`)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/nextavailablesubnet"):
			io.WriteString(w, `{"results":[{"id":"ipam/subnet/new-1","address":"172.16.128.0","cidr":24}]}`)
		case r.Method == http.MethodPost:
			io.WriteString(w, `{"result":{"id":"x/made"}}`)
		case strings.HasSuffix(r.URL.Path, "/"+uaBlockID):
			io.WriteString(w, `{"result":{"address":"172.16.128.0","cidr":21,"space":"ipam/ip_space/sp-1"}}`)
		case q.Get("_order_by") != "" && q.Get("_offset") != "0":
			io.WriteString(w, `{"results":[]}`)
		case shared && strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			io.WriteString(w, `{"results":[`+subnetRow("other", "172.16.128.0", "ipam/ip_space/sp-2")+`],"page":{"total_size":"1"}}`)
		default:
			io.WriteString(w, `{"results":[]}`)
		}
	}
}

func TestSubnetStream_UnknownAllocationIsNotCalledRefused(t *testing.T) {
	for _, tc := range []struct {
		st   int
		body string
	}{
		{500, `{}`}, {503, ``},
		{202, `{"results":[{"id":"ipam/subnet/new-1","address":"172.16.128.0","cidr":24}]}`},
		{200, `{"results":[]}`}, {200, `{}`},
	} {
		d, logPath := newInventoryDeps(t, subnetStreamUpstream(false, func(w http.ResponseWriter, r *http.Request) bool {
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/nextavailablesubnet") {
				w.WriteHeader(tc.st)
				io.WriteString(w, tc.body)
				return true
			}
			return false
		}))
		rr := httptest.NewRecorder()
		d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=0"))
		body := rr.Body.String()
		if !strings.Contains(body, "may or may not") || strings.Contains(body, "nothing was created") ||
			strings.Contains(body, "could not be sent") || strings.Contains(body, `"done":true`) {
			t.Fatalf("status %d %s: %s", tc.st, tc.body, body)
		}
		if detail := uaOnly(t, logPath, "provision-subnet-error", "the allocation is unknown"); detail["outcome"] != "unknown" {
			t.Fatalf("status %d: audit = %v", tc.st, detail)
		}
	}
}

func TestSubnetStream_RefusedAllocationStaysRefused(t *testing.T) {
	d, _ := newInventoryDeps(t, subnetStreamUpstream(false, func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == http.MethodPost {
			w.WriteHeader(403)
			return true
		}
		return false
	}))
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=0"))
	if !strings.Contains(rr.Body.String(), "refused") {
		t.Fatalf("403: %s", rr.Body.String())
	}
}

func TestSubnetStream_UnknownZoneCreateIsNotCalledFailed(t *testing.T) {
	for _, st := range []int{500, 503, 202} {
		d, logPath := newInventoryDeps(t, subnetStreamUpstream(false, func(w http.ResponseWriter, r *http.Request) bool {
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/dns/auth_zone") {
				w.WriteHeader(st)
				io.WriteString(w, `{}`)
				return true
			}
			return false
		}))
		rr := httptest.NewRecorder()
		d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=0&make_zone=1"))
		body := rr.Body.String()
		if !strings.Contains(body, "may or may not") || strings.Contains(body, "refused") || strings.Contains(body, `"done":true`) {
			t.Fatalf("status %d: %s", st, body)
		}
		if detail := uaOnly(t, logPath, "provision-subnet-error", "the zone is unknown"); detail["outcome"] != "unknown" {
			t.Fatalf("status %d: audit = %v", st, detail)
		}
	}
}

func TestReplaceSharedPick_AcceptedCleanCreateIsUnknown(t *testing.T) {
	d, _ := newInventoryDeps(t, subnetStreamUpstream(true, func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/ipam/subnet") {
			w.WriteHeader(202)
			io.WriteString(w, `{"result":{"id":"ipam/subnet/clean-1"}}`)
			return true
		}
		return false
	}))
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=0"))
	if body := rr.Body.String(); !strings.Contains(body, "may have been created") || strings.Contains(body, `"done":true`) {
		t.Fatalf("202: %s", body)
	}
}

func TestReplaceSharedPick_UnknownDeleteStops(t *testing.T) {
	for _, st := range []int{500, 503, 202} {
		var cleanPosts atomic.Int32
		d, logPath := newInventoryDeps(t, subnetStreamUpstream(true, func(w http.ResponseWriter, r *http.Request) bool {
			if r.Method == http.MethodDelete {
				w.WriteHeader(st)
				return true
			}
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/ipam/subnet") {
				cleanPosts.Add(1)
			}
			return false
		}))
		rr := httptest.NewRecorder()
		d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=0"))
		body := rr.Body.String()
		if strings.Contains(body, `"done":true`) || !strings.Contains(body, "may or may not have been removed") || cleanPosts.Load() != 0 {
			t.Fatalf("status %d (%d creates): %s", st, cleanPosts.Load(), body)
		}
		if detail := uaOnly(t, logPath, "provision-subnet", "the pick may still be there"); detail["outcome"] != "unknown" {
			t.Fatalf("status %d: audit = %v", st, detail)
		}
	}
	d, _ := newInventoryDeps(t, subnetStreamUpstream(true, func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == http.MethodDelete {
			w.WriteHeader(403)
			return true
		}
		return false
	}))
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=0"))
	if !strings.Contains(rr.Body.String(), `"done":true`) {
		t.Fatalf("a refused delete must leave the shared pick standing: %s", rr.Body.String())
	}
}

func TestRetagRoute_EarlierUnconfirmedSurvivesARefusal(t *testing.T) {
	base := partialRetagUpstream(false)
	var patches atomic.Int32
	d, logPath := newResidualDeps(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PATCH" {
			w.WriteHeader(map[int32]int{1: 202, 2: 403}[patches.Add(1)])
			return
		}
		base(w, r)
	})
	rr := httptest.NewRecorder()
	d.retagBlock(rr, retagRequest(""), map[string]any{"template": retagTemplate, "status": "reserved", "dry": "0"})
	if body := rr.Body.String(); !strings.Contains(body, `"unconfirmed"`) || !strings.Contains(body, "10.1.0.0") ||
		!strings.Contains(body, "may or may not") {
		t.Fatalf("= %d %s", rr.Code, body)
	}
	if detail := uaOnly(t, logPath, "retag-block-error", "block A is unknown, block B refused"); detail["unconfirmed"] != float64(1) {
		t.Fatalf("audit = %v", detail)
	}
}

func TestSeedTeardown_AcceptedDeleteIsNotAuditedAsSucceeded(t *testing.T) {
	d, logPath := newResidualDeps(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		teardownSuccessUpstream(w, r)
	})
	d.StateDir = t.TempDir()
	rr := httptest.NewRecorder()
	d.teardownSeedDemoStream(rr, teardownSeedStreamRequest("regions=amer&dry=0&confirm=DELETE"))
	terminal := terminalFrameOf(t, parseSSEFrames(t, rr.Body.String()))
	if terminal["succeeded"] != float64(2) || terminal["unconfirmed"] != float64(1) || terminal["total"] != float64(3) {
		t.Fatalf("terminal = %v, want 2 succeeded and 1 unconfirmed of 3", terminal)
	}
	if note, _ := terminal["unconfirmed_note"].(string); !strings.Contains(note, "may or may not") {
		t.Fatalf("note = %q", note)
	}
	detail := residualAuditDetail(t, auditEntries(t, logPath, "teardown-seed-demo")[0])
	if detail["succeeded"] != float64(2) || detail["unconfirmed"] != float64(1) {
		t.Fatalf("audit = %v", detail)
	}
}

// One site whose zone delete gets a 202 and whose subnet delete is refused.
func TestSiteTeardownError_KeepsUnconfirmedDeletes(t *testing.T) {
	d, logPath := newResidualDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "DELETE" && strings.Contains(r.URL.Path, "auth_zone"):
			w.WriteHeader(202)
		case r.Method == "DELETE":
			w.WriteHeader(403)
		case strings.HasSuffix(r.URL.Path, "/dns/auth_zone") && !strings.Contains(r.URL.Query().Get("_filter"), "in-addr"):
			fmt.Fprint(w, `{"results":[{"id":"dns/auth_zone/z1","fqdn":"site.example.com."}]}`)
		case strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			fmt.Fprint(w, `{"results":[{"id":"ipam/subnet/s1","address":"10.1.0.0","cidr":24}]}`)
		default:
			teardownSuccessUpstream(w, r)
		}
	})
	d.StateDir = t.TempDir()
	d.teardownSeedDemoStream(httptest.NewRecorder(), teardownSeedStreamRequest("regions=amer&dry=0&confirm=DELETE"))
	entries := auditEntries(t, logPath, "teardown-site-error")
	if len(entries) == 0 {
		t.Fatal("no teardown-site-error row")
	}
	if detail := residualAuditDetail(t, entries[0]); detail["unconfirmed"] != float64(1) {
		t.Fatalf("audit = %v", detail)
	}
}

func TestDeskRemove_RefusedRetryAfterUnknownStaysUnknown(t *testing.T) {
	d, f, _ := newDeskDeps(t)
	deskPost(t, d, d.deskRun, "/api/desk/run", `{"job":"network","input":`+networkInput+`,"dry":false}`)
	run := onlyRun(t, d)
	f.refuseDelete, f.refuseStatus = true, 504
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	f.refuseStatus = 403
	deskPost(t, d, d.deskRemove, "/api/desk/remove", `{"run":"`+run.ID+`","dry":false}`)
	got := onlyRun(t, d)
	if o := got.Objects[0]; o.State != runs.Error || o.Outcome != outcomeUnknown || !strings.Contains(o.Error, "may or may not") {
		t.Fatalf("object = %+v", o)
	}
	if strings.Contains(got.Error, "not removed") {
		t.Fatalf("summary = %q", got.Error)
	}
}

func TestAllocateRoute_EmptyAnswerIsAuditedAsUnknown(t *testing.T) {
	for _, body := range []string{`{"results":[]}`, `{}`} {
		d, logPath := newDeleteDeps(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if r.Method == http.MethodPost {
				io.WriteString(w, body)
				return
			}
			io.WriteString(w, `{"results":[]}`)
		})
		r := httptest.NewRequest("POST", "/api/selfservice/allocate", nil)
		r.RemoteAddr = "127.0.0.1:12345"
		rr := httptest.NewRecorder()
		d.selfserviceAllocate(rr, r, map[string]any{"subnet_id": "s-42", "count": float64(1), "dry": false})
		if rr.Code < 500 {
			t.Fatalf("%s: = %d %s", body, rr.Code, rr.Body.String())
		}
		detail := uaOnly(t, logPath, "selfservice-allocate", "the allocation may have landed")
		if _, claimed := detail["still_reserved"]; claimed || detail["outcome"] != "unknown" {
			t.Fatalf("%s: audit = %v", body, detail)
		}
	}
}

func TestEditCreate_UnknownPickDeleteKeepsItsID(t *testing.T) {
	d, logPath := newInventoryDeps(t, subnetStreamUpstream(true, func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == http.MethodDelete {
			w.WriteHeader(503)
			return true
		}
		return false
	}))
	d.StateDir = t.TempDir()
	d.Edit = edit.New(d.Rest)
	rr := httptest.NewRecorder()
	d.editCreate(rr, editRequest("POST", "/api/edit/subnet"), map[string]any{"block_id": uaBlockID, "cidr": float64(24), "dry": false})
	if !strings.Contains(rr.Body.String(), "may or may not have been removed") {
		t.Fatalf("= %d %s", rr.Code, rr.Body.String())
	}
	detail := uaOnly(t, logPath, "edit-subnet-create-unreadable", "the pick may still be there")
	if detail["id"] != "ipam/subnet/new-1" || detail["outcome"] != "unknown" {
		t.Fatalf("audit = %v", detail)
	}
	o := onlyRun(t, d).Objects[0]
	if o.ID != "ipam/subnet/new-1" || o.State != runs.Error || o.Outcome != outcomeUnknown {
		t.Fatalf("object = %+v", o)
	}
}

func TestSubnetObjects_UnknownPickDeleteCanBeRemoved(t *testing.T) {
	objs, note := subnetObjects(map[string]any{"created_unreadable": true, "pick_unknown": true,
		"id": "ipam/subnet/new-1", "address": "10.0.5.0/24", "error": "may or may not"}, map[string]any{"name": "lab"})
	if len(objs) != 1 || objs[0].ID != "ipam/subnet/new-1" || objs[0].State != runs.Error ||
		objs[0].Outcome != outcomeUnknown || objs[0].Label != "10.0.5.0/24, lab" {
		t.Fatalf("objects = %+v", objs)
	}
	if strings.Contains(note, "did not say which") {
		t.Fatalf("note = %q", note)
	}
}

func TestSubnetStream_UnusableZoneReplyIsUnknown(t *testing.T) {
	for _, st := range []int{200, 201} {
		for _, reply := range []string{`{"result":null}`, `[]`, `"ok"`} {
			d, logPath := newInventoryDeps(t, subnetStreamUpstream(false, func(w http.ResponseWriter, r *http.Request) bool {
				if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/dns/auth_zone") {
					w.WriteHeader(st)
					io.WriteString(w, reply)
					return true
				}
				return false
			}))
			rr := httptest.NewRecorder()
			d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=0&make_zone=1"))
			if body := rr.Body.String(); !strings.Contains(body, "may or may not") || strings.Contains(body, `"done":true`) {
				t.Fatalf("%d %s: %s", st, reply, body)
			}
			if detail := uaOnly(t, logPath, "provision-subnet-error", "the zone is unknown"); detail["outcome"] != "unknown" {
				t.Fatalf("%d %s: audit = %v", st, reply, detail)
			}
		}
	}
}

func TestSeedTeardown_UnconfirmedRowIsNotAnError(t *testing.T) {
	d, _ := newResidualDeps(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		teardownSuccessUpstream(w, r)
	})
	d.StateDir = t.TempDir()
	rr := httptest.NewRecorder()
	d.teardownSeedDemoStream(rr, teardownSeedStreamRequest("regions=amer&dry=0&confirm=DELETE"))
	seen := false
	for _, f := range parseSSEFrames(t, rr.Body.String()) {
		if f["phase"] == "unconfirmed" {
			seen = true
			if _, isErr := f["error"]; isErr || !strings.Contains(anyStr(f["step"]), "may or may not") {
				t.Fatalf("frame = %v", f)
			}
		}
	}
	if !seen {
		t.Fatal("no unconfirmed frame")
	}
}
