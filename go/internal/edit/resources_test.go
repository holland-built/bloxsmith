package edit

import (
	"io"
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
// write is recorded; route answers writes. ownSubnets adds subnet rows.
func inventoryServer(t *testing.T, writes *[]string, ownSubnets ...string) *httptest.Server {
	t.Helper()
	subnets := `{"id":"ipam/subnet/theirs","space":"ipam/ip_space/sp-2","address":"10.0.5.0","cidr":24}`
	for _, row := range ownSubnets {
		subnets += "," + row
	}
	inv := map[string]string{
		"ipam/ip_space":      `{"id":"ipam/ip_space/sp-1","name":"corp"},{"id":"ipam/ip_space/sp-2","name":"lab"}`,
		"ipam/address_block": `{"id":"ipam/address_block/block-1","space":"ipam/ip_space/sp-1","address":"10.0.0.0","cidr":8}`,
		"ipam/subnet":        subnets,
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
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			b, _ := io.ReadAll(r.Body)
			*writes = append(*writes, r.Method+" "+r.URL.Path+" "+string(b))
			w.WriteHeader(201)
			w.Write([]byte(`{"result":{"id":"ipam/subnet/clean-1"}}`))
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
		{"block over its own space's subnet", func(c *Client, dry bool) (M, int) {
			return c.BlockCreate(M{"address": "10.0.4.0", "cidr": 22.0, "space": "ipam/ip_space/sp-2", "dry": dry})
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

// Overlap only with something in ANOTHER IP space is not a clash: each create
// goes ahead, in the preview and live, and the preview carries the warning.
func TestCreates_AnotherSpaceOnlyIsOfferedWithAWarning(t *testing.T) {
	cases := []struct {
		name   string
		call   func(*Client, bool) (M, int)
		object string
	}{
		{"block over another space's subnet", func(c *Client, dry bool) (M, int) {
			return c.BlockCreate(M{"address": "10.0.4.0", "cidr": 22.0, "space": "ipam/ip_space/sp-1", "dry": dry})
		}, "10.0.5.0/24"},
		{"range over another space's range and reservation", func(c *Client, dry bool) (M, int) {
			return c.RangeCreate(M{"start": "10.1.0.45", "end": "10.1.0.65", "space": "ipam/ip_space/sp-2", "dry": dry})
		}, "10.1.0.10 to 10.1.0.50"},
		{"host inside another space's DHCP range", func(c *Client, dry bool) (M, int) {
			return c.HostCreate(M{"name": "web", "addresses": []any{M{"address": "10.1.0.20", "space": "ipam/ip_space/sp-2"}}, "dry": dry})
		}, "10.1.0.10 to 10.1.0.50"},
	}
	for _, tc := range cases {
		for _, dry := range []bool{true, false} {
			var writes []string
			res, status := tc.call(newTestClient(inventoryServer(t, &writes)), dry)
			if status != 200 && status != 201 {
				t.Fatalf("%s dry=%v: = %d %v, want it to go ahead", tc.name, dry, status, res)
			}
			if !dry {
				if len(writes) != 1 || !strings.HasPrefix(writes[0], "POST ") {
					t.Fatalf("%s: writes = %v, want the create", tc.name, writes)
				}
				continue
			}
			ws, _ := res["warnings"].([]any)
			if len(ws) == 0 || asMap(ws[0])["object"] != tc.object && asMap(ws[len(ws)-1])["object"] != tc.object {
				t.Fatalf("%s: warnings = %v, want %s named", tc.name, res["warnings"], tc.object)
			}
			if asMap(res["checked"])["shared"] != 1 {
				t.Fatalf("%s: checked = %v, want shared 1", tc.name, res["checked"])
			}
		}
	}
}

// Infoblox's preview pick is used in its own space: the preview offers the
// next free /24 instead and names the one it passed over.
func TestSubnetCreate_DryRunSwapsAPickItsOwnSpaceUses(t *testing.T) {
	var writes []string
	res, status := newTestClient(inventoryServer(t, &writes, ownSubnet)).SubnetCreate(
		M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": true})
	would, _ := res["would_create"].(M)
	if status != 200 || would["address"] != "10.0.0.0" {
		t.Fatalf("= %d %v, want 10.0.0.0 offered", status, res)
	}
	sk, _ := res["skipped"].([]any)
	if len(sk) == 0 || pyStr(asMap(sk[0])["reason"]) != "a subnet in corp already uses 10.0.5.0/24" {
		t.Fatalf("skipped = %v", res["skipped"])
	}
}

// ownSubnet is a subnet in the block's own space, on Infoblox's pick.
const ownSubnet = `{"id":"ipam/subnet/ours","space":"ipam/ip_space/sp-1","address":"10.0.5.0","cidr":24}`

// Infoblox's preview pick is used only in another space, and 10.0.0.0/24 is
// clean: the clean one is offered (the owner's rule: a warned one only when
// none is clean), and Infoblox's pick is listed as passed over.
func TestSubnetCreate_DryRunOffersACleanOneOverInfobloxsWarnedPick(t *testing.T) {
	var writes []string
	res, status := newTestClient(inventoryServer(t, &writes)).SubnetCreate(
		M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": true})
	would, _ := res["would_create"].(M)
	ws, _ := res["warnings"].([]any)
	if status != 200 || would["address"] != "10.0.0.0" || len(ws) != 0 {
		t.Fatalf("= %d %v, want the clean 10.0.0.0 offered", status, res)
	}
	sk, _ := res["skipped"].([]any)
	if len(sk) == 0 || asMap(sk[0])["candidate"] != "10.0.5.0/24" ||
		!strings.HasPrefix(pyStr(asMap(sk[0])["reason"]), "it is also used in IP space lab") {
		t.Fatalf("skipped = %v, want Infoblox's shared pick named", res["skipped"])
	}
}

// labEverywhere is a network in another space over the whole block: no /24 in
// it is clean.
const labEverywhere = `{"id":"ipam/subnet/lab8","space":"ipam/ip_space/sp-2","address":"10.0.0.0","cidr":8}`

// With no clean one anywhere, Infoblox's warned pick stands, with its warnings.
func TestSubnetCreate_DryRunKeepsInfobloxsWarnedPickWhenNoneIsClean(t *testing.T) {
	var writes []string
	res, status := newTestClient(inventoryServer(t, &writes, labEverywhere)).SubnetCreate(
		M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": true})
	would, _ := res["would_create"].(M)
	ws, _ := res["warnings"].([]any)
	if status != 200 || would["address"] != "10.0.5.0" || len(ws) == 0 || asMap(ws[0])["space"] != "lab" {
		t.Fatalf("= %d %v, want 10.0.5.0 offered with lab's warning", status, res)
	}
}

// On the live run Infoblox picks again, and a pick its own space uses is
// removed rather than left on the network.
func TestSubnetCreate_LiveRemovesAPickItsOwnSpaceUses(t *testing.T) {
	var writes []string
	res, status := newTestClient(inventoryServer(t, &writes, ownSubnet)).SubnetCreate(
		M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": false})
	if status != 409 || !strings.Contains(pyStr(res["error"]), "Infoblox picked 10.0.5.0/24, but a subnet in corp already uses 10.0.5.0/24, so it was removed") {
		t.Fatalf("= %d %v, want the pick refused and removed", status, res)
	}
	want := []string{"POST /api/ddi/v1/ipam/address_block/block-1/nextavailablesubnet", "DELETE /api/ddi/v1/ipam/subnet/new-1"}
	if !reflect.DeepEqual(writes, want) {
		t.Fatalf("writes = %v, want %v (no tagging PATCH)", writes, want)
	}
}

// Live: Infoblox's pick is shared with another space and a clean one exists.
// The shared pick is removed and the clean one the preview offered is created
// by its address, then tagged.
func TestSubnetCreate_LiveReplacesAWarnedPickWithTheCleanOne(t *testing.T) {
	var writes []string
	res, status := newTestClient(inventoryServer(t, &writes)).SubnetCreate(
		M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": false})
	if status != 200 || res["ok"] != true {
		t.Fatalf("= %d %v, want the clean subnet made", status, res)
	}
	want := []string{"POST /api/ddi/v1/ipam/address_block/block-1/nextavailablesubnet",
		"DELETE /api/ddi/v1/ipam/subnet/new-1",
		`POST /api/ddi/v1/ipam/subnet {"address":"10.0.0.0","cidr":24,"space":"ipam/ip_space/sp-1"}`,
		"PATCH /api/ddi/v1/ipam/subnet/clean-1"}
	if !reflect.DeepEqual(writes, want) {
		t.Fatalf("writes = %v, want %v", writes, want)
	}
}

// Live: with no clean one anywhere, Infoblox's shared pick is kept.
func TestSubnetCreate_LiveKeepsAWarnedPickWhenNoneIsClean(t *testing.T) {
	var writes []string
	res, status := newTestClient(inventoryServer(t, &writes, labEverywhere)).SubnetCreate(
		M{"block_id": "ipam/address_block/block-1", "cidr": 24.0, "dry": false})
	if status != 200 && status != 201 || res["ok"] != true {
		t.Fatalf("= %d %v, want the pick kept", status, res)
	}
	for _, w := range writes {
		if strings.HasPrefix(w, "DELETE") {
			t.Fatalf("writes = %v, want no DELETE", writes)
		}
	}
}
