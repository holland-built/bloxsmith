package server

import (
	"fmt"
	"net/netip"

	"bloxsmith/internal/freecheck"
	"bloxsmith/internal/rest"
)

// guessNextSubnet works out the subnet a live Provision would most likely
// create: the lowest free, aligned /bits inside the block. Free is
// freecheck's rule: nothing in any IP space overlaps it (blocks and subnets at
// any depth, DHCP ranges, reservations, host addresses), except the block
// itself and its own parents. Infoblox's own look-only call
// (GET .../nextavailablesubnet) would say for sure, but on licences without
// Federation it answers 400 "Federation is not enabled for the given
// license_uid" (seen 2026-10-21), and it only knows the block's own space.
// Infoblox makes the final pick on Provision, so callers label the result
// "probably".
//
// It returns the block's own prefix too, so the preview can name the block in
// plain numbers, and what was checked and skipped. An empty next prefix with a
// nil error means the block is full. If the inventory cannot be read in full
// it is an error: nothing is suggested.
func guessNextSubnet(c *rest.Client, blockPath, blockID string, bits int) (block, next netip.Prefix, checked freecheck.Counts, skipped []freecheck.Skip, err error) {
	block, space, err := blockOf(c, blockPath)
	if err != nil {
		return block, next, checked, nil, err
	}
	// A preview: a read of only what overlaps the block, in every IP space,
	// shared for up to PreviewTTL.
	lo, hi := freecheck.Bounds(block.Masked())
	snap, err := freecheck.For(c, freecheck.All, true, lo, hi)
	if err != nil {
		return block, next, checked, nil, fmt.Errorf("%s", freecheck.Public(err))
	}
	next, skipped, _ = snap.NextFreePrefix(space, block, bits)
	return block, next, snap.Counts, skipped, nil
}

// prefixOf reads Infoblox's {"address": "10.0.0.0", "cidr": 24} pair. The one
// copy is freecheck.PrefixOf.
func prefixOf(m map[string]any) (netip.Prefix, bool) { return freecheck.PrefixOf(m) }

// firstFreePrefix is freecheck.FirstFreePrefix, kept for its callers.
func firstFreePrefix(block netip.Prefix, used []netip.Prefix, bits int) (netip.Prefix, bool) {
	return freecheck.FirstFreePrefix(block, used, bits)
}
