package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIPAMOverlaps_Handler(t *testing.T) {
	d := incidentsTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		var body map[string]any
		switch {
		case strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
			rows := []map[string]any{{"id": "n1", "space": "sB", "address": "10.1.0.0", "cidr": 16}}
			if r.URL.Query().Get("_offset") != "0" {
				rows = nil
			}
			body = map[string]any{"results": rows, "page": map[string]any{"total_size": "1"}}
		case strings.HasSuffix(r.URL.Path, "/ipam/address_block"):
			rows := []map[string]any{{"id": "b1", "space": "sA", "address": "10.0.0.0", "cidr": 8}}
			if r.URL.Query().Get("_offset") != "0" {
				rows = nil
			}
			body = map[string]any{"results": rows}
		default:
			body = map[string]any{"results": []any{}}
		}
		_ = json.NewEncoder(w).Encode(body)
	})
	mux := http.NewServeMux()
	d.registerIPAMReadRoutes(mux)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("GET", "/api/ipam/overlaps", nil))
	if rr.Code != 200 {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var got struct {
		Status string `json:"status"`
		Groups []struct {
			Range   string `json:"range"`
			Spaces  int    `json:"spaces"`
			Members []struct {
				Name     string   `json:"name"`
				Prefixes []string `json:"prefixes"`
			} `json:"members"`
		} `json:"groups"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != "ok" || len(got.Groups) != 1 || got.Groups[0].Range != "10.0.0.0/8" || got.Groups[0].Spaces != 2 {
		t.Fatalf("got %s", rr.Body.String())
	}
	// No names were readable, so each space shows its id.
	if got.Groups[0].Members[0].Name != "sA" || got.Groups[0].Members[1].Prefixes[0] != "10.1.0.0/16" {
		t.Fatalf("members = %+v", got.Groups[0].Members)
	}
}
