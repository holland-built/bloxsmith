package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// The 2026-10-27 miss: "Which subnets are nearly full?" was answered from the
// first 25 of 1,103 subnets in Infoblox's own order, all at 0-3%, while one sat
// at 80%. The sample now comes fullest first.
func TestGetSubnets_SampleIsFullestFirst(t *testing.T) {
	rows := []map[string]any{}
	for i := 0; i < 40; i++ {
		used := 1
		if i == 33 {
			used = 204 // 80% of 256, far past the first 25 rows
		}
		rows = append(rows, map[string]any{"name": fmt.Sprintf("s%d", i), "address": fmt.Sprintf("10.0.%d.0", i), "cidr": 24,
			"utilization": map[string]any{"total": 256, "used": used}})
	}
	rows = append(rows, map[string]any{"name": "unreported", "address": "10.9.0.0", "cidr": 24})
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) { writeResults(w, rows) })
	var out struct {
		Sample []map[string]any `json:"sample"`
	}
	if err := json.Unmarshal([]byte(s.RunAITool(context.Background(), "get_subnets", map[string]any{})), &out); err != nil {
		t.Fatal(err)
	}
	if out.Sample[0]["name"] != "s33" {
		t.Fatalf("first row = %v, want the 80%% subnet s33", out.Sample[0]["name"])
	}
	for _, r := range out.Sample {
		if r["name"] == "unreported" {
			t.Fatal("a subnet with no utilization reported made the 25-row sample ahead of measured ones")
		}
	}
}

// min_utilization asks Infoblox for every subnet at or above it, with the
// same filter the dashboard's at-risk read sends, and says so in the summary.
func TestGetSubnets_MinUtilizationFiltersUpstream(t *testing.T) {
	var filter, order string
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q, _ := url.ParseQuery(r.URL.RawQuery)
		filter, order = q.Get("_filter"), q.Get("_order_by")
		writeResults(w, []map[string]any{{"name": "wireless", "address": "10.11.1.0", "cidr": 24,
			"utilization": map[string]any{"total": 256, "used": 204}}})
	})
	out := s.RunAITool(context.Background(), "get_subnets", map[string]any{"min_utilization": float64(80)})
	if filter != "utilization.utilization>=80 and (cidr<=28 or cidr>=33)" {
		t.Fatalf("_filter = %q", filter)
	}
	if order != "utilization.utilization desc" {
		t.Fatalf("_order_by = %q: Infoblox must sort the whole tenant, not just the rows returned", order)
	}
	if !strings.Contains(out, "1 subnet at 80% used or more (IPv4 /29 to /32 links left out) exists in total") || !strings.Contains(out, "wireless") {
		t.Fatalf("summary should count the subnets at or above 80%%: %s", out)
	}
}

func TestGetSubnets_MinUtilizationWithNoneSaysSo(t *testing.T) {
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) { writeResults(w, nil) })
	if out := s.RunAITool(context.Background(), "get_subnets", map[string]any{"min_utilization": float64(95)}); out != "No subnet is 95% used or more (IPv4 /29 to /32 links are left out)." {
		t.Fatalf("got %q", out)
	}
	// Out of range is ignored rather than sent upstream.
	var filter string
	s2, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		filter = r.URL.Query().Get("_filter")
		writeResults(w, nil)
	})
	s2.RunAITool(context.Background(), "get_subnets", map[string]any{"min_utilization": float64(500)})
	if filter != "" {
		t.Fatalf("an out-of-range min_utilization reached upstream: %q", filter)
	}
}
