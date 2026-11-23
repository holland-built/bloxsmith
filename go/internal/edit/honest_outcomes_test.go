package edit

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// A DNS record write with no clear answer may have landed, so the addresses it
// points at stay reserved and the result says the record may exist.
func TestAllocateDNS_NoClearAnswerKeepsTheAddress(t *testing.T) {
	for _, st := range []int{500, 501, 505, 202, 204} {
		f := newAllocFake(t, allocConfig{dnsStatus: st, dnsBody: `{"error":"no clear answer"}`})
		res, status := f.client().SelfserviceAllocate(M{
			"subnet_id": "s-42", "count": float64(2), "dry": false,
			"dns": M{"zone_id": "z-1", "name": "web"},
		})
		if dels := f.byMethod(http.MethodDelete); len(dels) != 0 {
			t.Fatalf("status %d: %d address(es) released, want none", st, len(dels))
		}
		if res[CreatedUnreadableKey] != true || resultOK(res) || has(res, "released") {
			t.Fatalf("status %d: want a may-exist result, got %v", st, res)
		}
		if msg := pyStr(res["error"]); !strings.Contains(msg, "MAY EXIST") {
			t.Fatalf("status %d: error = %q", st, msg)
		}
		if status < 500 {
			t.Fatalf("status %d: returned %d, which a browser reads as success", st, status)
		}
	}
}

func TestAllocateDNS_ClearRefusalStillReleasesTheAddress(t *testing.T) {
	for _, st := range []int{400, 401, 403, 404, 409} {
		f := newAllocFake(t, allocConfig{dnsStatus: st, dnsBody: `{"error":"refused"}`})
		res, status := f.client().SelfserviceAllocate(M{
			"subnet_id": "s-42", "count": float64(2), "dry": false,
			"dns": M{"zone_id": "z-1", "name": "web"},
		})
		if dels := f.byMethod(http.MethodDelete); len(dels) != 2 {
			t.Fatalf("status %d: %d address(es) released, want 2", st, len(dels))
		}
		if status != 502 || res["ok"] != false || res[CreatedUnreadableKey] == true {
			t.Fatalf("status %d: = %d %v", st, status, res)
		}
	}
}

func TestReserveDNS_NoClearAnswerSaysTheRecordMayExist(t *testing.T) {
	for _, st := range []int{500, 202, 204} {
		f := newResvFake(t, resvConfig{dnsStatus: st})
		res, status := f.client().SelfserviceAllocate(M{"subnet_id": resvSubnet, "dry": false,
			"dhcp": M{"mac": "aa:bb:cc:dd:ee:01"}, "dns": M{"zone_id": "dns/auth_zone/z-1", "name": "printer-3"}})
		if res[CreatedUnreadableKey] != true || has(res, "ok") || status < 500 {
			t.Fatalf("status %d: want a may-exist result, got %d %v", st, status, res)
		}
		if msg := pyStr(res["error"]); !strings.Contains(msg, "MAY EXIST") || strings.Contains(msg, "add the record") {
			t.Fatalf("status %d: error = %q", st, msg)
		}
	}
}

// Infoblox hands out an address something else uses, and the release that
// follows gets no clear answer.
func TestAllocateClash_ReleaseWithNoAnswerIsNotCalledFailed(t *testing.T) {
	inv := map[string]string{"dhcp/fixed_address": `{"id":"dhcp/fixed_address/f","ip_space":"","address":"10.7.0.4"}`}
	for _, tc := range []struct {
		st   int
		want string
	}{
		{500, "may or may not have been released"},
		{202, "may or may not have been released"},
		{403, "could not be released"},
	} {
		f := newAllocFake(t, allocConfig{inventory: inv, deleteStatuses: []int{tc.st, tc.st}})
		res, _ := f.client().SelfserviceAllocate(M{"subnet_id": "s-42", "count": float64(2), "dry": false})
		msg := pyStr(res["error"])
		if !strings.Contains(msg, tc.want) || !strings.Contains(msg, "Editor") {
			t.Fatalf("status %d: error = %q, want %q", tc.st, msg, tc.want)
		}
	}
}

func TestReleaseNote_NamesEachKindOfResult(t *testing.T) {
	for _, tc := range []struct {
		left, unclear int
		want          string
	}{
		{2, 0, "2 address(es) could not be released; remove them in the Editor"},
		{2, 2, "2 address(es) may or may not have been released. Check them in the Editor"},
		{3, 1, "2 address(es) could not be released and 1 may or may not have been released. Check them in the Editor"},
	} {
		if got := releaseNote(tc.left, tc.unclear); got != tc.want {
			t.Fatalf("releaseNote(%d, %d) = %q, want %q", tc.left, tc.unclear, got, tc.want)
		}
	}
}

// deleteAnswerServer puts a fixed answer to the Nth DELETE in front of the
// inventory fake. after, when set, replaces the subnet list once the clean
// subnet has been created, so the fresh check after it finds a clash.
func deleteAnswerServer(t *testing.T, inner *httptest.Server, answerDelete, status int, after string) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	deletes, created := 0, false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == http.MethodDelete {
			deletes++
			if deletes == answerDelete {
				w.WriteHeader(status)
				return
			}
		}
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/ipam/subnet") {
			created = true
		}
		if created && after != "" && r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/ipam/subnet") {
			w.Header().Set("Content-Type", "application/json")
			rows := after
			if r.URL.Query().Get("_offset") != "0" && r.URL.Query().Get("_order_by") != "" {
				rows = ""
			}
			w.Write([]byte(`{"results":[` + rows + `]}`))
			return
		}
		inner.Config.Handler.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSubnetCreate_CleanupWithNoAnswerIsNotCalledFailed(t *testing.T) {
	for _, tc := range []struct {
		st   int
		want string
	}{
		{500, "may or may not have been removed. Check it in the Editor"},
		{202, "may or may not have been removed. Check it in the Editor"},
		{403, "could not be removed"},
	} {
		var writes []string
		srv := deleteAnswerServer(t, inventoryServer(t, &writes, ownSubnet), 1, tc.st, "")
		res, _ := newTestClient(srv).SubnetCreate(M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": false})
		if msg := pyStr(res["error"]); !strings.Contains(msg, tc.want) {
			t.Fatalf("status %d: error = %q, want %q", tc.st, msg, tc.want)
		}
	}
}

func TestSubnetReplace_CleanupWithNoAnswerIsNotCalledFailed(t *testing.T) {
	clash := `{"id":"ipam/subnet/late","space":"ipam/ip_space/sp-1","address":"10.0.0.0","cidr":25}`
	for _, tc := range []struct {
		st   int
		want string
	}{
		{500, "may or may not have been removed. Check it in the Editor"},
		{403, "could not be removed"},
	} {
		var writes []string
		srv := deleteAnswerServer(t, inventoryServer(t, &writes), 2, tc.st, clash)
		res, _ := newTestClient(srv).SubnetCreate(M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": false})
		if msg := pyStr(res["error"]); !strings.Contains(msg, tc.want) {
			t.Fatalf("status %d: error = %q, want %q", tc.st, msg, tc.want)
		}
	}
}

func TestDelete_AnOddSuccessStatusIsUnknownNotFailed(t *testing.T) {
	f := dispatchStatic(t, 202, `{}`)
	res, _ := f.client().Delete("/api/ddi/v1/dns/record/r-1")
	if resultOK(res) || !strings.Contains(pyStr(res["error"]), "may or may not") {
		t.Fatalf("202 on a delete = %v, want an unknown result", res)
	}
}
