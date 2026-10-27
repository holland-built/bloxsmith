package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// "Open in Infoblox" opens this server's own Infoblox address, and only the
// asset splits whose portal field was checked by hand carry one.
func TestChartOptionsCarryThePortalAddressAndFields(t *testing.T) {
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {})
	defer closeSrv()
	rr := httptest.NewRecorder()
	d.chartOptions(rr, httptest.NewRequest("GET", "/api/chart/options", nil))
	body := decodeBody(t, rr)
	if p, _ := body["portal"].(string); p == "" || !strings.HasPrefix(p, "http://127.0.0.1") {
		t.Fatalf("portal = %v, want the test server's address", body["portal"])
	}
	want := map[string]string{"atype": "asset.Type", "os": "asset.OSType", "source": "asset.Providers", "where": "asset.LocationType",
		"vendor": "asset.Vendor", "problem": "asset.Classifications", "missing": "asset.MissingRecords"}
	for _, s := range body["splits"].([]any) {
		m := s.(map[string]any)
		id := m["id"].(string)
		portal, has := m["portal"].(map[string]any)
		if field, ok := want[id]; ok {
			if !has || portal["field"] != field {
				t.Errorf("split %s: portal = %v, want field %s", id, m["portal"], field)
			}
		} else if has {
			t.Errorf("split %s has a portal field nobody checked: %v", id, portal)
		}
	}
}
