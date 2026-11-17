package server

import (
	"bloxsmith/internal/cache"
	"bloxsmith/internal/freecheck"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"testing"
)

func TestFirstFreePrefix(t *testing.T) {
	p := netip.MustParsePrefix
	cases := []struct {
		name  string
		block string
		used  []string
		bits  int
		want  string // "" = none free
	}{
		{"empty block", "172.16.128.0/21", nil, 24, "172.16.128.0/24"},
		{"skips used, keeps order", "172.16.128.0/21", []string{"172.16.129.0/24", "172.16.128.0/24"}, 24, "172.16.130.0/24"},
		{"aligns past a small subnet", "10.0.0.0/16", []string{"10.0.0.0/26"}, 24, "10.0.1.0/24"},
		{"fills a gap", "10.0.0.0/16", []string{"10.0.0.0/24", "10.0.2.0/24"}, 24, "10.0.1.0/24"},
		{"child block covers a range", "10.0.0.0/16", []string{"10.0.0.0/20"}, 24, "10.0.16.0/24"},
		{"full", "10.0.0.0/23", []string{"10.0.0.0/24", "10.0.1.0/24"}, 24, ""},
		{"bigger than the block", "10.0.0.0/24", nil, 16, ""},
		{"ipv6", "fd00::/8", []string{"fd00::/64"}, 64, "fd00:0:0:1::/64"},
	}
	for _, tc := range cases {
		var used []netip.Prefix
		for _, u := range tc.used {
			used = append(used, p(u))
		}
		got, ok := firstFreePrefix(p(tc.block), used, tc.bits)
		if tc.want == "" {
			if ok {
				t.Errorf("%s: got %s, want none free", tc.name, got)
			}
			continue
		}
		if !ok || got.String() != tc.want {
			t.Errorf("%s: got %s (%v), want %s", tc.name, got, ok, tc.want)
		}
	}
}

// previewBlockUpstream answers the preview's reads for a /21 in space sp-1:
// the block itself, then every list freecheck reads. subnets is the whole
// subnet list's answer; a _filter on parent is honoured, as Infoblox would, so
// a preview that reads only the block's own children sees only those. Every
// other list is empty. Anything but a GET is a test failure: a preview writes
// nothing.
func previewBlockUpstream(t *testing.T, subnets string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("a preview must not write, got %s %s", r.Method, r.URL.Path)
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/"+uaBlockID):
			io.WriteString(w, `{"result":{"address":"172.16.128.0","cidr":21,"space":"ipam/ip_space/sp-1"}}`)
		case strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			io.WriteString(w, filterByParent(t, subnets, r.URL.Query().Get("_filter")))
		case strings.HasSuffix(r.URL.Path, "/ipam/address_block"), strings.HasSuffix(r.URL.Path, "/ipam/ip_space"),
			strings.HasSuffix(r.URL.Path, "/ipam/range"), strings.HasSuffix(r.URL.Path, "/dhcp/fixed_address"),
			strings.HasSuffix(r.URL.Path, "/ipam/address"):
			io.WriteString(w, `{"results":[]}`) // Infoblox sends no page object for an empty list
		default:
			t.Errorf("unexpected read %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}
}

// filterByParent keeps the rows whose parent the filter names, when it names
// one, and recounts the total.
func filterByParent(t *testing.T, body, filter string) string {
	if !strings.Contains(filter, "parent==") {
		return body
	}
	var v map[string]any
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		return body
	}
	rows, _ := v["results"].([]any)
	kept := []any{}
	for _, r := range rows {
		m, _ := r.(map[string]any)
		if p, _ := m["parent"].(string); p != "" && strings.Contains(filter, p) {
			kept = append(kept, r)
		}
	}
	v["results"] = kept
	if _, ok := v["page"]; ok {
		v["page"] = map[string]any{"total_size": fmt.Sprint(len(kept))}
	}
	out, _ := json.Marshal(v)
	return string(out)
}

// subnetRow is one subnet in the list: in sp-1 and a child of the block
// unless space says otherwise.
func subnetRow(id, address, space string) string {
	parent := uaBlockID
	if space == "" {
		space = "ipam/ip_space/sp-1"
	} else {
		parent = "ipam/address_block/elsewhere"
	}
	return fmt.Sprintf(`{"id":"ipam/subnet/%s","address":%q,"cidr":24,"space":%q,"parent":%q}`, id, address, space, parent)
}

// The preview used to say only "Would create /24 in block <id>". It now names
// the subnet and the reverse zone the live run would most likely create.
func TestSubnetStream_DryRun_NamesTheSubnetItWouldCreate(t *testing.T) {
	d, logPath := newInventoryDeps(t, previewBlockUpstream(t,
		`{"results":[`+subnetRow("a", "172.16.128.0", "")+`,`+subnetRow("b", "172.16.129.0", "")+`],"page":{"total_size":"2"}}`))
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&make_zone=1&dry=1"))

	body := rr.Body.String()
	for _, want := range []string{"172.16.130.0/24", "probably", "172.16.128.0/21", "130.16.172.in-addr.arpa"} {
		if !strings.Contains(body, want) {
			t.Errorf("preview lacks %q: %s", want, body)
		}
	}
	terminalFrameOf(t, parseSSEFrames(t, body))
	uaNone(t, logPath, "", "a preview writes nothing, so no row of any kind belongs in the log")
}

func TestSubnetStream_DryRun_SaysWhenTheBlockIsFull(t *testing.T) {
	var all []string
	for i := 128; i < 136; i++ {
		all = append(all, subnetRow(fmt.Sprint(i), fmt.Sprintf("172.16.%d.0", i), ""))
	}
	d, _ := newInventoryDeps(t, previewBlockUpstream(t, `{"results":[`+strings.Join(all, ",")+`],"page":{"total_size":"8"}}`))
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=1"))
	noDoneFrame(t, parseSSEFrames(t, rr.Body.String()))
	if !strings.Contains(rr.Body.String(), "no free /24 left in block 172.16.128.0/21") {
		t.Fatalf("want a full block named, got %s", rr.Body.String())
	}
}

// A list that may be incomplete, a child that cannot be read, or an inventory
// read that fails outright must not produce a guess, nor a "Would create":
// the done frame says the check could not run and carries no subnet, so there
// is nothing to apply.
func TestSubnetStream_DryRun_RefusesWhenTheCheckCannotRun(t *testing.T) {
	for name, subnets := range map[string]string{
		"more rows than returned": `{"results":[` + subnetRow("a", "172.16.128.0", "") + `],"page":{"total_size":"3"}}`,
		"unreadable child":        `{"results":[{"id":"ipam/subnet/x","address":"","cidr":24}],"page":{"total_size":"1"}}`,
		// The same page at every offset: the list never reaches an empty page.
		"no total and a list that never ends": `{"results":[` + subnetRow("a", "172.16.128.0", "") + `]}`,
		"the subnet list answers 503":         "503",
	} {
		up := previewBlockUpstream(t, subnets)
		if subnets == "503" {
			inner := up
			up = func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/ipam/subnet") {
					w.WriteHeader(503)
					return
				}
				inner(w, r)
			}
		}
		d, _ := newInventoryDeps(t, up)
		rr := httptest.NewRecorder()
		d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=1"))
		body := rr.Body.String()
		if strings.Contains(body, "Would create") || strings.Contains(body, "probably") {
			t.Errorf("%s: a preview that could not check offered a subnet: %s", name, body)
		}
		done := terminalFrameOf(t, parseSSEFrames(t, body))
		msg, _ := done["message"].(string)
		if done["check_failed"] != true || done["subnet"] != nil ||
			!strings.Contains(msg, "Couldn't check which addresses are free, so no subnet is offered") {
			t.Errorf("%s: done frame = %v, want check_failed, no subnet and the plain reason", name, done)
		}
	}
}

// Previews within PreviewTTL share one read of what is in use, and say how
// old it is. Before, every preview read the whole tenant again (about 30 s on
// a large one).
func TestSubnetStream_DryRun_SecondPreviewReusesTheRead(t *testing.T) {
	freecheck.UseCache(cache.New())
	t.Cleanup(func() { freecheck.UseCache(nil) })
	var mu sync.Mutex
	inventory := 0
	inner := previewBlockUpstream(t, `{"results":[`+subnetRow("a", "172.16.128.0", "")+`],"page":{"total_size":"1"}}`)
	d, _ := newInventoryDeps(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("_order_by") != "" {
			mu.Lock()
			inventory++
			mu.Unlock()
		}
		inner(w, r)
	})
	for i := 0; i < 2; i++ {
		rr := httptest.NewRecorder()
		d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=1"))
		if !strings.Contains(rr.Body.String(), "Would create 172.16.129.0/24") ||
			!strings.Contains(rr.Body.String(), `"age_seconds"`) {
			t.Fatalf("preview %d = %s", i+1, rr.Body.String())
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if inventory != 6 { // spaces, blocks, subnets, ranges, reservations, hosts: once
		t.Fatalf("%d inventory reads over two previews, want 6 (one read, shared)", inventory)
	}
}

// A subnet in ANOTHER IP space over the block's first /24 is not one of the
// block's children, and the old preview, which read only those, offered it.
// It is not a clash either (the owner's rule of 2026-11-17), but a /24 no
// other space uses is preferred, so the next one is offered and the first is
// listed as passed over.
func TestSubnetStream_DryRun_PrefersOneNoOtherSpaceUses(t *testing.T) {
	d, _ := newInventoryDeps(t, previewBlockUpstream(t,
		`{"results":[`+subnetRow("other", "172.16.128.0", "ipam/ip_space/sp-2")+`],"page":{"total_size":"1"}}`))
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=1"))
	body := rr.Body.String()
	if !strings.Contains(body, "Would create 172.16.129.0/24") {
		t.Fatalf("want 172.16.129.0/24 offered, got %s", body)
	}
	for _, want := range []string{`"candidate":"172.16.128.0/24"`,
		`"reason":"it is also used in IP space ipam/ip_space/sp-2`, `"networks":1`, `"warnings":[]`, `"shared":0`} {
		if !strings.Contains(body, want) {
			t.Errorf("preview lacks %s: %s", want, body)
		}
	}
}

// The live tenant's shape: another IP space holds a network around the whole
// block, so no /24 in it is clean. The first free one is offered, with the
// warning next to it, rather than nothing.
func TestSubnetStream_DryRun_OffersAWarnedOneWhenNoneIsClean(t *testing.T) {
	lab := `{"id":"ipam/subnet/lab","address":"172.16.0.0","cidr":16,"space":"ipam/ip_space/sp-2"}`
	d, _ := newInventoryDeps(t, previewBlockUpstream(t, `{"results":[`+lab+`],"page":{"total_size":"1"}}`))
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=1"))
	body := rr.Body.String()
	if !strings.Contains(body, "Would create 172.16.128.0/24") {
		t.Fatalf("want 172.16.128.0/24 offered, got %s", body)
	}
	done := terminalFrameOf(t, parseSSEFrames(t, body))
	ws, _ := done["warnings"].([]any)
	if len(ws) != 1 {
		t.Fatalf("warnings = %v, want one", done["warnings"])
	}
	w, _ := ws[0].(map[string]any)
	if w["candidate"] != "172.16.128.0/24" || w["object"] != "172.16.0.0/16" || w["space"] != "ipam/ip_space/sp-2" ||
		w["kind"] != "subnet" || w["contains"] != true {
		t.Fatalf("warning = %v", w)
	}
	if c, _ := done["checked"].(map[string]any); c["shared"] != float64(1) {
		t.Fatalf("checked = %v, want shared 1", done["checked"])
	}
}

// emptyInventory answers the free-address check's reads as a tenant holding
// only block 10.0.0.0/8 in ipam/ip_space/sp-1, so a fake built for one create
// path need not know every list: freecheck's full inventory reads (the only
// requests that send _order_by) see an empty tenant, and a create's read of
// its block (_fields address,cidr,space) gets that block. Everything else goes
// to h.
func emptyInventory(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		switch {
		case r.Method == http.MethodGet && q.Get("_order_by") != "":
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"results":[]}`)
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/ipam/address_block/") && q.Get("_fields") == "address,cidr,space":
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"result":{"address":"10.0.0.0","cidr":8,"space":"ipam/ip_space/sp-1"}}`)
		default:
			h(w, r)
		}
	}
}

// Apply: Infoblox's pick is checked against a fresh read around it (which
// also sees the new subnet itself: that is not a clash). A pick something else
// in the same space already uses is removed and refused with the reason.
// Before, the live run kept it and reported done.
func TestSubnetStream_Apply_RemovesAPickItsOwnSpaceUses(t *testing.T) {
	applyPickTest(t, subnetRow("other", "172.16.128.0", "ipam/ip_space/sp-1"), true)
}

// A pick that only ANOTHER space uses is not refused. With no clean /24
// anywhere in the block (another space holds all of it), it is kept.
func TestSubnetStream_Apply_KeepsASharedPickWhenNoneIsClean(t *testing.T) {
	applyPickTest(t, `{"id":"ipam/subnet/lab","address":"172.16.0.0","cidr":16,"space":"ipam/ip_space/sp-2"}`, false)
}

// Apply makes what the clean-first preview offered: Infoblox picks
// 172.16.128.0/24, which only another space uses, while 172.16.129.0/24 is
// clean. The shared pick is removed and the clean one created by its address,
// with the name and comment asked for.
func TestSubnetStream_Apply_ReplacesASharedPickWithTheCleanOne(t *testing.T) {
	var mu sync.Mutex
	var deletes, creates []string
	d, logPath := newInventoryDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		q := r.URL.Query()
		switch {
		case r.Method == http.MethodDelete:
			mu.Lock()
			deletes = append(deletes, r.URL.Path)
			mu.Unlock()
			io.WriteString(w, `{}`)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/nextavailablesubnet"):
			io.WriteString(w, `{"results":[{"id":"ipam/subnet/new-1","address":"172.16.128.0","cidr":24}]}`)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			creates = append(creates, string(b))
			mu.Unlock()
			w.WriteHeader(201)
			io.WriteString(w, `{"result":{"id":"ipam/subnet/clean-1","address":"172.16.129.0","cidr":24}}`)
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
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=0&name=web"))
	done := terminalFrameOf(t, parseSSEFrames(t, rr.Body.String()))
	if sub, _ := done["subnet"].(map[string]any); sub["address"] != "172.16.129.0" {
		t.Fatalf("done = %v, want the clean 172.16.129.0 made; body %s", done, rr.Body.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(deletes) != 1 || deletes[0] != "/api/ddi/v1/ipam/subnet/new-1" {
		t.Fatalf("deletes = %v, want Infoblox's shared pick removed", deletes)
	}
	if len(creates) != 1 || !strings.Contains(creates[0], `"address":"172.16.129.0"`) ||
		!strings.Contains(creates[0], `"cidr":24`) || !strings.Contains(creates[0], `"space":"ipam/ip_space/sp-1"`) ||
		!strings.Contains(creates[0], `"name":"web"`) {
		t.Fatalf("creates = %v, want 172.16.129.0/24 in sp-1 named web", creates)
	}
	rows := auditEntries(t, logPath, "provision-subnet")
	if len(rows) != 1 || !strings.Contains(fmt.Sprint(rows[0]), "172.16.129.0") {
		t.Fatalf("provision-subnet rows = %v, want one naming 172.16.129.0", rows)
	}
}

// replaceRun runs a live Apply where Infoblox picks the shared 172.16.128.0/24
// and the clean 172.16.129.0/24 is created in its place. The create answers
// createStatus with createBody; late is a row that appears in the inventory
// only after that create ("" for none).
func replaceRun(t *testing.T, createStatus int, createBody, late string) (body string, deletes []string, logPath string) {
	t.Helper()
	var mu sync.Mutex
	created := false
	d, logPath := newInventoryDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		q := r.URL.Query()
		switch {
		case r.Method == http.MethodDelete:
			mu.Lock()
			deletes = append(deletes, r.URL.Path)
			mu.Unlock()
			io.WriteString(w, `{}`)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/nextavailablesubnet"):
			io.WriteString(w, `{"results":[{"id":"ipam/subnet/new-1","address":"172.16.128.0","cidr":24}]}`)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			mu.Lock()
			created = true
			mu.Unlock()
			w.WriteHeader(createStatus)
			io.WriteString(w, createBody)
		case strings.HasSuffix(r.URL.Path, "/"+uaBlockID):
			io.WriteString(w, `{"result":{"address":"172.16.128.0","cidr":21,"space":"ipam/ip_space/sp-1"}}`)
		case q.Get("_order_by") != "" && q.Get("_offset") != "0":
			io.WriteString(w, `{"results":[]}`)
		case strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			rows := subnetRow("other", "172.16.128.0", "ipam/ip_space/sp-2")
			mu.Lock()
			if created && late != "" {
				rows += "," + late
			}
			mu.Unlock()
			io.WriteString(w, `{"results":[`+rows+`]}`)
		default:
			io.WriteString(w, `{"results":[]}`)
		}
	})
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=0"))
	mu.Lock()
	defer mu.Unlock()
	return rr.Body.String(), append([]string(nil), deletes...), logPath
}

const cleanCreated = `{"result":{"id":"ipam/subnet/clean-1","address":"172.16.129.0","cidr":24}}`

// The clean subnet is checked against a fresh read once made: a subnet in the
// block's own space that appeared since is a clash, so it is removed and the
// run fails.
func TestSubnetStream_Apply_RemovesACleanPickThatClashesOnAFreshRead(t *testing.T) {
	body, deletes, _ := replaceRun(t, 201, cleanCreated,
		`{"id":"ipam/subnet/late","address":"172.16.129.0","cidr":25,"space":"ipam/ip_space/sp-1"}`)
	noDoneFrame(t, parseSSEFrames(t, body))
	if !slices.Contains(deletes, "/api/ddi/v1/ipam/subnet/clean-1") {
		t.Fatalf("deletes = %v, want the clean subnet removed; body %s", deletes, body)
	}
}

// Once the shared pick is removed, a refused create of the clean one fails the
// run, and says nothing was made.
func TestSubnetStream_Apply_FailsWhenTheCleanCreateIsRefused(t *testing.T) {
	body, _, _ := replaceRun(t, 400, `{"error":[{"message":"refused"}]}`, "")
	noDoneFrame(t, parseSSEFrames(t, body))
	if !strings.Contains(body, "172.16.129.0/24") || !strings.Contains(body, "Nothing was created") {
		t.Fatalf("want the refused create of 172.16.129.0/24 reported, got %s", body)
	}
}

// When Infoblox's answer to the clean create is lost (a gateway error) or names
// no subnet, the subnet may exist: the run fails without saying nothing was
// made, and the log names the subnet that may exist.
func TestSubnetStream_Apply_SaysACleanCreateWithNoAnswerMayExist(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
	}{{504, `{}`}, {201, `{"result":{}}`}} {
		body, _, logPath := replaceRun(t, tc.status, tc.body, "")
		noDoneFrame(t, parseSSEFrames(t, body))
		if strings.Contains(body, "Nothing was created") || !strings.Contains(body, "may have been created") {
			t.Fatalf("status %d: want 172.16.129.0/24 named as possibly made, got %s", tc.status, body)
		}
		rows := auditEntries(t, logPath, "provision-subnet")
		if len(rows) != 1 || !strings.Contains(fmt.Sprint(rows[0]), "172.16.129.0") {
			t.Fatalf("status %d: provision-subnet rows = %v, want one naming 172.16.129.0", tc.status, rows)
		}
	}
}

func applyPickTest(t *testing.T, otherRow string, refused bool) {
	t.Helper()
	var mu sync.Mutex
	var deletes, filters []string
	d, logPath := newInventoryDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		q := r.URL.Query()
		switch {
		case r.Method == http.MethodDelete:
			mu.Lock()
			deletes = append(deletes, r.URL.Path)
			mu.Unlock()
			io.WriteString(w, `{}`)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/nextavailablesubnet"):
			io.WriteString(w, `{"results":[{"id":"ipam/subnet/new-1","address":"172.16.128.0","cidr":24}]}`)
		case strings.HasSuffix(r.URL.Path, "/"+uaBlockID):
			io.WriteString(w, `{"result":{"address":"172.16.128.0","cidr":21,"space":"ipam/ip_space/sp-1"}}`)
		case q.Get("_order_by") != "" && q.Get("_offset") != "0":
			io.WriteString(w, `{"results":[]}`)
		case strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			mu.Lock()
			filters = append(filters, q.Get("_filter"))
			mu.Unlock()
			io.WriteString(w, `{"results":[`+otherRow+`,`+
				`{"id":"ipam/subnet/new-1","address":"172.16.128.0","cidr":24,"space":"ipam/ip_space/sp-1"}],"page":{"total_size":"2"}}`)
		default:
			io.WriteString(w, `{"results":[]}`)
		}
	})
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=0"))
	body := rr.Body.String()
	if !refused {
		mu.Lock()
		defer mu.Unlock()
		if len(deletes) != 0 || strings.Contains(body, "so it was removed") {
			t.Fatalf("deletes = %v, body %s: want the pick kept", deletes, body)
		}
		if n := len(auditEntries(t, logPath, "provision-subnet")); n != 1 {
			t.Fatalf("%d provision-subnet rows, want 1", n)
		}
		return
	}
	noDoneFrame(t, parseSSEFrames(t, body))
	if !strings.Contains(body, "Infoblox picked 172.16.128.0/24, but a subnet in ipam/ip_space/sp-1 already uses 172.16.128.0/24, so it was removed") {
		t.Fatalf("want the pick refused and removed, got %s", body)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(deletes) != 1 || deletes[0] != "/api/ddi/v1/ipam/subnet/new-1" {
		t.Fatalf("deletes = %v, want the new subnet removed", deletes)
	}
	if len(filters) == 0 || !strings.Contains(filters[0], `address>="172.16.128.0" and address<="172.16.128.255"`) {
		t.Fatalf("subnet read filters = %v, want a read scoped to the pick", filters)
	}
	if n := len(auditEntries(t, logPath, "provision-subnet")); n != 0 {
		t.Fatalf("%d provision-subnet rows, want none: the subnet was removed", n)
	}
	if n := len(auditEntries(t, logPath, "provision-subnet-error")); n != 1 {
		t.Fatalf("%d provision-subnet-error rows, want 1", n)
	}
}

// A subnet preview reads only what overlaps the chosen block (every IP space),
// not the whole tenant: 63 s cold on a large one. checked.around names the span.
func TestSubnetStream_DryRun_ReadsOnlyAroundTheBlock(t *testing.T) {
	var mu sync.Mutex
	var filters []string
	inner := previewBlockUpstream(t, `{"results":[`+subnetRow("a", "172.16.128.0", "")+`],"page":{"total_size":"1"}}`)
	d, _ := newInventoryDeps(t, func(w http.ResponseWriter, r *http.Request) {
		if q := r.URL.Query(); q.Get("_order_by") != "" && strings.HasSuffix(r.URL.Path, "/ipam/subnet") {
			mu.Lock()
			filters = append(filters, q.Get("_filter"))
			mu.Unlock()
		}
		inner(w, r)
	})
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=1"))
	done := terminalFrameOf(t, parseSSEFrames(t, rr.Body.String()))
	checked, _ := done["checked"].(map[string]any)
	if checked["around"] != "172.16.128.0 to 172.16.135.255" {
		t.Fatalf("checked = %v, want a read around the block 172.16.128.0/21", done["checked"])
	}
	mu.Lock()
	defer mu.Unlock()
	if len(filters) != 1 || !strings.Contains(filters[0], `address>="172.16.128.0" and address<="172.16.135.255"`) {
		t.Fatalf("subnet read filters = %v, want one read scoped to the block", filters)
	}
}

// A preview in a block as big as 10.0.0.0/8 reads a /16 at a time and stops
// at the first /16 with room. Before, it read everything overlapping the /8,
// which on a large tenant is most of it (about 40 s cold).
func TestSubnetStream_DryRun_ReadsAHugeBlockOnePieceAtATime(t *testing.T) {
	var mu sync.Mutex
	var filters []string
	d, _ := newInventoryDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		q := r.URL.Query()
		switch {
		case r.Method != http.MethodGet:
			t.Errorf("a preview must not write, got %s %s", r.Method, r.URL.Path)
			w.WriteHeader(500)
		case strings.HasSuffix(r.URL.Path, "/"+uaBlockID):
			io.WriteString(w, `{"result":{"address":"10.0.0.0","cidr":8,"space":"ipam/ip_space/sp-1"}}`)
		case strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			mu.Lock()
			filters = append(filters, q.Get("_filter"))
			mu.Unlock()
			io.WriteString(w, `{"results":[{"id":"ipam/subnet/a","address":"10.0.0.0","cidr":24,"space":"ipam/ip_space/sp-2"}],"page":{"total_size":"1"}}`)
		default:
			io.WriteString(w, `{"results":[]}`)
		}
	})
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=1"))
	body := rr.Body.String()
	if !strings.Contains(body, "Would create 10.0.1.0/24") {
		t.Fatalf("want 10.0.1.0/24 offered, got %s", body)
	}
	done := terminalFrameOf(t, parseSSEFrames(t, body))
	if checked, _ := done["checked"].(map[string]any); checked["around"] != "10.0.0.0 to 10.0.255.255" {
		t.Fatalf("checked = %v, want only the first /16 read", done["checked"])
	}
	mu.Lock()
	defer mu.Unlock()
	if len(filters) != 1 || !strings.Contains(filters[0], `address>="10.0.0.0" and address<="10.0.255.255"`) {
		t.Fatalf("subnet read filters = %v, want one read of the first /16", filters)
	}
}
