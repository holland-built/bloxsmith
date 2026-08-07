package server

import (
	"net/http"
	"strconv"
	"strings"

	"bloxsmith/internal/rest"
)

// Estate search: the two free-text tenant reads behind the dossier page.
//
// /api/dns/records requires a zone and /api/ipam/addresses requires a subnet
// (ipam.go:419-422, :466-470), so before these routes there was no way to ask
// "where does this IP or hostname appear in the tenant" without already knowing
// the answer. These two ask the unparented question: an ipam/address filtered on
// address alone, a dns/record filtered on name-or-rdata alone, with no parent
// and no zone clause.
//
// WHY EVERY ANSWER IS A 200, INCLUDING THE FAILURES. Same contract the Assets
// routes document at csp.go:76-82, and it is the reason these handlers do not
// call pagedFetch. pagedFetch writes its own response on an upstream failure — a
// 502 via writeUpstreamError (ipam.go:306-319, :354) — and a 502 carries no body
// the browser's useApi will read. The dossier page renders five sections that
// resolve independently, so a section answering 502 looks exactly like the whole
// page being broken. Instead searchFetch below calls GetPageStrict directly,
// keeps pagedFetch's paging and truncation-metadata logic, and hands the typed
// error back so the handler can answer 200 and put the verdict in the body.
//
// THE FOUR availability STATES, and why "nothing found" is not one of them:
//
//	ok          — the search ran. rows may be empty, and an empty rows here
//	              genuinely means the tenant holds no match.
//	empty       — no query was given. Not the same as "no match", and it must
//	              not render as one.
//	unsupported — upstream refused the question (a 4xx on the filter itself).
//	              We could not ask, so we do not know. Rendering this as an
//	              empty list would tell an operator "this IP has no DNS record"
//	              when the truth is "this tenant's API will not answer that".
//	error       — upstream was unreachable, or failed for some other reason.
//
// The distinction between "unsupported" and "ok with zero rows" is the whole
// point of this file's error handling, not a refinement of it.
const searchLimit = 50

// searchQueryMax bounds ?q= at 256 BYTES. The number is not new here: it is
// assetQueryMax (internal/dashboard/assets.go:90), which mirrors
// internal/mcp.Search's cap on user text. Unbounded, a multi-hundred-kilobyte q
// would be escaped and forwarded upstream — and searchDNS interpolates it FOUR
// times into a single request, so upstream receives roughly four times whatever
// was typed.
//
// It is also a real ceiling rather than an arbitrary one: a fully qualified DNS
// name maxes out at 255 bytes and an IP address is far shorter, so nothing
// either endpoint can legitimately be asked about exceeds it.
const searchQueryMax = 256

// registerSearchRoutes wires the two estate-search reads. Both are GETs that
// change nothing upstream, so — exactly like the IPAM/DNS reads next to them in
// registerIPAMReadRoutes — neither belongs in writelock.go's tenantWritePaths.
func (d *Deps) registerSearchRoutes(mux router) {
	mux.HandleFunc("GET /api/search/ipam", d.searchIPAM)
	mux.HandleFunc("GET /api/search/dns", d.searchDNS)
}

// searchFetch is pagedFetch's body with the response-writing removed. It issues
// a SINGLE upstream request for searchLimit+1 rows, asks CSP for the
// authoritative total the same way (_is_total_size_needed=true), and derives
// total-or-truncated from that one response via findTotal — all identical to
// pagedFetch, deliberately, so the two cannot drift on what a truncated page
// means. The one difference is the failure path: it returns the typed
// *rest.UpstreamError instead of writing a 502, leaving the caller to decide
// what the client sees.
func (d *Deps) searchFetch(r *http.Request, path string, params map[string]string) (rows []any, extra map[string]any, ue *rest.UpstreamError) {
	p := map[string]string{}
	for k, v := range params {
		p[k] = v
	}
	p["_limit"] = strconv.Itoa(searchLimit + 1)
	p["_is_total_size_needed"] = "true"

	fetchRows, body, err := d.restFor(r).GetPageStrict(path, p)
	if err != nil {
		e, isUE := err.(*rest.UpstreamError)
		if !isUE {
			// GetPageStrict only ever returns *rest.UpstreamError; defensive.
			e = &rest.UpstreamError{Path: path}
		}
		return nil, nil, e
	}

	rowCount := len(fetchRows)
	truncated := rowCount > searchLimit
	if truncated {
		fetchRows = fetchRows[:searchLimit]
	}
	if body != nil {
		if total, found := findTotal(body, rowCount); found {
			return fetchRows, map[string]any{"total": total, "limit": searchLimit}, nil
		}
	}
	return fetchRows, map[string]any{"truncated": truncated, "limit": searchLimit}, nil
}

// searchUnavailable turns a failed upstream read into the 200 body a dossier
// section renders. It logs the full redacted snippet server-side (the same
// logUpstreamError line every other upstream failure in this package writes)
// and surfaces only an allowlisted message through extractUpstreamMessage —
// the raw upstream body never reaches the client here either.
//
// "unsupported" is a PERMANENT verdict and is spelled from a short list of
// statuses, not from the whole 4xx range. It tells an operator their tenant's
// API cannot answer this question, and an operator who reads that stops trying
// — so a failure that would clear on its own must never reach it.
//
// searchUnsupportedStatuses below holds the three that genuinely mean "upstream
// rejected this filter". Everything else, 4xx included, is availability
// "error": a feed that is down, a token that expired, a limit that will lift.
func searchUnavailable(ue *rest.UpstreamError) map[string]any {
	logUpstreamError(ue)
	resp := map[string]any{
		"availability": "error",
		"reason":       ue.Public(),
		"rows":         []any{},
		"status":       ue.Status,
	}
	if ue.Category == "status" {
		switch {
		case searchUnsupportedStatuses[ue.Status]:
			resp["availability"] = "unsupported"
			resp["reason"] = "search across all zones/spaces is not supported by this tenant's API"
		case ue.Status == 401 || ue.Status == 403:
			resp["reason"] = "the tenant API rejected these credentials — sign in again and retry"
		case ue.Status == 429:
			resp["reason"] = "the tenant API is rate-limiting these requests — wait and retry"
		}
	}
	if msg, found := extractUpstreamMessage(ue.Snippet); found {
		resp["upstream"] = msg
	}
	return resp
}

// searchUnsupportedStatuses is the exact set that maps to "unsupported". Three
// entries, each for a stated reason:
//
//	400  the live probe, 2026-08-06: filtering dns/record on the non-existent
//	     field absolute_name_in_zone returned
//	     {"error":[{"message":"Unknown field: absolute_name_in_zone"}]}.
//	     This is the case the whole state was invented for.
//	404  both handlers send a COMPILE-TIME path (/api/ddi/v1/ipam/address,
//	     /api/ddi/v1/dns/record) with no user input anywhere in it, and CSP
//	     answers a collection read, not an object read — so a 404 cannot mean
//	     "the thing you named is missing". It can only mean this tenant's CSP
//	     does not serve that collection, which is the same permanent gap as
//	     a rejected field.
//	422  these are GETs with no request body, so the only thing upstream can
//	     find well-formed-but-unprocessable is the _filter itself. Same
//	     meaning as the 400, arriving under the other conventional status.
//
// Not here, deliberately: 401 and 403 (a CSP token expires — telling that
// operator their API is incapable sends them to the wrong problem entirely),
// and 429 (a rate limit is the definition of "try again later"). All three are
// temporary, all three now answer "error" with a reason that says what to do,
// and none of them claims anything about what the tenant supports.
var searchUnsupportedStatuses = map[int]bool{400: true, 404: true, 422: true}

// searchQuery trims, bounds and escapes ?q=. It returns a ready-to-send 200
// body when the query cannot be used at all, so neither handler ever answers
// non-200 for something a caller can type.
//
// AN OVER-LONG QUERY IS REFUSED, NOT TRUNCATED, and that is the one place this
// deliberately parts company with the assets path it borrows searchQueryMax
// from. assets clamps a `contains` needle, where a shorter needle only matches
// more rows. Both filters here are `==`, exact — a truncated query matches
// NOTHING, and the handler would then answer availability "ok" with zero rows
// for a search that was never really run. "This tenant holds no such record"
// when the truth is "we asked a mangled question" is exactly the failure the
// four availability states exist to prevent.
//
// Refusing also removes the mid-rune hazard by construction: nothing is cut, so
// no cut can land inside a multi-byte character and hand upstream a _filter
// containing invalid UTF-8. The bound is measured in bytes, like assetQueryMax,
// but because it only ever gates and never slices, a 256-byte query made of
// two-byte runes arrives whole.
func searchQuery(r *http.Request) (esc string, bad map[string]any) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		return "", map[string]any{
			"availability": "empty",
			"reason":       "no query given",
			"rows":         []any{},
		}
	}
	if len(q) > searchQueryMax {
		return "", map[string]any{
			"availability": "error",
			"reason":       "the query is too long to be a host name or an address",
			"rows":         []any{},
		}
	}
	esc, err := rest.CSPQ(q)
	if err != nil {
		return "", map[string]any{
			"availability": "error",
			"reason":       "the query contains characters that cannot be sent in a filter",
			"rows":         []any{},
		}
	}
	return esc, nil
}

// searchIPAM answers GET /api/search/ipam?q= — every IPAM address object whose
// address is exactly q, across every IP space. No parent clause: that is the
// unparented filter, and it is what makes this a search rather than a listing.
// space is carried on each row because results can span spaces and an address
// with no space named is ambiguous.
func (d *Deps) searchIPAM(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/search/ipam")
	esc, bad := searchQuery(r)
	if bad != nil {
		d.json(w, r, 200, bad)
		return
	}
	rows, extra, ue := d.searchFetch(r, "/api/ddi/v1/ipam/address",
		map[string]string{"_filter": `address=="` + esc + `"`})
	if ue != nil {
		d.json(w, r, 200, searchUnavailable(ue))
		return
	}
	d.json(w, r, 200, searchResponse(
		pick(rows, "id", "address", "name", "comment", "state", "space"), extra))
}

// searchDNS answers GET /api/search/dns?q= — every DNS record whose absolute
// name OR whose rdata is exactly q, across every zone. No zone clause. Both
// sides of the or matter for a dossier: querying an IP finds the A records
// pointing at it (dns_rdata), querying a hostname finds the record itself
// (absolute_name_spec). zone is carried on each row for the same reason space
// is above.
//
// THE FIELD NAMES HERE WERE PROBED AGAINST THE LIVE TENANT, NOT ASSUMED, and
// the obvious guess was wrong. absolute_name_in_zone — what the plan named — is
// rejected outright: 400 {"error":[{"message":"Unknown field:
// absolute_name_in_zone"}]}. What this tenant's CSP actually accepts on
// dns/record, verified one field at a time on 2026-08-06:
//
//	absolute_name_spec      accepted, returns rows          <- used
//	dns_absolute_name_spec  accepted, returns identical rows (the dns_ alias)
//	dns_rdata               accepted, returns rows          <- used
//	name_in_zone            accepted (bare label, no zone context — not useful)
//	rdata                   accepted as a field, but 400 "Operation EQ is not
//	                        allowed for 'rdata'" — hence dns_rdata
//	absolute_name_in_zone   400 Unknown field
//
// THE TRAILING DOT IS LOAD-BEARING. absolute_name_spec holds the fully
// qualified name WITH its root dot, and CSP's == is exact: "app-dc1-prod.acme.corp."
// matches, "app-dc1-prod.acme.corp" returns zero rows. Nobody types the dot, and
// a zero-row answer to a name that exists is precisely the "reads as no DNS
// record when the truth is we asked the wrong question" failure this endpoint is
// supposed to prevent. So an unterminated query gets both of its clauses
// repeated with the dot appended — same single request, two more or-terms. Both,
// not just the name one: a PTR record's rdata is a dotted FQDN too, so
// "app-dc1-prod.acme.corp" would otherwise find the A record and silently miss
// the PTR pointing back at it (verified live — the dotted form returns both, the
// bare form returned only the A before this clause existed).
func (d *Deps) searchDNS(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/search/dns")
	esc, bad := searchQuery(r)
	if bad != nil {
		d.json(w, r, 200, bad)
		return
	}
	clauses := []string{`absolute_name_spec=="` + esc + `"`, `dns_rdata=="` + esc + `"`}
	if !strings.HasSuffix(esc, ".") {
		clauses = append(clauses,
			`absolute_name_spec=="`+esc+`."`, `dns_rdata=="`+esc+`."`)
	}
	rows, extra, ue := d.searchFetch(r, "/api/ddi/v1/dns/record",
		map[string]string{"_filter": strings.Join(clauses, " or ")})
	if ue != nil {
		d.json(w, r, 200, searchUnavailable(ue))
		return
	}
	d.json(w, r, 200, searchResponse(
		pick(rows, "id", "absolute_name_spec", "name_in_zone", "absolute_zone_name",
			"type", "ttl", "dns_rdata", "zone", "comment", "disabled"), extra))
}

// searchResponse merges the shaped rows with searchFetch's truncation metadata.
func searchResponse(rows []any, extra map[string]any) map[string]any {
	resp := map[string]any{"availability": "ok", "rows": rows}
	for k, v := range extra {
		resp[k] = v
	}
	return resp
}
