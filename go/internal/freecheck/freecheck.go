// Package freecheck is the one answer to "is this network or address free?".
// Every place that suggests or creates a network, a DHCP range, a reservation
// or a host address asks it, so none of them can offer something that clashes
// with what already exists.
//
// The rule (the owner's, 2026-11-16): a candidate is NOT free if it overlaps,
// in ANY IP space, an address block or subnet at any depth, a DHCP range, a
// reservation (fixed address) or a host address. The one exception is
// containment: a new network may sit inside its own parent block in the same
// space, and so inside that block's own parents. Only blocks contain: a new
// network inside or over a subnet is a clash.
//
// Addresses and DHCP ranges are checked against ranges, reservations and host
// addresses in every space, and never against networks: an address always sits
// inside a subnet, and a subnet that another space also uses was already there
// before the address, so refusing on it would refuse every address on a tenant
// whose spaces overlap.
//
// NEVER A PARTIAL ANSWER. Load refuses (returns an error) when any list cannot
// be shown to be complete, because a row it missed could be the clash.
package freecheck

import (
	"fmt"
	"math/big"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Kinds of thing that can hold an address, in the words the reasons use.
const (
	KindBlock       = "address block"
	KindSubnet      = "subnet"
	KindRange       = "DHCP range"
	KindReservation = "reservation"
	KindHost        = "host"
)

// Used is one existing thing holding addresses Lo to Hi (inclusive). Prefix is
// set for blocks and subnets only. Space is the IP space id.
type Used struct {
	Kind   string
	Space  string
	ID     string
	Lo, Hi netip.Addr
	Prefix netip.Prefix
}

// Network makes the Used for a block or subnet.
func Network(kind, space, id string, p netip.Prefix) Used {
	p = p.Masked()
	lo, hi := PrefixRange(p)
	return Used{Kind: kind, Space: space, ID: id, Lo: addrFromInt(lo, p.Addr().BitLen()), Hi: addrFromInt(hi, p.Addr().BitLen()), Prefix: p}
}

// Span makes the Used for a range, reservation or host address.
func Span(kind, space, id string, lo, hi netip.Addr) Used {
	return Used{Kind: kind, Space: space, ID: id, Lo: lo, Hi: hi}
}

func (u Used) isNetwork() bool { return u.Kind == KindBlock || u.Kind == KindSubnet }

// Counts is what was read, for the "checked" field of every preview. ReadAt is
// when; a preview's snapshot can be up to PreviewTTL old. Around, when set,
// says the read covered only those addresses (Apply's fresh read).
type Counts struct {
	Spaces       int       `json:"spaces"`
	Networks     int       `json:"networks"`
	Ranges       int       `json:"ranges"`
	Reservations int       `json:"reservations"`
	Hosts        int       `json:"hosts"`
	ReadAt       time.Time `json:"read_at"`
	Around       string    `json:"around,omitempty"`
}

// Map is Counts as a plain map, for the untyped result maps edit and provision
// build. age_seconds is how old the data is now; read_at is when it was read.
func (c Counts) Map() map[string]any {
	m := map[string]any{"spaces": c.Spaces, "networks": c.Networks, "ranges": c.Ranges,
		"reservations": c.Reservations, "hosts": c.Hosts}
	if !c.ReadAt.IsZero() {
		m["read_at"] = c.ReadAt.UTC().Format(time.RFC3339)
		m["age_seconds"] = int(time.Since(c.ReadAt).Seconds())
	}
	if c.Around != "" {
		m["around"] = c.Around
	}
	return m
}

// Age says in plain words how old the data is, for a preview's steps.
func (c Counts) Age() string {
	if c.ReadAt.IsZero() {
		return ""
	}
	n := int(time.Since(c.ReadAt).Seconds())
	switch {
	case n < 5:
		return "checked just now"
	case n < 120:
		return fmt.Sprintf("checked against what was read %d seconds ago", n)
	default:
		return fmt.Sprintf("checked against what was read %d minutes ago", n/60)
	}
}

// Skip is one candidate passed over, and why, in plain words.
type Skip struct {
	Candidate string `json:"candidate"`
	Reason    string `json:"reason"`
}

// SkipList turns skips into the []any the untyped result maps hold. It is
// never nil, so an empty list is sent as [] rather than null.
func SkipList(skips []Skip) []any {
	out := []any{}
	for _, s := range skips {
		out = append(out, map[string]any{"candidate": s.Candidate, "reason": s.Reason})
	}
	return out
}

// Result is a single check's answer. Reason is empty when Free is true.
type Result struct {
	Free   bool
	Reason string
}

// Snapshot is everything that was read, ready to check candidates against.
type Snapshot struct {
	Counts Counts
	items  []Used
	names  map[string]string
}

// NewSnapshot builds a Snapshot from items already read. names maps an IP space
// id to its name, for the reasons. Counts are taken from the items.
func NewSnapshot(names map[string]string, items ...Used) *Snapshot {
	s := &Snapshot{names: map[string]string{}}
	for k, v := range names {
		s.names[k] = v
	}
	s.Counts.Spaces = len(names)
	for _, u := range items {
		s.items = append(s.items, u)
		switch {
		case u.isNetwork():
			s.Counts.Networks++
		case u.Kind == KindRange:
			s.Counts.Ranges++
		case u.Kind == KindReservation:
			s.Counts.Reservations++
		case u.Kind == KindHost:
			s.Counts.Hosts++
		}
	}
	return s
}

// Merge is one snapshot holding everything the given reads saw, each item
// once (reads around neighbouring addresses can both see the same network).
// ReadAt is the oldest read's; Around lists every span read.
func Merge(snaps ...*Snapshot) *Snapshot {
	names := map[string]string{}
	seen := map[Used]bool{}
	var items []Used
	var at time.Time
	var around []string
	for _, s := range snaps {
		if s == nil {
			continue
		}
		for k, v := range s.names {
			names[k] = v
		}
		for _, u := range s.items {
			if !seen[u] {
				seen[u] = true
				items = append(items, u)
			}
		}
		if at.IsZero() || (!s.Counts.ReadAt.IsZero() && s.Counts.ReadAt.Before(at)) {
			at = s.Counts.ReadAt
		}
		if s.Counts.Around != "" {
			around = append(around, s.Counts.Around)
		}
	}
	m := NewSnapshot(names, items...)
	m.Counts.ReadAt = at
	m.Counts.Around = strings.Join(around, ", ")
	return m
}

// Add records something this run made (or would make, in a preview), so the
// next pick in the same run steps past it. It does not change Counts, which
// say what was read.
func (s *Snapshot) Add(u Used) { s.items = append(s.items, u) }

// Has says whether a network of kind with exactly prefix p is already in
// space: the same object, not a clash with it.
func (s *Snapshot) Has(kind, space string, p netip.Prefix) bool {
	p = p.Masked()
	for _, u := range s.items {
		if u.Kind == kind && u.Space == space && u.Prefix == p {
			return true
		}
	}
	return false
}

// Without is a copy leaving out the item with this id: the object a run just
// made, read back by an Apply check, is not a clash with itself.
func (s *Snapshot) Without(id string) *Snapshot {
	c := *s
	c.items = nil
	for _, u := range s.items {
		if id == "" || u.ID != id {
			c.items = append(c.items, u)
		}
	}
	return &c
}

// Clone is a copy that Add on one does not change the other, for trying a
// plan before committing to it.
func (s *Snapshot) Clone() *Snapshot {
	c := *s
	c.items = append([]Used(nil), s.items...)
	return &c
}

func (s *Snapshot) spaceName(id string) string {
	if n := strings.TrimSpace(s.names[id]); n != "" {
		return n
	}
	if id == "" {
		return "an IP space"
	}
	return id
}

// reason says, in plain words, what already uses the addresses.
func (s *Snapshot) reason(u Used) string {
	article := "a"
	if u.Kind == KindBlock {
		article = "an"
	}
	what := u.Lo.String()
	switch {
	case u.isNetwork():
		what = u.Prefix.String()
	case u.Lo != u.Hi:
		what = u.Lo.String() + " to " + u.Hi.String()
	}
	return fmt.Sprintf("%s %s in %s already uses %s", article, u.Kind, s.spaceName(u.Space), what)
}

func overlaps(u Used, lo, hi netip.Addr) bool {
	if u.Lo.BitLen() != lo.BitLen() {
		return false
	}
	return u.Lo.Compare(hi) <= 0 && lo.Compare(u.Hi) <= 0
}

// clashes lists every item that makes the candidate not free, lowest first.
func (s *Snapshot) prefixClashes(space string, p, parent netip.Prefix) []Used {
	p = p.Masked()
	lo, hi := Bounds(p)
	// anchor is what an allowed container must hold: the chosen parent and so
	// its own parents, or, with none chosen (a block made inside an existing
	// chain of blocks), the candidate itself. Only a block can contain: a new
	// network inside or over a subnet is always a clash.
	anchor := p
	if parent.IsValid() {
		anchor = parent.Masked()
	}
	var out []Used
	for _, u := range s.items {
		if !overlaps(u, lo, hi) {
			continue
		}
		if u.Kind == KindBlock && u.Space == space && u.Prefix != p &&
			u.Prefix.Bits() <= anchor.Bits() && u.Prefix.Contains(anchor.Addr()) {
			continue // its own parent block, or a parent of that
		}
		out = append(out, u)
	}
	sortUsed(out)
	return out
}

func (s *Snapshot) spanClashes(lo, hi netip.Addr) []Used {
	var out []Used
	for _, u := range s.items {
		if !u.isNetwork() && overlaps(u, lo, hi) {
			out = append(out, u)
		}
	}
	sortUsed(out)
	return out
}

func sortUsed(us []Used) {
	sort.SliceStable(us, func(i, j int) bool { return us[i].Lo.Compare(us[j].Lo) < 0 })
}

// CheckPrefix answers whether network p, to be made in space inside parent
// (the zero Prefix when no parent was chosen), is free.
func (s *Snapshot) CheckPrefix(space string, p, parent netip.Prefix) Result {
	if c := s.prefixClashes(space, p, parent); len(c) > 0 {
		return Result{Reason: s.reason(c[0])}
	}
	return Result{Free: true}
}

// CheckSpan answers whether addresses lo to hi (a DHCP range) are free.
func (s *Snapshot) CheckSpan(lo, hi netip.Addr) Result {
	if c := s.spanClashes(lo, hi); len(c) > 0 {
		return Result{Reason: s.reason(c[0])}
	}
	return Result{Free: true}
}

// CheckAddr answers whether one address is free.
func (s *Snapshot) CheckAddr(a netip.Addr) Result { return s.CheckSpan(a, a) }

// maxSkips caps the skipped list a preview carries; the pick is still exact.
const maxSkips = 20

// NextFreePrefix is the lowest /bits inside parent, aligned to its own size,
// that CheckPrefix calls free, with the candidates passed over on the way. ok
// is false when none is left.
func (s *Snapshot) NextFreePrefix(space string, parent netip.Prefix, bits int) (pick netip.Prefix, skipped []Skip, ok bool) {
	parent = parent.Masked()
	total := parent.Addr().BitLen()
	if !parent.IsValid() || bits < parent.Bits() || bits > total {
		return netip.Prefix{}, nil, false
	}
	size := new(big.Int).Lsh(big.NewInt(1), uint(total-bits))
	cand, end := PrefixRange(parent)
	one := big.NewInt(1)
	for {
		candEnd := new(big.Int).Sub(new(big.Int).Add(cand, size), one)
		if candEnd.Cmp(end) > 0 {
			return netip.Prefix{}, skipped, false
		}
		p := netip.PrefixFrom(addrFromInt(cand, total), bits)
		c := s.prefixClashes(space, p, parent)
		if len(c) == 0 {
			return p, skipped, true
		}
		if len(skipped) < maxSkips {
			skipped = append(skipped, Skip{Candidate: p.String(), Reason: s.reason(c[0])})
		}
		// Step past every clash, then up to the next aligned start. Each
		// step passes at least one item, so the loop ends.
		next := new(big.Int).Add(candEnd, one)
		for _, u := range c {
			if h := new(big.Int).Add(intOf(u.Hi), one); h.Cmp(next) > 0 {
				next = h
			}
		}
		if rem := new(big.Int).Mod(next, size); rem.Sign() != 0 {
			next.Add(next, new(big.Int).Sub(size, rem))
		}
		cand = next
	}
}

// NextFreeAddr is the first address at or after from, inside within, that
// CheckAddr calls free, with the addresses passed over on the way. For IPv4 it
// never offers within's own network or broadcast address.
func (s *Snapshot) NextFreeAddr(within netip.Prefix, from netip.Addr) (pick netip.Addr, skipped []Skip, ok bool) {
	within = within.Masked()
	lo, hi := Bounds(within)
	if within.Addr().Is4() && within.Bits() <= 30 {
		lo, hi = lo.Next(), hi.Prev()
	}
	a := from
	if a.Compare(lo) < 0 {
		a = lo
	}
	for a.IsValid() && within.Contains(a) && a.Compare(hi) <= 0 {
		c := s.spanClashes(a, a)
		if len(c) == 0 {
			return a, skipped, true
		}
		if len(skipped) < maxSkips {
			skipped = append(skipped, Skip{Candidate: a.String(), Reason: s.reason(c[0])})
		}
		// Past the widest clash in one step, so a 200-address range is one skip.
		next := a
		for _, u := range c {
			if u.Hi.Compare(next) > 0 {
				next = u.Hi
			}
		}
		a = next.Next()
	}
	return netip.Addr{}, skipped, false
}

// PrefixOf reads Infoblox's {"address": "10.0.0.0", "cidr": 24} pair. It is
// the one copy; dashboard.PrefixOf and server's prefixOf call it.
func PrefixOf(m map[string]any) (netip.Prefix, bool) {
	a, _ := m["address"].(string)
	addr, err := netip.ParseAddr(strings.TrimSpace(a))
	if err != nil {
		return netip.Prefix{}, false
	}
	var bits int
	switch v := m["cidr"].(type) {
	case float64:
		bits = int(v)
	case int:
		bits = v
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

// FirstFreePrefix returns the lowest /bits inside block, aligned to its own
// size, that overlaps none of used. Addresses are handled as big integers so
// IPv4 and IPv6 blocks take the same path. It knows nothing of spaces, ranges
// or hosts; NextFreePrefix is the full check.
func FirstFreePrefix(block netip.Prefix, used []netip.Prefix, bits int) (netip.Prefix, bool) {
	var items []Used
	for _, u := range used {
		items = append(items, Network(KindSubnet, "other", "", u))
	}
	p, _, ok := NewSnapshot(nil, items...).NextFreePrefix("", block, bits)
	return p, ok
}

// PrefixRange is p's first and last address as integers.
func PrefixRange(p netip.Prefix) (lo, hi *big.Int) {
	p = p.Masked()
	lo = new(big.Int).SetBytes(p.Addr().AsSlice())
	host := uint(p.Addr().BitLen() - p.Bits())
	hi = new(big.Int).Add(lo, new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), host), big.NewInt(1)))
	return lo, hi
}

// Bounds is p's first and last address.
func Bounds(p netip.Prefix) (lo, hi netip.Addr) {
	l, h := PrefixRange(p)
	return addrFromInt(l, p.Addr().BitLen()), addrFromInt(h, p.Addr().BitLen())
}

func intOf(a netip.Addr) *big.Int { return new(big.Int).SetBytes(a.AsSlice()) }

func addrFromInt(n *big.Int, bitLen int) netip.Addr {
	b := make([]byte, bitLen/8)
	n.FillBytes(b)
	a, _ := netip.AddrFromSlice(b)
	return a
}
