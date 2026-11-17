package freecheck

import (
	"fmt"
	"net/netip"
	"strings"
	"testing"
)

var netipPrefixZero netip.Prefix

// The owner's rule of 2026-11-17: overlap with something only in ANOTHER IP
// space is not a clash. The candidate is offered, with a warning naming the
// space and the object. Same-space overlap is still a clash.

func TestShared_SameSpaceIsStillRefused(t *testing.T) {
	s := tenant()
	if r := s.CheckPrefix("sp-a", pfx("10.16.8.0/24"), pfx("10.16.0.0/20")); r.Free {
		t.Fatalf("a same-space subnet is a clash: %+v", r)
	}
	for _, a := range []string{"10.16.8.5", "10.16.8.6", "10.16.8.50"} {
		if r := s.CheckAddr("sp-a", addr(a)); r.Free {
			t.Fatalf("%s is used in the same space: %+v", a, r)
		}
	}
	if r := s.CheckSpan("sp-a", addr("10.16.8.1"), addr("10.16.8.9")); r.Free {
		t.Fatalf("a range over a same-space reservation is a clash: %+v", r)
	}
}

func TestShared_OtherSpaceIsOfferedWithAWarning(t *testing.T) {
	s := tenant()
	// sp-b's subnet sits exactly on the candidate: offered, with a warning.
	r := s.CheckPrefix("sp-a", pfx("10.16.32.0/24"), pfx("10.16.0.0/16"))
	want := []Warning{{Candidate: "10.16.32.0/24", Space: "corp-emea", Object: "10.16.32.0/24", Kind: KindSubnet, Contains: true}}
	if !r.Free || fmt.Sprint(r.Warnings) != fmt.Sprint(want) {
		t.Fatalf("CheckPrefix = %+v, want free with %+v", r, want)
	}
	// A network in sp-b inside sp-a's block: the block contains it.
	r = s.CheckPrefix("sp-b", pfx("10.16.64.0/24"), netipPrefixZero)
	want = []Warning{{Candidate: "10.16.64.0/24", Space: "corp-amer", Object: "10.16.0.0/16", Kind: KindBlock, Contains: true}}
	if !r.Free || fmt.Sprint(r.Warnings) != fmt.Sprint(want) {
		t.Fatalf("CheckPrefix = %+v, want free with %+v", r, want)
	}
	// A bigger sp-b network over sp-a's child block only overlaps it.
	r = s.CheckPrefix("sp-b", pfx("10.16.0.0/19"), netipPrefixZero)
	if !r.Free || len(r.Warnings) == 0 {
		t.Fatalf("CheckPrefix = %+v, want free with warnings", r)
	}
	for _, w := range r.Warnings {
		if w.Object == "10.16.0.0/20" && w.Contains {
			t.Fatalf("the /20 is inside the candidate, not around it: %+v", w)
		}
	}
	// An address sp-a reserves, offered in sp-b.
	r = s.CheckAddr("sp-b", addr("10.16.8.5"))
	want = []Warning{{Candidate: "10.16.8.5", Space: "corp-amer", Object: "10.16.8.5", Kind: KindReservation, Contains: true}}
	if !r.Free || fmt.Sprint(r.Warnings) != fmt.Sprint(want) {
		t.Fatalf("CheckAddr = %+v, want free with %+v", r, want)
	}
	// A DHCP range in sp-b over sp-a's range and reservation.
	r = s.CheckSpan("sp-b", addr("10.16.8.1"), addr("10.16.8.20"))
	if !r.Free || len(r.Warnings) != 3 || r.Warnings[0].Candidate != "10.16.8.1 to 10.16.8.20" {
		t.Fatalf("CheckSpan = %+v, want free with three warnings", r)
	}
	// Something made earlier in the same run, whose space is not recorded,
	// counts as the same space: still a clash.
	s.Add(Span(KindHost, "", "", addr("10.16.9.9"), addr("10.16.9.9")))
	if r := s.CheckAddr("sp-b", addr("10.16.9.9")); r.Free {
		t.Fatalf("an item with no space is a clash: %+v", r)
	}
	// A candidate with no space checks every space as its own.
	if r := s.CheckAddr("", addr("10.16.8.5")); r.Free {
		t.Fatalf("no space given: every space is a clash: %+v", r)
	}
}

func TestShared_CleanIsPreferredOverWarned(t *testing.T) {
	s := NewSnapshot(map[string]string{"sp-a": "corp", "sp-b": "lab"},
		Network(KindBlock, "sp-a", "top", pfx("10.0.0.0/16")),
		Network(KindSubnet, "sp-b", "lab1", pfx("10.0.0.0/24")),
		Network(KindSubnet, "sp-a", "own", pfx("10.0.1.0/24")),
	)
	pick, warns, skipped, ok := s.NextFreePrefix("sp-a", pfx("10.0.0.0/16"), 24)
	if !ok || pick != pfx("10.0.2.0/24") || len(warns) != 0 {
		t.Fatalf("pick = %s %v warns %+v, want the clean 10.0.2.0/24", pick, ok, warns)
	}
	if len(skipped) != 2 || skipped[0].Candidate != "10.0.0.0/24" || skipped[1].Candidate != "10.0.1.0/24" {
		t.Fatalf("skipped = %+v, want the shared one then the clash", skipped)
	}

	// No clean one anywhere: the first warned one is offered.
	s = NewSnapshot(map[string]string{"sp-a": "corp", "sp-b": "default-TK-lab"},
		Network(KindBlock, "sp-a", "top", pfx("10.0.0.0/16")),
		Network(KindBlock, "sp-b", "lab", pfx("10.0.0.0/8")),
		Network(KindSubnet, "sp-a", "own", pfx("10.0.0.0/24")),
	)
	pick, warns, skipped, ok = s.NextFreePrefix("sp-a", pfx("10.0.0.0/16"), 24)
	want := []Warning{{Candidate: "10.0.1.0/24", Space: "default-TK-lab", Object: "10.0.0.0/8", Kind: KindBlock, Contains: true}}
	if !ok || pick != pfx("10.0.1.0/24") || fmt.Sprint(warns) != fmt.Sprint(want) {
		t.Fatalf("pick = %s %v warns %+v, want 10.0.1.0/24 with %+v", pick, ok, warns, want)
	}
	if len(skipped) != 1 || skipped[0].Candidate != "10.0.0.0/24" {
		t.Fatalf("skipped = %+v, want only the same-space clash", skipped)
	}

	// Addresses: a clean one after a shared one is preferred.
	s = NewSnapshot(map[string]string{"sp-a": "corp", "sp-b": "lab"},
		Span(KindReservation, "sp-b", "r", addr("10.0.0.1"), addr("10.0.0.1")),
		Span(KindHost, "sp-a", "h", addr("10.0.0.2"), addr("10.0.0.2")),
	)
	a, aw, _, ok := s.NextFreeAddr("sp-a", pfx("10.0.0.0/24"), addr("10.0.0.1"))
	if !ok || a != addr("10.0.0.3") || len(aw) != 0 {
		t.Fatalf("addr = %s %v %+v, want the clean 10.0.0.3", a, ok, aw)
	}
	// Every address shared: the first is offered, with its warning.
	s.Add(Span(KindRange, "sp-b", "rng", addr("10.0.0.3"), addr("10.0.0.254")))
	a, aw, _, ok = s.NextFreeAddr("sp-a", pfx("10.0.0.0/24"), addr("10.0.0.1"))
	if !ok || a != addr("10.0.0.1") || len(aw) != 1 || aw[0].Kind != KindReservation {
		t.Fatalf("addr = %s %v %+v, want 10.0.0.1 with the reservation warning", a, ok, aw)
	}
}

// The live tenant's shape: another space holds all of 10.0.0.0/8. A subnet
// preview in a 10.x block is offered, with that warning, after reading one
// piece: the warning covers the rest of the block, so no clean one can exist.
func TestShared_PiecesOfferTheWarnedOneWhenAnotherSpaceHoldsItAll(t *testing.T) {
	r := &pieceReader{items: []Used{
		Network(KindBlock, "sp-a", "top", pfx("10.0.0.0/8")),
		Network(KindBlock, "sp-lab", "lab", pfx("10.0.0.0/8")),
	}}
	pick, warns, _, _, ok, err := nextFreeInPieces(r.read, "sp-a", pfx("10.0.0.0/8"), 24)
	if err != nil || !ok || pick != pfx("10.0.0.0/24") || len(warns) != 1 || warns[0].Object != "10.0.0.0/8" || !warns[0].Contains {
		t.Fatalf("= %s %v %+v %v, want 10.0.0.0/24 sitting inside 10.0.0.0/8", pick, ok, warns, err)
	}
	if len(r.reads) != 1 {
		t.Fatalf("reads = %v, want one", r.reads)
	}
}

// A piece holding only a warned candidate does not stop the search: a clean
// one in a later piece wins.
func TestShared_PiecesFindACleanOneInALaterPiece(t *testing.T) {
	r := &pieceReader{items: eightBlock(Network(KindSubnet, "sp-lab", "lab", pfx("10.0.0.0/16")))}
	pick, warns, _, _, ok, err := nextFreeInPieces(r.read, "sp-a", pfx("10.0.0.0/8"), 24)
	if err != nil || !ok || pick != pfx("10.1.0.0/24") || len(warns) != 0 {
		t.Fatalf("= %s %v %+v %v, want the clean 10.1.0.0/24", pick, ok, warns, err)
	}
}

// A warned candidate does not stop the search: other-space networks over the
// first pieces are stepped over, and the clean 10.4.0.0/24 behind them wins.
func TestShared_PiecesKeepLookingPastOtherSpaceNetworks(t *testing.T) {
	r := &pieceReader{items: eightBlock(
		Network(KindSubnet, "sp-lab", "a", pfx("10.0.0.0/16")),
		Network(KindSubnet, "sp-lab", "b", pfx("10.1.0.0/16")),
		Network(KindSubnet, "sp-lab", "c", pfx("10.2.0.0/15")))}
	pick, warns, _, _, ok, err := nextFreeInPieces(r.read, "sp-a", pfx("10.0.0.0/8"), 24)
	if err != nil || !ok || pick != pfx("10.4.0.0/24") || len(warns) != 0 {
		t.Fatalf("= %s %v %+v %v, want the clean 10.4.0.0/24", pick, ok, warns, err)
	}
	if len(r.reads) > 4 {
		t.Fatalf("reads = %v, want at most 4: each other-space network is stepped over", r.reads)
	}
}

// With no clean one anywhere, the whole block is searched and the first warned
// one is offered, in few reads: the pieces grow after each one with no room.
func TestShared_PiecesSearchTheWholeBlockForACleanOne(t *testing.T) {
	var items []Used
	for i := 0; i < 256; i++ {
		items = append(items, Network(KindSubnet, "sp-lab", fmt.Sprint(i), pfx(fmt.Sprintf("10.%d.0.0/16", i))))
	}
	r := &pieceReader{items: eightBlock(items...)}
	pick, warns, _, _, ok, err := nextFreeInPieces(r.read, "sp-a", pfx("10.0.0.0/8"), 24)
	if err != nil || !ok || pick != pfx("10.0.0.0/24") || len(warns) != 1 {
		t.Fatalf("= %s %v %+v %v, want the first warned 10.0.0.0/24", pick, ok, warns, err)
	}
	if len(r.reads) > 10 {
		t.Fatalf("%d reads, want at most 10", len(r.reads))
	}
	if last := r.reads[len(r.reads)-1]; !strings.HasSuffix(last, "10.255.255.255") {
		t.Fatalf("reads = %v, want the block read to its end", r.reads)
	}
}

func TestShared_CountsAndLists(t *testing.T) {
	ws := []Warning{
		{Candidate: "10.0.0.0/24", Space: "a", Object: "10.0.0.0/8", Kind: KindBlock, Contains: true},
		{Candidate: "10.0.0.0/24", Space: "b", Object: "10.0.0.0/16", Kind: KindSubnet, Contains: true},
		{Candidate: "10.0.0.9", Space: "a", Object: "10.0.0.9", Kind: KindHost, Contains: true},
	}
	if m := (Counts{}).MapWith(ws); m["shared"] != 2 {
		t.Fatalf("shared = %v, want 2 candidates", m["shared"])
	}
	if l := WarnList(nil); l == nil || len(l) != 0 {
		t.Fatalf("WarnList(nil) = %#v, want []", l)
	}
}
