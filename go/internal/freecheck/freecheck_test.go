package freecheck

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"testing"

	"bloxsmith/internal/rest"
)

var (
	pfx  = netip.MustParsePrefix
	addr = netip.MustParseAddr
)

// The tenant every table test reads: space A (corp-amer) has a /16 block, a
// child block, a grandchild subnet and a DHCP range; space B (corp-emea) has a
// subnet that overlaps A's block; a reservation and a host sit in A.
func tenant() *Snapshot {
	return NewSnapshot(map[string]string{"sp-a": "corp-amer", "sp-b": "corp-emea"},
		Network(KindBlock, "sp-a", "blk-top", pfx("10.16.0.0/16")),
		Network(KindBlock, "sp-a", "blk-child", pfx("10.16.0.0/20")),
		Network(KindSubnet, "sp-a", "sub-grand", pfx("10.16.8.0/24")),
		Span(KindRange, "sp-a", "rng", addr("10.16.8.10"), addr("10.16.8.200")),
		Span(KindReservation, "sp-a", "fix", addr("10.16.8.5"), addr("10.16.8.5")),
		Span(KindHost, "sp-a", "host", addr("10.16.8.6"), addr("10.16.8.6")),
		Network(KindSubnet, "sp-b", "sub-other", pfx("10.16.32.0/24")),
	)
}

func TestCheckPrefix(t *testing.T) {
	cases := []struct {
		name, space, cand, parent string
		wantFree                  bool
		wantReason                string
	}{
		// A /24 inside the child block's range clashes with the grandchild
		// subnet; reading only the top block's direct children would miss it.
		{"grandchild subnet overlap", "sp-a", "10.16.8.0/24", "10.16.0.0/20", false,
			"a subnet in corp-amer already uses 10.16.8.0/24"},
		{"grandchild subnet overlap, parent is the top block", "sp-a", "10.16.8.0/22", "10.16.0.0/16", false,
			"an address block in corp-amer already uses 10.16.0.0/20"},
		{"cross-space overlap", "sp-a", "10.16.32.0/24", "10.16.0.0/16", false,
			"a subnet in corp-emea already uses 10.16.32.0/24"},
		{"containment in own parent allowed", "sp-a", "10.16.1.0/24", "10.16.0.0/20", true, ""},
		{"containment in the parent's parent allowed", "sp-a", "10.16.64.0/24", "10.16.0.0/16", true, ""},
		{"no parent chosen: same-space container allowed", "sp-a", "10.16.64.0/24", "", true, ""},
		{"same-space container is a clash in another space", "sp-b", "10.16.64.0/24", "", false,
			"an address block in corp-amer already uses 10.16.0.0/16"},
		{"exact match is a clash", "sp-a", "10.16.0.0/20", "", false,
			"an address block in corp-amer already uses 10.16.0.0/20"},
		{"a network over a DHCP range", "sp-b", "10.16.8.0/26", "", false,
			"an address block in corp-amer already uses 10.16.0.0/16"},
	}
	s := tenant()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var parent netip.Prefix
			if tc.parent != "" {
				parent = pfx(tc.parent)
			}
			got := s.CheckPrefix(tc.space, pfx(tc.cand), parent)
			if got.Free != tc.wantFree || got.Reason != tc.wantReason {
				t.Fatalf("CheckPrefix(%s) = %+v, want free=%v reason=%q", tc.cand, got, tc.wantFree, tc.wantReason)
			}
		})
	}
}

func TestCheckAddr(t *testing.T) {
	cases := []struct {
		name, a    string
		wantReason string // "" = free
	}{
		{"address inside a range", "10.16.8.50", "a DHCP range in corp-amer already uses 10.16.8.10 to 10.16.8.200"},
		{"range edge", "10.16.8.200", "a DHCP range in corp-amer already uses 10.16.8.10 to 10.16.8.200"},
		{"reservation clash", "10.16.8.5", "a reservation in corp-amer already uses 10.16.8.5"},
		{"host clash", "10.16.8.6", "a host in corp-amer already uses 10.16.8.6"},
		// Inside a subnet, in a block another space overlaps: networks never
		// make an address not free.
		{"free address in a subnet", "10.16.8.7", ""},
		{"free in the cross-space subnet", "10.16.32.9", ""},
	}
	s := tenant()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := s.CheckAddr(addr(tc.a))
			if got.Free != (tc.wantReason == "") || got.Reason != tc.wantReason {
				t.Fatalf("CheckAddr(%s) = %+v, want reason %q", tc.a, got, tc.wantReason)
			}
		})
	}
}

func TestCheckSpan_RangeOverReservation(t *testing.T) {
	got := tenant().CheckSpan(addr("10.16.8.1"), addr("10.16.8.9"))
	if got.Free || got.Reason != "a reservation in corp-amer already uses 10.16.8.5" {
		t.Fatalf("CheckSpan = %+v, want the reservation named", got)
	}
}

func TestNextFreePrefix(t *testing.T) {
	s := tenant()
	// Inside the top block: the child block covers 10.16.0.0/20, so the first
	// free /24 is 10.16.16.0/24, and the skip names the child block.
	pick, skipped, ok := s.NextFreePrefix("sp-a", pfx("10.16.0.0/16"), 24)
	if !ok || pick.String() != "10.16.16.0/24" {
		t.Fatalf("pick = %s (%v), want 10.16.16.0/24", pick, ok)
	}
	if len(skipped) != 1 || skipped[0].Candidate != "10.16.0.0/24" ||
		skipped[0].Reason != "an address block in corp-amer already uses 10.16.0.0/20" {
		t.Fatalf("skipped = %+v", skipped)
	}
	// Inside the child block: the grandchild subnet is skipped.
	pick, _, ok = s.NextFreePrefix("sp-a", pfx("10.16.8.0/21"), 24)
	if !ok || pick.String() != "10.16.9.0/24" {
		t.Fatalf("pick in child = %s (%v), want 10.16.9.0/24", pick, ok)
	}
	// After the run adds its own pick, the next pick moves on.
	s.Add(Network(KindSubnet, "sp-a", "", pick))
	pick, _, _ = s.NextFreePrefix("sp-a", pfx("10.16.8.0/21"), 24)
	if pick.String() != "10.16.10.0/24" {
		t.Fatalf("pick after Add = %s, want 10.16.10.0/24", pick)
	}
	// Full.
	if _, _, ok := s.NextFreePrefix("sp-a", pfx("10.16.8.0/24"), 24); ok {
		t.Fatal("a block holding only the grandchild subnet has no free /24")
	}
}

func TestNextFreeAddr_SkipsTheRangeInOneStep(t *testing.T) {
	pick, skipped, ok := tenant().NextFreeAddr(pfx("10.16.8.0/24"), addr("10.16.8.5"))
	if !ok || pick.String() != "10.16.8.7" {
		t.Fatalf("pick = %s (%v), want 10.16.8.7", pick, ok)
	}
	pick, skipped, _ = tenant().NextFreeAddr(pfx("10.16.8.0/24"), addr("10.16.8.10"))
	if pick.String() != "10.16.8.201" || len(skipped) != 1 {
		t.Fatalf("pick = %s skipped = %+v, want 10.16.8.201 after one skip", pick, skipped)
	}
}

func TestFirstFreePrefix(t *testing.T) {
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
			used = append(used, pfx(u))
		}
		got, ok := FirstFreePrefix(pfx(tc.block), used, tc.bits)
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

// --- Load ---------------------------------------------------------------------

// fakeTenant serves the six lists. Each list is rows; a list in withTotal also
// reports page.total_size (claimTotal overrides the number reported).
type fakeTenant struct {
	lists      map[string][]string
	withTotal  map[string]bool
	claimTotal map[string]int
	fail       string // a path that answers 500
	noOffset   string // a path that ignores _offset (an endless list)
}

func (f fakeTenant) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("Load must only read, got %s %s", r.Method, r.URL.Path)
		}
		path := strings.TrimPrefix(r.URL.Path, "/api/ddi/v1/")
		if path == f.fail {
			w.WriteHeader(500)
			return
		}
		rows := f.lists[path]
		off, _ := strconv.Atoi(r.URL.Query().Get("_offset"))
		lim, _ := strconv.Atoi(r.URL.Query().Get("_limit"))
		if path == f.noOffset {
			off = 0
		}
		page := []string{}
		for i := off; i < len(rows) && i < off+lim; i++ {
			page = append(page, rows[i])
		}
		body := `{"results":[` + strings.Join(page, ",") + `]`
		if f.withTotal[path] {
			total := len(rows)
			if n, ok := f.claimTotal[path]; ok {
				total = n
			}
			body += fmt.Sprintf(`,"page":{"total_size":"%d"}`, total)
		}
		w.Write([]byte(body + "}"))
	}
}

func goodTenant() fakeTenant {
	return fakeTenant{
		lists: map[string][]string{
			"ipam/ip_space":      {`{"id":"sp-a","name":"corp-amer"}`, `{"id":"sp-b","name":"corp-emea"}`},
			"ipam/address_block": {`{"id":"b1","space":"sp-a","address":"10.16.0.0","cidr":16}`},
			"ipam/subnet": {`{"id":"s1","space":"sp-a","address":"10.16.8.0","cidr":24}`,
				`{"id":"s2","space":"sp-b","address":"10.16.32.0","cidr":24}`},
			"ipam/range":         {`{"id":"r1","space":"sp-a","start":"10.16.8.10","end":"10.16.8.200"}`},
			"dhcp/fixed_address": {`{"id":"f1","ip_space":"sp-a","address":"10.16.8.5"}`},
			"ipam/host":          {`{"id":"h1","addresses":[{"address":"10.16.8.6","space":"sp-a"}]}`},
		},
		withTotal: map[string]bool{"ipam/subnet": true},
	}
}

func load(t *testing.T, f fakeTenant, scope Scope) (*Snapshot, error) {
	t.Helper()
	srv := httptest.NewServer(f.handler(t))
	t.Cleanup(srv.Close)
	return Load(rest.New(srv.URL, rest.NewAuth("k", nil)), scope)
}

func TestLoad_ReadsEveryKind(t *testing.T) {
	s, err := load(t, goodTenant(), All)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := Counts{Spaces: 2, Networks: 3, Ranges: 1, Reservations: 1, Hosts: 1}
	if s.Counts != want {
		t.Fatalf("Counts = %+v, want %+v", s.Counts, want)
	}
	if r := s.CheckPrefix("sp-a", pfx("10.16.32.0/24"), pfx("10.16.0.0/16")); r.Free ||
		r.Reason != "a subnet in corp-emea already uses 10.16.32.0/24" {
		t.Fatalf("cross-space after Load = %+v", r)
	}
	if r := s.CheckAddr(addr("10.16.8.5")); r.Free {
		t.Fatal("reservation after Load not seen")
	}
}

func TestLoad_AddressesScopeSkipsNetworks(t *testing.T) {
	f := goodTenant()
	f.fail = "ipam/subnet" // never read in this scope
	s, err := load(t, f, Addresses)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if s.Counts.Networks != 0 || s.Counts.Ranges != 1 {
		t.Fatalf("Counts = %+v", s.Counts)
	}
}

func TestLoad_IncompleteListIsAnError(t *testing.T) {
	cases := []struct {
		name string
		edit func(*fakeTenant)
		noun string
	}{
		{"a list answers 500", func(f *fakeTenant) { f.fail = "ipam/range" }, "DHCP range"},
		{"total says more than was read", func(f *fakeTenant) { f.claimTotal = map[string]int{"ipam/subnet": 3} }, "subnet"},
		{"a list that never ends", func(f *fakeTenant) { f.noOffset = "dhcp/fixed_address" }, "reservation"},
		{"a block with no space", func(f *fakeTenant) {
			f.lists["ipam/address_block"] = []string{`{"id":"b1","address":"10.16.0.0","cidr":16}`}
		}, "address block"},
		{"a host address that cannot be read", func(f *fakeTenant) {
			f.lists["ipam/host"] = []string{`{"id":"h1","addresses":[{"address":"nope","space":"sp-a"}]}`}
		}, "host"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := goodTenant()
			tc.edit(&f)
			s, err := load(t, f, All)
			if err == nil {
				t.Fatalf("Load = %+v, want an error", s.Counts)
			}
			if msg := Public(err); !strings.Contains(msg, "Couldn't read every "+tc.noun) {
				t.Fatalf("Public = %q, want it to name the %s list", msg, tc.noun)
			}
		})
	}
}

func TestLoad_PagesUntilEmpty(t *testing.T) {
	f := goodTenant()
	var blocks []string
	for i := 0; i < pageSize+5; i++ {
		blocks = append(blocks, fmt.Sprintf(`{"id":"b%d","space":"sp-a","address":"10.%d.%d.0","cidr":24}`, i, 100+i/256, i%256))
	}
	f.lists["ipam/address_block"] = blocks
	s, err := load(t, f, All)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if s.Counts.Networks != pageSize+5+2 {
		t.Fatalf("Networks = %d, want every block and subnet", s.Counts.Networks)
	}
}
