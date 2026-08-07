package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// /api/service-inventory exists so the UI can hide panels for services a
// tenant does not run. That makes its FAILURE shape more important than its
// success shape: if a dead feed came back as 200 {"service_types": []}, the UI
// would hide every mapped panel on the strength of a read that never
// happened. The dashboard layer returns nil for that case; these tests hold
// the line at the wire, where nil and empty stop being different Go values and
// have to survive as JSON null vs [].

func TestServiceInventoryRouteRegistered(t *testing.T) {
	rr := &recordingRouter{}
	(&Deps{}).registerDataRoutes(rr)

	for _, p := range rr.patterns {
		if p == "GET /api/service-inventory" {
			return
		}
	}
	t.Fatalf("GET /api/service-inventory is not registered by registerDataRoutes; got %v", rr.patterns)
}

func TestServiceInventory_OK_ListsDistinctTypes(t *testing.T) {
	d := incidentsTestDeps(t, healthyEmptyFeedsHandler(map[string]http.HandlerFunc{
		"/api/infra/v1/detail_services": func(w http.ResponseWriter, r *http.Request) {
			writeIncidentsResults(w, []map[string]any{
				{"service_type": "dns"}, {"service_type": "dhcp"}, {"service_type": "dns"},
			})
		},
	}))

	rec := httptest.NewRecorder()
	d.serviceInventory(rec, httptest.NewRequest("GET", "/api/service-inventory", nil))

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeIncidentsBody(t, rec)
	if body["availability"] != "ok" {
		t.Fatalf("availability = %v, want \"ok\"", body["availability"])
	}
	types, ok := body["service_types"].([]any)
	if !ok {
		t.Fatalf("service_types = %v (%T), want a JSON array", body["service_types"], body["service_types"])
	}
	if len(types) != 2 || types[0] != "dhcp" || types[1] != "dns" {
		t.Fatalf("service_types = %v, want [dhcp dns]", types)
	}
}

// The one that matters: a 500 from the upstream must still be a 200 here
// (a 5xx reads as "no data" to a fetch()), carrying availability "error" and a
// service_types of null. Null is the wire signal for "unknown" — [] would be a
// claim that this tenant owns nothing.
func TestServiceInventory_DeadFeed_Is200WithNullTypes(t *testing.T) {
	d := incidentsTestDeps(t, healthyEmptyFeedsHandler(map[string]http.HandlerFunc{
		"/api/infra/v1/detail_services": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		},
	}))

	rec := httptest.NewRecorder()
	d.serviceInventory(rec, httptest.NewRequest("GET", "/api/service-inventory", nil))

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 — the failure is reported in availability, not the HTTP status; body=%s",
			rec.Code, rec.Body.String())
	}
	body := decodeIncidentsBody(t, rec)
	if body["availability"] != "error" {
		t.Fatalf("availability = %v, want \"error\"", body["availability"])
	}
	raw, present := body["service_types"]
	if !present {
		t.Fatal("service_types key is absent; it must be present and null so the client can tell unknown from empty")
	}
	if raw != nil {
		t.Fatalf("service_types = %#v on a failed read, want JSON null — an array here (even an empty one) "+
			"tells the UI this tenant owns nothing and hides panels on a read that never succeeded", raw)
	}
}
