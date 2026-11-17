package freecheck

import (
	"errors"
	"fmt"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/pyconv"
	"bloxsmith/internal/rest"
)

// Scope says what Load reads.
type Scope int

const (
	// All reads every IP space, address block, subnet, DHCP range,
	// reservation and host: what checking a new network needs.
	All Scope = iota
	// Addresses leaves out blocks and subnets, which an address or DHCP range
	// check never uses (see the package doc). On a large tenant the subnets are
	// most of the read.
	Addresses
)

// IncompleteError is a read that could not be shown to be whole. Msg is the
// plain sentence to show; Detail is for the log.
type IncompleteError struct{ Msg, Detail string }

func (e *IncompleteError) Error() string { return e.Msg + " (" + e.Detail + ")" }

// Public is the plain sentence alone.
func Public(err error) string {
	var ie *IncompleteError
	if errors.As(err, &ie) {
		return ie.Msg
	}
	return "Couldn't read what is already in use, so nothing is offered."
}

func incomplete(noun, format string, a ...any) error {
	return &IncompleteError{
		Msg:    fmt.Sprintf("Couldn't read every %s, so nothing is offered: a missing one could already use the addresses.", noun),
		Detail: fmt.Sprintf(format, a...),
	}
}

// Live sizes on the largest tenant (GETs, 2026-11-16): 848 spaces, 4,679
// blocks, about 72,600 subnets, 30,729 DHCP ranges, 99,767 reservations and
// 132,280 hosts holding 105,773 addresses. _limit=5000 is accepted. A 2,000-row
// subnet page took 3.5 s; ranges, reservations and blocks report no total, so
// they are read to an empty page (ranges 10 s, reservations 23 s). A full read
// is about 30 s, which is why previews use Cached and Apply uses Around.
const (
	pageSize = 5000
	maxPages = 200 // 1,000,000 rows; an upstream that ignores _offset stops here
	parallel = 4
)

type list struct {
	path, fields, noun string
	// filter is the list's own _filter; an Around read adds to it.
	filter string
}

// Host addresses are read from ipam/address, not ipam/host: ipam/host answers
// 400 "can't preload field Addresses" to any _fields naming addresses, so a
// host read is whole objects (1.35 MB per 2,000), and it cannot be filtered by
// address. ipam/address with host!=null lists every host address once: live,
// the 132,280 hosts carried 105,773 addresses and host!=null answered exactly
// 105,773 rows.
var (
	listSpaces  = list{path: "/api/ddi/v1/ipam/ip_space", fields: "id,name", noun: "IP space"}
	listBlocks  = list{path: "/api/ddi/v1/ipam/address_block", fields: "id,space,address,cidr", noun: "address block"}
	listSubnets = list{path: "/api/ddi/v1/ipam/subnet", fields: "id,space,address,cidr", noun: "subnet"}
	listRanges  = list{path: "/api/ddi/v1/ipam/range", fields: "id,space,start,end", noun: "DHCP range"}
	listFixed   = list{path: "/api/ddi/v1/dhcp/fixed_address", fields: "id,ip_space,address", noun: "reservation"}
	listHosts   = list{path: "/api/ddi/v1/ipam/address", fields: "id,address,space,host", noun: "host", filter: "host!=null"}
)

func lists(scope Scope) []list {
	out := []list{listSpaces, listRanges, listFixed, listHosts}
	if scope == All {
		out = append(out, listBlocks, listSubnets)
	}
	return out
}

// Load reads what scope needs, every list in full, side by side. Any list
// that cannot be shown to be complete is an error, never a shorter list.
func Load(c *rest.Client, scope Scope) (*Snapshot, error) {
	return load(c, lists(scope))
}

func load(c *rest.Client, lists []list) (*Snapshot, error) {
	rows := make([][]map[string]any, len(lists))
	errs := make([]error, len(lists))
	var wg sync.WaitGroup
	for i, l := range lists {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rows[i], errs[i] = readAll(c, l)
		}()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	names := map[string]string{}
	var items []Used
	for i, l := range lists {
		got, err := parse(l, rows[i], names)
		if err != nil {
			return nil, err
		}
		items = append(items, got...)
	}
	s := NewSnapshot(names, items...)
	s.Counts.ReadAt = time.Now()
	return s, nil
}

// shared is the process's cache for preview snapshots; nil reads every time.
var shared *cache.Cache

// UseCache makes Cached keep snapshots in c. main calls it once with the
// shared cache, so a tenant switch (which rotates that cache) drops them too.
func UseCache(c *cache.Cache) { shared = c }

// PreviewTTL is how long a preview may reuse a snapshot. Apply never does.
const PreviewTTL = 2 * time.Minute

// Cached is Load for previews: one full read per tenant and scope is shared
// for PreviewTTL, so a run of previews does not wait 30 s each. The snapshot
// is a copy (a preview may Add to it), and Counts.ReadAt says how old it is.
// A failed read is not kept.
func Cached(c *rest.Client, scope Scope) (*Snapshot, error) {
	if shared == nil {
		return Load(c, scope)
	}
	key := fmt.Sprintf("freecheck|%s|%d", c.TenantTag(), scope)
	v, err := shared.DoTTL(key, PreviewTTL, func() (any, error) { return Load(c, scope) })
	if err != nil {
		return nil, err
	}
	snap, ok := v.(*Snapshot)
	if !ok {
		return Load(c, scope)
	}
	return snap.Clone(), nil
}

// Around is Load for Apply: a fresh read of only what can clash with the
// addresses lo to hi, so Apply does not wait for the whole tenant. Networks
// are those starting inside lo..hi plus every network that could contain lo
// (lo masked to each prefix length); ranges, reservations and host addresses
// are those overlapping lo..hi. Infoblox compares addresses as addresses, not
// text (live: address>="10.1.0.0" and address<="10.3.0.0" answered only
// 10.1 to 10.3, 855 rows, matching its total). A scoped list that cannot be
// shown complete falls back to a full fresh Load.
func Around(c *rest.Client, scope Scope, lo, hi netip.Addr) (*Snapshot, error) {
	if !lo.IsValid() || !hi.IsValid() || lo.BitLen() != hi.BitLen() || hi.Less(lo) {
		return Load(c, scope)
	}
	inSpan := fmt.Sprintf(`address>="%s" and address<="%s"`, lo, hi)
	nets := "(" + inSpan + ")"
	for b := 0; b <= lo.BitLen(); b++ {
		p, _ := lo.Prefix(b)
		nets += fmt.Sprintf(` or (address=="%s" and cidr==%d)`, p.Addr(), b)
	}
	scoped := []list{listSpaces}
	for _, l := range lists(scope)[1:] {
		f := inSpan
		switch l.path {
		case listBlocks.path, listSubnets.path:
			f = nets
		case listRanges.path:
			f = fmt.Sprintf(`start<="%s" and end>="%s"`, hi, lo)
		}
		if l.filter != "" {
			f = "(" + f + ") and " + l.filter
		}
		l.filter = f
		scoped = append(scoped, l)
	}
	s, err := load(c, scoped)
	if err != nil {
		return Load(c, scope)
	}
	s.Counts.Around = lo.String() + " to " + hi.String()
	return s, nil
}

// AroundPrefix is Around for every address in p.
func AroundPrefix(c *rest.Client, scope Scope, p netip.Prefix) (*Snapshot, error) {
	lo, hi := Bounds(p.Masked())
	return Around(c, scope, lo, hi)
}

// For is the one entry point for callers: a preview (dry) gets the cached
// snapshot, Apply a fresh read around lo..hi.
func For(c *rest.Client, scope Scope, dry bool, lo, hi netip.Addr) (*Snapshot, error) {
	if dry {
		return Cached(c, scope)
	}
	return Around(c, scope, lo, hi)
}

// ForPrefix is For around every address in p.
func ForPrefix(c *rest.Client, scope Scope, dry bool, p netip.Prefix) (*Snapshot, error) {
	lo, hi := Bounds(p.Masked())
	return For(c, scope, dry, lo, hi)
}

// parse turns one list's rows into Used items (or space names). A row that
// cannot be read is an error, never skipped: skipping it could hide a clash.
func parse(l list, rows []map[string]any, names map[string]string) ([]Used, error) {
	var out []Used
	for _, m := range rows {
		id := pyconv.Str(m["id"])
		switch l.path {
		case listSpaces.path:
			names[id] = pyconv.Str(m["name"])
		case listBlocks.path, listSubnets.path:
			p, ok := PrefixOf(m)
			space := strings.TrimSpace(pyconv.Str(m["space"]))
			if !ok || space == "" {
				return nil, incomplete(l.noun, "%s has no readable address or IP space", id)
			}
			kind := KindBlock
			if l.path == listSubnets.path {
				kind = KindSubnet
			}
			out = append(out, Network(kind, space, id, p))
		case listRanges.path:
			lo, e1 := netip.ParseAddr(strings.TrimSpace(pyconv.Str(m["start"])))
			hi, e2 := netip.ParseAddr(strings.TrimSpace(pyconv.Str(m["end"])))
			if e1 != nil || e2 != nil || lo.BitLen() != hi.BitLen() || hi.Compare(lo) < 0 {
				return nil, incomplete(l.noun, "%s has no readable start and end", id)
			}
			out = append(out, Span(KindRange, pyconv.Str(m["space"]), id, lo, hi))
		case listFixed.path:
			a, err := netip.ParseAddr(strings.TrimSpace(pyconv.Str(m["address"])))
			if err != nil {
				return nil, incomplete(l.noun, "%s has no readable address", id)
			}
			out = append(out, Span(KindReservation, pyconv.Str(m["ip_space"]), id, a, a))
		case listHosts.path:
			a, err := netip.ParseAddr(strings.TrimSpace(pyconv.Str(m["address"])))
			if err != nil {
				return nil, incomplete(l.noun, "%s has an address that cannot be read", id)
			}
			if h := pyconv.Str(m["host"]); h != "" {
				id = h
			}
			out = append(out, Span(KindHost, pyconv.Str(m["space"]), id, a, a))
		}
	}
	return out, nil
}

// readAll reads one list in full. When the first page reports a total
// (page.total_size), the other pages are read side by side and the distinct
// ids read must equal it. When it reports none (address_block never does),
// pages are read one after another until a page comes back EMPTY, which rules
// out a page cap below our _limit: a capped page looks short, but the next
// offset still has rows.
func readAll(c *rest.Client, l list) ([]map[string]any, error) {
	get := func(offset int) ([]any, map[string]any, error) {
		params := map[string]string{
			"_fields": l.fields, "_limit": strconv.Itoa(pageSize), "_offset": strconv.Itoa(offset),
			"_order_by": "id", "_is_total_size_needed": "true"}
		if l.filter != "" {
			params["_filter"] = l.filter
		}
		return c.GetPageStrict(l.path, params)
	}
	first, body, err := get(0)
	if err != nil {
		return nil, incomplete(l.noun, "%s: %v", l.path, err)
	}
	if _, ok := body["results"].([]any); !ok {
		return nil, incomplete(l.noun, "%s: the answer had no results list", l.path)
	}
	all := first
	if total, ok := totalOf(body); ok {
		pages := (total + pageSize - 1) / pageSize
		if pages > maxPages {
			return nil, incomplete(l.noun, "%s: %d rows is more than this reads", l.path, total)
		}
		later := make([][]any, pages)
		errs := make([]error, pages)
		sem := make(chan struct{}, parallel)
		var wg sync.WaitGroup
		for i := 1; i < pages; i++ {
			wg.Add(1)
			sem <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-sem }()
				rows, b, err := get(i * pageSize)
				if err == nil {
					if t, ok := totalOf(b); !ok || t != total {
						err = fmt.Errorf("the total changed while reading")
					}
				}
				later[i], errs[i] = rows, err
			}()
		}
		wg.Wait()
		for i := 1; i < pages; i++ {
			if errs[i] != nil {
				return nil, incomplete(l.noun, "%s: %v", l.path, errs[i])
			}
			all = append(all, later[i]...)
		}
		if n := distinct(all); n != total || len(all) != total {
			return nil, incomplete(l.noun, "%s: read %d rows (%d distinct) of %d", l.path, len(all), n, total)
		}
		return maps(all), nil
	}
	for i := 1; len(first) > 0; i++ {
		if i >= maxPages {
			return nil, incomplete(l.noun, "%s: still not at the end after %d pages", l.path, maxPages)
		}
		rows, b, err := get(len(all))
		if err != nil {
			return nil, incomplete(l.noun, "%s: %v", l.path, err)
		}
		if _, ok := b["results"].([]any); !ok {
			return nil, incomplete(l.noun, "%s: a page came back with no results list", l.path)
		}
		if len(rows) == 0 {
			break
		}
		all = append(all, rows...)
	}
	if n := distinct(all); n != len(all) {
		return nil, incomplete(l.noun, "%s: %d rows but %d distinct", l.path, len(all), n)
	}
	return maps(all), nil
}

func totalOf(body map[string]any) (int, bool) {
	page, _ := body["page"].(map[string]any)
	switch v := page["total_size"].(type) {
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(v))
		return n, err == nil && n >= 0
	case float64:
		return int(v), v >= 0
	}
	return 0, false
}

func distinct(rows []any) int {
	seen := map[string]bool{}
	for _, r := range rows {
		m, _ := r.(map[string]any)
		seen[pyconv.Str(m["id"])] = true
	}
	return len(seen)
}

func maps(rows []any) []map[string]any {
	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		m, _ := r.(map[string]any)
		out = append(out, m)
	}
	return out
}

// CheckAddrRecord asks Infoblox whether it holds a record of address a in
// space that is in use: an address handed out by nextavailableip, say, which
// is neither a host nor a reservation, so the lists Load reads do not hold
// it. A failed read is an error, never "free".
func (s *Snapshot) CheckAddrRecord(c *rest.Client, space string, a netip.Addr) (Result, error) {
	sq, err := rest.CSPQ(space)
	if err != nil {
		return Result{}, err
	}
	rows, err := c.GetStrict("/api/ddi/v1/ipam/address", map[string]string{
		// address>= and <= the same address, not address==: live, == took 9 s
		// and the range form 0.3 s.
		"_filter": fmt.Sprintf(`address>="%s" and address<="%s" and space=="%s"`, a, a, sq), "_fields": "id,address,state,usage"})
	if err != nil {
		return Result{}, &IncompleteError{Msg: "Couldn't check whether " + a.String() + " is already in use, so it is not offered.",
			Detail: err.Error()}
	}
	for _, r := range rows {
		m, _ := r.(map[string]any)
		if strings.EqualFold(pyconv.Str(m["state"]), "free") {
			continue
		}
		return Result{Reason: fmt.Sprintf("an address in %s already uses %s", s.spaceName(space), a)}, nil
	}
	return Result{Free: true}, nil
}
