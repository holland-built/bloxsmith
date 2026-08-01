package server

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

// /api/data?only= narrows the aggregate to the named slices. The one thing
// this endpoint must never do is answer a typo with a success: a 200 that is
// quietly thinner than asked for renders as an empty panel, i.e. "you have
// none" for data that was never requested. So an unknown name is a 400.

func TestApiData_UnknownSliceNameIs400(t *testing.T) {
	d := incidentsTestDeps(t, healthyEmptyFeedsHandler(nil))

	req := httptest.NewRequest("GET", "/api/data?only=zonez", nil)
	rr := httptest.NewRecorder()
	d.apiData(rr, req)

	if rr.Code != 400 {
		t.Fatalf("status = %d, want 400 for an unknown slice name; body=%s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body %q: %v", rr.Body.String(), err)
	}
	unknown, ok := body["unknown"].([]any)
	if !ok || len(unknown) != 1 || unknown[0] != "zonez" {
		t.Fatalf("body must name the bad slice, got %v", body)
	}
	if _, present := body["auditLogs"]; present {
		t.Fatalf("a rejected request must not also carry data: %v", body)
	}
}

// A valid name alongside an invalid one is still a 400 — partially honouring
// the request would hand back a payload missing a slice the caller asked for,
// which is the impersonation the 400 exists to prevent.
func TestApiData_MixedValidAndUnknownSliceNamesIs400(t *testing.T) {
	d := incidentsTestDeps(t, healthyEmptyFeedsHandler(nil))

	req := httptest.NewRequest("GET", "/api/data?only=auditLogs,zonez", nil)
	rr := httptest.NewRecorder()
	d.apiData(rr, req)

	if rr.Code != 400 {
		t.Fatalf("status = %d, want 400 when any name is unknown; body=%s", rr.Code, rr.Body.String())
	}
}

// A known name still works, and the response carries exactly that slice.
func TestApiData_KnownSliceNameNarrowsThePayload(t *testing.T) {
	d := incidentsTestDeps(t, healthyEmptyFeedsHandler(nil))

	req := httptest.NewRequest("GET", "/api/data?only=auditLogs", nil)
	rr := httptest.NewRecorder()
	d.apiData(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body %q: %v", rr.Body.String(), err)
	}
	if _, present := body["auditLogs"]; !present {
		t.Fatalf("requested slice missing from the response: %v", body)
	}
	for _, notAsked := range []string{"subnets", "zones", "hosts", "leases", "_totals"} {
		if _, present := body[notAsked]; present {
			t.Fatalf("%q was not requested but appeared in the response: %v", notAsked, body)
		}
	}
}

// No ?only= at all is the untouched full path: a blank or missing parameter is
// "everything", never the empty set.
func TestApiData_BlankOnlyParamReturnsTheFullPayload(t *testing.T) {
	for _, url := range []string{"/api/data", "/api/data?only=", "/api/data?only=,"} {
		d := incidentsTestDeps(t, healthyEmptyFeedsHandler(nil))
		req := httptest.NewRequest("GET", url, nil)
		rr := httptest.NewRecorder()
		d.apiData(rr, req)

		if rr.Code != 200 {
			t.Fatalf("%s: status = %d, want 200; body=%s", url, rr.Code, rr.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: decode body: %v", url, err)
		}
		for _, key := range []string{"subnets", "leases", "dnsViews", "zones", "hosts", "secPolicies", "feeds", "auditLogs", "_totals", "_meta"} {
			if _, present := body[key]; !present {
				t.Fatalf("%s: full payload lost %q — an absent slice set is not the empty set", url, key)
			}
		}
	}
}
