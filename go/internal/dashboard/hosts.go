package dashboard

// One place that knows how this package reads /api/infra/v1/detail_hosts.
//
// WHY THIS FILE EXISTS. Five readers ask that endpoint for the host estate, and
// they used to disagree about how much of it to ask for: 1000 (dashboard.go),
// 500 (csp.go, analytics.go, sources.go), 200 (hub.go). The repo has measured
// the live tenant TWICE and both numbers are above 500 — page.total_size 532
// (dashboard.go:591-599) and 548 (ai_tools.go:101-107) — so three of those
// readers were silently dropping rows while reporting a count that read as the
// whole estate. Only the two that ask for the authoritative total ever knew.
//
// WHY NOT PAGING. `_offset` has never been sent to this endpoint anywhere in
// this repo; the existing pagers page ipam/subnet and dns/record. Building a
// pager on an unexercised query param is the failure assets.go:206-210 warns
// about — "sending an argument nobody tested is how a working unfiltered query
// turns into a mystery" — and hub.go already takes the same position for a
// sibling feed. So this file does the two things this endpoint is PROVEN to do
// (a 1000-row limit, and the authoritative total) and reports the truncation it
// cannot remove, rather than guessing at one it cannot verify.
//
// Above hostsListLimit rows the estate is still truncated. That is stated, not
// hidden: every caller that has a payload to put it in now says so.

import (
	"fmt"
	"strconv"
)

// hostsListLimit is the row limit every host reader in this package sends.
// 1000 is not a truth, it is HEADROOM over two measurements (532, 548) at a
// cost that was measured when dashboard.go adopted it: 0.96s vs 0.93-1.08s for
// 500, i.e. free. A tenant above 1000 hosts is still truncated — the total
// below is how a caller finds that out.
const hostsListLimit = 1000

// hostsReason is the one operator-facing sentence, so four readers cannot word
// the same fact four ways.
var hostsReason = fmt.Sprintf(
	"host list truncated at the %d-row limit — the estate is larger than the rows shown",
	hostsListLimit)

// hostsParams is the one request shape. _is_total_size_needed is not a new
// param on this endpoint: ai_tools.go:104-107 already sends it here alongside
// _limit and _fields, and dashboard.go's fetchCount sends it here too, so the
// combination is proven rather than assumed.
func hostsParams(fields string) map[string]string {
	p := map[string]string{
		"_limit":                strconv.Itoa(hostsListLimit),
		"_is_total_size_needed": "true",
	}
	if fields != "" {
		p["_fields"] = fields
	}
	return p
}

// fetchHosts reads the host estate and reports how much of it it actually saw.
//
// totalOK false means "upstream told us no total", which is NOT the same as
// "there are no more rows" and NOT the same as truncated. A caller with no
// total must make no claim about completeness in either direction — a full page
// with no metadata is not evidence that more rows exist, and this package does
// not guess from len(rows).
func (s *Service) fetchHosts(fields string) (rows []any, total int, totalOK bool, err error) {
	rows, body, err := s.Rest.GetPageStrict("/api/infra/v1/detail_hosts", hostsParams(fields))
	if err != nil {
		return nil, 0, false, err
	}
	if n := pageTotalSize(body, -1); n >= 0 {
		return rows, n, true, nil
	}
	return rows, 0, false, nil
}

// hostsTruncated is the only place a truncation claim is made, and it is made
// on authoritative evidence or not at all: a readable total that exceeds the
// rows in hand. Everything else — no total, a total that agrees, or a total
// smaller than what arrived (an internally inconsistent answer, distrusted the
// way csp.go's totalConsistencyCheck distrusts one) — makes no claim.
func hostsTruncated(rows []any, total int, totalOK bool) bool {
	return totalOK && total > len(rows)
}
