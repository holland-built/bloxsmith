package server

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"testing"
)

// GET /api/visibility-counts hands back data.json as a file to save.
func TestVisibilityCountsRoute_Download(t *testing.T) {
	up := &countingUpstream{calls: map[string]int{}, respond: func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/cubejs/v1/query":
			_, _ = io.WriteString(w, `{"result":{"data":[]}}`)
		case "/api/ddi/v1/ipam/subnet":
			_, _ = io.WriteString(w, `{"results":[],"page":{"total_size":"0"}}`)
		default:
			_, _ = io.WriteString(w, `{"results":[]}`)
		}
		return true
	}}
	h, _ := newCachedChassis(t, up)
	rr := get(h, "/api/visibility-counts")
	if rr.Code != 200 {
		t.Fatalf("HTTP %d %s", rr.Code, rr.Body.String())
	}
	cd := rr.Header().Get("Content-Disposition")
	if !regexp.MustCompile(`^attachment; filename="visibility-\d{4}-\d{2}-\d{2}\.json"$`).MatchString(cd) {
		t.Fatalf("Content-Disposition = %q", cd)
	}
	if ct := rr.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q", ct)
	}
	var f struct {
		Counts []map[string]any `json:"counts"`
		Source map[string]any   `json:"source"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Counts) != 18 || f.Source["kind"] != "bloxsmith" {
		t.Fatalf("got %d counts, source %v", len(f.Counts), f.Source)
	}
}
