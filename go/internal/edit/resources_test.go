package edit

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

// --- SubnetCreate dry-run preview: success / genuine-empty / failed lookup --

func TestSubnetCreate_DryRun_PreviewSucceeds_NoMarker(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[{"address":"10.0.5.0","id":"addr-1"}]}`))
	}))
	defer srv.Close()
	c := newTestClient(srv)

	res, status := c.SubnetCreate(M{"block_id": "block-1", "cidr": float64(24), "name": "test-subnet", "dry": true})
	if status != 200 {
		t.Fatalf("status = %d, want 200: %v", status, res)
	}
	would := res["would_create"].(M)
	if would["address"] != "10.0.5.0" {
		t.Fatalf("address = %v, want 10.0.5.0", would["address"])
	}
	if _, present := would["address_preview"]; present {
		t.Fatalf("address_preview = %v, want absent on a successful preview", would["address_preview"])
	}
}

func TestSubnetCreate_DryRun_PreviewGenuinelyEmpty_NoneAvailableMarker(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[]}`))
	}))
	defer srv.Close()
	c := newTestClient(srv)

	res, status := c.SubnetCreate(M{"block_id": "block-1", "cidr": float64(24), "name": "test-subnet", "dry": true})
	if status != 200 {
		t.Fatalf("status = %d, want 200 (a full block must never abort a dry run): %v", status, res)
	}
	would := res["would_create"].(M)
	if would["address_preview"] != "none-available" {
		t.Fatalf("address_preview = %v, want none-available", would["address_preview"])
	}
	if _, present := would["reason"]; present {
		t.Fatalf("reason = %v, want absent — a genuinely empty block is not a broken lookup", would["reason"])
	}
	if would["address"] != "" {
		t.Fatalf("address = %v, want empty string (legitimate empty)", would["address"])
	}
}

func TestSubnetCreate_DryRun_PreviewLookupFails_UnavailableMarkerNoAbort(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
	}))
	defer srv.Close()
	c := newTestClient(srv)

	res, status := c.SubnetCreate(M{"block_id": "block-1", "cidr": float64(24), "name": "test-subnet", "dry": true})
	if status != 200 {
		t.Fatalf("status = %d, want 200 — a failed preview must never abort the dry run: %v", status, res)
	}
	if res["ok"] != true {
		t.Fatalf("ok = %v, want true", res["ok"])
	}
	would := res["would_create"].(M)
	if would["address_preview"] != "unavailable" {
		t.Fatalf("address_preview = %v, want unavailable", would["address_preview"])
	}
	reason, _ := would["reason"].(string)
	if reason == "" {
		t.Fatalf("reason = %q, want a non-empty operator-safe explanation", reason)
	}
	if addr, _ := would["address"].(string); addr == "" || addr == "10.0.5.0" {
		t.Fatalf("address = %q, want a non-blank, non-fabricated placeholder", addr)
	}
}

// TestSubnetCreate_DryRun_FailedPreviewNeverMatchesSuccess is the regression
// test for the bug being closed: a failed preview lookup used to produce the
// exact same would_create shape (blank address, no marker) that the Editor
// renders as JSON — indistinguishable from a genuinely successful preview or
// a genuine "block is full" result. Failure must now be observably different
// from both.
func TestSubnetCreate_DryRun_FailedPreviewNeverMatchesSuccess(t *testing.T) {
	successSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[{"address":"10.0.5.0","id":"addr-1"}]}`))
	}))
	defer successSrv.Close()
	failSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
	}))
	defer failSrv.Close()
	emptySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"results":[]}`))
	}))
	defer emptySrv.Close()

	body := M{"block_id": "block-1", "cidr": float64(24), "name": "test-subnet", "dry": true}

	successRes, _ := newTestClient(successSrv).SubnetCreate(body)
	failRes, _ := newTestClient(failSrv).SubnetCreate(body)
	emptyRes, _ := newTestClient(emptySrv).SubnetCreate(body)

	successWould := successRes["would_create"].(M)
	failWould := failRes["would_create"].(M)
	emptyWould := emptyRes["would_create"].(M)

	if reflect.DeepEqual(failWould, successWould) {
		t.Fatalf("a failed preview produced the exact same would_create as a successful one: %v", failWould)
	}
	if reflect.DeepEqual(failWould, emptyWould) {
		t.Fatalf("a failed preview produced the exact same would_create as a genuine empty result: %v", failWould)
	}
	if reflect.DeepEqual(emptyWould, successWould) {
		t.Fatalf("sanity check failed: genuine-empty and success fixtures must differ: %v", emptyWould)
	}
}
