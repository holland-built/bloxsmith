package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"testing"
)

// failuresUpstream answers every Cube.js query with one NXDOMAIN row whose
// count depends on the query's window, so each window's answer is different.
func failuresUpstream() *countingUpstream {
	counts := map[string]string{"today": "100", "yesterday": "200", "this week": "300", "last 30 days": "400"}
	return &countingUpstream{calls: map[string]int{}, respond: func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/api/cubejs/v1/query" {
			return false
		}
		var q struct {
			TimeDimensions []struct {
				DateRange string `json:"dateRange"`
			} `json:"timeDimensions"`
		}
		_ = json.Unmarshal([]byte(r.URL.Query().Get("query")), &q)
		n := counts[q.TimeDimensions[0].DateRange]
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"result":{"data":[{"X.rcode":"3","X.qname":"a.example.","X.total_query_count":"`+n+`","X.failedTransactionCount":"`+n+`"}]}}`)
		return true
	}}
}

func failuresTotal(t *testing.T, h http.Handler, window string) any {
	t.Helper()
	rr := get(h, "/api/csp/dns-failures?window="+url.QueryEscape(window))
	if rr.Code != 200 {
		t.Fatalf("%s: HTTP %d %s", window, rr.Code, rr.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["window"] != window {
		t.Errorf("window = %v, want %q", body["window"], window)
	}
	return body["total"]
}

// Each window is cached under its own key: switching window gives that
// window's numbers, and asking for one again inside the TTL costs no call.
func TestDNSFailuresRoute_EachWindowCachedSeparately(t *testing.T) {
	up := failuresUpstream()
	h, _ := newCachedChassis(t, up)
	want := map[string]float64{"today": 100, "yesterday": 200, "this week": 300, "last 30 days": 400}
	for _, w := range []string{"today", "yesterday", "this week", "last 30 days"} {
		if got := failuresTotal(t, h, w); got != want[w] {
			t.Errorf("%s total = %v, want %v", w, got, want[w])
		}
	}
	calls := up.total("/api/cubejs/")
	if calls != 8 {
		t.Fatalf("four windows made %d cube calls, want 8 (two each)", calls)
	}
	for _, w := range []string{"yesterday", "today"} {
		if got := failuresTotal(t, h, w); got != want[w] {
			t.Errorf("cached %s total = %v, want %v", w, got, want[w])
		}
	}
	if got := up.total("/api/cubejs/"); got != calls {
		t.Errorf("repeat windows inside the TTL made %d more calls, want 0", got-calls)
	}
}

func TestDNSFailuresRoute_RejectsOtherWindows(t *testing.T) {
	up := failuresUpstream()
	h, _ := newCachedChassis(t, up)
	for _, q := range []string{"", "?window=", "?window=last%207%20days", "?window=Today", "?window=today%20"} {
		if rr := get(h, "/api/csp/dns-failures"+q); rr.Code != 400 {
			t.Errorf("%q: HTTP %d, want 400", q, rr.Code)
		}
	}
	if n := up.total("/api/cubejs/"); n != 0 {
		t.Errorf("a refused window made %d upstream calls, want 0", n)
	}
}

func TestDHCPRequestsRoute_Answers(t *testing.T) {
	up := &countingUpstream{calls: map[string]int{}, respond: func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/api/cubejs/v1/query" {
			return false
		}
		_, _ = io.WriteString(w, `{"result":{"data":[{"HostMetricsV1.sum_value":12483,"HostMetricsV1.count_value":"2304"}]}}`)
		return true
	}}
	h, _ := newCachedChassis(t, up)
	rr := get(h, "/api/csp/dhcp-requests")
	if rr.Code != 200 {
		t.Fatalf("HTTP %d", rr.Code)
	}
	var body map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body["status"] != "ok" {
		t.Errorf("status = %v, want ok: %v", body["status"], body)
	}
	if up.total("/api/cubejs/") != 4 {
		t.Errorf("cube calls = %d, want 4", up.total("/api/cubejs/"))
	}
}
