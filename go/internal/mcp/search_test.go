package mcp

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

// searchReply has one row of each kind Infoblox returned live on 2026-11-22:
// an entity, a short threat row, a very large threat row, and the summary row
// that threat intelligence adds at the end. The values are made up.
func searchReply(t *testing.T) string {
	t.Helper()
	reply, err := json.Marshal(map[string]any{
		"total_hits": 4,
		"results": []any{
			map[string]any{
				"mode": "infoblox_entities", "id": "dns/record/abc", "name": "host.example",
				"application": "ddi", "resource": "dns/record", "score": 0.9,
				"object_information": map[string]any{"secret_field": "must not survive"},
			},
			map[string]any{
				"mode": "threat_intelligence", "source": "whitelist", "indicator": "bad.example",
				"indicator_type": "host", "data": map[string]any{"value": "bad.example", "whitelisted": false},
			},
			map[string]any{
				"mode": "threat_intelligence", "source": "atp", "indicator": "bad.example",
				"indicator_type": "host", "data": map[string]any{"record_count": 2, "threat": strings.Repeat("x", 100000)},
			},
			map[string]any{
				"mode": "threat_intelligence", "summary": true, "sources_checked": 13,
				"sources_with_findings": 2, "no_findings": []any{"acs", "threatfox"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(reply)
}

func TestSearchCallsEntitySearchWithBothModes(t *testing.T) {
	ts := &textToolServer{}
	srv := ts.start(t, searchReply(t))
	c := New(srv.URL+"/mcp", func() string { return "Bearer k" })
	if err := c.Initialize(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SearchErr(t.Context(), "bad.example"); err != nil {
		t.Fatal(err)
	}
	ts.mu.Lock()
	defer ts.mu.Unlock()
	if len(ts.names) != 1 || ts.names[0] != "infoblox-portal_entity_search" {
		t.Fatalf("called %v, want infoblox-portal_entity_search", ts.names)
	}
	want := []any{"infoblox_entities", "threat_intelligence"}
	if got := ts.args[0]["modes"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("modes = %v, want %v", got, want)
	}
}

func TestSearchReturnsCompactRowsWithOneSetOfColumns(t *testing.T) {
	ts := &textToolServer{}
	srv := ts.start(t, searchReply(t))
	c := New(srv.URL+"/mcp", func() string { return "Bearer k" })
	if err := c.Initialize(t.Context()); err != nil {
		t.Fatal(err)
	}
	hits, err := c.SearchErr(t.Context(), "bad.example")
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 4 {
		t.Fatalf("got %d rows, want 4", len(hits))
	}
	columns := []string{"name", "score", "source", "summary", "type"}
	for i, hit := range hits {
		row, ok := hit.(map[string]any)
		if !ok {
			t.Fatalf("row %d is %T", i, hit)
		}
		if len(row) != len(columns) {
			t.Errorf("row %d has columns %v, want %v", i, row, columns)
		}
		for _, col := range columns {
			if _, ok := row[col]; !ok {
				t.Errorf("row %d has no %q column", i, col)
			}
		}
		if s, _ := row["summary"].(string); utf8.RuneCountInString(s) > 301 {
			t.Errorf("row %d summary is %d characters", i, utf8.RuneCountInString(s))
		}
	}

	// The summary row comes first, so the AI's 10-row cap cannot cut it off.
	first := hits[0].(map[string]any)
	if first["type"] != "summary" || !strings.Contains(first["summary"].(string), "13 sources checked") {
		t.Errorf("first row should be the summary, got %v", first)
	}
	entity := hits[1].(map[string]any)
	if entity["name"] != "host.example" || entity["type"] != "dns/record" || entity["source"] != "ddi" || entity["summary"] != "dns/record/abc" {
		t.Errorf("entity row = %v", entity)
	}
	threat := hits[2].(map[string]any)
	if threat["name"] != "bad.example" || threat["type"] != "host" || threat["source"] != "whitelist" ||
		!strings.Contains(threat["summary"].(string), `"whitelisted":false`) {
		t.Errorf("threat row = %v", threat)
	}
	raw, _ := json.Marshal(hits)
	if strings.Contains(string(raw), "must not survive") {
		t.Error("object_information reached the compact rows")
	}
}

func TestSearchKeepsEmptyAndFailedApart(t *testing.T) {
	for _, tc := range []struct {
		reply   string
		wantNil bool
	}{
		{`{"total_hits":0,"results":[],"message":"No results found"}`, false},
		{`{"unexpected":"shape"}`, true},
	} {
		ts := &textToolServer{}
		srv := ts.start(t, tc.reply)
		c := New(srv.URL+"/mcp", func() string { return "Bearer k" })
		if err := c.Initialize(t.Context()); err != nil {
			t.Fatal(err)
		}
		hits, err := c.SearchErr(t.Context(), "x")
		if (hits == nil) != tc.wantNil || (err != nil) != tc.wantNil {
			t.Errorf("reply %s: hits=%v err=%v, wantNil=%v", tc.reply, hits, err, tc.wantNil)
		}
	}
}

// A long field must not push the one that says how bad the finding is past the
// summary's cap.
func TestSearchSummaryKeepsTheFindingPastALongField(t *testing.T) {
	row := compactSearchHit("bad.example", map[string]any{
		"mode": "threat_intelligence", "source": "atp", "indicator": "bad.example", "indicator_type": "host",
		"data": map[string]any{
			"details": strings.Repeat("x", 400),
			"verdict": "malicious",
			"threat": []any{
				map[string]any{"class": "Phishing", "threat_level": float64(100)},
				map[string]any{"class": "Phishing", "threat_level": float64(80)},
			},
		},
	})
	summary := row["summary"].(string)
	for _, want := range []string{"verdict=malicious", "threat_level=100, 80", "class=Phishing"} {
		if !strings.Contains(summary, want) {
			t.Errorf("summary lost %q: %.120s", want, summary)
		}
	}
	if n := utf8.RuneCountInString(summary); n > searchSummaryMax+1 {
		t.Errorf("summary is %d characters, cap is %d", n, searchSummaryMax)
	}
}
