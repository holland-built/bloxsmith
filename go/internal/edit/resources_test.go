package edit

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// --- SubnetCreate dry-run preview: success / genuine-empty / failed lookup --

func TestSubnetCreate_DryRun_PreviewSucceeds_NoMarker(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if answerFreecheckReads(w, r) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[{"address":"10.0.5.0","id":"addr-1"}]}`))
	}))
	defer srv.Close()
	c := newTestClient(srv)

	res, status := c.SubnetCreate(M{"block_id": "block-1", "cidr": float64(24), "name": "test-subnet", "dry": true})
	if status != 200 {
		t.Fatalf("status = %d, want 200: %v", status, res)
	}
	would := res["would_create"].(M)
	if would["address"] != "10.0.5.0" {
		t.Fatalf("address = %v, want 10.0.5.0", would["address"])
	}
	if _, present := would["address_preview"]; present {
		t.Fatalf("address_preview = %v, want absent on a successful preview", would["address_preview"])
	}
}

func TestSubnetCreate_DryRun_PreviewGenuinelyEmpty_NoneAvailableMarker(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if answerFreecheckReads(w, r) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[]}`))
	}))
	defer srv.Close()
	c := newTestClient(srv)

	res, status := c.SubnetCreate(M{"block_id": "block-1", "cidr": float64(24), "name": "test-subnet", "dry": true})
	if status != 200 {
		t.Fatalf("status = %d, want 200 (a full block must never abort a dry run): %v", status, res)
	}
	would := res["would_create"].(M)
	if would["address_preview"] != "none-available" {
		t.Fatalf("address_preview = %v, want none-available", would["address_preview"])
	}
	if _, present := would["reason"]; present {
		t.Fatalf("reason = %v, want absent — a genuinely empty block is not a broken lookup", would["reason"])
	}
	if would["address"] != "" {
		t.Fatalf("address = %v, want empty string (legitimate empty)", would["address"])
	}
}

func TestSubnetCreate_DryRun_PreviewLookupFails_UnavailableMarkerNoAbort(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if answerFreecheckReads(w, r) {
			return
		}
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
	}))
	defer srv.Close()
	c := newTestClient(srv)

	res, status := c.SubnetCreate(M{"block_id": "block-1", "cidr": float64(24), "name": "test-subnet", "dry": true})
	if status != 200 {
		t.Fatalf("status = %d, want 200 — a failed preview must never abort the dry run: %v", status, res)
	}
	if res["ok"] != true {
		t.Fatalf("ok = %v, want true", res["ok"])
	}
	would := res["would_create"].(M)
	if would["address_preview"] != "unavailable" {
		t.Fatalf("address_preview = %v, want unavailable", would["address_preview"])
	}
	reason, _ := would["reason"].(string)
	if reason == "" {
		t.Fatalf("reason = %q, want a non-empty operator-safe explanation", reason)
	}
	if addr, _ := would["address"].(string); addr == "" || addr == "10.0.5.0" {
		t.Fatalf("address = %q, want a non-blank, non-fabricated placeholder", addr)
	}
}

// TestSubnetCreate_DryRun_FailedPreviewNeverMatchesSuccess is the regression
// test for the bug being closed: a failed preview lookup used to produce the
// exact same would_create shape (blank address, no marker) that the Editor
// renders as JSON — indistinguishable from a genuinely successful preview or
// a genuine "block is full" result. Failure must now be observably different
// from both.
func TestSubnetCreate_DryRun_FailedPreviewNeverMatchesSuccess(t *testing.T) {
	successSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if answerFreecheckReads(w, r) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[{"address":"10.0.5.0","id":"addr-1"}]}`))
	}))
	defer successSrv.Close()
	failSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if answerFreecheckReads(w, r) {
			return
		}
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
	}))
	defer failSrv.Close()
	emptySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if answerFreecheckReads(w, r) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[]}`))
	}))
	defer emptySrv.Close()

	body := M{"block_id": "block-1", "cidr": float64(24), "name": "test-subnet", "dry": true}

	successRes, _ := newTestClient(successSrv).SubnetCreate(body)
	failRes, _ := newTestClient(failSrv).SubnetCreate(body)
	emptyRes, _ := newTestClient(emptySrv).SubnetCreate(body)

	successWould := successRes["would_create"].(M)
	failWould := failRes["would_create"].(M)
	emptyWould := emptyRes["would_create"].(M)

	if reflect.DeepEqual(failWould, successWould) {
		t.Fatalf("a failed preview produced the exact same would_create as a successful one: %v", failWould)
	}
	if reflect.DeepEqual(failWould, emptyWould) {
		t.Fatalf("a failed preview produced the exact same would_create as a genuine empty result: %v", failWould)
	}
	if reflect.DeepEqual(emptyWould, successWould) {
		t.Fatalf("sanity check failed: genuine-empty and success fixtures must differ: %v", emptyWould)
	}
}

// --- free-address checks on create ---------------------------------------------

// inventoryServer is a tenant holding: block 10.0.0.0/8 in sp-1 (the block
// SubnetCreate reads), a subnet 10.0.5.0/24 in ANOTHER space sp-2, a DHCP
// range 10.1.0.10 to 10.1.0.50 and a reservation 10.1.0.60. Infoblox's
// nextavailablesubnet offers 10.0.5.0, the address sp-2 already uses. Every
// write is recorded; route answers writes.
func inventoryServer(t *testing.T, writes *[]string) *httptest.Server {
	t.Helper()
	inv := map[string]string{
		"ipam/ip_space":      `{"id":"ipam/ip_space/sp-1","name":"corp"},{"id":"ipam/ip_space/sp-2","name":"lab"}`,
		"ipam/address_block": `{"id":"ipam/address_block/block-1","space":"ipam/ip_space/sp-1","address":"10.0.0.0","cidr":8}`,
		"ipam/subnet":        `{"id":"ipam/subnet/theirs","space":"ipam/ip_space/sp-2","address":"10.0.5.0","cidr":24}`,
		"ipam/range":         `{"id":"ipam/range/r-1","space":"ipam/ip_space/sp-1","start":"10.1.0.10","end":"10.1.0.50"}`,
		"dhcp/fixed_address": `{"id":"dhcp/fixed_address/f-1","ip_space":"ipam/ip_space/sp-1","address":"10.1.0.60"}`,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		q := r.URL.Query()
		switch {
		case r.Method == http.MethodGet && q.Get("_order_by") != "":
			rows := inv[strings.TrimPrefix(r.URL.Path, "/api/ddi/v1/")]
			if q.Get("_offset") != "0" {
				rows = ""
			}
			w.Write([]byte(`{"results":[` + rows + `]}`))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/nextavailablesubnet"):
			w.Write([]byte(`{"results":[{"address":"10.0.5.0"}]}`))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/ipam/address_block/block-1"):
			w.Write([]byte(`{"result":{"address":"10.0.0.0","cidr":8,"space":"ipam/ip_space/sp-1"}}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/nextavailablesubnet"):
			*writes = append(*writes, r.Method+" "+r.URL.Path)
			w.WriteHeader(201)
			w.Write([]byte(`{"results":[{"id":"ipam/subnet/new-1","address":"10.0.5.0","cidr":24}]}`))
		case r.Method == http.MethodDelete:
			*writes = append(*writes, r.Method+" "+r.URL.Path)
			w.Write([]byte(`{}`))
		default:
			*writes = append(*writes, r.Method+" "+r.URL.Path)
			w.WriteHeader(201)
			w.Write([]byte(`{"result":{"id":"x"}}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestCreates_RefuseWhatIsAlreadyInUse(t *testing.T) {
	cases := []struct {
		name string
		call func(*Client, bool) (M, int)
		want string
	}{
		{"block over another space's subnet", func(c *Client, dry bool) (M, int) {
			return c.BlockCreate(M{"address": "10.0.4.0", "cidr": 22.0, "space": "ipam/ip_space/sp-1", "dry": dry})
		}, "10.0.4.0/22 is not free: a subnet in lab already uses 10.0.5.0/24"},
		{"range over a reservation", func(c *Client, dry bool) (M, int) {
			return c.RangeCreate(M{"start": "10.1.0.55", "end": "10.1.0.70", "space": "ipam/ip_space/sp-1", "dry": dry})
		}, "10.1.0.55 to 10.1.0.70 is not free: a reservation in corp already uses 10.1.0.60"},
		{"host inside a DHCP range", func(c *Client, dry bool) (M, int) {
			return c.HostCreate(M{"name": "web", "addresses": []any{M{"address": "10.1.0.20", "space": "ipam/ip_space/sp-1"}}, "dry": dry})
		}, "10.1.0.20 is not free: a DHCP range in corp already uses 10.1.0.10 to 10.1.0.50"},
	}
	for _, tc := range cases {
		for _, dry := range []bool{true, false} {
			var writes []string
			res, status := tc.call(newTestClient(inventoryServer(t, &writes)), dry)
			if status != 409 || !strings.Contains(pyStr(res["error"]), tc.want) {
				t.Fatalf("%s dry=%v: = %d %v, want 409 naming %q", tc.name, dry, status, res, tc.want)
			}
			if len(writes) != 0 {
				t.Fatalf("%s dry=%v: wrote %v, want nothing", tc.name, dry, writes)
			}
		}
	}
}

// A block of the same space around a new block is containment, not a clash.
func TestBlockCreate_InsideItsOwnSpaceBlockIsFree(t *testing.T) {
	var writes []string
	res, status := newTestClient(inventoryServer(t, &writes)).BlockCreate(
		M{"address": "10.9.0.0", "cidr": 16.0, "space": "ipam/ip_space/sp-1", "dry": true})
	if status != 200 || res["checked"] == nil {
		t.Fatalf("= %d %v, want a preview with checked counts", status, res)
	}
}

// Infoblox's preview pick is used in another space: the preview offers the
// next free /24 instead and names the one it passed over.
func TestSubnetCreate_DryRunSwapsAPickAnotherSpaceUses(t *testing.T) {
	var writes []string
	res, status := newTestClient(inventoryServer(t, &writes)).SubnetCreate(
		M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": true})
	would, _ := res["would_create"].(M)
	if status != 200 || would["address"] != "10.0.0.0" {
		t.Fatalf("= %d %v, want 10.0.0.0 offered", status, res)
	}
	sk, _ := res["skipped"].([]any)
	if len(sk) == 0 || pyStr(asMap(sk[0])["reason"]) != "a subnet in lab already uses 10.0.5.0/24" {
		t.Fatalf("skipped = %v", res["skipped"])
	}
}

// On the live run Infoblox picks again, and a pick another space uses is
// removed rather than left on the network.
func TestSubnetCreate_LiveRemovesAPickAnotherSpaceUses(t *testing.T) {
	var writes []string
	res, status := newTestClient(inventoryServer(t, &writes)).SubnetCreate(
		M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": false})
	if status != 409 || !strings.Contains(pyStr(res["error"]), "Infoblox picked 10.0.5.0/24, but a subnet in lab already uses 10.0.5.0/24, so it was removed") {
		t.Fatalf("= %d %v, want the pick refused and removed", status, res)
	}
	want := []string{"POST /api/ddi/v1/ipam/address_block/block-1/nextavailablesubnet", "DELETE /api/ddi/v1/ipam/subnet/new-1"}
	if !reflect.DeepEqual(writes, want) {
		t.Fatalf("writes = %v, want %v (no tagging PATCH)", writes, want)
	}
}
