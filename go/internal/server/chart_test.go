package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// chartMux serves the routes through registerAll, the way production does, so
// a handler that exists but was never registered fails here too.
func chartMux(t *testing.T, handler http.HandlerFunc) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	incidentsTestDeps(t, handler).registerAll(mux)
	return mux
}

func TestChartOptionsRoute(t *testing.T) {
	mux := chartMux(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("options must not call the tenant, called %s", r.URL.Path)
	})
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("GET", "/api/chart/options", nil))
	if rr.Code != 200 {
		t.Fatalf("status = %d; body=%s", rr.Code, rr.Body.String())
	}
	body := decodeIncidentsBody(t, rr)
	if _, ok := body["combos"].([]any); !ok {
		t.Fatalf("options has no combos: %v", body)
	}
}

func TestChartRoute_RunsAnAllowedPick(t *testing.T) {
	var path string
	mux := chartMux(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":{"data":[{"NetworkNstarDnsActivity.device_name":"ws-1","NetworkNstarDnsActivity.device_ip":"10.0.0.1","NetworkNstarDnsActivity.total_query_count":"7"}]}}`))
	})
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("GET", "/api/chart?count=dns&split=device&window=7d&over=none&top=10", nil))
	if rr.Code != 200 {
		t.Fatalf("status = %d; body=%s", rr.Code, rr.Body.String())
	}
	if path != "/api/cubejs/v1/query" {
		t.Fatalf("upstream path = %s", path)
	}
	body := decodeIncidentsBody(t, rr)
	if body["status"] != "ok" {
		t.Fatalf("status = %v", body["status"])
	}
	if rows, _ := body["rows"].([]any); len(rows) != 1 {
		t.Fatalf("rows = %v", body["rows"])
	}
}

func TestChartRoute_BadPickIs400AndNeverReachesTheTenant(t *testing.T) {
	var calls int32
	mux := chartMux(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
	})
	for _, q := range []string{
		"count=threats&split=qtype&window=7d&over=none&top=10",
		"count=dns&split=none&window=7d&over=hour",
		"count=dns&split=device&window=7d&over=none&top=abc",
		"",
	} {
		rr := httptest.NewRecorder()
		mux.ServeHTTP(rr, httptest.NewRequest("GET", "/api/chart?"+q, nil))
		if rr.Code != 400 {
			t.Errorf("%q: status = %d, want 400", q, rr.Code)
			continue
		}
		msg, _ := decodeIncidentsBody(t, rr)["error"].(string)
		if msg == "" || strings.Contains(msg, "{") {
			t.Errorf("%q: error = %q, want a plain message", q, msg)
		}
	}
	if atomic.LoadInt32(&calls) != 0 {
		t.Fatalf("a refused pick reached the tenant %d times", calls)
	}
}

func TestChartRoute_CarriesTheFilter(t *testing.T) {
	var got string
	mux := chartMux(t, func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.Query().Get("query")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":{"data":[]}}`))
	})
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("GET", "/api/chart?count=threats&split=policy&window=7d&over=none&top=10&only=action&is=is&value=Block", nil))
	if rr.Code != 200 || !strings.Contains(got, `"operator":"equals","values":["Block"]`) {
		t.Fatalf("status %d, query sent %s", rr.Code, got)
	}
	rr = httptest.NewRecorder()
	got = ""
	mux.ServeHTTP(rr, httptest.NewRequest("GET", "/api/chart?count=threats&split=policy&window=7d&over=none&top=10&only=device&is=is&value=x", nil))
	if rr.Code != 400 || got != "" {
		t.Fatalf("a filter on another cube's field: status %d, sent %q", rr.Code, got)
	}
}

func TestChartValuesRoute(t *testing.T) {
	var calls atomic.Int32
	mux := chartMux(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":{"data":[{"PortunusAggThreat_ch.action":"Block","PortunusAggThreat_ch.requests":"5"}]}}`))
	})
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("GET", "/api/chart/values?count=threats&only=action&window=7d", nil))
	if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"Block"`) {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	rr = httptest.NewRecorder()
	before := calls.Load()
	mux.ServeHTTP(rr, httptest.NewRequest("GET", "/api/chart/values?count=dns&only=atype&window=7d", nil))
	if rr.Code != 400 || calls.Load() != before {
		t.Fatalf("a field the count doesn't have: status %d after %d calls", rr.Code, calls.Load()-before)
	}
}
