package dashboard

import (
	"net/http"
	"sync"
	"testing"
)

// dhcpRequestsServer answers by metric and window: bodies["metric|range"], or
// a 500 when that body is "500". Unlisted reads answer with no rows.
func dhcpRequestsServer(t *testing.T, bodies map[string]string) (*Service, *[]map[string]any) {
	t.Helper()
	var mu sync.Mutex
	seen := []map[string]any{}
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/cubejs/v1/query" {
			t.Errorf("unexpected path %s", r.URL.Path)
			return
		}
		q := cubeQueryFromRequest(t, r)
		mu.Lock()
		seen = append(seen, q)
		mu.Unlock()
		metric := getStr(asMap(q["filters"].([]any)[0])["values"].([]any)[0])
		rng := getStr(asMap(q["timeDimensions"].([]any)[0])["dateRange"])
		body, ok := bodies[metric+"|"+rng]
		if !ok {
			body = `{"result":{"data":[]}}`
		}
		if body == "500" {
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	})
	return s, &seen
}

func sumRow(v string) string {
	return `{"HostMetricsV1.sum_value":` + v + `,"HostMetricsV1.count_value":"288"}`
}

func dhcpTotal(t *testing.T, got map[string]any, metric, window string) map[string]any {
	t.Helper()
	m, ok := asMap(got["metrics"])[metric].(map[string]any)
	if !ok {
		t.Fatalf("metrics[%s] missing: %v", metric, got)
	}
	return m[window].(map[string]any)
}

func TestCSPDHCPRequests_TotalsAddedNotAveraged(t *testing.T) {
	s, seen := dhcpRequestsServer(t, map[string]string{
		// Two rows (as from two hosts): the total is their sum.
		"dhcp_discover_iq|today":          `{"result":{"data":[` + sumRow("2789") + `,` + sumRow("2461") + `]}}`,
		"dhcp_discover_iq|last 30 days":   `{"result":{"data":[` + sumRow("463813") + `]}}`,
		"dhcp_demand_gap_iq|today":        `{"result":{"data":[` + sumRow("12475") + `]}}`,
		"dhcp_demand_gap_iq|last 30 days": `{"result":{"data":[` + sumRow("449710.75") + `]}}`,
	})
	got := s.CSPDHCPRequests()
	if got["status"] != "ok" {
		t.Fatalf("status = %v", got["status"])
	}
	if v := dhcpTotal(t, got, "discover", "today"); v["value"] != 5250.0 || v["status"] != "ok" {
		t.Errorf("discover today = %v, want 5250", v)
	}
	if v := dhcpTotal(t, got, "no_address", "last_30_days"); v["value"] != 449710.75 {
		t.Errorf("no_address 30 days = %v", v)
	}
	if len(*seen) != 4 {
		t.Fatalf("reads = %d, want 4", len(*seen))
	}
	for _, q := range *seen {
		if q["measures"].([]any)[0] != "HostMetricsV1.sum_value" {
			t.Errorf("measures = %v, want sum_value first", q["measures"])
		}
		f := q["filters"].([]any)
		if len(f) != 2 || asMap(f[1])["member"] != "HostMetricsV1.granularity" || asMap(f[1])["values"].([]any)[0] != "minute" {
			t.Errorf("filters = %v, want metric_name and the 5-minute rows", f)
		}
		if q["dimensions"] != nil {
			t.Errorf("dimensions = %v, want none (one total)", q["dimensions"])
		}
	}
}

func TestCSPDHCPRequests_FailedReadIsNotChecked(t *testing.T) {
	s, _ := dhcpRequestsServer(t, map[string]string{
		"dhcp_discover_iq|today":        "500",
		"dhcp_discover_iq|last 30 days": `{"result":{}}`, // 200 without result.data
		"dhcp_demand_gap_iq|today":      `{"result":{"data":[` + sumRow("12475") + `]}}`,
	})
	got := s.CSPDHCPRequests()
	if got["status"] != "partial" {
		t.Errorf("status = %v, want partial", got["status"])
	}
	for _, w := range []string{"today", "last_30_days"} {
		if v := dhcpTotal(t, got, "discover", w); v["status"] != "error" || v["value"] != nil {
			t.Errorf("discover %s = %v, want error with null", w, v)
		}
	}
	if v := dhcpTotal(t, got, "no_address", "today"); v["value"] != 12475.0 {
		t.Errorf("no_address today = %v", v)
	}
}

func TestCSPDHCPRequests_NoReadingsIsEmptyNotZero(t *testing.T) {
	s, _ := dhcpRequestsServer(t, map[string]string{
		// Cube.js answers a range with no samples as one row of nulls.
		"dhcp_discover_iq|today":        `{"result":{"data":[{"HostMetricsV1.sum_value":null,"HostMetricsV1.count_value":"0"}]}}`,
		"dhcp_discover_iq|last 30 days": `{"result":{"data":[{"HostMetricsV1.count_value":"0"}]}}`,
	})
	got := s.CSPDHCPRequests()
	for _, w := range []string{"today", "last_30_days"} {
		if v := dhcpTotal(t, got, "discover", w); v["status"] != "empty" || v["value"] != nil {
			t.Errorf("discover %s = %v, want empty with null", w, v)
		}
	}
	if got["status"] != "empty" {
		t.Errorf("status = %v, want empty", got["status"])
	}
}

// One missing reading beside real ones would show a total that is too low.
func TestCSPDHCPRequests_MissingReadingIsEmptyNotPartialTotal(t *testing.T) {
	for name, bad := range map[string]string{
		"null":   sumRow("null"),
		"absent": `{"HostMetricsV1.count_value":"288"}`,
		"words":  sumRow(`"n/a"`),
		"nan":    sumRow(`"NaN"`),
	} {
		t.Run(name, func(t *testing.T) {
			s, _ := dhcpRequestsServer(t, map[string]string{
				"dhcp_discover_iq|today": `{"result":{"data":[` + sumRow("2789") + `,` + bad + `]}}`,
			})
			if v := dhcpTotal(t, s.CSPDHCPRequests(), "discover", "today"); v["status"] != "empty" || v["value"] != nil {
				t.Errorf("discover today = %v, want empty with null", v)
			}
		})
	}
}

func TestCSPDHCPRequests_AllFailedIsError(t *testing.T) {
	b := map[string]string{}
	for _, m := range dhcpRequestMetrics {
		for _, w := range dhcpRequestWindows {
			b[m.Metric+"|"+w.Range] = "500"
		}
	}
	s, _ := dhcpRequestsServer(t, b)
	if got := s.CSPDHCPRequests(); got["status"] != "error" {
		t.Errorf("status = %v, want error", got["status"])
	}
}
