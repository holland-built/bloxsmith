package server

import (
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

// previewBlockUpstream answers the preview's three reads for a /21 that already holds
// two /24s. Anything but a GET is a test failure: a preview writes nothing.
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
			io.WriteString(w, `{"result":{"address":"172.16.128.0","cidr":21}}`)
		case strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			if !strings.Contains(r.URL.Query().Get("_filter"), uaBlockID) {
				t.Errorf("subnet list not filtered to the block: %s", r.URL.RawQuery)
			}
			io.WriteString(w, subnets)
		case strings.HasSuffix(r.URL.Path, "/ipam/address_block"):
			io.WriteString(w, `{"results":[]}`) // Infoblox sends no page object for an empty list
		default:
			t.Errorf("unexpected read %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}
}

// The preview used to say only "Would create /24 in block <id>". It now names
// the subnet and the reverse zone the live run would most likely create.
func TestSubnetStream_DryRun_NamesTheSubnetItWouldCreate(t *testing.T) {
	d, logPath := newResidualDeps(t, previewBlockUpstream(t,
		`{"results":[{"address":"172.16.128.0","cidr":24},{"address":"172.16.129.0","cidr":24}],"page":{"total_size":"2"}}`))
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
		all = append(all, fmt.Sprintf(`{"address":"172.16.%d.0","cidr":24}`, i))
	}
	d, _ := newResidualDeps(t, previewBlockUpstream(t, `{"results":[`+strings.Join(all, ",")+`],"page":{"total_size":"8"}}`))
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
	var many []string
	for i := 0; i < previewNoTotalMax; i++ {
		many = append(many, `{"address":"10.0.0.0","cidr":32}`)
	}
	for name, subnets := range map[string]string{
		"more rows than returned":  `{"results":[{"address":"172.16.128.0","cidr":24}],"page":{"total_size":"3"}}`,
		"unreadable child":         `{"results":[{"address":"","cidr":24}],"page":{"total_size":"1"}}`,
		"no total and a long list": `{"results":[` + strings.Join(many, ",") + `]}`,
	} {
		d, _ := newResidualDeps(t, previewBlockUpstream(t, subnets))
		rr := httptest.NewRecorder()
		d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=1"))
		body := rr.Body.String()
		if strings.Contains(body, "probably") || !strings.Contains(body, "could not work out which one") {
			t.Errorf("%s: want the fallback wording, got %s", name, body)
		}
		terminalFrameOf(t, parseSSEFrames(t, body))
	}
}
