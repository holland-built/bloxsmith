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
