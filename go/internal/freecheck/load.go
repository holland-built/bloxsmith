package freecheck

import (
	"errors"
	"fmt"
	"net/netip"
	"strconv"
	"strings"
	"sync"

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

const (
	pageSize = 2000
	maxPages = 200 // 400,000 rows; an upstream that ignores _offset stops here
	parallel = 4
)

type list struct {
	path, fields, noun string
}

var (
	listSpaces  = list{"/api/ddi/v1/ipam/ip_space", "id,name", "IP space"}
	listBlocks  = list{"/api/ddi/v1/ipam/address_block", "id,space,address,cidr", "address block"}
	listSubnets = list{"/api/ddi/v1/ipam/subnet", "id,space,address,cidr", "subnet"}
	listRanges  = list{"/api/ddi/v1/ipam/range", "id,space,start,end", "DHCP range"}
	listFixed   = list{"/api/ddi/v1/dhcp/fixed_address", "id,ip_space,address", "reservation"}
	listHosts   = list{"/api/ddi/v1/ipam/host", "id,addresses", "host"}
)

// Load reads what scope needs, every list in full, side by side. Any list
// that cannot be shown to be complete is an error, never a shorter list.
func Load(c *rest.Client, scope Scope) (*Snapshot, error) {
	lists := []list{listSpaces, listRanges, listFixed, listHosts}
	if scope == All {
		lists = append(lists, listBlocks, listSubnets)
	}
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
	return NewSnapshot(names, items...), nil
}

// parse turns one list's rows into Used items (or space names). A row that
// cannot be read is an error, never skipped: skipping it could hide a clash.
func parse(l list, rows []map[string]any, names map[string]string) ([]Used, error) {
	var out []Used
	for _, m := range rows {
		id := pyconv.Str(m["id"])
		switch l {
		case listSpaces:
			names[id] = pyconv.Str(m["name"])
		case listBlocks, listSubnets:
			p, ok := PrefixOf(m)
			space := strings.TrimSpace(pyconv.Str(m["space"]))
			if !ok || space == "" {
				return nil, incomplete(l.noun, "%s has no readable address or IP space", id)
			}
			kind := KindBlock
			if l == listSubnets {
				kind = KindSubnet
			}
			out = append(out, Network(kind, space, id, p))
		case listRanges:
			lo, e1 := netip.ParseAddr(strings.TrimSpace(pyconv.Str(m["start"])))
			hi, e2 := netip.ParseAddr(strings.TrimSpace(pyconv.Str(m["end"])))
			if e1 != nil || e2 != nil || lo.BitLen() != hi.BitLen() || hi.Compare(lo) < 0 {
				return nil, incomplete(l.noun, "%s has no readable start and end", id)
			}
			out = append(out, Span(KindRange, pyconv.Str(m["space"]), id, lo, hi))
		case listFixed:
			a, err := netip.ParseAddr(strings.TrimSpace(pyconv.Str(m["address"])))
			if err != nil {
				return nil, incomplete(l.noun, "%s has no readable address", id)
			}
			out = append(out, Span(KindReservation, pyconv.Str(m["ip_space"]), id, a, a))
		case listHosts:
			addrs, _ := m["addresses"].([]any)
			for _, x := range addrs {
				am, _ := x.(map[string]any)
				a, err := netip.ParseAddr(strings.TrimSpace(pyconv.Str(am["address"])))
				if err != nil {
					return nil, incomplete(l.noun, "%s has an address that cannot be read", id)
				}
				out = append(out, Span(KindHost, pyconv.Str(am["space"]), id, a, a))
			}
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
		return c.GetPageStrict(l.path, map[string]string{
			"_fields": l.fields, "_limit": strconv.Itoa(pageSize), "_offset": strconv.Itoa(offset),
			"_order_by": "id", "_is_total_size_needed": "true"})
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
		"_filter": fmt.Sprintf(`address=="%s" and space=="%s"`, a, sq), "_fields": "id,address,state,usage"})
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
