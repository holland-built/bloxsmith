package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const anyMeta = `{"result":{"cubes":[{"name":"DnsActivityV1","title":"DNS Activity","public":true,"isVisible":true,
 "measures":[{"name":"DnsActivityV1.total_query_count","shortTitle":"Queries","type":"number"}],
 "dimensions":[{"name":"DnsActivityV1.device_name","shortTitle":"Device","type":"string"}]}]}}`

// anyMux answers both catalogs, counts the queries that reach the tenant, and
// fails the catalog when down is set.
func anyMux(t *testing.T, down bool, queries *int32) http.Handler {
	return chartMux(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/meta") {
			if down {
				w.WriteHeader(503)
				return
			}
			if strings.Contains(r.URL.Path, "security") {
				_, _ = w.Write([]byte(`{"result":{"cubes":[]}}`))
				return
			}
			_, _ = w.Write([]byte(anyMeta))
			return
		}
		atomic.AddInt32(queries, 1)
		_, _ = w.Write([]byte(`{"result":{"data":[{"DnsActivityV1.device_name":"ws-1","DnsActivityV1.total_query_count":"7"}]}}`))
	})
}

func TestChartAnyRoute_OnlyListedMembersReachTheTenant(t *testing.T) {
	var queries int32
	mux := anyMux(t, false, &queries)
	for _, q := range []string{
		"cube=Nope&measure=Nope.count",
		"cube=DnsActivityV1&measure=DnsActivityV1.secret",
		"cube=DnsActivityV1&measure=DnsActivityV1.total_query_count&split=DnsActivityV1.other&top=10",
		"cube=DnsActivityV1&measure=DnsActivityV1.total_query_count&top=abc",
	} {
		rr := httptest.NewRecorder()
		mux.ServeHTTP(rr, httptest.NewRequest("GET", "/api/chart/any?"+q, nil))
		if rr.Code != 400 {
			t.Errorf("%q: status = %d, want 400", q, rr.Code)
		}
	}
	if queries != 0 {
		t.Fatalf("a refused pick reached the tenant %d times", queries)
	}
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("GET", "/api/chart/any?cube=DnsActivityV1&measure=DnsActivityV1.total_query_count&split=DnsActivityV1.device_name&top=10", nil))
	body := decodeIncidentsBody(t, rr)
	if rr.Code != 200 || body["status"] != "ok" || queries != 1 {
		t.Fatalf("good pick: %d %v (queries %d)", rr.Code, body, queries)
	}
}

func TestChartCubesRoute_DownIsAnErrorNotNoData(t *testing.T) {
	var queries int32
	mux := anyMux(t, true, &queries)
	for _, path := range []string{"/api/chart/cubes", "/api/chart/fields?cube=DnsActivityV1", "/api/chart/any?cube=DnsActivityV1&measure=DnsActivityV1.total_query_count"} {
		rr := httptest.NewRecorder()
		mux.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
		if body := decodeIncidentsBody(t, rr); rr.Code != 200 || body["status"] != "error" {
			t.Errorf("%s: %d %v, want status error", path, rr.Code, body)
		}
	}
}

func TestChartFieldsRoute(t *testing.T) {
	var queries int32
	mux := anyMux(t, false, &queries)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("GET", "/api/chart/fields?cube=DnsActivityV1", nil))
	cube, _ := decodeIncidentsBody(t, rr)["cube"].(map[string]any)
	if rr.Code != 200 || cube["name"] != "DnsActivityV1" || len(cube["measures"].([]any)) != 1 {
		t.Fatalf("fields: %d %v", rr.Code, cube)
	}
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("GET", "/api/chart/fields?cube=Nope", nil))
	if rr.Code != 400 {
		t.Fatalf("unknown cube: %d", rr.Code)
	}
}
