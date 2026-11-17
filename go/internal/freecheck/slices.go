package freecheck

import (
	"math/big"
	"net/netip"

	"bloxsmith/internal/rest"
)

// A block like 10.0.0.0/8 can hold most of a tenant, so reading everything
// that overlaps it is close to a full read (about 40 s cold on the largest
// tenant). NextFreePrefixIn reads it in pieces, the first of this size and
// each later one up to twice the one before, lowest first, and stops at the
// first piece with room.
const (
	pieceBits4 = 16
	pieceBits6 = 48
	// maxSharedPieces bounds the search for a clean candidate once a warned
	// one is in hand (see nextFreeInPieces).
	maxSharedPieces = 2
)

// NextFreePrefixIn is NextFreePrefix over fresh reads: the lowest free /bits
// in parent, reading only what overlaps one piece of parent at a time (in
// every IP space) and stopping at the first piece that has a free one. A
// preview (dry) may reuse each piece's read for PreviewTTL. A piece whose read
// cannot be shown whole falls back to a full read, which then answers for the
// rest of parent. checked says what was read: Around covers only the pieces
// read, or is empty after a full read. ok is false when parent is full, and
// then every piece has been read.
func NextFreePrefixIn(c *rest.Client, dry bool, space string, parent netip.Prefix, bits int) (pick netip.Prefix, warn []Warning, skipped []Skip, checked Counts, ok bool, err error) {
	return nextFreeInPieces(func(lo, hi netip.Addr) (*Snapshot, error) {
		return For(c, All, dry, lo, hi)
	}, space, parent, bits)
}

func nextFreeInPieces(read func(lo, hi netip.Addr) (*Snapshot, error), space string, parent netip.Prefix, bits int) (pick netip.Prefix, warn []Warning, skipped []Skip, checked Counts, ok bool, err error) {
	parent = parent.Masked()
	total := parent.Addr().BitLen()
	if !parent.IsValid() || bits < parent.Bits() || bits > total {
		return netip.Prefix{}, nil, nil, checked, false, nil
	}
	piece := pieceBits4
	if total == 128 {
		piece = pieceBits6
	}
	// A piece is never smaller than the candidate, nor bigger than parent.
	piece = min(max(piece, parent.Bits()), bits)

	var reads []*Snapshot
	var readLo, readHi netip.Addr // the first piece read, and the last
	// shared is the first free candidate that something in another IP space
	// overlaps. It does not stop the search for a clean one, but that search
	// is bounded: after the piece it was found in, at most maxSharedPieces
	// more pieces are read (each up to twice the size of the one before).
	// Once one is held, an other-space object is stepped over like a clash,
	// so one that covers the rest of parent (another space's 10.0.0.0/8, say)
	// ends the search at once.
	var shared *sharedPick
	var sharedSkipped []Skip
	since := 0
	from, end := PrefixRange(parent)
	for misses := 0; from.Cmp(end) <= 0; misses++ {
		// Each piece after one with no room is up to twice as big, so a
		// block full of small subnets is not read in 256 slow pieces: a full
		// /8 takes about ten reads. A piece starts at from, so it is only as
		// big as from's alignment allows.
		size := max(piece-misses, parent.Bits())
		for size < piece {
			if p := netip.PrefixFrom(addrFromInt(from, total), size); p.Masked().Addr() == p.Addr() {
				break
			}
			size++
		}
		within := netip.PrefixFrom(addrFromInt(from, total), size).Masked()
		lo, hi := Bounds(within)
		snap, rerr := read(lo, hi)
		if rerr != nil {
			return netip.Prefix{}, nil, nil, checked, false, rerr
		}
		reads = append(reads, snap)
		if !readLo.IsValid() {
			readLo = lo
		}
		readHi = hi
		full := snap.Counts.Around == ""
		if full {
			within = parent // a full read holds everything, so it answers for the rest
		}
		held := shared != nil
		p, found, sh, sk, resume := snap.nextFreeWithin(space, parent, within, bits, from, held)
		if sh != nil {
			shared = sh
			sharedSkipped = append(append([]Skip(nil), skipped...), sk[:sh.skips]...)
			if len(sharedSkipped) > maxSkips {
				sharedSkipped = sharedSkipped[:maxSkips]
			}
		}
		for _, s := range sk {
			if len(skipped) < maxSkips {
				skipped = append(skipped, s)
			}
		}
		if found {
			return p, nil, skipped, pieceCounts(reads, readLo, readHi), true, nil
		}
		if full || resume == nil {
			break
		}
		if held {
			if since++; since >= maxSharedPieces {
				break
			}
		}
		// Past every clash met, so a piece a big subnet covers is not read.
		from = new(big.Int).Set(resume)
	}
	if shared != nil {
		return shared.pick, shared.warn, sharedSkipped, pieceCounts(reads, readLo, readHi), true, nil
	}
	return netip.Prefix{}, nil, skipped, pieceCounts(reads, readLo, readHi), false, nil
}

// pieceCounts is what the piece reads saw together. Around names the span
// from the first piece read to the last, or is empty when one was a full read.
func pieceCounts(reads []*Snapshot, lo, hi netip.Addr) Counts {
	m := Merge(reads...)
	m.Counts.Around = ""
	for _, s := range reads {
		if s.Counts.Around == "" {
			return m.Counts
		}
	}
	if lo.IsValid() {
		m.Counts.Around = lo.String() + " to " + hi.String()
	}
	return m.Counts
}
