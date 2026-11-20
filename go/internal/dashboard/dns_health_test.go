package dashboard

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// dnsHealthServer answers each HostMetricsV1 query by its metric_name filter
// with the body bodies[metric], or a 500 when the metric is in fail.
func dnsHealthServer(t *testing.T, bodies map[string]string, fail map[string]bool) (*Service, *[]map[string]any) {
	t.Helper()
	var mu sync.Mutex
	seen := []map[string]any{}
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/infra/v1/detail_hosts":
			_, _ = w.Write([]byte(`{"results":[{"id":"uuid-1","ophid":"oph-1","display_name":"ns1.example.com"}]}`))
		case "/api/cubejs/v1/query":
			q := cubeQueryFromRequest(t, r)
			mu.Lock()
			seen = append(seen, q)
			mu.Unlock()
			f := asMap(q["filters"].([]any)[0])
			metric := getStr(f["values"].([]any)[0])
			if fail[metric] {
				w.WriteHeader(500)
				return
			}
			body, ok := bodies[metric]
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

func tenantRow(v string) string {
	return `{"result":{"data":[{"HostMetricsV1.host":"","HostMetricsV1.avg_value":` + v + `,"HostMetricsV1.count_value":"288"}]}}`
}

func allTenantBodies() map[string]string {
	b := map[string]string{}
	for _, m := range dnsHealthMetrics {
		b[m.Metric] = tenantRow("1.5")
	}
	b["dns_latency_all_iq"] = tenantRow("0.0314894046215304")
	b["cache_hit_ratio_iq"] = tenantRow("39.23")
	return b
}

func metricOf(t *testing.T, got map[string]any, key string) map[string]any {
	t.Helper()
	m, ok := asMap(got["metrics"])[key].(map[string]any)
	if !ok {
		t.Fatalf("metrics[%q] missing: %v", key, got["metrics"])
	}
	return m
}

func TestCSPDNSHealth_AllMetricsRead(t *testing.T) {
	s, seen := dnsHealthServer(t, allTenantBodies(), nil)
	got := s.CSPDNSHealth()
	if got["status"] != "ok" {
		t.Fatalf("status = %v, want ok", got["status"])
	}
	if len(*seen) != len(dnsHealthMetrics) {
		t.Fatalf("queries = %d, want one per metric (%d)", len(*seen), len(dnsHealthMetrics))
	}
	for _, q := range *seen {
		filters := q["filters"].([]any)
		if len(filters) != 1 || asMap(filters[0])["member"] != "HostMetricsV1.metric_name" {
			t.Errorf("filters = %v, want only the metric_name filter", filters)
		}
		td := asMap(q["timeDimensions"].([]any)[0])
		if td["dateRange"] != "last 24 hours" || td["granularity"] != nil {
			t.Errorf("timeDimension = %v, want last 24 hours as one total", td)
		}
	}
	at := metricOf(t, got, "answer_time")
	if at["status"] != "ok" || at["value"] != 0.0314894046215304 || at["unit"] != "seconds" || at["metric"] != "dns_latency_all_iq" {
		t.Errorf("answer_time = %v", at)
	}
	if ch := metricOf(t, got, "cache_hit"); ch["value"] != 39.23 || ch["unit"] != "percent" {
		t.Errorf("cache_hit = %v", ch)
	}
	if to := metricOf(t, got, "timeouts"); to["unit"] != "per_second" {
		t.Errorf("timeouts unit = %v", to["unit"])
	}
	if hosts := at["hosts"].([]map[string]any); len(hosts) != 0 {
		t.Errorf("hosts = %v, want none for an account-wide row", hosts)
	}
}

// A 200 with no result.data is a read that did not deliver: "error", null,
// never an empty "ok" or a zero.
func TestCSPDNSHealth_200WithoutResultDataIsNotChecked(t *testing.T) {
	b := allTenantBodies()
	b["dns_success_percent_iq"] = `{"result":{}}`
	s, _ := dnsHealthServer(t, b, nil)
	got := s.CSPDNSHealth()
	m := metricOf(t, got, "success")
	if m["status"] != "error" || m["value"] != nil {
		t.Errorf("success = %v, want status error and a null value", m)
	}
	if got["status"] != "partial" {
		t.Errorf("status = %v, want partial", got["status"])
	}
}

func TestCSPDNSHealth_OneMetricFailsOthersStillShown(t *testing.T) {
	s, _ := dnsHealthServer(t, allTenantBodies(), map[string]bool{"cache_hit_ratio_iq": true})
	got := s.CSPDNSHealth()
	if got["status"] != "partial" {
		t.Errorf("status = %v, want partial", got["status"])
	}
	if m := metricOf(t, got, "cache_hit"); m["status"] != "error" || m["value"] != nil {
		t.Errorf("cache_hit = %v, want error/null", m)
	}
	if m := metricOf(t, got, "answer_time"); m["status"] != "ok" || m["value"] != 0.0314894046215304 {
		t.Errorf("answer_time = %v, want still read", m)
	}
}

func TestCSPDNSHealth_AllFailIsError(t *testing.T) {
	fail := map[string]bool{}
	for _, m := range dnsHealthMetrics {
		fail[m.Metric] = true
	}
	s, _ := dnsHealthServer(t, nil, fail)
	if got := s.CSPDNSHealth(); got["status"] != "error" {
		t.Errorf("status = %v, want error", got["status"])
	}
}

// No rows is "empty" with a null value: the metric answered but has no
// reading, which is not 0.
func TestCSPDNSHealth_EmptyRows(t *testing.T) {
	s, _ := dnsHealthServer(t, map[string]string{}, nil)
	got := s.CSPDNSHealth()
	if got["status"] != "empty" {
		t.Errorf("status = %v, want empty", got["status"])
	}
	for _, m := range dnsHealthMetrics {
		mm := metricOf(t, got, m.Key)
		if mm["status"] != "empty" || mm["value"] != nil {
			t.Errorf("%s = %v, want empty/null", m.Key, mm)
		}
	}
}

// Per-host rows: names resolved, a null reading stays null, and with no
// account-wide row the tenant value is the count-weighted average.
func TestCSPDNSHealth_PerHostWithNullReading(t *testing.T) {
	b := allTenantBodies()
	b["dns_latency_all_iq"] = `{"result":{"data":[
		{"HostMetricsV1.host":"uuid-1","HostMetricsV1.avg_value":"0.02","HostMetricsV1.count_value":"100"},
		{"HostMetricsV1.host":"uuid-2","HostMetricsV1.avg_value":"0.05","HostMetricsV1.count_value":"300"},
		{"HostMetricsV1.host":"uuid-3","HostMetricsV1.avg_value":null,"HostMetricsV1.count_value":"0"}
	]}}`
	s, _ := dnsHealthServer(t, b, nil)
	got := s.CSPDNSHealth()
	m := metricOf(t, got, "answer_time")
	want := (0.02*100 + 0.05*300) / 400
	if v, _ := m["value"].(float64); m["status"] != "ok" || v < want-1e-12 || v > want+1e-12 {
		t.Errorf("answer_time = %v, want weighted %v", m, want)
	}
	hosts := m["hosts"].([]map[string]any)
	if len(hosts) != 3 {
		t.Fatalf("hosts = %v, want 3", hosts)
	}
	byID := map[string]map[string]any{}
	for _, h := range hosts {
		byID[getStr(h["host"])] = h
	}
	if byID["uuid-1"]["host_name"] != "ns1.example.com" {
		t.Errorf("uuid-1 name = %v, want resolved", byID["uuid-1"]["host_name"])
	}
	if byID["uuid-3"]["value"] != nil {
		t.Errorf("uuid-3 value = %v, want null for a null reading", byID["uuid-3"]["value"])
	}
	if !strings.HasPrefix(getStr(byID["uuid-2"]["host_name"]), "uuid-2") {
		t.Errorf("unresolved host should keep its id, got %v", byID["uuid-2"]["host_name"])
	}
}

// The account-wide row wins over per-host rows when both come back.
func TestCSPDNSHealth_TenantRowPreferred(t *testing.T) {
	b := allTenantBodies()
	b["dns_timeout_rate_iq"] = `{"result":{"data":[
		{"HostMetricsV1.host":null,"HostMetricsV1.avg_value":1.62,"HostMetricsV1.count_value":"288"},
		{"HostMetricsV1.host":"uuid-1","HostMetricsV1.avg_value":9,"HostMetricsV1.count_value":"288"}
	]}}`
	s, _ := dnsHealthServer(t, b, nil)
	if m := metricOf(t, s.CSPDNSHealth(), "timeouts"); m["value"] != 1.62 {
		t.Errorf("timeouts = %v, want the account-wide 1.62", m["value"])
	}
}

func TestFetchHostMetrics_MissingReadingStaysNull(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/infra/v1/detail_hosts":
			_, _ = w.Write([]byte(`{"results":[]}`))
		case "/api/cubejs/v1/query":
			_, _ = w.Write([]byte(`{"result":{"data":[{"HostMetricsV1.host":"uuid-1","HostMetricsV1.metric_name_label":"CPU","HostMetricsV1.avg_value":null}]}}`))
		}
	})
	got := s.FetchHostMetrics(context.Background())
	metrics := got["metrics"].([]any)
	if len(metrics) != 2 {
		t.Fatalf("metrics = %v, want one row per metric", metrics)
	}
	for _, m := range metrics {
		if v := asMap(m)["avg_value"]; v != nil {
			t.Errorf("avg_value = %v, want null for a missing reading", v)
		}
	}
}
