package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Bad input is refused before any call to Infoblox; good input gets past the
// checks (here to the no-service reply, since the test wires no Dashboard).
func TestHostConfigValidatesInput(t *testing.T) {
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("no upstream call expected, got %s", r.URL)
	})
	defer closeSrv()
	const good = "96d9195bd3a4a56368520a0091a72623"
	cases := []struct {
		query string
		want  int
	}{
		{"ophid=" + good + "&type=dns", 200},
		{"ophid=" + good + "&type=dhcp", 200},
		{"ophid=" + good + "&type=ntp", 400},
		{"ophid=" + good, 400},
		{"ophid=" + good[:31] + "&type=dns", 400},
		{"ophid=" + good + "0&type=dns", 400},
		{"ophid=" + good[:31] + "z&type=dns", 400},
		{"ophid=..%2F..%2Fetc&type=dns", 400},
		{"type=dns", 400},
	}
	for _, c := range cases {
		rr := httptest.NewRecorder()
		d.hostConfig(rr, httptest.NewRequest("GET", "/api/host-config?"+c.query, nil))
		if rr.Code != c.want {
			t.Errorf("%s: code %d, want %d (%s)", c.query, rr.Code, c.want, rr.Body.String())
		}
	}
}
