package dashboard

import (
	"encoding/json"
	"net/http"
	"testing"
)

// The hub's anycast_ha and dfp_services rows are the Sources page's normAnycast
// and normSourceDFP rows (anycast_ha adds a severity). Pinned as JSON so the
// hub cannot drift from them again, including a member with no runtime_status
// at all, which both used to handle in their own way.
func TestFetchHubDomains_AnycastAndDFPRows(t *testing.T) {
	s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/anycast/v1/accm/ac_runtime_statuses":
			writeResults(w, []map[string]any{
				{"name": "a1", "service": "dns", "anycast_ip_address": "10.0.0.1", "runtime_status": map[string]any{"state": "UP"}},
				{"name": "a2", "service": "dhcp", "runtime_status": "Offline"},
				{"name": "a3"},
				{"name": "a4", "runtime_status": map[string]any{"state": ""}},
			})
		case "/api/atcdfp/v1/dfp_services":
			writeResults(w, []map[string]any{
				{"name": "d1", "forwarding_policy": "fwd", "host": []any{map[string]any{"name": "h1"}}, "default_resolvers": []any{"1.1.1.1", "8.8.8.8"}},
				{"name": "d2", "mode": "m", "host": "0123456789012345678901234567890123456789-cut"},
				{"name": "d3", "host": []any{}},
			})
		default:
			writeResults(w, nil)
		}
	})
	result := s.FetchHubDomains()
	check := func(key, want string) {
		t.Helper()
		got, _ := json.Marshal(result[key])
		if string(got) != want {
			t.Errorf("%s =\n%s\nwant\n%s", key, got, want)
		}
	}
	check("anycast_ha", `[`+
		`{"ip":"10.0.0.1","name":"a1","service":"dns","severity":"ok","state":"up"},`+
		`{"ip":"","name":"a2","service":"dhcp","severity":"warn","state":"offline"},`+
		`{"ip":"","name":"a3","service":"","severity":"warn","state":"unknown"},`+
		`{"ip":"","name":"a4","service":"","severity":"warn","state":"unknown"}]`)
	check("dfp_services", `[`+
		`{"host":"h1","mode":"fwd","name":"d1","resolvers":2},`+
		`{"host":"0123456789012345678901234567890123456789","mode":"m","name":"d2","resolvers":0},`+
		`{"host":"","mode":"","name":"d3","resolvers":0}]`)
}
