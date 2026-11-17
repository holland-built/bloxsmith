package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
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
			strings.HasSuffix(r.URL.Path, "/ipam/host"):
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

// A list that may be incomplete, or a child that cannot be read, must not
// produce a guess: the preview falls back to naming only the size and block.
func TestSubnetStream_DryRun_FallsBackWhenTheBlockCannotBeReadInFull(t *testing.T) {
	for name, subnets := range map[string]string{
		"more rows than returned": `{"results":[` + subnetRow("a", "172.16.128.0", "") + `],"page":{"total_size":"3"}}`,
		"unreadable child":        `{"results":[{"id":"ipam/subnet/x","address":"","cidr":24}],"page":{"total_size":"1"}}`,
		// The same page at every offset: the list never reaches an empty page.
		"no total and a list that never ends": `{"results":[` + subnetRow("a", "172.16.128.0", "") + `]}`,
	} {
		d, _ := newInventoryDeps(t, previewBlockUpstream(t, subnets))
		rr := httptest.NewRecorder()
		d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=1"))
		body := rr.Body.String()
		if strings.Contains(body, "probably") || !strings.Contains(body, "could not work out which one") {
			t.Errorf("%s: want the fallback wording, got %s", name, body)
		}
		terminalFrameOf(t, parseSSEFrames(t, body))
	}
}

// A subnet in ANOTHER IP space over the block's first /24 is not one of the
// block's children, and the old preview, which read only those, offered it.
func TestSubnetStream_DryRun_SkipsAnOverlapInAnotherSpace(t *testing.T) {
	d, _ := newInventoryDeps(t, previewBlockUpstream(t,
		`{"results":[`+subnetRow("other", "172.16.128.0", "ipam/ip_space/sp-2")+`],"page":{"total_size":"1"}}`))
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=1"))
	body := rr.Body.String()
	if !strings.Contains(body, "Would create 172.16.129.0/24") {
		t.Fatalf("want 172.16.129.0/24 offered, got %s", body)
	}
	for _, want := range []string{`"candidate":"172.16.128.0/24"`,
		`"reason":"a subnet in ipam/ip_space/sp-2 already uses 172.16.128.0/24"`, `"networks":1`} {
		if !strings.Contains(body, want) {
			t.Errorf("preview lacks %s: %s", want, body)
		}
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
