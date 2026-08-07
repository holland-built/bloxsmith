package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

// searchHandler names one of the two estate-search routes so the shared-contract
// tests below can run the identical assertion against both. Every expected
// value in this file is a hand-written literal — the page size is written as 50
// and the probe fetch as 51, never derived from searchLimit, so a change to that
// constant fails these tests instead of silently agreeing with them.
type searchHandler struct {
	name    string
	fn      func(*Deps) http.HandlerFunc
	req     string // a request URL with a usable q
	upstrea string // the upstream path this route must call
}

var searchHandlers = []searchHandler{
	{
		name:    "ipam",
		fn:      func(d *Deps) http.HandlerFunc { return d.searchIPAM },
		req:     "/api/search/ipam?q=10.0.0.1",
		upstrea: "/api/ddi/v1/ipam/address",
	},
	{
		name:    "dns",
		fn:      func(d *Deps) http.HandlerFunc { return d.searchDNS },
		req:     "/api/search/dns?q=host.example.com",
		upstrea: "/api/ddi/v1/dns/record",
	},
}

// --- the contract: never a non-200, whatever happens --------------------------

// TestSearchUpstreamFailureIsAlwaysHTTP200 is THE contract test for these two
// routes, and the reason neither of them may call pagedFetch: pagedFetch writes
// its own 502 on an upstream failure (ipam.go:306-319, documented at :354), and
// a 502 carries no availability body at all. The dossier page renders five
// independent sections, so a section that answers 502 is indistinguishable in
// the browser from the whole page being broken. A 5xx upstream is a dead feed —
// availability "error", not "unsupported", and never an empty list.
func TestSearchUpstreamFailureIsAlwaysHTTP200(t *testing.T) {
	for _, h := range searchHandlers {
		t.Run(h.name, func(t *testing.T) {
			d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(500)
				w.Write([]byte(`{"error":"boom"}`))
			})
			defer closeSrv()

			rr := httptest.NewRecorder()
			h.fn(d)(rr, httptest.NewRequest("GET", h.req, nil))

			if rr.Code != 200 {
				t.Fatalf("status = %d, want 200 (a dead upstream must not make this section look like a broken page); body=%s",
					rr.Code, rr.Body.String())
			}
			body := decodeBody(t, rr)
			if body["availability"] != "error" {
				t.Fatalf("availability = %v, want \"error\"; body=%s", body["availability"], rr.Body.String())
			}
			rows, ok := body["rows"].([]any)
			if !ok || len(rows) != 0 {
				t.Fatalf("rows = %v, want an empty list present (a missing rows key breaks the section's render)", body["rows"])
			}
			if body["reason"] == nil || body["reason"] == "" {
				t.Fatalf("reason missing on a failed search — the whole point of answering 200 is that the reason reaches the screen: %s", rr.Body.String())
			}
		})
	}
}

// TestSearchUpstreamRejectionIsUnsupportedNotEmpty pins the distinction the
// dossier page depends on. CSP answers a filter it will not accept with a 4xx —
// this is the SHAPE OBSERVED LIVE on 2026-08-06 against the real tenant, when
// the field name from the plan was tried:
//
//	400 {"error":[{"message":"Unknown field: absolute_name_in_zone"}]}
//
// That must not become an empty row list. "No rows" reads as "this IP has no DNS
// record"; the truth is "we could not ask", and the two are different facts.
func TestSearchUpstreamRejectionIsUnsupportedNotEmpty(t *testing.T) {
	for _, h := range searchHandlers {
		t.Run(h.name, func(t *testing.T) {
			d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(400)
				w.Write([]byte(`{"error":[{"message":"Unknown field: absolute_name_in_zone"}]}`))
			})
			defer closeSrv()

			rr := httptest.NewRecorder()
			h.fn(d)(rr, httptest.NewRequest("GET", h.req, nil))

			if rr.Code != 200 {
				t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
			}
			body := decodeBody(t, rr)
			if body["availability"] != "unsupported" {
				t.Fatalf("availability = %v, want \"unsupported\" (a refused filter is a capability report, not an empty result); body=%s",
					body["availability"], rr.Body.String())
			}
			if body["reason"] != "search across all zones/spaces is not supported by this tenant's API" {
				t.Fatalf("reason = %v, want the capability sentence", body["reason"])
			}
			if body["upstream"] != "Unknown field: absolute_name_in_zone" {
				t.Fatalf("upstream = %v, want the allowlisted upstream message", body["upstream"])
			}
			if status, ok := body["status"].(float64); !ok || int(status) != 400 {
				t.Fatalf("status field = %v, want 400", body["status"])
			}
		})
	}
}

// TestSearchStatusToAvailability is the whole 4xx range, not just the one status
// the live probe produced. "unsupported" is a PERMANENT verdict — it tells the
// operator their tenant's API cannot answer this question at all, and an
// operator who reads that stops trying. So it may only be reached by a status
// that actually means "upstream rejected this filter". An expired CSP token
// (401), a permission denial (403) and a rate limit (429) are all TEMPORARY and
// must land in "error" with a reason that says so — none of them says anything
// about what the tenant's API supports.
//
// Every want below is a hand-written literal. The reason strings are typed out
// in full rather than referenced from the handler, so changing the sentence a
// user reads has to be done deliberately in two places.
func TestSearchStatusToAvailability(t *testing.T) {
	cases := []struct {
		status           int
		wantAvailability string
		wantReason       string
	}{
		// The live probe: filtering on a field CSP does not have.
		// 400 {"error":[{"message":"Unknown field: absolute_name_in_zone"}]}
		{400, "unsupported", "search across all zones/spaces is not supported by this tenant's API"},
		// Both handlers send a COMPILE-TIME path with no user input in it, so a
		// 404 cannot mean "you asked for a record that does not exist" — it can
		// only mean this tenant's CSP does not serve that collection. Permanent.
		{404, "unsupported", "search across all zones/spaces is not supported by this tenant's API"},
		// A GET with no body: the only thing upstream can find semantically
		// unprocessable is the _filter itself. Same verdict as 400. Permanent.
		{422, "unsupported", "search across all zones/spaces is not supported by this tenant's API"},
		// The retryable half. An expired token is the single most likely 401 an
		// operator will ever see here, and telling them their API is incapable
		// is the exact wrong instruction.
		{401, "error", "the tenant API rejected these credentials — sign in again and retry"},
		{403, "error", "the tenant API rejected these credentials — sign in again and retry"},
		{429, "error", "the tenant API is rate-limiting these requests — wait and retry"},
		// Not a 4xx at all: a dead feed, already covered by the contract test
		// above; pinned here so the whole ladder is in one place.
		{500, "error", "The upstream server returned an error (status 500)."},
		{503, "error", "The upstream server returned an error (status 503)."},
	}
	for _, tc := range cases {
		for _, h := range searchHandlers {
			t.Run(h.name+"/"+strconv.Itoa(tc.status), func(t *testing.T) {
				d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
					w.WriteHeader(tc.status)
					w.Write([]byte(`{"error":"nope"}`))
				})
				defer closeSrv()

				rr := httptest.NewRecorder()
				h.fn(d)(rr, httptest.NewRequest("GET", h.req, nil))

				if rr.Code != 200 {
					t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
				}
				body := decodeBody(t, rr)
				if body["availability"] != tc.wantAvailability {
					t.Fatalf("upstream %d: availability = %v, want %q; body=%s",
						tc.status, body["availability"], tc.wantAvailability, rr.Body.String())
				}
				if body["reason"] != tc.wantReason {
					t.Fatalf("upstream %d: reason = %v, want %q", tc.status, body["reason"], tc.wantReason)
				}
				if tc.wantAvailability == "error" && strings.Contains(body["reason"].(string), "not supported") {
					t.Fatalf("upstream %d: a retryable failure claimed a permanent capability gap: %v",
						tc.status, body["reason"])
				}
				rows, ok := body["rows"].([]any)
				if !ok || len(rows) != 0 {
					t.Fatalf("upstream %d: rows = %v, want an empty list present", tc.status, body["rows"])
				}
			})
		}
	}
}

// TestSearchUpstreamFailureIssuesExactlyOneRequest mirrors the same guard on
// dnsRecordsGet: the typed error must come from the one GetPageStrict call
// already made, never a second request to an upstream that is already failing.
func TestSearchUpstreamFailureIssuesExactlyOneRequest(t *testing.T) {
	for _, h := range searchHandlers {
		t.Run(h.name, func(t *testing.T) {
			calls := 0
			d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.WriteHeader(500)
				w.Write([]byte(`{"error":"boom"}`))
			})
			defer closeSrv()

			rr := httptest.NewRecorder()
			h.fn(d)(rr, httptest.NewRequest("GET", h.req, nil))

			if calls != 1 {
				t.Fatalf("upstream calls = %d, want exactly 1 (no re-fetch to recover the error)", calls)
			}
		})
	}
}

// TestSearchRawUpstreamBodyNeverInResponse keeps the allowlist honest: answering
// 200 with a reason must not become an excuse to forward the upstream body.
func TestSearchRawUpstreamBodyNeverInResponse(t *testing.T) {
	const marker = "TOTALLY-DISTINCTIVE-UPSTREAM-MARKER-XYZ"
	for _, h := range searchHandlers {
		t.Run(h.name, func(t *testing.T) {
			d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(400)
				w.Write([]byte(`{"error":"bad filter","debug":"` + marker + `","stack":"trace ` + marker + `"}`))
			})
			defer closeSrv()

			rr := httptest.NewRecorder()
			h.fn(d)(rr, httptest.NewRequest("GET", h.req, nil))

			if strings.Contains(rr.Body.String(), marker) {
				t.Fatalf("raw upstream body leaked into HTTP response: %s", rr.Body.String())
			}
		})
	}
}

// --- query handling -----------------------------------------------------------

// TestSearchEmptyQueryIsEmptyNotOk pins that "you gave me nothing to look for"
// is its own state. If it reported availability "ok" with no rows, the page
// would tell an operator the estate holds no match for a search that never ran.
func TestSearchEmptyQueryIsEmptyNotOk(t *testing.T) {
	for _, h := range searchHandlers {
		for _, q := range []string{"", "   "} {
			t.Run(h.name+"/"+strings.ReplaceAll(q, " ", "_"), func(t *testing.T) {
				calls := 0
				d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
					calls++
					w.Write([]byte(`{"results":[]}`))
				})
				defer closeSrv()

				path := strings.SplitN(h.req, "?", 2)[0] + "?q=" + strings.ReplaceAll(q, " ", "%20")
				rr := httptest.NewRecorder()
				h.fn(d)(rr, httptest.NewRequest("GET", path, nil))

				if rr.Code != 200 {
					t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
				}
				body := decodeBody(t, rr)
				if body["availability"] != "empty" {
					t.Fatalf("availability = %v, want \"empty\" (no query is not the same as no match); body=%s",
						body["availability"], rr.Body.String())
				}
				if calls != 0 {
					t.Fatalf("upstream calls = %d, want 0 — an empty query must not be sent upstream", calls)
				}
			})
		}
	}
}

// TestSearchQuerySanitisedThroughCSPQ covers both halves of rest.CSPQ.
//
// A control character is REJECTED (CSPQ returns ErrBadFilter) and must never
// reach upstream. A double quote and a backslash are ESCAPED, not rejected, and
// the escaped form is what must appear in the _filter — a bare `"` would close
// the quoted clause and let the rest of the query be read as filter syntax. The
// want values here are written out by hand, not produced by calling CSPQ.
func TestSearchQuerySanitisedThroughCSPQ(t *testing.T) {
	t.Run("control-char-rejected", func(t *testing.T) {
		for _, h := range searchHandlers {
			t.Run(h.name, func(t *testing.T) {
				calls := 0
				d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
					calls++
					w.Write([]byte(`{"results":[]}`))
				})
				defer closeSrv()

				path := strings.SplitN(h.req, "?", 2)[0] + "?q=bad%00value"
				rr := httptest.NewRecorder()
				h.fn(d)(rr, httptest.NewRequest("GET", path, nil))

				if rr.Code != 200 {
					t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
				}
				body := decodeBody(t, rr)
				if body["availability"] != "error" {
					t.Fatalf("availability = %v, want \"error\" for an unsendable query; body=%s",
						body["availability"], rr.Body.String())
				}
				if calls != 0 {
					t.Fatalf("upstream calls = %d, want 0 — a query CSPQ rejects must never be sent", calls)
				}
			})
		}
	})

	t.Run("quote-and-backslash-escaped", func(t *testing.T) {
		cases := []struct {
			name, handler, path, wantFilter string
		}{
			{
				name: "ipam-double-quote", handler: "ipam",
				path:       `/api/search/ipam?q=a%22b`,
				wantFilter: `address=="a\"b"`,
			},
			{
				name: "ipam-backslash", handler: "ipam",
				path:       `/api/search/ipam?q=a%5Cb`,
				wantFilter: `address=="a\\b"`,
			},
			{
				name: "dns-double-quote", handler: "dns",
				path:       `/api/search/dns?q=a%22b`,
				wantFilter: `absolute_name_spec=="a\"b" or dns_rdata=="a\"b" or absolute_name_spec=="a\"b." or dns_rdata=="a\"b."`,
			},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				var gotFilter string
				d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
					gotFilter = r.URL.Query().Get("_filter")
					w.Write([]byte(`{"results":[]}`))
				})
				defer closeSrv()

				rr := httptest.NewRecorder()
				if tc.handler == "ipam" {
					d.searchIPAM(rr, httptest.NewRequest("GET", tc.path, nil))
				} else {
					d.searchDNS(rr, httptest.NewRequest("GET", tc.path, nil))
				}
				if gotFilter != tc.wantFilter {
					t.Fatalf("_filter = %q, want %q", gotFilter, tc.wantFilter)
				}
			})
		}
	})
}

// TestSearchOverLongQueryIsRejected bounds ?q= at 256 BYTES — the same ceiling
// internal/dashboard/assets.go:90 already applies to user text (assetQueryMax),
// not a new number invented here. Without it a multi-hundred-kilobyte q is
// escaped and forwarded upstream, and searchDNS interpolates it FOUR times into
// one request, so the body upstream receives is roughly four times whatever was
// typed.
//
// REJECTED, NOT TRUNCATED, and that is the one place this deliberately differs
// from the assets path it borrows the number from. assets clamps a `contains`
// needle, where a shorter needle simply matches more rows. Both filters here are
// `==`, exact: a truncated query matches NOTHING, and the handler would then
// answer availability "ok" with zero rows — "this tenant holds no such record"
// — for a search that was never actually run. That is precisely the lie this
// file exists to prevent, so an over-long q is refused up front and never sent.
//
// 256 bytes is also a real semantic ceiling rather than an arbitrary one: a
// fully qualified DNS name maxes out at 255 bytes and an IP address is far
// shorter, so nothing this endpoint can legitimately be asked about is longer.
//
// Rejecting also disposes of the mid-rune hazard structurally: there is no
// truncation, so no cut can ever land inside a multi-byte character and hand
// upstream a filter containing invalid UTF-8. The multibyte cases below are the
// boundary itself — "é" is two bytes, so 128 of them are exactly 256 and pass
// whole, and 129 are 258 and are refused.
func TestSearchOverLongQueryIsRejected(t *testing.T) {
	cases := []struct {
		name       string
		q          string
		wantSent   bool
		wantReason string
	}{
		{"ascii-256-accepted", strings.Repeat("a", 256), true, ""},
		{"ascii-257-rejected", strings.Repeat("a", 257), false,
			"the query is too long to be a host name or an address"},
		{"ascii-100k-rejected", strings.Repeat("a", 100000), false,
			"the query is too long to be a host name or an address"},
		// 128 two-byte runes = exactly 256 bytes: the last legal query, and it
		// must arrive upstream intact rather than cut at byte 256.
		{"multibyte-256-bytes-accepted", strings.Repeat("é", 128), true, ""},
		// 129 two-byte runes = 258 bytes. A byte clamp would have sliced the
		// 129th rune in half here.
		{"multibyte-258-bytes-rejected", strings.Repeat("é", 129), false,
			"the query is too long to be a host name or an address"},
	}
	for _, tc := range cases {
		for _, h := range searchHandlers {
			t.Run(tc.name+"/"+h.name, func(t *testing.T) {
				calls := 0
				var gotFilter string
				d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
					calls++
					gotFilter = r.URL.Query().Get("_filter")
					w.Write([]byte(`{"results":[]}`))
				})
				defer closeSrv()

				path := strings.SplitN(h.req, "?", 2)[0] + "?q=" + url.QueryEscape(tc.q)
				rr := httptest.NewRecorder()
				h.fn(d)(rr, httptest.NewRequest("GET", path, nil))

				if rr.Code != 200 {
					t.Fatalf("status = %d, want 200 — an over-long query is still a 200 with a reason; body=%s",
						rr.Code, rr.Body.String())
				}
				body := decodeBody(t, rr)

				if !tc.wantSent {
					if calls != 0 {
						t.Fatalf("upstream calls = %d, want 0 — a %d-byte query must never be forwarded",
							calls, len(tc.q))
					}
					if body["availability"] != "error" {
						t.Fatalf("availability = %v, want \"error\"; body=%s", body["availability"], rr.Body.String())
					}
					if body["reason"] != tc.wantReason {
						t.Fatalf("reason = %v, want %q", body["reason"], tc.wantReason)
					}
					if rows, ok := body["rows"].([]any); !ok || len(rows) != 0 {
						t.Fatalf("rows = %v, want an empty list present", body["rows"])
					}
					return
				}

				if calls != 1 {
					t.Fatalf("upstream calls = %d, want 1 — a %d-byte query is inside the limit and must be sent",
						calls, len(tc.q))
				}
				if body["availability"] != "ok" {
					t.Fatalf("availability = %v, want \"ok\"; body=%s", body["availability"], rr.Body.String())
				}
				if !utf8.ValidString(gotFilter) {
					t.Fatalf("_filter sent upstream is not valid UTF-8 — a clamp split a multi-byte rune: %q", gotFilter)
				}
				if !strings.Contains(gotFilter, tc.q) {
					t.Fatalf("_filter does not carry the whole query — it was cut: %q", gotFilter)
				}
			})
		}
	}
}

// --- the filters themselves, pinned against the live probe --------------------

// TestSearchIPAMFilterHasNoParentClause pins what makes this a search: the
// filter names the address and nothing else. /api/ipam/addresses sends
// parent=="<subnet>" (ipam.go:481) and therefore can only list a subnet you have
// already identified. Confirmed live 2026-08-06: this unparented filter returns
// 200 with a real row from the tenant.
func TestSearchIPAMFilterHasNoParentClause(t *testing.T) {
	var gotFilter, gotPath, gotLimit, gotTotalNeeded string
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotFilter = r.URL.Query().Get("_filter")
		gotLimit = r.URL.Query().Get("_limit")
		gotTotalNeeded = r.URL.Query().Get("_is_total_size_needed")
		w.Write([]byte(`{"results":[]}`))
	})
	defer closeSrv()

	rr := httptest.NewRecorder()
	d.searchIPAM(rr, httptest.NewRequest("GET", "/api/search/ipam?q=172.16.128.1", nil))

	if gotPath != "/api/ddi/v1/ipam/address" {
		t.Fatalf("upstream path = %q, want /api/ddi/v1/ipam/address", gotPath)
	}
	if want := `address=="172.16.128.1"`; gotFilter != want {
		t.Fatalf("_filter = %q, want %q", gotFilter, want)
	}
	if strings.Contains(gotFilter, "parent") {
		t.Fatalf("_filter contains a parent clause (%q) — that turns the estate-wide search back into a subnet listing", gotFilter)
	}
	if gotLimit != "51" {
		t.Fatalf("upstream _limit = %q, want 51 (page size 50 + 1 truncation probe row)", gotLimit)
	}
	if gotTotalNeeded != "true" {
		t.Fatalf("_is_total_size_needed = %q, want \"true\" — CSP only fills in the total when asked", gotTotalNeeded)
	}
}

// TestSearchDNSFilterFieldsAndNoZoneClause pins the field names that were
// PROBED against the live tenant, not guessed. The plan named
// absolute_name_in_zone; upstream answered 400 "Unknown field:
// absolute_name_in_zone". absolute_name_spec and dns_rdata were each confirmed
// to return the real record. The dot-suffixed pair exists because
// absolute_name_spec holds the FQDN with its root dot and CSP's == is exact, so
// a user-typed name without the dot would otherwise find nothing.
func TestSearchDNSFilterFieldsAndNoZoneClause(t *testing.T) {
	cases := []struct{ name, q, want string }{
		{
			name: "bare-name-gets-the-dotted-clauses",
			q:    "app-dc1-prod.acme.corp",
			want: `absolute_name_spec=="app-dc1-prod.acme.corp" or dns_rdata=="app-dc1-prod.acme.corp" or absolute_name_spec=="app-dc1-prod.acme.corp." or dns_rdata=="app-dc1-prod.acme.corp."`,
		},
		{
			name: "already-dotted-is-not-doubled",
			q:    "app-dc1-prod.acme.corp.",
			want: `absolute_name_spec=="app-dc1-prod.acme.corp." or dns_rdata=="app-dc1-prod.acme.corp."`,
		},
		{
			name: "ip-query-searches-rdata-too",
			q:    "10.4.0.53",
			want: `absolute_name_spec=="10.4.0.53" or dns_rdata=="10.4.0.53" or absolute_name_spec=="10.4.0.53." or dns_rdata=="10.4.0.53."`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotFilter, gotPath string
			d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
				gotPath = r.URL.Path
				gotFilter = r.URL.Query().Get("_filter")
				w.Write([]byte(`{"results":[]}`))
			})
			defer closeSrv()

			rr := httptest.NewRecorder()
			d.searchDNS(rr, httptest.NewRequest("GET", "/api/search/dns?q="+tc.q, nil))

			if gotPath != "/api/ddi/v1/dns/record" {
				t.Fatalf("upstream path = %q, want /api/ddi/v1/dns/record", gotPath)
			}
			if gotFilter != tc.want {
				t.Fatalf("_filter = %q, want %q", gotFilter, tc.want)
			}
			if strings.Contains(gotFilter, "zone==") {
				t.Fatalf("_filter contains a zone clause (%q) — that turns the estate-wide search back into a zone listing", gotFilter)
			}
			if strings.Contains(gotFilter, "absolute_name_in_zone") {
				t.Fatalf("_filter uses absolute_name_in_zone (%q) — upstream rejects that field with 400 \"Unknown field\"", gotFilter)
			}
		})
	}
}

// --- result shapes ------------------------------------------------------------

func TestSearchIPAMHitShape(t *testing.T) {
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[{"id":"ipam/address/2e305a93","address":"172.16.128.1","name":null,"comment":"Auto-created by vdiscovery","state":"used","space":"ipam/ip_space/78d386a0","dhcp_info":{"secret":"drop me"}}],"page":{"total_size":"1"}}`))
	})
	defer closeSrv()

	rr := httptest.NewRecorder()
	d.searchIPAM(rr, httptest.NewRequest("GET", "/api/search/ipam?q=172.16.128.1", nil))

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	body := decodeBody(t, rr)
	if body["availability"] != "ok" {
		t.Fatalf("availability = %v, want \"ok\"", body["availability"])
	}
	if total, ok := body["total"].(float64); !ok || int(total) != 1 {
		t.Fatalf("total = %v, want 1", body["total"])
	}
	if limit, ok := body["limit"].(float64); !ok || int(limit) != 50 {
		t.Fatalf("limit = %v, want 50", body["limit"])
	}
	if _, has := body["truncated"]; has {
		t.Fatalf("truncated present when an authoritative total was found: %v", body)
	}
	rows := body["rows"].([]any)
	if len(rows) != 1 {
		t.Fatalf("rows = %v, want 1", rows)
	}
	row := rows[0].(map[string]any)
	wantRowKeys := map[string]bool{
		"id": true, "address": true, "name": true, "comment": true,
		"state": true, "space": true,
	}
	for k := range row {
		if !wantRowKeys[k] {
			t.Fatalf("unexpected key %q in ipam row — the shaper must not pass upstream fields through: %v", k, row)
		}
	}
	for k := range wantRowKeys {
		if _, has := row[k]; !has {
			t.Fatalf("ipam row missing key %q: %v", k, row)
		}
	}
	if row["address"] != "172.16.128.1" {
		t.Fatalf("address = %v, want 172.16.128.1", row["address"])
	}
	if row["space"] != "ipam/ip_space/78d386a0" {
		t.Fatalf("space = %v, want the space id (results span spaces, so the row must say which)", row["space"])
	}
}

func TestSearchDNSHitShape(t *testing.T) {
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[{"id":"dns/record/22954b5b","absolute_name_spec":"app-dc1-prod.acme.corp.","name_in_zone":"app-dc1-prod","absolute_zone_name":"acme.corp.","type":"A","ttl":28800,"dns_rdata":"10.4.0.53","zone":"dns/auth_zone/909cf607","comment":"","disabled":false,"internal":"drop me"}]}`))
	})
	defer closeSrv()

	rr := httptest.NewRecorder()
	d.searchDNS(rr, httptest.NewRequest("GET", "/api/search/dns?q=app-dc1-prod.acme.corp", nil))

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	body := decodeBody(t, rr)
	if body["availability"] != "ok" {
		t.Fatalf("availability = %v, want \"ok\"", body["availability"])
	}
	rows := body["rows"].([]any)
	if len(rows) != 1 {
		t.Fatalf("rows = %v, want 1", rows)
	}
	row := rows[0].(map[string]any)
	wantRowKeys := map[string]bool{
		"id": true, "absolute_name_spec": true, "name_in_zone": true,
		"absolute_zone_name": true, "type": true, "ttl": true,
		"dns_rdata": true, "zone": true, "comment": true, "disabled": true,
	}
	for k := range row {
		if !wantRowKeys[k] {
			t.Fatalf("unexpected key %q in dns row: %v", k, row)
		}
	}
	for k := range wantRowKeys {
		if _, has := row[k]; !has {
			t.Fatalf("dns row missing key %q: %v", k, row)
		}
	}
	if row["absolute_name_spec"] != "app-dc1-prod.acme.corp." {
		t.Fatalf("absolute_name_spec = %v, want app-dc1-prod.acme.corp.", row["absolute_name_spec"])
	}
	if row["dns_rdata"] != "10.4.0.53" {
		t.Fatalf("dns_rdata = %v, want 10.4.0.53", row["dns_rdata"])
	}
	if row["zone"] != "dns/auth_zone/909cf607" {
		t.Fatalf("zone = %v, want the zone id (results span zones)", row["zone"])
	}
}

// TestSearchGenuinelyEmptyIsOk is the other half of the unsupported test above:
// upstream answered, and the answer is that the tenant holds no match. THAT is
// the only case allowed to render as "nothing found".
func TestSearchGenuinelyEmptyIsOk(t *testing.T) {
	for _, h := range searchHandlers {
		t.Run(h.name, func(t *testing.T) {
			d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(`{"results":[]}`))
			})
			defer closeSrv()

			rr := httptest.NewRecorder()
			h.fn(d)(rr, httptest.NewRequest("GET", h.req, nil))

			if rr.Code != 200 {
				t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
			}
			body := decodeBody(t, rr)
			if body["availability"] != "ok" {
				t.Fatalf("availability = %v, want \"ok\" (a genuinely empty result is not a failure)", body["availability"])
			}
			rows, ok := body["rows"].([]any)
			if !ok || len(rows) != 0 {
				t.Fatalf("rows = %v, want an empty list", body["rows"])
			}
			if body["truncated"] != false {
				t.Fatalf("truncated = %v, want false", body["truncated"])
			}
			if _, has := body["reason"]; has {
				t.Fatalf("reason present on a successful search: %v", body)
			}
		})
	}
}

// --- truncation metadata ------------------------------------------------------

// TestSearchTruncationMetadata covers both branches of searchFetch's metadata,
// which is the logic it shares with pagedFetch: an authoritative total when CSP
// supplies one, and the truncated flag derived from the 51st probe row when it
// does not. 51 rows in, 50 rows out, truncated true.
func TestSearchTruncationMetadata(t *testing.T) {
	ipamRow := `{"id":"1","address":"10.0.0.1","name":"h","comment":"","state":"used","space":"s"}`
	dnsRow := `{"id":"1","absolute_name_spec":"a.b.","name_in_zone":"a","absolute_zone_name":"b.","type":"A","ttl":1,"dns_rdata":"10.0.0.1","zone":"z","comment":"","disabled":false}`

	rowsFor := func(name string, n int) string {
		row := ipamRow
		if name == "dns" {
			row = dnsRow
		}
		out := make([]string, n)
		for i := range out {
			out[i] = row
		}
		return strings.Join(out, ",")
	}

	t.Run("no-total-truncated", func(t *testing.T) {
		for _, h := range searchHandlers {
			t.Run(h.name, func(t *testing.T) {
				d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
					// 51 rows: the page of 50 plus the one probe row that
					// proves there is more upstream.
					w.Write([]byte(`{"results":[` + rowsFor(h.name, 51) + `]}`))
				})
				defer closeSrv()

				rr := httptest.NewRecorder()
				h.fn(d)(rr, httptest.NewRequest("GET", h.req, nil))

				body := decodeBody(t, rr)
				if body["truncated"] != true {
					t.Fatalf("truncated = %v, want true", body["truncated"])
				}
				rows := body["rows"].([]any)
				if len(rows) != 50 {
					t.Fatalf("rows = %d, want exactly 50 (the page size; the 51st probe row must be dropped)", len(rows))
				}
				if _, has := body["total"]; has {
					t.Fatalf("total present when upstream supplied none — never invent a total: %v", body)
				}
			})
		}
	})

	t.Run("authoritative-total-suppresses-truncated", func(t *testing.T) {
		for _, h := range searchHandlers {
			t.Run(h.name, func(t *testing.T) {
				d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
					w.Write([]byte(`{"results":[` + rowsFor(h.name, 51) + `],"page":{"total_size":"4210"}}`))
				})
				defer closeSrv()

				rr := httptest.NewRecorder()
				h.fn(d)(rr, httptest.NewRequest("GET", h.req, nil))

				body := decodeBody(t, rr)
				if total, ok := body["total"].(float64); !ok || int(total) != 4210 {
					t.Fatalf("total = %v, want 4210", body["total"])
				}
				if _, has := body["truncated"]; has {
					t.Fatalf("truncated present alongside an authoritative total: %v", body)
				}
				rows := body["rows"].([]any)
				if len(rows) != 50 {
					t.Fatalf("rows = %d, want 50", len(rows))
				}
			})
		}
	})

	t.Run("count-key-is-not-trusted", func(t *testing.T) {
		d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(`{"results":[` + ipamRow + `],"count":9}`))
		})
		defer closeSrv()

		rr := httptest.NewRecorder()
		d.searchIPAM(rr, httptest.NewRequest("GET", "/api/search/ipam?q=10.0.0.1", nil))

		body := decodeBody(t, rr)
		if _, has := body["total"]; has {
			t.Fatalf("total present from a bare \"count\" key, want it rejected: %v", body)
		}
		if body["truncated"] != false {
			t.Fatalf("truncated = %v, want false", body["truncated"])
		}
	})
}

// --- registration -------------------------------------------------------------

// TestSearchRoutesAreReadsNotWrites states the writelock finding as an
// executable claim rather than a comment. Both routes are GETs that only read,
// exactly like the handlers in registerIPAMReadRoutes, so neither belongs in
// writelock.go's tenantWritePaths — and isTenantWrite must agree, or the write
// lock would refuse a search on any tenant that is merely being looked at.
//
// TestEveryWriteRouteIsClassified in writelock_routes_test.go covers the other
// direction (nothing state-changing escaped classification); it can only see
// these two routes because registerSearchRoutes was added to allRoutes there.
func TestSearchRoutesAreReadsNotWrites(t *testing.T) {
	d := &Deps{}
	rr := &recordingRouter{}
	d.registerSearchRoutes(rr)

	want := []string{"GET /api/search/ipam", "GET /api/search/dns"}
	if len(rr.patterns) != len(want) {
		t.Fatalf("registered %v, want exactly %v", rr.patterns, want)
	}
	for i, p := range want {
		if rr.patterns[i] != p {
			t.Fatalf("route %d = %q, want %q", i, rr.patterns[i], p)
		}
	}
	for _, p := range want {
		_, path := splitPattern(p)
		if isTenantWrite(path) {
			t.Errorf("%s is a read but isTenantWrite() says it changes the tenant — the write lock would refuse a search on a read-only tenant", path)
		}
	}
}
