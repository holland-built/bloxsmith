package provision

import (
	"strconv"
	"strings"
	"time"
)

// READING EVERY HOST, OR REFUSING TO READ ANY.
//
// Two places need "all the IPAM hosts in this tenant": the site teardown, which
// filters them by FQDN suffix and DELETEs the matches, and the drift check,
// which matches them into subnets. Both used to do it with ONE request:
//
//	GetStrict("/api/ddi/v1/ipam/host", {"_limit": "1000"})
//
// GetStrict issues exactly one GET. So on a tenant with more than 1000 hosts,
// everything past row 1000 was invisible. The teardown then deleted the site's
// subnets and zones, left those hosts alive holding addresses on the customer's
// network, and returned a normal success — and the pre-delete export recorded
// the same short list, so the artifact that exists to make a teardown
// recoverable was itself missing the objects. The drift check reported hosts as
// MISSING when they had merely fallen off the end of the page.
//
// WHY THIS REFUSES INSTEAD OF DEGRADING. dashboard.fetchAtRiskSubnets pages the
// same way and sets a `degraded` flag when it gives up, because showing fewer
// at-risk subnets is a smaller answer, not a wrong one. Here a short list drives
// DELETEs. A teardown working from an incomplete inventory is the exact failure
// export.go already refuses for ("A TEARDOWN THAT COULD NOT BE RECORDED DOES
// NOT RUN"), so every give-up below is an error, and every one of them happens
// before the first delete.
//
// WHAT IT DOES NOT FIX. `_offset` paging over a collection someone else is
// mutating can still skip a row: delete row 5 while we are fetching page 2 and
// everything shifts up by one. Nothing available on this endpoint makes that
// impossible — there is no cursor or snapshot — so instead the walk DETECTS it:
// rows are deduplicated by id, and the unique count is checked against the
// authoritative total. Fewer unique rows than the tenant says exist means the
// walk may have skipped something, and that refuses. It does not claim to be a
// consistent snapshot; it claims to notice when it wasn't one.
const (
	// hostPageSize is the rows-per-request. 1000 preserves the size the single
	// un-paged read used, so a tenant under one page makes exactly the same one
	// request it always did.
	hostPageSize = 1000

	// hostPageCap and hostReadCap are runaway backstops, NOT measured tenant
	// sizes. Nothing here has been run against a 50,000-host tenant; these bound
	// a loop that would otherwise be unbounded, and hitting either one refuses
	// rather than returning a short list.
	hostPageCap = 50
	hostReadCap = 2 * time.Minute
)

// hostTotal reads the authoritative collection size out of a list envelope.
//
// The shape is body.page.total_size, a STRING, which CSP only populates when
// the request carries _is_total_size_needed=true. Same contract as
// dashboard.pageTotalSize (ai_tools.go:408) and server.findTotal
// (ipam.go:157) — a third small copy rather than exporting one of them, because
// this is the only thing this package needs from either.
//
// Absent or unparseable means "no total", not zero: the cross-check below is
// skipped rather than being run against a made-up number.
func hostTotal(body map[string]any) (int, bool) {
	page, ok := body["page"].(map[string]any)
	if !ok {
		return 0, false
	}
	s, ok := page["total_size"].(string)
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}

// readAllHosts walks every page of /api/ddi/v1/ipam/host, or returns an error.
// It never returns a partial list: on any give-up the rows are dropped, so a
// caller cannot accidentally act on half a tenant.
func (e *Engine) readAllHosts() ([]any, error) {
	start := time.Now()
	var rows []any
	seen := map[string]bool{}
	total, totalOK := 0, false
	offset := 0

	for page := 0; page < hostPageCap; page++ {
		if time.Since(start) > hostReadCap {
			return nil, perr("refusing: reading the tenant's hosts took longer than %s and did not "+
				"finish (%d read so far). Acting on a partial host list would leave hosts behind while "+
				"reporting success.", hostReadCap, len(rows))
		}
		batch, body, err := e.Rest.GetPageStrict("/api/ddi/v1/ipam/host", map[string]string{
			"_limit": itoa(hostPageSize), "_offset": itoa(offset), "_is_total_size_needed": "true"})
		if err != nil {
			return nil, err
		}
		if page == 0 && body != nil {
			total, totalOK = hostTotal(body)
		}
		for _, h := range batch {
			// An id-less row cannot be deduplicated and cannot be DELETEd, so it
			// is kept as-is; the callers' own filters decide what to do with it.
			id := pyStr(asMap(h)["id"])
			if id != "" {
				if seen[id] {
					continue
				}
				seen[id] = true
			}
			rows = append(rows, h)
		}
		// A SHORT PAGE IS THE END. This is the primary stop condition and it
		// needs no total: asking for 1000 and getting 999 means there is no
		// 1001st row. Using the total instead would need a total to exist, and
		// would need an extra empty-page request whenever the collection divides
		// exactly by the page size.
		if len(batch) < hostPageSize {
			break
		}
		offset += len(batch)
	}
	if offset >= hostPageCap*hostPageSize {
		return nil, perr("refusing: this tenant has more than %d hosts (%d pages of %d) and the walk "+
			"did not reach the end. Acting on a partial host list would leave hosts behind while "+
			"reporting success.", hostPageCap*hostPageSize, hostPageCap, hostPageSize)
	}
	// The cross-check. Fewer unique rows than the tenant says it holds means
	// either a page was skipped by a concurrent mutation shifting the offsets, or
	// duplicates masked real rows. Either way this list is not the tenant.
	//
	// The reverse — MORE rows than the total — is not an error: it means hosts
	// were added while the walk ran, and finding more than expected cannot cause
	// something to be left behind.
	if totalOK && len(rows) < total {
		return nil, perr("refusing: read %d unique hosts but the tenant reports %d. The list changed "+
			"while it was being read, so some hosts may not be in it, and acting on it could leave "+
			"them behind while reporting success.", len(rows), total)
	}
	return rows, nil
}
