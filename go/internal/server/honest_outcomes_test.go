package server

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
