package dashboard

import (
	"net/http"
	"strings"
	"sync"
	"testing"
)

// valuePlatformServer answers HostMetricsV1 queries by metric_name with
// bodies[metric] (500 when fail[metric]), the roaming query with
// bodies["roaming"] (500 when fail["roaming"]), and the cube list with meta
// (500 when meta is "").
func valuePlatformServer(t *testing.T, bodies map[string]string, fail map[string]bool, meta string) (*Service, *[]map[string]any) {
	t.Helper()
	var mu sync.Mutex
	seen := []map[string]any{}
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/infra/v1/detail_hosts":
			_, _ = w.Write([]byte(`{"results":[{"id":"uuid-1","ophid":"oph-1","display_name":"ns1.example.com"}]}`))
		case "/api/cubejs/v1/meta", "/api/cubejs-security/v1/meta":
			if meta == "" {
				w.WriteHeader(500)
				return
			}
			if strings.Contains(r.URL.Path, "security") {
				_, _ = w.Write([]byte(`{"result":{"cubes":[]}}`))
				return
			}
			_, _ = w.Write([]byte(meta))
		case "/api/cubejs/v1/query":
			q := cubeQueryFromRequest(t, r)
			mu.Lock()
			seen = append(seen, q)
			mu.Unlock()
			key := "roaming"
			if fs, ok := q["filters"].([]any); ok && len(fs) > 0 {
				key = getStr(asMap(fs[0])["values"].([]any)[0])
			}
			if fail[key] {
				w.WriteHeader(400)
				return
			}
			body, ok := bodies[key]
			if !ok {
				body = `{"result":{"data":[]}}`
			}
			_, _ = w.Write([]byte(body))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	})
	return s, &seen
}

func vpBodies() map[string]string {
	return map[string]string{
		"total_query_count_iq": `{"result":{"data":[{"HostMetricsV1.host":null,"HostMetricsV1.sum_value":25431225.68867135,"HostMetricsV1.avg_value":35321.1,"HostMetricsV1.count_value":"720"}]}}`,
		"cache_hit_ratio_iq":   `{"result":{"data":[{"HostMetricsV1.host":"","HostMetricsV1.sum_value":1340.8577,"HostMetricsV1.avg_value":44.695256666666666,"HostMetricsV1.count_value":"30"}]}}`,
		"dhcp_cumulative_assigned_addresses_iq": `{"result":{"data":[
			{"HostMetricsV1.host":"h1","HostMetricsV1.sum_value":4908,"HostMetricsV1.avg_value":163.6,"HostMetricsV1.count_value":"30"},
			{"HostMetricsV1.host":"h2","HostMetricsV1.sum_value":"616","HostMetricsV1.avg_value":205.3,"HostMetricsV1.count_value":"3"},
			{"HostMetricsV1.host":"h3","HostMetricsV1.sum_value":0,"HostMetricsV1.avg_value":0,"HostMetricsV1.count_value":"30"}]}}`,
		"roaming": `{"result":{"data":[{"B1EndpointsDailyV1.payload_protection_count":"7"}]}}`,
	}
}

const vpMetaWithRoaming = `{"result":{"cubes":[{"name":"B1EndpointsDailyV1","measures":[{"name":"B1EndpointsDailyV1.payload_protection_count","type":"number"}],"dimensions":[]}]}}`

func vpMetric(t *testing.T, got map[string]any, key string) map[string]any {
	t.Helper()
	m, ok := asMap(got["metrics"])[key].(map[string]any)
	if !ok {
		t.Fatalf("metrics[%q] missing: %v", key, got["metrics"])
	}
	return m
}

func TestCSPValuePlatform_AllOK(t *testing.T) {
	s, seen := valuePlatformServer(t, vpBodies(), nil, vpMetaWithRoaming)
	got := s.CSPValuePlatform()
	if got["status"] != "ok" || got["window"] != "last 30 days" {
		t.Fatalf("status/window = %v/%v, want ok/last 30 days", got["status"], got["window"])
	}
	// One query per metric plus roaming; uptime is switched off so not read.
	if len(*seen) != 4 {
		t.Fatalf("queries = %d, want 4", len(*seen))
	}
	for _, q := range *seen {
		td := asMap(q["timeDimensions"].([]any)[0])
		if td["dateRange"] != "last 30 days" || td["granularity"] != nil {
			t.Errorf("timeDimension = %v, want last 30 days as one total", td)
		}
		if fs, ok := q["filters"].([]any); ok && len(fs) != 1 {
			t.Errorf("filters = %v, want only the metric_name filter", fs)
		}
	}
	if m := vpMetric(t, got, "queries"); m["status"] != "ok" || m["value"] != 25431225.68867135 || m["unit"] != "queries" {
		t.Errorf("queries = %v", m)
	}
	if m := vpMetric(t, got, "cache_hit"); m["value"] != 44.695256666666666 || m["unit"] != "percent" {
		t.Errorf("cache_hit = %v", m)
	}
	if m := vpMetric(t, got, "roaming"); m["status"] != "ok" || m["value"] != 7.0 || m["unit"] != "devices" {
		t.Errorf("roaming = %v", m)
	}
}

// Totals add the per-host sums; they never average them.
func TestCSPValuePlatform_TotalsSummedNotAveraged(t *testing.T) {
	s, _ := valuePlatformServer(t, vpBodies(), nil, vpMetaWithRoaming)
	m := vpMetric(t, s.CSPValuePlatform(), "dhcp_assigned")
	if m["status"] != "ok" || m["value"] != 5524.0 || m["unit"] != "addresses" {
		t.Errorf("dhcp_assigned = %v, want 4908+616+0 = 5524 addresses", m)
	}
}

// A missing, null or non-numeric measure is not a reading: it never becomes 0.
func TestCSPValuePlatform_BadMeasureIsNotZero(t *testing.T) {
	for name, row := range map[string]string{
		"missing":     `{"HostMetricsV1.host":""}`,
		"null":        `{"HostMetricsV1.host":"","HostMetricsV1.sum_value":null,"HostMetricsV1.avg_value":null}`,
		"non-numeric": `{"HostMetricsV1.host":"","HostMetricsV1.sum_value":"n/a","HostMetricsV1.avg_value":"n/a"}`,
	} {
		b := vpBodies()
		b["total_query_count_iq"] = `{"result":{"data":[` + row + `]}}`
		b["cache_hit_ratio_iq"] = `{"result":{"data":[` + row + `]}}`
		b["roaming"] = `{"result":{"data":[{"B1EndpointsDailyV1.payload_protection_count":null}]}}`
		s, _ := valuePlatformServer(t, b, nil, vpMetaWithRoaming)
		got := s.CSPValuePlatform()
		for _, k := range []string{"queries", "cache_hit", "roaming"} {
			if m := vpMetric(t, got, k); m["status"] != "empty" || m["value"] != nil {
				t.Errorf("%s: %s = %v, want empty with a null value", name, k, m)
			}
		}
	}
}

// One failed read is "error" (not checked); the rest still show.
func TestCSPValuePlatform_OneFailing(t *testing.T) {
	s, _ := valuePlatformServer(t, vpBodies(), map[string]bool{"total_query_count_iq": true}, vpMetaWithRoaming)
	got := s.CSPValuePlatform()
	if m := vpMetric(t, got, "queries"); m["status"] != "error" || m["value"] != nil {
		t.Errorf("queries = %v, want error and null", m)
	}
	if m := vpMetric(t, got, "cache_hit"); m["status"] != "ok" {
		t.Errorf("cache_hit = %v, want ok", m)
	}
	if got["status"] != "partial" {
		t.Errorf("status = %v, want partial", got["status"])
	}
}

func TestCSPValuePlatform_AllFailing(t *testing.T) {
	fail := map[string]bool{"total_query_count_iq": true, "cache_hit_ratio_iq": true,
		"dhcp_cumulative_assigned_addresses_iq": true, "roaming": true}
	s, _ := valuePlatformServer(t, vpBodies(), fail, "")
	if got := s.CSPValuePlatform(); got["status"] != "error" {
		t.Errorf("status = %v, want error", got["status"])
	}
}

// A 200 with no result.data did not deliver: "error", never an empty "ok".
func TestCSPValuePlatform_200WithoutResultData(t *testing.T) {
	b := vpBodies()
	b["dhcp_cumulative_assigned_addresses_iq"] = `{"result":{}}`
	s, _ := valuePlatformServer(t, b, nil, vpMetaWithRoaming)
	if m := vpMetric(t, s.CSPValuePlatform(), "dhcp_assigned"); m["status"] != "error" || m["value"] != nil {
		t.Errorf("dhcp_assigned = %v, want error and null", m)
	}
}

// Roaming: a failed read on a tenant whose cube list has no such cube is
// "unavailable"; a failed read where the cube exists, or the list itself
// failed, stays "error".
func TestCSPValuePlatform_RoamingUnavailableVsFailed(t *testing.T) {
	for name, tc := range map[string]struct{ meta, want string }{
		"cube missing":   {`{"result":{"cubes":[]}}`, "unavailable"},
		"cube present":   {vpMetaWithRoaming, "error"},
		"list failed":    {"", "error"},
		"measure absent": {`{"result":{"cubes":[{"name":"B1EndpointsDailyV1","measures":[{"name":"B1EndpointsDailyV1.online_rate","type":"number"}]}]}}`, "unavailable"},
	} {
		s, _ := valuePlatformServer(t, vpBodies(), map[string]bool{"roaming": true}, tc.meta)
		m := vpMetric(t, s.CSPValuePlatform(), "roaming")
		if m["status"] != tc.want || m["value"] != nil {
			t.Errorf("%s: roaming = %v, want %s and null", name, m, tc.want)
		}
	}
}

// Uptime is switched off until its meaning is confirmed: "unavailable" with a
// reason, and dns_status_iq is not read.
func TestCSPValuePlatform_UptimeOffByDefault(t *testing.T) {
	s, seen := valuePlatformServer(t, vpBodies(), nil, vpMetaWithRoaming)
	m := vpMetric(t, s.CSPValuePlatform(), "uptime")
	if m["status"] != "unavailable" || m["value"] != nil || m["reason"] == nil {
		t.Errorf("uptime = %v, want unavailable with a reason", m)
	}
	for _, q := range *seen {
		if fs, ok := q["filters"].([]any); ok && asMap(fs[0])["values"].([]any)[0] == "dns_status_iq" {
			t.Errorf("dns_status_iq was read while uptime is off")
		}
	}
}

// Switched on, uptime averages mixed per-host samples by how many readings
// each host had, and lists each host by name.
func TestCSPValuePlatform_UptimeMixedSamples(t *testing.T) {
	uptimeMeaningConfirmed = true
	t.Cleanup(func() { uptimeMeaningConfirmed = false })
	b := vpBodies()
	b["dns_status_iq"] = `{"result":{"data":[
		{"HostMetricsV1.host":"oph-1","HostMetricsV1.avg_value":100,"HostMetricsV1.count_value":"30"},
		{"HostMetricsV1.host":"oph-2","HostMetricsV1.avg_value":"90","HostMetricsV1.count_value":"10"},
		{"HostMetricsV1.host":"oph-3","HostMetricsV1.avg_value":null,"HostMetricsV1.count_value":"5"}]}}`
	s, _ := valuePlatformServer(t, b, nil, vpMetaWithRoaming)
	m := vpMetric(t, s.CSPValuePlatform(), "uptime")
	if m["status"] != "ok" || m["value"] != 97.5 || m["unit"] != "percent" {
		t.Errorf("uptime = %v, want ok 97.5 percent ((100*30+90*10)/40)", m)
	}
	hosts := m["hosts"].([]map[string]any)
	if len(hosts) != 3 || hosts[2]["value"] != nil {
		t.Fatalf("hosts = %v, want 3 with oph-3 null", hosts)
	}
	if hosts[0]["host_name"] != "ns1.example.com" {
		t.Errorf("first host = %v, want named ns1.example.com", hosts[0])
	}
}
