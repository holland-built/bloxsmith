package freecheck

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"

	"bloxsmith/internal/rest"
)

// pieceReader is a fake read for nextFreeInPieces: the items overlapping
// lo..hi, as Around would return them. full lists the read numbers (0 first)
// that come back as a full read instead, as Around does when a scoped list
// cannot be shown whole. reads records each span asked for.
type pieceReader struct {
	items []Used
	full  map[int]bool
	reads []string
}

func (r *pieceReader) read(lo, hi netip.Addr) (*Snapshot, error) {
	n := len(r.reads)
	r.reads = append(r.reads, lo.String()+" to "+hi.String())
	if r.full[n] {
		return NewSnapshot(nil, r.items...), nil
	}
	var got []Used
	for _, u := range r.items {
		if overlaps(u, lo, hi) {
			got = append(got, u)
		}
	}
	s := NewSnapshot(nil, got...)
	s.Counts.Around = lo.String() + " to " + hi.String()
	return s, nil
}

func eightBlock(extra ...Used) []Used {
	return append([]Used{Network(KindBlock, "sp-a", "top", pfx("10.0.0.0/8"))}, extra...)
}

// A /8 is searched a /16 at a time, and the search stops at the first piece
// with room: only 10.0.0.0/16 is read, not the whole /8.
func TestPieces_StopAtTheFirstPieceWithRoom(t *testing.T) {
	r := &pieceReader{items: eightBlock(Network(KindSubnet, "sp-a", "s", pfx("10.0.0.0/24")))}
	pick, _, skipped, checked, ok, err := nextFreeInPieces(r.read, "sp-a", pfx("10.0.0.0/8"), 24)
	if err != nil || !ok || pick != pfx("10.0.1.0/24") {
		t.Fatalf("= %s %v %v, want 10.0.1.0/24", pick, ok, err)
	}
	if len(r.reads) != 1 || r.reads[0] != "10.0.0.0 to 10.0.255.255" {
		t.Fatalf("reads = %v, want only the first /16", r.reads)
	}
	if len(skipped) != 1 || checked.Around != "10.0.0.0 to 10.0.255.255" {
		t.Fatalf("skipped %v, checked %+v", skipped, checked)
	}
}

// A full first piece moves the search on to the next one, and a subnet that
// covers many pieces is stepped over without reading the pieces under it.
func TestPieces_FindACandidateInALaterPiece(t *testing.T) {
	r := &pieceReader{items: eightBlock(
		Network(KindSubnet, "sp-a", "big", pfx("10.0.0.0/9")),
		Network(KindSubnet, "sp-a", "s", pfx("10.128.0.0/24")))}
	pick, _, _, checked, ok, err := nextFreeInPieces(r.read, "sp-a", pfx("10.0.0.0/8"), 24)
	if err != nil || !ok || pick != pfx("10.128.1.0/24") {
		t.Fatalf("= %s %v %v, want 10.128.1.0/24", pick, ok, err)
	}
	want := []string{"10.0.0.0 to 10.0.255.255", "10.128.0.0 to 10.129.255.255"}
	if fmt.Sprint(r.reads) != fmt.Sprint(want) {
		t.Fatalf("reads = %v, want %v", r.reads, want)
	}
	if checked.Around != "10.0.0.0 to 10.129.255.255" || checked.Networks != 3 {
		t.Fatalf("checked = %+v", checked)
	}
}

// A full block is read to its end, and checked says so. After a piece with
// no room the next one is up to twice as big (as its start's alignment
// allows), so a full /8 is about ten reads, not 256.
func TestPieces_AFullBlockReadsEveryPiece(t *testing.T) {
	var items []Used
	for i := 0; i < 4; i++ {
		items = append(items, Network(KindSubnet, "sp-a", fmt.Sprint(i), pfx(fmt.Sprintf("10.%d.0.0/16", i))))
	}
	r := &pieceReader{items: items}
	_, _, _, checked, ok, err := nextFreeInPieces(r.read, "sp-a", pfx("10.0.0.0/14"), 24)
	if err != nil || ok {
		t.Fatalf("ok %v err %v, want none free", ok, err)
	}
	want := []string{"10.0.0.0 to 10.0.255.255", "10.1.0.0 to 10.1.255.255", "10.2.0.0 to 10.3.255.255"}
	if fmt.Sprint(r.reads) != fmt.Sprint(want) || checked.Around != "10.0.0.0 to 10.3.255.255" {
		t.Fatalf("reads %v, want %v; checked %+v", r.reads, want, checked)
	}
	// A /8 packed with /24s: no piece has room, and no clash spans a piece.
	var packed []Used
	for i := 0; i < 256; i++ {
		packed = append(packed, Network(KindSubnet, "sp-a", fmt.Sprint(i), pfx(fmt.Sprintf("10.%d.0.0/17", i))),
			Network(KindSubnet, "sp-a", fmt.Sprint(i)+"b", pfx(fmt.Sprintf("10.%d.128.0/17", i))))
	}
	r = &pieceReader{items: packed}
	if _, _, _, _, ok, _ := nextFreeInPieces(r.read, "sp-a", pfx("10.0.0.0/8"), 24); ok || len(r.reads) > 10 {
		t.Fatalf("ok %v after %d reads, want none free in at most 10", ok, len(r.reads))
	}
}

// A piece whose read had to fall back to a full read answers for the rest of
// the block from that one read; checked.around is then empty (everything).
func TestPieces_AFullReadAnswersForTheRest(t *testing.T) {
	r := &pieceReader{full: map[int]bool{0: true}, items: eightBlock(
		Network(KindSubnet, "sp-a", "a", pfx("10.0.0.0/16")),
		Network(KindSubnet, "sp-a", "b", pfx("10.1.0.0/24")))}
	pick, _, _, checked, ok, err := nextFreeInPieces(r.read, "sp-a", pfx("10.0.0.0/8"), 24)
	if err != nil || !ok || pick != pfx("10.1.1.0/24") {
		t.Fatalf("= %s %v %v, want 10.1.1.0/24", pick, ok, err)
	}
	if len(r.reads) != 1 || checked.Around != "" {
		t.Fatalf("reads %v, checked %+v: want one full read", r.reads, checked)
	}
}

// Reading in pieces picks exactly what one read of the whole block picks,
// including a child block of the parent (a clash) and the parent's own
// parent (not one).
func TestPieces_PickWhatAWholeReadPicks(t *testing.T) {
	cases := [][]Used{
		eightBlock(),
		eightBlock(Network(KindBlock, "sp-a", "child", pfx("10.0.0.0/16"))),
		append(eightBlock(Network(KindBlock, "sp-a", "grand", pfx("0.0.0.0/0"))),
			Span(KindRange, "sp-c", "r", addr("10.0.0.0"), addr("10.2.3.4"))),
		eightBlock(Network(KindSubnet, "sp-b", "x", pfx("10.0.0.0/12")), Span(KindHost, "sp-a", "h", addr("10.16.0.9"), addr("10.16.0.9"))),
	}
	for i, items := range cases {
		for _, bits := range []int{8, 12, 16, 24, 30} {
			want, wantW, _, wok := NewSnapshot(nil, items...).NextFreePrefix("sp-a", pfx("10.0.0.0/8"), bits)
			r := &pieceReader{items: items}
			got, gotW, _, _, gok, err := nextFreeInPieces(r.read, "sp-a", pfx("10.0.0.0/8"), bits)
			if err != nil || got != want || gok != wok || len(gotW) != len(wantW) {
				t.Errorf("case %d /%d: pieces %s %v, whole %s %v (%v)", i, bits, got, gok, want, wok, err)
			}
		}
	}
}

// Over HTTP: a piece whose scoped subnet read fails falls back to a full read
// of the tenant (Around's rule), and that read answers for the rest of the
// block: no other piece is read.
func TestNextFreePrefixIn_FallsBackToAFullReadWhenAPieceIsIncomplete(t *testing.T) {
	f := goodTenant()
	f.lists["ipam/address_block"] = []string{`{"id":"b8","space":"sp-a","address":"10.0.0.0","cidr":8}`}
	f.lists["ipam/subnet"] = []string{`{"id":"s0","space":"sp-a","address":"10.0.0.0","cidr":16}`,
		`{"id":"s1","space":"sp-a","address":"10.1.0.0","cidr":24}`}
	h := f.handler(t)
	var mu sync.Mutex
	var subnetReads []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		filter := r.URL.Query().Get("_filter")
		if strings.HasSuffix(r.URL.Path, "/ipam/subnet") {
			mu.Lock()
			subnetReads = append(subnetReads, filter)
			mu.Unlock()
			if filter != "" {
				w.WriteHeader(500) // the scoped read cannot be shown whole
				return
			}
		}
		h(w, r)
	}))
	t.Cleanup(srv.Close)
	c := rest.New(srv.URL, rest.NewAuth("k", nil))
	pick, _, _, checked, ok, err := NextFreePrefixIn(c, false, "sp-a", pfx("10.0.0.0/8"), 24)
	if err != nil || !ok || pick != pfx("10.1.1.0/24") {
		t.Fatalf("= %s %v %v, want 10.1.1.0/24", pick, ok, err)
	}
	mu.Lock()
	defer mu.Unlock()
	// The scoped read is asked twice: rest asks a failed read once more.
	if len(subnetReads) != 3 || !strings.Contains(subnetReads[0], `address<="10.0.255.255"`) ||
		subnetReads[1] != subnetReads[0] || subnetReads[2] != "" {
		t.Fatalf("subnet reads = %q, want the first piece's scoped read (and its retry), then one full read", subnetReads)
	}
	if checked.Around != "" {
		t.Fatalf("checked.around = %q, want empty: the full read covered everything", checked.Around)
	}
}
