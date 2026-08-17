package server

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- /api/provision/stream: the run's OUTCOME, not merely its completion ------
//
// provisionSubnetStream used to bind `result, status, _` and look at none of the
// three. rest.Write hands an upstream 4xx/5xx back as (errorBody, status, nil),
// so a refused allocation still ended in `{"done":true,"subnet":{...null}}` and a
// provision-subnet SUCCESS row carrying `subnet: <nil>`. The UI turns any done
// frame into "Provisioned — subnet " (ui/src/tabs/Provision.jsx:115,307) and
// renders the failure frame as the bare words "Subnet allocation result" (:186),
// so the operator had no signal at all.
//
// These tests drive the real handler with a real audit.Log on disk, because a
// detail value canonicalJSON rejects makes auditAppend log-and-continue: the
// stream would still look right while nothing was recorded.

// subnetUpstream answers the allocation with the given status and body, and the
// reverse-zone POST with the zone status and body. A zone status of 0 means the
// test does not expect the zone call at all.
func subnetUpstream(allocStatus int, allocBody string, zoneStatus int, zoneBody string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/nextavailablesubnet"):
			w.WriteHeader(allocStatus)
			io.WriteString(w, allocBody)
		case strings.HasSuffix(r.URL.Path, "/dns/auth_zone"):
			w.WriteHeader(zoneStatus)
			io.WriteString(w, zoneBody)
		default:
			w.WriteHeader(500)
			fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, r.URL.Path)
		}
	}
}

const okAllocBody = `{"results":[{"id":"ipam/subnet/sn-1","address":"10.1.7.0","cidr":25}]}`

// noDoneFrame is the assertion the whole issue turns on: a run that failed must
// not end in the frame the UI reads as success.
func noDoneFrame(t *testing.T, frames []map[string]any) {
	t.Helper()
	for _, f := range frames {
		if f["done"] == true {
			t.Fatalf("the run failed but still emitted a terminal done frame %v — the UI reads "+
				"any done frame as \"Provisioned\" (ui/src/tabs/Provision.jsx:115)", f)
		}
	}
}

// eventCount reads the on-disk log and counts one event.
func eventCount(t *testing.T, logPath, event string) int {
	t.Helper()
	return len(auditEntries(t, logPath, event))
}

// --- allocation failures: nothing was created --------------------------------

func TestSubnetStream_AllocationFailures_ReportFailureAndAuditOnlyTheError(t *testing.T) {
	cases := []struct {
		name       string
		upstream   http.HandlerFunc
		wantInText string
	}{
		{
			// The CSP error shape. The upstream's own sentence has to survive into
			// the operator's banner and the log, or the run is unreconcilable.
			name:       "4xx with a JSON error body",
			upstream:   subnetUpstream(400, `{"error":[{"message":"no available subnet of that size in this block"}]}`, 0, ""),
			wantInText: "no available subnet of that size in this block",
		},
		{
			// A gateway that never reached the API at all: no JSON to quote, so the
			// status is all there is — and it must still be a failure.
			name:       "5xx with a non-JSON body",
			upstream:   subnetUpstream(502, `<html>gateway</html>`, 0, ""),
			wantInText: "HTTP 502",
		},
		{
			// The one shape rest.Write DOES return an error for.
			name:       "transport failure",
			upstream:   nil, // wired below
			wantInText: "could not be sent",
		},
		{
			// A 2xx that allocated nothing. Just as empty as a 400, and it used to be
			// the exact shape that produced "Provisioned — subnet ".
			name:       "2xx with an empty results list",
			upstream:   subnetUpstream(200, `{"results":[]}`, 0, ""),
			wantInText: "no subnet address",
		},
		{
			// The address is the field every consumer needs; an id alone cannot be
			// reconciled, displayed, or turned into a reverse zone.
			name:       "2xx with an id but no address",
			upstream:   subnetUpstream(200, `{"results":[{"id":"ipam/subnet/sn-1","cidr":25}]}`, 0, ""),
			wantInText: "no subnet address",
		},
		{
			// A non-string address cannot become a usable one by coercion.
			name:       "2xx with a non-string address",
			upstream:   subnetUpstream(200, `{"results":[{"id":"ipam/subnet/sn-1","address":{"v":"10.1.7.0"},"cidr":25}]}`, 0, ""),
			wantInText: "no subnet address",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			up := tc.upstream
			if up == nil {
				// A server that hangs up mid-response is the closest reproducible
				// transport failure: rest.Write returns (nil, 0, err).
				up = func(w http.ResponseWriter, r *http.Request) {
					hj, ok := w.(http.Hijacker)
					if !ok {
						t.Skip("ResponseWriter is not a Hijacker; cannot simulate a transport failure")
					}
					conn, _, err := hj.Hijack()
					if err != nil {
						t.Fatalf("hijack: %v", err)
					}
					conn.Close()
				}
			}
			d, logPath := newResidualDeps(t, up)
			rr := httptest.NewRecorder()
			d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=25&dry=0"))

			frames := parseSSEFrames(t, rr.Body.String())
			noDoneFrame(t, frames)
			frame := errorFrame(t, frames)
			msg, _ := frame["error"].(string)
			if !strings.Contains(msg, tc.wantInText) {
				t.Fatalf("error frame = %q, want it to contain %q", msg, tc.wantInText)
			}

			if n := eventCount(t, logPath, "provision-subnet"); n != 0 {
				t.Fatalf("%d provision-subnet success row(s) written for an allocation that "+
					"created nothing — that is the false claim this fix removes", n)
			}
			detail := uaOnly(t, logPath, "provision-subnet-error",
				"the allocation was refused against a real address block")
			if detail["phase"] != "allocate" {
				t.Fatalf("audit phase = %v, want \"allocate\" — an auditor cannot otherwise tell a "+
					"refused allocation from a subnet that exists with no zone", detail["phase"])
			}
			if !strings.Contains(provisionStr(detail["error"]), tc.wantInText) {
				t.Fatalf("audit error = %v, want it to contain %q", detail["error"], tc.wantInText)
			}
			if strings.Contains(provisionStr(detail["error"]), "map[") {
				t.Fatalf("audit error = %v — a raw Go map was formatted into a log nobody can amend",
					detail["error"])
			}
		})
	}
}

// --- the success path still succeeds -----------------------------------------

// The id is NOT required: the address is what makes an allocation usable, and a
// predicate that demanded both would refuse a legitimate allocation.
func TestSubnetStream_AddressWithoutID_StillSucceeds(t *testing.T) {
	d, logPath := newResidualDeps(t,
		subnetUpstream(200, `{"results":[{"address":"10.1.7.0","cidr":25}]}`, 0, ""))
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=25&dry=0"))

	terminalFrameOf(t, parseSSEFrames(t, rr.Body.String()))
	if n := eventCount(t, logPath, "provision-subnet"); n != 1 {
		t.Fatalf("provision-subnet rows = %d, want 1", n)
	}
	if n := eventCount(t, logPath, "provision-subnet-error"); n != 0 {
		t.Fatalf("provision-subnet-error rows = %d, want 0 — the allocation succeeded", n)
	}
}

// --- reverse-zone failures: the subnet is REAL and the log must say so --------

func TestSubnetStream_ZoneFailures_AuditTheCreatedSubnetAndTheFailure(t *testing.T) {
	cases := []struct {
		name       string
		upstream   http.HandlerFunc
		qs         string
		wantInText string
	}{
		{
			name:       "zone refused by upstream",
			upstream:   subnetUpstream(200, okAllocBody, 409, `{"error":[{"message":"zone already exists"}]}`),
			qs:         "block=" + uaBlockID + "&cidr=25&make_zone=1&dry=0",
			wantInText: "zone already exists",
		},
		{
			// CidrToReverseZone refuses an IPv6 address before any zone request is
			// sent — a failure that used to `return ferr` with no success row at all.
			name:       "reverse-zone name cannot be derived",
			upstream:   subnetUpstream(200, `{"results":[{"id":"ipam/subnet/sn-1","address":"2001:db8::","cidr":64}]}`, 0, ""),
			qs:         "block=" + uaBlockID + "&cidr=64&make_zone=1&dry=0",
			wantInText: "reverse zone requires an IPv4 network",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d, logPath := newResidualDeps(t, tc.upstream)
			rr := httptest.NewRecorder()
			d.provisionSubnetStream(rr, uaSubnetRequest(tc.qs))

			frames := parseSSEFrames(t, rr.Body.String())
			noDoneFrame(t, frames)
			msg, _ := errorFrame(t, frames)["error"].(string)
			if !strings.Contains(msg, tc.wantInText) {
				t.Fatalf("error frame = %q, want it to contain %q", msg, tc.wantInText)
			}
			// The UI never shows the Result panel after an error frame, so if the
			// address is not in this sentence the operator cannot find the subnet
			// that now exists on the customer's network.
			if !strings.Contains(msg, "was created") {
				t.Fatalf("error frame = %q, want it to say the subnet WAS created", msg)
			}

			created := uaOnly(t, logPath, "provision-subnet",
				"the allocation succeeded, so a real subnet exists whatever the zone did")
			if provisionStr(created["subnet"]) == "" {
				t.Fatalf("provision-subnet row names no subnet: %v", created)
			}
			failed := uaOnly(t, logPath, "provision-subnet-error", "the zone step failed")
			if failed["phase"] != "reverse-zone" {
				t.Fatalf("audit phase = %v, want \"reverse-zone\"", failed["phase"])
			}
			if provisionStr(failed["subnet"]) != provisionStr(created["subnet"]) {
				t.Fatalf("error row names subnet %v, success row names %v — they describe one run",
					failed["subnet"], created["subnet"])
			}
		})
	}
}

// A clean run with make_zone=1 must still be a clean run.
func TestSubnetStream_ZoneSucceeds_NoErrorRow(t *testing.T) {
	d, logPath := newResidualDeps(t,
		subnetUpstream(200, okAllocBody, 201, `{"result":{"id":"dns/auth_zone/z-1"}}`))
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=25&make_zone=1&dry=0"))

	terminalFrameOf(t, parseSSEFrames(t, rr.Body.String()))
	if n := eventCount(t, logPath, "provision-subnet-error"); n != 0 {
		t.Fatalf("provision-subnet-error rows = %d, want 0 — subnet and zone both succeeded", n)
	}
	if n := eventCount(t, logPath, "provision-subnet"); n != 1 {
		t.Fatalf("provision-subnet rows = %d, want exactly 1", n)
	}
}

// A preview writes nothing, whatever the upstream would have said.
func TestSubnetStream_DryRun_UnaffectedByUpstreamFailure(t *testing.T) {
	d, logPath := newResidualDeps(t, subnetUpstream(400, `{"error":"refused"}`, 0, ""))
	rr := httptest.NewRecorder()
	d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=25&dry=1"))

	terminalFrameOf(t, parseSSEFrames(t, rr.Body.String()))
	uaNone(t, logPath, "", "a preview sends no allocation, so no row of any kind belongs in the log")
}

// --- the upstream-message extraction, shape by shape --------------------------

func TestUpstreamMessage_Shapes(t *testing.T) {
	cases := []struct {
		name string
		body any
		want string
	}{
		{"plain string", "  boom  ", "boom"},
		{"error string", map[string]any{"error": "refused"}, "refused"},
		{"CSP message list", map[string]any{"error": []any{
			map[string]any{"message": "first"}, map[string]any{"message": "second"}}}, "first; second"},
		{"bare message", map[string]any{"message": "plain"}, "plain"},
		{"unparseable body", nil, ""},
		{"structure with nothing sayable", map[string]any{"code": 7}, ""},
		{"list of non-objects", map[string]any{"error": []any{1, 2}}, ""},
	}
	for _, tc := range cases {
		if got := upstreamMessage(tc.body); got != tc.want {
			t.Fatalf("%s: upstreamMessage(%v) = %q, want %q", tc.name, tc.body, got, tc.want)
		}
	}
	if got := upstreamDetail(502, nil); got != " (HTTP 502)" {
		t.Fatalf("upstreamDetail with nothing sayable = %q", got)
	}
	if got := upstreamDetail(400, map[string]any{"error": "nope"}); got != " (HTTP 400): nope" {
		t.Fatalf("upstreamDetail = %q", got)
	}
}

func provisionStr(v any) string {
	s, _ := v.(string)
	return s
}
