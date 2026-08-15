package server

// The first tests GET /api/ipam/availability has ever had (issue #78). It is a
// registered public route with no caller anywhere in this repo — no UI fetch, no
// doc, no MCP tool — which is how both of its defects survived:
//
//   - it refused the only id shape a caller could hold. `subnetIDRe` allowed no
//     slash, so the full-form `ipam/subnet/<uuid>` that GET /api/ipam/subnets
//     hands out came back 400, and a bare id was then pasted behind a hardcoded
//     `ipam/subnet/` prefix — the doubled path of #73;
//   - it answered `free: 0` for a subnet with free addresses. `toIntAny` read a
//     numeric STRING as 0 while `firstTruthy` one line above passed the same
//     string through, so `254 - 10` came out as 0. A wrong number, not a missing
//     one: `free: 0` reads exactly like a measured full subnet.
//
// The assertions on `free` are about KEY ABSENCE, not a nil value, because the
// question the endpoint answers is "how many addresses are left" and 0 is a real
// answer to it. Unknown has to look different from full.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// availUpstream serves one subnet object with the given utilization JSON, and
// records the path it was asked for.
func availUpstream(t *testing.T, utilJSON string, seen *[]string) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		*seen = append(*seen, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"result":{"id":"ipam/subnet/s-1","address":"10.0.0.0","cidr":24,"utilization":%s}}`, utilJSON)
	}
}

func availRequest(subnet string) *http.Request {
	r := httptest.NewRequest("GET", "/api/ipam/availability?subnet="+subnet, nil)
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	return r
}

// availCall drives the handler and returns the response code plus the decoded
// utilization object.
func availCall(t *testing.T, subnet, utilJSON string) (int, map[string]any, []string) {
	t.Helper()
	var seen []string
	d, _ := newResidualDeps(t, availUpstream(t, utilJSON, &seen))
	rr := httptest.NewRecorder()
	d.ipamAvailability(rr, availRequest(subnet))
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("undecodable response %q: %v", rr.Body.String(), err)
	}
	util, _ := body["utilization"].(map[string]any)
	return rr.Code, util, seen
}

// TestAvailability_AcceptsBothIDShapes. The full-form case is the one that used
// to 400; both must resolve to the same single upstream path.
func TestAvailability_AcceptsBothIDShapes(t *testing.T) {
	const wantPath = "GET /api/ddi/v1/ipam/subnet/s-1"
	for _, id := range []string{"ipam%2Fsubnet%2Fs-1", "s-1"} {
		t.Run(id, func(t *testing.T) {
			code, util, seen := availCall(t, id, `{"used":10,"total":254}`)
			if code != 200 {
				t.Fatalf("status = %d, want 200", code)
			}
			if len(seen) != 1 || seen[0] != wantPath {
				t.Fatalf("upstream calls = %v, want exactly [%q]", seen, wantPath)
			}
			if util["free"] != float64(244) {
				t.Fatalf("free = %v, want 244", util["free"])
			}
		})
	}
}

// TestAvailability_RefusesIDsThatEscapeTheirPath — zero upstream calls, because
// a refusal issued after the request is on the wire has already made it.
func TestAvailability_RefusesIDsThatEscapeTheirPath(t *testing.T) {
	for _, id := range []string{"..%2F..%2F..%2Fatlas%2Fv1%2Fpwn", "dns%2Fauth_zone%2Fz-1", "s-1%2Fextra"} {
		t.Run(id, func(t *testing.T) {
			var seen []string
			d, _ := newResidualDeps(t, availUpstream(t, `{}`, &seen))
			rr := httptest.NewRecorder()
			d.ipamAvailability(rr, availRequest(id))
			if rr.Code != 400 {
				t.Fatalf("status = %d, want 400 for %q", rr.Code, id)
			}
			if len(seen) != 0 {
				t.Fatalf("%d upstream calls, want 0: %v", len(seen), seen)
			}
		})
	}
}

// TestAvailability_FreeIsNeverGuessed is the headline. The string row is the
// captured bug; the rest are the ways a subtraction can invent a number.
func TestAvailability_FreeIsNeverGuessed(t *testing.T) {
	cases := []struct {
		name    string
		util    string
		want    any // nil => the key must be ABSENT
		wantTot any
	}{
		{"numeric used and total", `{"used":10,"total":254}`, float64(244), float64(254)},
		{"STRING used and total", `{"used":"10","total":"254"}`, float64(244), "254"},
		{"free reported directly", `{"used":10,"total":254,"free":7}`, float64(7), float64(254)},
		{"a reported total of zero", `{"used":0,"total":0}`, float64(0), float64(0)},
		{"total absent", `{"used":10}`, nil, nil},
		{"used absent", `{"total":254}`, nil, float64(254)},
		{"unparseable total", `{"used":10,"total":"lots"}`, nil, "lots"},
		{"fractional total", `{"used":10,"total":254.5}`, nil, 254.5},
		{"negative used", `{"used":-5,"total":254}`, nil, float64(254)},
		{"used exceeds total", `{"used":300,"total":254}`, nil, float64(254)},
		{"no utilization at all", `{}`, nil, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, util, _ := availCall(t, "ipam%2Fsubnet%2Fs-1", tc.util)
			if code != 200 {
				t.Fatalf("status = %d, want 200", code)
			}
			got, present := util["free"]
			if tc.want == nil {
				if present {
					t.Fatalf("free = %v, want the key ABSENT — a count nobody measured must not "+
						"be reported, and 0 reads as a full subnet", got)
				}
				return
			}
			if !present || got != tc.want {
				t.Fatalf("free = %v (present=%v), want %v", got, present, tc.want)
			}
			if util["total"] != tc.wantTot {
				t.Fatalf("total = %v, want %v", util["total"], tc.wantTot)
			}
		})
	}
}

// TestAvailability_ReportedZeroTotalIsNotDiscarded. The old selection used
// firstTruthy, so a REPORTED total of 0 was falsy and the handler silently
// answered with dhcp_total instead — a different subnet measurement standing in
// for this one. internal/dashboard/norm.go records the same trap for the same
// data.
func TestAvailability_ReportedZeroTotalIsNotDiscarded(t *testing.T) {
	code, util, _ := availCall(t, "s-1", `{"used":0,"total":0,"dhcp_total":512}`)
	if code != 200 {
		t.Fatalf("status = %d, want 200", code)
	}
	if util["total"] != float64(0) {
		t.Fatalf("total = %v, want the REPORTED 0, not dhcp_total's 512", util["total"])
	}
	if util["free"] != float64(0) {
		t.Fatalf("free = %v, want 0 — here 0 is a measurement, not a guess", util["free"])
	}
}

// TestAvailability_FallsBackToDHCPTotalWhenTotalIsAbsent keeps the fallback the
// presence rule must not remove: absent (or null) is still unreported.
func TestAvailability_FallsBackToDHCPTotalWhenTotalIsAbsent(t *testing.T) {
	for _, util := range []string{`{"used":10,"dhcp_total":512}`, `{"used":10,"total":null,"dhcp_total":512}`} {
		code, got, _ := availCall(t, "s-1", util)
		if code != 200 || got["total"] != float64(512) {
			t.Fatalf("total = %v (status %d) for %s, want 512", got["total"], code, util)
		}
	}
}

// TestAvailability_UnreadableUpstreamIsA502. Answering HTTP 200 with an error
// body inside it is a reply that contradicts itself — the same shape removed
// from the update builders. This is a stated API behaviour change.
func TestAvailability_UnreadableUpstreamIsA502(t *testing.T) {
	cases := []struct {
		name  string
		reply func(http.ResponseWriter)
	}{
		{"non-JSON 200", func(w http.ResponseWriter) { io.WriteString(w, "<html>hi</html>") }},
		{"JSON array 200", func(w http.ResponseWriter) { io.WriteString(w, `[{"id":"x"}]`) }},
		{"empty 200", func(w http.ResponseWriter) {}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d, _ := newResidualDeps(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				tc.reply(w)
			})
			rr := httptest.NewRecorder()
			d.ipamAvailability(rr, availRequest("s-1"))
			if rr.Code != 502 {
				t.Fatalf("status = %d, want 502 — a 200 that cannot be read is not a lookup that "+
					"succeeded; body=%s", rr.Code, rr.Body.String())
			}
			if strings.Contains(rr.Body.String(), "127.0.0.1") {
				t.Fatalf("response leaks the upstream address: %s", rr.Body.String())
			}
		})
	}
}

// TestAvailability_BareBodyWithoutAResultWrapper — CSP answers some object reads
// unwrapped, and the handler has always accepted both. Pinned so the id change
// did not quietly drop one.
func TestAvailability_BareBodyWithoutAResultWrapper(t *testing.T) {
	var seen []string
	d, _ := newResidualDeps(t, func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ipam/subnet/s-1","address":"10.9.0.0","cidr":25,"utilization":{"used":"1","total":"126"}}`)
	})
	rr := httptest.NewRecorder()
	d.ipamAvailability(rr, availRequest("s-1"))
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("undecodable: %v", err)
	}
	if body["address"] != "10.9.0.0" {
		t.Fatalf("address = %v, want the unwrapped body's own field", body["address"])
	}
	util, _ := body["utilization"].(map[string]any)
	if util["free"] != float64(125) {
		t.Fatalf("free = %v, want 125", util["free"])
	}
}
