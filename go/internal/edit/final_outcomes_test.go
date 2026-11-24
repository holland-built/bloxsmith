package edit

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

func answerFirst(t *testing.T, inner *httptest.Server, method, suffix string, st int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == method && strings.HasSuffix(r.URL.Path, suffix) {
			w.WriteHeader(st)
			io.WriteString(w, body)
			return
		}
		inner.Config.Handler.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSubnetReplace_UnknownDeleteOfThePickStops(t *testing.T) {
	for _, st := range []int{500, 503, 202} {
		var writes []string
		srv := deleteAnswerServer(t, inventoryServer(t, &writes), 1, st, "")
		res, status := newTestClient(srv).SubnetCreate(M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": false})
		if resultOK(res) || status < 500 || !strings.Contains(pyStr(res["error"]), "may or may not have been removed") {
			t.Fatalf("status %d: = %d %v", st, status, res)
		}
		for _, w := range writes {
			if strings.HasPrefix(w, "POST") && strings.HasSuffix(strings.Fields(w)[1], "/ipam/subnet") {
				t.Fatalf("status %d: the clean subnet was created anyway: %v", st, writes)
			}
		}
	}
	var writes []string
	srv := deleteAnswerServer(t, inventoryServer(t, &writes), 1, 403, "")
	if res, _ := newTestClient(srv).SubnetCreate(M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": false}); !resultOK(res) {
		t.Fatalf("403 must leave the shared pick standing: %v", res)
	}
}

func TestSubnetTagging_AcceptedPatchIsUnknown(t *testing.T) {
	var writes []string
	srv := answerFirst(t, inventoryServer(t, &writes), http.MethodPatch, "/clean-1", 202, `{}`)
	res, status := newTestClient(srv).SubnetCreate(M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": false})
	if !strings.Contains(pyStr(res["error"]), "may or may not") || status < 500 {
		t.Fatalf("= %d %v", status, res)
	}
}

func TestAllocateName_UnknownIsNotCalledFailed(t *testing.T) {
	for _, tc := range []struct {
		st   int
		want string
	}{{500, "may or may not"}, {202, "may or may not"}, {403, "could not be set"}} {
		f := newAllocFake(t, allocConfig{nameStatus: tc.st})
		res, _ := f.client().SelfserviceAllocate(M{"subnet_id": "s-42", "count": float64(1), "dry": false, "name": "printer"})
		if !strings.Contains(pyStr(res["warning"]), tc.want) {
			t.Fatalf("status %d: warning = %v", tc.st, res["warning"])
		}
	}
}

func TestAllocate_EmptyAnswerIsUnknown(t *testing.T) {
	for _, body := range []string{`{"results":[]}`, `{}`} {
		f := newAllocFake(t, allocConfig{allocBody: body})
		res, status := f.client().SelfserviceAllocate(M{"subnet_id": "s-42", "count": float64(1), "dry": false})
		if resultOK(res) || status < 500 || !strings.Contains(pyStr(res["error"]), "may or may not") {
			t.Fatalf("%s: = %d %v", body, status, res)
		}
	}
}

func TestSubnetCreate_EmptyAnswerIsUnknown(t *testing.T) {
	for _, body := range []string{`{"results":[]}`, `{}`} {
		var writes []string
		srv := answerFirst(t, inventoryServer(t, &writes), http.MethodPost, "/nextavailablesubnet", 200, body)
		res, status := newTestClient(srv).SubnetCreate(M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": false})
		msg := pyStr(res["error"])
		if !strings.Contains(msg, "MAY EXIST") || strings.Contains(msg, "no free") || status < 500 {
			t.Fatalf("%s: = %d %v", body, status, res)
		}
	}
}

func TestCloudHold_OnlyAClearRefusalSaysRefused(t *testing.T) {
	made := netip.MustParsePrefix("10.0.0.0/24")
	for _, tc := range []struct {
		st      int
		refused bool
	}{{500, false}, {503, false}, {202, false}, {403, true}, {409, true}} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.st) }))
		t.Cleanup(srv.Close)
		_, notHeld := newTestClient(srv).holdCloudAddresses("aws", made, "ipam/ip_space/sp-1")
		if len(notHeld) == 0 {
			t.Fatalf("status %d: nothing listed", tc.st)
		}
		reason := pyStr(asMap(notHeld[0])["reason"])
		if strings.Contains(reason, "refused") != tc.refused {
			t.Fatalf("status %d: reason = %q", tc.st, reason)
		}
	}
}

func TestAllocate_EmptyAnswerIsMarkedUnknown(t *testing.T) {
	f := newAllocFake(t, allocConfig{allocBody: `{"results":[]}`})
	res, _ := f.client().SelfserviceAllocate(M{"subnet_id": "s-42", "count": float64(1), "dry": false})
	if res["outcome"] != "unknown" {
		t.Fatalf("result = %v", res)
	}
}

func TestSubnetReplace_UnknownDeleteKeepsTheID(t *testing.T) {
	var writes []string
	srv := deleteAnswerServer(t, inventoryServer(t, &writes), 1, 503, "")
	res, _ := newTestClient(srv).SubnetCreate(M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": false})
	if res["id"] != "ipam/subnet/new-1" || res["pick_unknown"] != true || res["address"] != "10.0.5.0/24" {
		t.Fatalf("result = %v", res)
	}
}

// The first tag write got no answer and the retry was refused: the first may
// have landed, so the result stays unknown, and so does the hold's reason.
func TestSubnetTagging_RefusedRetryAfterUnknownStaysUnknown(t *testing.T) {
	for _, second := range []int{403, 409} {
		var writes []string
		inner := inventoryServer(t, &writes)
		patches := 0
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPatch {
				patches++
				w.WriteHeader(map[int]int{1: 504, 2: second}[patches])
				return
			}
			inner.Config.Handler.ServeHTTP(w, r)
		}))
		t.Cleanup(srv.Close)
		res, status := newTestClient(srv).SubnetCreate(M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": false, "cloud": "aws"})
		if msg := pyStr(res["error"]); !strings.Contains(msg, "may or may not") || strings.Contains(msg, "tagging failed") || status < 500 || patches != 2 {
			t.Fatalf("second %d: = %d %v (%d patches)", second, status, res, patches)
		}
		held, _ := res["not_held"].([]any)
		if len(held) == 0 || strings.Contains(pyStr(asMap(held[0])["reason"]), "failed") {
			t.Fatalf("second %d: not_held = %v", second, res["not_held"])
		}
	}
}
