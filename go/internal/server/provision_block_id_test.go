package server

// provisionSubnetStream takes its address block straight off the query string
// and used to concatenate it into the outgoing allocation path
// ("/api/ddi/v1/"+block+"/nextavailablesubnet"). Go's transport does not clean
// ".." out of a request path, so a crafted `block` left this process intact and
// reached an arbitrary CSP path under the server's own tenant key — the escape
// already closed for the DELETE routes (server/edit.go's editDelete). Issue #74.
//
// The route is reached with the operator role, the same role an ordinary
// self-service user holds.
//
// The refusal assertions are on the number of UPSTREAM REQUESTS, not just on the
// emitted frame: an error reported after the call is on the wire has already
// made the call.

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// countingSubnetUpstream answers the wizard's allocation and records the exact
// path every request arrived on.
func countingSubnetUpstream(paths *[]string, n *int32) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(n, 1)
		*paths = append(*paths, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/nextavailablesubnet") {
			io.WriteString(w, `{"results":[{"id":"ipam/subnet/sn-1","address":"10.1.7.0","cidr":25}]}`)
			return
		}
		w.WriteHeader(500)
		fmt.Fprintf(w, `{"error":"unexpected upstream call %s %s"}`, r.Method, r.URL.Path)
	}
}

// TestProvisionSubnetStream_BlockIDShapes pins the outgoing path for both id
// shapes. The full-form case is the compatibility half — it is what the UI's
// Block select sends (Provision.jsx binds it to b.id from GET /api/ipam/blocks),
// and it must resolve byte-identically to what shipped before. The bare case is
// what moves: it used to build /api/ddi/v1/<id>/nextavailablesubnet, a path that
// names no CSP object.
func TestProvisionSubnetStream_BlockIDShapes(t *testing.T) {
	const wantPath = "POST /api/ddi/v1/ipam/address_block/blk-1/nextavailablesubnet"
	for _, block := range []string{"ipam/address_block/blk-1", "blk-1"} {
		t.Run(block, func(t *testing.T) {
			var paths []string
			var n int32
			d, _ := newResidualDeps(t, countingSubnetUpstream(&paths, &n))
			rr := httptest.NewRecorder()
			d.provisionSubnetStream(rr, uaSubnetRequest("block="+block+"&cidr=25&dry=0"))

			frames := parseSSEFrames(t, rr.Body.String())
			terminalFrameOf(t, frames) // the run must finish, or nothing below is proven
			if len(paths) == 0 {
				t.Fatalf("no upstream request was made at all")
			}
			if paths[0] != wantPath {
				t.Fatalf("upstream got %q, want %q", paths[0], wantPath)
			}
		})
	}
}

// TestProvisionSubnetStream_RefusesEscapingBlockIDs. Dry and live alike: the dry
// branch makes no upstream call, so its assertion is about the preview agreeing
// with the live run rather than about the wire, and the live one is the security
// claim.
func TestProvisionSubnetStream_RefusesEscapingBlockIDs(t *testing.T) {
	blocks := []string{"../../../atlas/v1/pwn", "blk-1%2f..%2fadmin", "ipam/subnet/sn-1"}
	for _, dry := range []string{"0", "1"} {
		for _, block := range blocks {
			t.Run(block+" dry="+dry, func(t *testing.T) {
				var paths []string
				var n int32
				d, logPath := newResidualDeps(t, countingSubnetUpstream(&paths, &n))
				rr := httptest.NewRecorder()
				d.provisionSubnetStream(rr, uaSubnetRequest("block="+block+"&cidr=25&dry="+dry))

				frames := parseSSEFrames(t, rr.Body.String())
				var refused bool
				for _, f := range frames {
					if f["error"] == "invalid block id" {
						refused = true
					}
					if f["done"] == true {
						t.Fatalf("the stream reported done for %q — a refused id must not "+
							"finish as if something were created", block)
					}
				}
				if !refused {
					t.Fatalf("no \"invalid block id\" frame for %q; frames=%v", block, frames)
				}
				if got := atomic.LoadInt32(&n); got != 0 {
					t.Fatalf("%d upstream requests for %q, want 0: %v", got, block, paths)
				}
				if rows := auditEntries(t, logPath, "provision-subnet"); len(rows) != 0 {
					t.Fatalf("%d provision-subnet audit rows, want 0 — nothing was provisioned", len(rows))
				}
			})
		}
	}
}
