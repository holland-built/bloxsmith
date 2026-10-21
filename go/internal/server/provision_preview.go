package server

import (
	"fmt"
	"math/big"
	"net/netip"
	"sort"
	"strconv"
	"strings"

	"bloxsmith/internal/rest"
)

// previewListLimit bounds the child read. A block with more children than this
// cannot be worked out from one page, so the preview says it does not know
// rather than guess from a partial list.
const previewListLimit = 5000

// guessNextSubnet works out the subnet a live Provision would most likely
// create: the lowest free, aligned /bits inside the block, after every subnet
// and child block already in it. Infoblox's own look-only call
// (GET .../nextavailablesubnet) would say for sure, but on licences without
// Federation it answers 400 "Federation is not enabled for the given
// license_uid" (seen 2026-10-21), so the preview reads the block and works it
// out. Infoblox makes the final pick on Provision, so callers label the result
// "probably".
//
// It returns the block's own prefix too, so the preview can name the block in
// plain numbers. An empty next prefix with a nil error means the block is full.
func guessNextSubnet(c *rest.Client, blockPath, blockID string, bits int) (block, next netip.Prefix, err error) {
	_, body, err := c.GetPageStrict(blockPath, map[string]string{"_fields": "address,cidr"})
	if err != nil {
		return block, next, err
	}
	res, _ := body["result"].(map[string]any)
	block, ok := prefixOf(res)
	if !ok {
		return block, next, fmt.Errorf("the block has no readable address")
	}
	esc, err := rest.CSPQ(blockID)
	if err != nil {
		return block, next, err
	}
	var used []netip.Prefix
	for _, path := range []string{"/api/ddi/v1/ipam/subnet", "/api/ddi/v1/ipam/address_block"} {
		rows, err := c.GetStrict(path, map[string]string{
			"_filter": `parent=="` + esc + `"`, "_fields": "address,cidr",
			"_limit": strconv.Itoa(previewListLimit)})
		if err != nil {
			return block, next, err
		}
		if len(rows) >= previewListLimit {
			return block, next, fmt.Errorf("the block holds more than %d objects", previewListLimit)
		}
		for _, r := range rows {
			m, _ := r.(map[string]any)
			if p, ok := prefixOf(m); ok {
				used = append(used, p)
			}
		}
	}
	next, _ = firstFreePrefix(block, used, bits)
	return block, next, nil
}

// prefixOf reads Infoblox's {"address": "10.0.0.0", "cidr": 24} pair.
func prefixOf(m map[string]any) (netip.Prefix, bool) {
	a, _ := m["address"].(string)
	addr, err := netip.ParseAddr(strings.TrimSpace(a))
	if err != nil {
		return netip.Prefix{}, false
	}
	var bits int
	switch v := m["cidr"].(type) {
	case float64:
		bits = int(v)
	case string:
		n, err := strconv.Atoi(v)
		if err != nil {
			return netip.Prefix{}, false
		}
		bits = n
	default:
		return netip.Prefix{}, false
	}
	p, err := addr.Prefix(bits)
	return p, err == nil
}

// firstFreePrefix returns the lowest /bits inside block, aligned to its own
// size, that overlaps none of used. Addresses are handled as big integers so
// IPv4 and IPv6 blocks take the same path.
func firstFreePrefix(block netip.Prefix, used []netip.Prefix, bits int) (netip.Prefix, bool) {
	total := block.Addr().BitLen()
	if bits < block.Bits() || bits > total {
		return netip.Prefix{}, false
	}
	size := new(big.Int).Lsh(big.NewInt(1), uint(total-bits))
	start, end := prefixRange(block)

	type span struct{ lo, hi *big.Int }
	var spans []span
	for _, u := range used {
		if u.Addr().BitLen() != total {
			continue
		}
		lo, hi := prefixRange(u)
		spans = append(spans, span{lo, hi})
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].lo.Cmp(spans[j].lo) < 0 })

	cand := new(big.Int).Set(start)
	for _, s := range spans {
		candEnd := new(big.Int).Sub(new(big.Int).Add(cand, size), big.NewInt(1))
		if candEnd.Cmp(s.lo) < 0 {
			break // fits before this one
		}
		if s.hi.Cmp(cand) >= 0 {
			// move past the used span, then up to the next aligned start
			cand.Add(s.hi, big.NewInt(1))
			if rem := new(big.Int).Mod(cand, size); rem.Sign() != 0 {
				cand.Add(cand, new(big.Int).Sub(size, rem))
			}
		}
	}
	candEnd := new(big.Int).Sub(new(big.Int).Add(cand, size), big.NewInt(1))
	if candEnd.Cmp(end) > 0 {
		return netip.Prefix{}, false
	}
	return netip.PrefixFrom(addrFromInt(cand, total), bits), true
}

func prefixRange(p netip.Prefix) (lo, hi *big.Int) {
	p = p.Masked()
	lo = new(big.Int).SetBytes(p.Addr().AsSlice())
	host := uint(p.Addr().BitLen() - p.Bits())
	hi = new(big.Int).Add(lo, new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), host), big.NewInt(1)))
	return lo, hi
}

func addrFromInt(n *big.Int, bitLen int) netip.Addr {
	b := make([]byte, bitLen/8)
	n.FillBytes(b)
	a, _ := netip.AddrFromSlice(b)
	return a
}
