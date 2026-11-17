// Package freecheck is the one answer to "is this network or address free?".
// Every place that suggests or creates a network, a DHCP range, a reservation
// or a host address asks it, so none of them can offer something that clashes
// with what already exists.
//
// The rule (the owner's, 2026-11-16): a candidate is NOT free if it overlaps,
// in its own IP space, an address block or subnet at any depth, a DHCP range, a
// reservation (fixed address) or a host address. The one exception is
// containment: a new network may sit inside its own parent block in the same
// space, and so inside that block's own parents. Only blocks contain: a new
// network inside or over a subnet is a clash.
//
// Overlap with something only in ANOTHER IP space (the owner's, 2026-11-17) is
// not a clash: the candidate is offered with Warnings naming the space and the
// object, because spaces kept apart, like a lab, may reuse addresses. A search
// prefers a candidate with no warnings and offers a warned one only when no
// clean one exists. An item whose space is not known (one a run made itself)
// and a candidate checked with no space count as the same space: a clash.
//
// Addresses and DHCP ranges are checked against ranges, reservations and host
// addresses, and never against networks: an address always sits inside a
// subnet, and a subnet that another space also uses was already there before
// the address, so even a warning on it would be on every address of a tenant
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

// Warning is one thing in ANOTHER IP space that overlaps a candidate on offer.
// It is not a clash: the spaces may be kept apart, like a separate lab. Space
// is the space's name, Object the thing's addresses ("10.0.0.0/8"), and
// Contains says whether it holds the whole candidate ("sits inside").
type Warning struct {
	Candidate string `json:"candidate"`
	Space     string `json:"space"`
	Object    string `json:"object"`
	Kind      string `json:"kind"`
	Contains  bool   `json:"contains"`
}

// WarnList turns warnings into the []any the untyped result maps hold, never
// nil, like SkipList.
func WarnList(ws []Warning) []any {
	out := []any{}
	for _, w := range ws {
		out = append(out, map[string]any{"candidate": w.Candidate, "space": w.Space, "object": w.Object,
			"kind": w.Kind, "contains": w.Contains})
	}
	return out
}

// Shared is how many candidates on offer carry a warning: the "shared" count
// of a preview's checked field.
func Shared(ws []Warning) int {
	seen := map[string]bool{}
	for _, w := range ws {
		seen[w.Candidate] = true
	}
	return len(seen)
}

// MapWith is Map with "shared" added: how many candidates on offer overlap
// something in another IP space (Shared).
func (c Counts) MapWith(ws []Warning) map[string]any {
	m := c.Map()
	m["shared"] = Shared(ws)
	return m
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
// Warnings lists what overlaps the candidate in other IP spaces only: not a
// clash, but said under the offer.
type Result struct {
	Free     bool
	Reason   string
	Warnings []Warning
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

// what is u's addresses in plain words: "10.0.0.0/8", "10.0.0.5" or
// "10.0.0.10 to 10.0.0.200".
func what(u Used) string {
	switch {
	case u.isNetwork():
		return u.Prefix.String()
	case u.Lo != u.Hi:
		return u.Lo.String() + " to " + u.Hi.String()
	}
	return u.Lo.String()
}

// reason says, in plain words, what already uses the addresses.
func (s *Snapshot) reason(u Used) string {
	article := "a"
	if u.Kind == KindBlock {
		article = "an"
	}
	return fmt.Sprintf("%s %s in %s already uses %s", article, u.Kind, s.spaceName(u.Space), what(u))
}

// maxWarnings caps the warnings one candidate carries.
const maxWarnings = 5

// warnings turns the other-space items overlapping candidate (lo..hi) into
// Warnings.
func (s *Snapshot) warnings(candidate string, others []Used, lo, hi netip.Addr) []Warning {
	var out []Warning
	for _, u := range others {
		if len(out) == maxWarnings {
			break
		}
		out = append(out, Warning{Candidate: candidate, Space: s.spaceName(u.Space), Object: what(u), Kind: u.Kind,
			Contains: u.Lo.Compare(lo) <= 0 && hi.Compare(u.Hi) <= 0})
	}
	return out
}

// sameSpace says whether u counts as being in space: the same space, or one
// not known on either side (see the package doc).
func sameSpace(space string, u Used) bool { return space == "" || u.Space == "" || u.Space == space }

func spanLabel(lo, hi netip.Addr) string {
	if lo == hi {
		return lo.String()
	}
	return lo.String() + " to " + hi.String()
}

func overlaps(u Used, lo, hi netip.Addr) bool {
	if u.Lo.BitLen() != lo.BitLen() {
		return false
	}
	return u.Lo.Compare(hi) <= 0 && lo.Compare(u.Hi) <= 0
}

// prefixClashes lists every item that makes the candidate not free, and every
// item in another space that overlaps it (others), each lowest first.
func (s *Snapshot) prefixClashes(space string, p, parent netip.Prefix) (clash, others []Used) {
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
	for _, u := range s.items {
		if !overlaps(u, lo, hi) {
			continue
		}
		if !sameSpace(space, u) {
			others = append(others, u)
			continue
		}
		if u.Kind == KindBlock && u.Space == space && u.Prefix != p &&
			u.Prefix.Bits() <= anchor.Bits() && u.Prefix.Contains(anchor.Addr()) {
			continue // its own parent block, or a parent of that
		}
		clash = append(clash, u)
	}
	sortUsed(clash)
	sortUsed(others)
	return clash, others
}

func (s *Snapshot) spanClashes(space string, lo, hi netip.Addr) (clash, others []Used) {
	for _, u := range s.items {
		if u.isNetwork() || !overlaps(u, lo, hi) {
			continue
		}
		if sameSpace(space, u) {
			clash = append(clash, u)
		} else {
			others = append(others, u)
		}
	}
	sortUsed(clash)
	sortUsed(others)
	return clash, others
}

func sortUsed(us []Used) {
	sort.SliceStable(us, func(i, j int) bool { return us[i].Lo.Compare(us[j].Lo) < 0 })
}

// CheckPrefix answers whether network p, to be made in space inside parent
// (the zero Prefix when no parent was chosen), is free.
func (s *Snapshot) CheckPrefix(space string, p, parent netip.Prefix) Result {
	c, o := s.prefixClashes(space, p, parent)
	if len(c) > 0 {
		return Result{Reason: s.reason(c[0])}
	}
	lo, hi := Bounds(p.Masked())
	return Result{Free: true, Warnings: s.warnings(p.Masked().String(), o, lo, hi)}
}

// CheckSpan answers whether addresses lo to hi (a DHCP range), to be made in
// space, are free.
func (s *Snapshot) CheckSpan(space string, lo, hi netip.Addr) Result {
	c, o := s.spanClashes(space, lo, hi)
	if len(c) > 0 {
		return Result{Reason: s.reason(c[0])}
	}
	return Result{Free: true, Warnings: s.warnings(spanLabel(lo, hi), o, lo, hi)}
}

// CheckAddr answers whether one address is free.
func (s *Snapshot) CheckAddr(space string, a netip.Addr) Result { return s.CheckSpan(space, a, a) }

// maxSkips caps the skipped list a preview carries; the pick is still exact.
const maxSkips = 20

// NextFreePrefix is the lowest /bits inside parent, aligned to its own size,
// that CheckPrefix calls free and that nothing in another IP space overlaps,
// with the candidates passed over on the way. When every free one overlaps
// something in another space, it is the lowest free one, with its warnings.
// ok is false when none is left.
func (s *Snapshot) NextFreePrefix(space string, parent netip.Prefix, bits int) (pick netip.Prefix, warn []Warning, skipped []Skip, ok bool) {
	pick, ok, shared, skipped, _ := s.nextFreeWithin(space, parent, parent, bits, nil, false)
	switch {
	case ok:
		return pick, nil, skipped, true
	case shared != nil:
		return shared.pick, shared.warn, skipped[:shared.skips], true
	}
	return netip.Prefix{}, nil, skipped, false
}

// sharedPick is the first free candidate met that something in another IP
// space overlaps, kept in case no clean one turns up. skips is how many skips
// had been listed then: the ones after it are dropped if it is offered.
type sharedPick struct {
	pick  netip.Prefix
	warn  []Warning
	skips int
}

// nextFreeWithin is NextFreePrefix searching only the candidates inside
// within (a piece of parent), starting at from (nil: within's start). The
// clash rule still uses parent, so a block inside parent is never mistaken
// for the parent. ok is true for a clean pick; otherwise shared is the first
// warned candidate met, unless haveShared says the caller already has one.
// When nothing in within is clean, resume is where the search would go on:
// past every clash met (and, once a warned one is in hand, past every
// other-space overlap too), so a clash that covers the pieces after within is
// stepped over without reading them.
func (s *Snapshot) nextFreeWithin(space string, parent, within netip.Prefix, bits int, from *big.Int, haveShared bool) (pick netip.Prefix, ok bool, shared *sharedPick, skipped []Skip, resume *big.Int) {
	parent, within = parent.Masked(), within.Masked()
	total := parent.Addr().BitLen()
	if !parent.IsValid() || bits < parent.Bits() || bits > total || bits < within.Bits() {
		return netip.Prefix{}, false, nil, nil, nil
	}
	size := new(big.Int).Lsh(big.NewInt(1), uint(total-bits))
	cand, end := PrefixRange(within)
	if from != nil && from.Cmp(cand) > 0 {
		cand = new(big.Int).Set(from)
	}
	one := big.NewInt(1)
	for {
		candEnd := new(big.Int).Sub(new(big.Int).Add(cand, size), one)
		if candEnd.Cmp(end) > 0 {
			return netip.Prefix{}, false, shared, skipped, cand
		}
		p := netip.PrefixFrom(addrFromInt(cand, total), bits)
		c, o := s.prefixClashes(space, p, parent)
		if len(c) == 0 && len(o) == 0 {
			return p, true, shared, skipped, nil
		}
		past := c
		reason := ""
		if len(c) == 0 {
			lo, hi := Bounds(p)
			w := s.warnings(p.String(), o, lo, hi)
			if shared == nil && !haveShared {
				shared = &sharedPick{pick: p, warn: w, skips: len(skipped)}
			}
			reason = SharedReason(w)
			past = o
		} else {
			reason = s.reason(c[0])
			if shared != nil || haveShared {
				past = append(append([]Used(nil), c...), o...)
			}
		}
		if len(skipped) < maxSkips {
			skipped = append(skipped, Skip{Candidate: p.String(), Reason: reason})
		}
		// Step past every clash (and every other-space overlap, once a
		// warned one is held), then up to the next aligned start. Each step
		// passes at least the candidate, so the loop ends.
		next := new(big.Int).Add(candEnd, one)
		for _, u := range past {
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
// CheckAddr calls free in space and that nothing in another IP space uses,
// with the addresses passed over on the way. When every free one is used in
// another space, it is the first free one, with its warnings. For IPv4 it
// never offers within's own network or broadcast address.
func (s *Snapshot) NextFreeAddr(space string, within netip.Prefix, from netip.Addr) (pick netip.Addr, warn []Warning, skipped []Skip, ok bool) {
	within = within.Masked()
	lo, hi := Bounds(within)
	if within.Addr().Is4() && within.Bits() <= 30 {
		lo, hi = lo.Next(), hi.Prev()
	}
	a := from
	if a.Compare(lo) < 0 {
		a = lo
	}
	var shared netip.Addr
	var sharedWarn []Warning
	sharedSkips := 0
	for a.IsValid() && within.Contains(a) && a.Compare(hi) <= 0 {
		c, o := s.spanClashes(space, a, a)
		if len(c) == 0 && len(o) == 0 {
			return a, nil, skipped, true
		}
		past := c
		reason := ""
		if len(c) == 0 {
			w := s.warnings(a.String(), o, a, a)
			if !shared.IsValid() {
				shared, sharedWarn, sharedSkips = a, w, len(skipped)
			}
			reason, past = SharedReason(w), o
		} else {
			reason = s.reason(c[0])
			if shared.IsValid() {
				past = append(append([]Used(nil), c...), o...)
			}
		}
		if len(skipped) < maxSkips {
			skipped = append(skipped, Skip{Candidate: a.String(), Reason: reason})
		}
		// Past the widest one in one step, so a 200-address range is one skip.
		next := a
		for _, u := range past {
			if u.Hi.Compare(next) > 0 {
				next = u.Hi
			}
		}
		a = next.Next()
	}
	if shared.IsValid() {
		return shared, sharedWarn, skipped[:sharedSkips], true
	}
	return netip.Addr{}, nil, skipped, false
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
	p, _, _, ok := NewSnapshot(nil, items...).NextFreePrefix("", block, bits)
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

// SharedReason is the skip reason for a candidate passed over only because
// something in another IP space overlaps it, for one that is not shared.
func SharedReason(ws []Warning) string {
	if len(ws) == 0 {
		return ""
	}
	w := ws[0]
	return fmt.Sprintf("it is also used in IP space %s (%s %s), and one used in no other space was found", w.Space, w.Kind, w.Object)
}
