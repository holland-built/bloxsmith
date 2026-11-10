package edit

import (
	"testing"

	"bloxsmith/internal/rest"
)

// A Go caller (the desk's address job) builds the allocate body itself, so
// count can be a Go int rather than a JSON float64. edit's own copy of
// intCoerce had no int case, so an int count was ignored and the default of 1
// used: count 0 sailed past the range check and count 5 reserved one address.
func TestSelfserviceAllocate_GoIntCountIsRead(t *testing.T) {
	c := New(rest.New("http://127.0.0.1:1", rest.NewAuth("Token test", nil)))
	res, status := c.SelfserviceAllocate(M{"subnet_id": "ipam/subnet/abc", "count": 0, "dry": true})
	if status != 400 {
		t.Fatalf("count int(0): status = %d, res = %v; want 400 — the count was not read", status, res)
	}
}
