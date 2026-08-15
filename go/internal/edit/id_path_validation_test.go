package edit

// Tests for the two builders that paste a CALLER-SUPPLIED id into an upstream
// path: SelfserviceAllocate (subnet_id -> .../nextavailableip) and SubnetCreate
// (block_id -> .../nextavailablesubnet). Issues #73 and #74.
//
// Two separate promises are proved here, and they need each other:
//
//   1. THE PATH IS RIGHT FOR THE ID SHAPE CSP ACTUALLY RETURNS. Every CSP list
//      endpoint hands back a FULL-FORM id ("ipam/subnet/<uuid>"), and both ways
//      into SelfserviceAllocate carry one — the UI's Subnet select posts e.id
//      straight from GET /api/ipam/subnets, and the tag_key/tag_value branch
//      reads it off a CSP list. The old code prefixed "ipam/subnet/" onto it
//      anyway, so the live request went to
//      /api/ddi/v1/ipam/subnet/ipam/subnet/<uuid>/nextavailableip. Every test in
//      this package used a BARE id, which no tenant ever returns, so the whole
//      suite was green while no live allocation could work. That is why the
//      assertions below are on the EXACT outgoing path, and why each one is run
//      twice — once with the real full-form id, once bare.
//
//   2. THE ID CANNOT AIM THE REQUEST SOMEWHERE ELSE. Go's transport does not
//      clean ".." out of a request path, so an unvalidated id reached an
//      arbitrary CSP path under the server's own tenant key. The refusal tests
//      therefore assert ZERO upstream requests, not merely a 400: a 400 returned
//      after the request was already on the wire would still have made the call.
//
// All upstream traffic is an httptest fake. Nothing here may be pointed at a
// live tenant.

import (
	"net/http"
	"testing"
)

// --- SelfserviceAllocate: the reservation path -------------------------------

// oneAddress is a single-reservation nextavailableip response.
const oneAddress = `{"results":[{"id":"ipam/address/a-1","address":"10.7.0.4"}]}`

// TestAllocatePathIsNotDoubledForRealIDs is the headline for #73. The wanted
// path is identical for both id shapes: that is the point of routing through
// ObjectPath rather than special-casing one form.
//
// Mutation: restore the old `"/api/ddi/v1/ipam/subnet/"+subnetID+...`
// concatenation and the full-form case fails with the doubled path.
func TestAllocatePathIsNotDoubledForRealIDs(t *testing.T) {
	const wantPath = "/api/ddi/v1/ipam/subnet/s-42/nextavailableip"
	cases := []struct {
		name     string
		subnetID string
	}{
		{"full-form id, the shape CSP returns", "ipam/subnet/s-42"},
		{"bare id, still accepted", "s-42"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := builderFakeServer(t, func(r builderReq) (int, string) {
				return 200, oneAddress
			})
			res, status := f.client().SelfserviceAllocate(M{"subnet_id": tc.subnetID, "dry": false})
			if status != 200 || res["ok"] != true {
				t.Fatalf("SelfserviceAllocate = (%v, %d), want ok:true 200", res, status)
			}
			calls := f.calls()
			if len(calls) != 1 {
				t.Fatalf("%d upstream requests, want exactly 1: %+v", len(calls), calls)
			}
			builderWantMethodPath(t, calls[0], http.MethodPost, wantPath)
		})
	}
}

// TestAllocateRefusesIDsThatEscapeTheirPath is the #74 half. Every case must
// cost the tenant NOTHING — the fake fails the test if it is reached at all.
func TestAllocateRefusesIDsThatEscapeTheirPath(t *testing.T) {
	cases := []struct {
		name     string
		subnetID string
	}{
		{"parent traversal", "../../../atlas/v1/pwn"},
		{"encoded slash", "s-42%2f..%2fadmin"},
		{"wrong kind", "dns/auth_zone/z-1"},
		{"extra segments", "ipam/subnet/s-42/extra"},
		{"backslash", `ipam/subnet/s-42\..`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := builderRefuseAll(t)
			res, status := f.client().SelfserviceAllocate(M{"subnet_id": tc.subnetID, "dry": false})
			if status != 400 {
				t.Fatalf("status = %d, want 400 for %q", status, tc.subnetID)
			}
			if res["error"] != "invalid subnet id" {
				t.Fatalf("error = %v, want \"invalid subnet id\"", res["error"])
			}
			if n := len(f.calls()); n != 0 {
				t.Fatalf("%d upstream requests, want 0 — a refusal after the request is on the "+
					"wire has already made the call: %+v", n, f.calls())
			}
		})
	}
}

// TestAllocateRefusesEscapingIDsOnTheDryPathToo. The dry branch sends nothing
// upstream, so this is not a security assertion — it pins the preview to the
// same answer the live run gives. A preview that reports "would allocate" for a
// request the live path refuses is the preview/live divergence this package
// keeps closing, and it is what every other id-validating builder here already
// does (ObjectPath-then-400 ahead of the dry branch).
func TestAllocateRefusesEscapingIDsOnTheDryPathToo(t *testing.T) {
	f := builderRefuseAll(t)
	res, status := f.client().SelfserviceAllocate(M{"subnet_id": "../../../atlas/v1/pwn", "dry": true})
	if status != 400 || res["dry_run"] == true {
		t.Fatalf("= (%v, %d), want a 400 refusal, not a preview", res, status)
	}
	if n := len(f.calls()); n != 0 {
		t.Fatalf("%d upstream requests on a dry run, want 0", n)
	}
}

// TestAllocateValidatesTheIDTheTagLookupReturned covers the second, non-obvious
// way a subnet id arrives: the tag_key/tag_value branch takes it from a CSP list
// response. That id is no more trusted than the caller's — it is still pasted
// into an outgoing path — so it goes through the same validator. Proving it
// needs the lookup to succeed and the allocation POST to never happen.
func TestAllocateValidatesTheIDTheTagLookupReturned(t *testing.T) {
	var posts int
	f := builderFakeServer(t, func(r builderReq) (int, string) {
		if r.Method == http.MethodPost {
			posts++
			return 200, oneAddress
		}
		// the _tfilter subnet lookup
		return 200, `{"results":[{"id":"../../../atlas/v1/pwn"}]}`
	})
	res, status := f.client().SelfserviceAllocate(M{
		"tag_key": "Site", "tag_value": "hq", "dry": false,
	})
	if status != 400 || res["error"] != "invalid subnet id" {
		t.Fatalf("= (%v, %d), want 400 \"invalid subnet id\"", res, status)
	}
	if posts != 0 {
		t.Fatalf("%d allocation POSTs, want 0 — the id came off the wire and was used unchecked", posts)
	}
}

// --- SubnetCreate: the allocation path ---------------------------------------

// TestSubnetCreateLivePathForBothIDShapes. Unlike allocate, this builder never
// added a kind prefix, so a full-form block_id was already correct and must stay
// BYTE-IDENTICAL — that is the compatibility half of the change. A bare id is
// the half that moves: it used to build /api/ddi/v1/<id>/nextavailablesubnet,
// which names no CSP object at all, and now gets its kind prefix. block_id is
// hand-typed free text in the Editor tab, so both shapes really do arrive.
func TestSubnetCreateLivePathForBothIDShapes(t *testing.T) {
	const wantPath = "/api/ddi/v1/ipam/address_block/b-1/nextavailablesubnet"
	for _, blockID := range []string{"ipam/address_block/b-1", "b-1"} {
		t.Run(blockID, func(t *testing.T) {
			f := builderFakeServer(t, func(r builderReq) (int, string) {
				if r.Method == http.MethodPost {
					return 201, `{"results":[{"id":"ipam/subnet/s1","address":"10.0.5.0"}]}`
				}
				return 200, `{"result":{"id":"ipam/subnet/s1"}}`
			})
			res, status := f.client().SubnetCreate(M{
				"block_id": blockID, "cidr": float64(24), "dry": false,
			})
			if status != 200 || res["ok"] != true {
				t.Fatalf("SubnetCreate = (%v, %d), want ok:true 200", res, status)
			}
			builderWantMethodPath(t, f.calls()[0], http.MethodPost, wantPath)
		})
	}
}

// TestSubnetCreateDryPreviewUsesTheSameValidatedPath. The dry-run preview is a
// real upstream GET made with the tenant key, so it carries the same escape risk
// as the live POST and must resolve to the same path.
func TestSubnetCreateDryPreviewUsesTheSameValidatedPath(t *testing.T) {
	f := builderFakeServer(t, func(r builderReq) (int, string) {
		return 200, `{"results":[{"address":"10.0.5.0"}]}`
	})
	res, status := f.client().SubnetCreate(M{
		"block_id": "ipam/address_block/b-1", "cidr": float64(24), "dry": true,
	})
	if status != 200 || res["dry_run"] != true {
		t.Fatalf("= (%v, %d), want a 200 preview", res, status)
	}
	calls := f.calls()
	if len(calls) != 1 {
		t.Fatalf("%d upstream requests, want exactly 1 preview GET: %+v", len(calls), calls)
	}
	builderWantMethodPath(t, calls[0], http.MethodGet,
		"/api/ddi/v1/ipam/address_block/b-1/nextavailablesubnet")
}

// TestSubnetCreateRefusesIDsThatEscapeTheirPath, on the live AND the preview
// half. The preview is included because a read done with the tenant key against
// an attacker-chosen path is still a request this server should never make.
func TestSubnetCreateRefusesIDsThatEscapeTheirPath(t *testing.T) {
	ids := []string{"../../../atlas/v1/pwn", "b-1%2f..%2fadmin", "ipam/subnet/s-1", `b-1\..`}
	for _, dry := range []bool{false, true} {
		for _, id := range ids {
			name := id
			if dry {
				name += " (dry)"
			}
			t.Run(name, func(t *testing.T) {
				f := builderRefuseAll(t)
				res, status := f.client().SubnetCreate(M{
					"block_id": id, "cidr": float64(24), "dry": dry,
				})
				if status != 400 {
					t.Fatalf("status = %d, want 400 for %q", status, id)
				}
				if res["error"] != "invalid block id" {
					t.Fatalf("error = %v, want \"invalid block id\"", res["error"])
				}
				if n := len(f.calls()); n != 0 {
					t.Fatalf("%d upstream requests, want 0: %+v", n, f.calls())
				}
			})
		}
	}
}
