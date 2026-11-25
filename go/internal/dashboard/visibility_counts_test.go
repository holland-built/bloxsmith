package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func visTenantFull() *visTenant {
	return &visTenant{
		Assets: visAssets(),
		Records: []fakeRecord{
			{Name: "a", Zone: "z.", Flags: []string{"Dangling"}},
			{Name: "b", Zone: "z.", Flags: []string{"Abandoned", "Untrusted"}},
			{Name: "c", Zone: "z.", Flags: []string{"Stale"}},
			{Name: "d", Zone: "z.", Flags: []string{"Stale", "Untrusted"}},
		},
		Subnets:    cloudSubnets(),
		Connectors: []map[string]any{},
	}
}

func toMap(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func visKeys(m map[string]any) []string {
	var ks []string
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func kindOf(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case float64:
		return "number"
	case []any:
		return "list"
	case map[string]any:
		return "object"
	}
	return "other"
}

// The file has exactly the shape of the build-report skill's example
// data.json (testdata/visibility-example.json, copied verbatim): the same
// top-level fields, the same fields on every count and chart bar, 18 counts
// in order, and every unread count null with a note.
func TestVisibilityCounts_MatchesSchemaExample(t *testing.T) {
	raw, err := os.ReadFile("testdata/visibility-example.json")
	if err != nil {
		t.Fatal(err)
	}
	var example map[string]any
	if err := json.Unmarshal(raw, &example); err != nil {
		t.Fatal(err)
	}
	got := toMap(t, visTenantFull().service(t).VisibilityCounts(context.Background()))

	for _, k := range visKeys(example) {
		if k == "portalUrl" || k == "context" { // optional, left out when empty
			continue
		}
		v, ok := got[k]
		if !ok {
			t.Errorf("missing top-level field %q", k)
			continue
		}
		// dnsPanelTotal is a string or null.
		if kindOf(v) != kindOf(example[k]) && !(k == "dnsPanelTotal" && v == nil) {
			t.Errorf("%s: want %s, got %s", k, kindOf(example[k]), kindOf(v))
		}
	}
	for _, k := range visKeys(got) {
		if _, ok := example[k]; !ok {
			t.Errorf("field %q is not in the schema", k)
		}
	}
	if strings.Join(visKeys(got["source"].(map[string]any)), ",") != strings.Join(visKeys(example["source"].(map[string]any)), ",") {
		t.Errorf("source fields: %v", got["source"])
	}
	if got["source"].(map[string]any)["kind"] != "bloxsmith" {
		t.Errorf("source.kind: %v", got["source"])
	}
	if !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`).MatchString(got["reportDate"].(string)) {
		t.Errorf("reportDate: %v", got["reportDate"])
	}
	if got["customer"] != "" || got["region"] != "" {
		t.Errorf("customer and region are left for the Glean form: %v %v", got["customer"], got["region"])
	}

	wantCountKeys := visKeys(example["counts"].([]any)[0].(map[string]any))
	counts := got["counts"].([]any)
	if len(counts) != 18 {
		t.Fatalf("want 18 counts, got %d", len(counts))
	}
	for i, c := range counts {
		m := c.(map[string]any)
		if !slices.Equal(visKeys(m), wantCountKeys) {
			t.Errorf("count %d fields %v, want %v", i+1, visKeys(m), wantCountKeys)
		}
		if m["n"] != float64(i+1) {
			t.Errorf("count %d has n %v", i+1, m["n"])
		}
		if m["ref"] == "" || m["note"] == "" || m["from"] != "portal" {
			t.Errorf("count %d: ref, note and from must be set: %v", i+1, m)
		}
		switch n := m["count"].(type) {
		case nil:
			if m["raw"] != "" {
				t.Errorf("count %d is null but raw is %v", i+1, m["raw"])
			}
		case float64:
			if n < 0 || n != float64(int(n)) {
				t.Errorf("count %d is not a whole number: %v", i+1, n)
			}
		default:
			t.Errorf("count %d: %T", i+1, n)
		}
	}

	exCharts, gotCharts := example["charts"].(map[string]any), got["charts"].(map[string]any)
	if !slices.Equal(visKeys(exCharts), visKeys(gotCharts)) {
		t.Fatalf("charts: %v, want %v", visKeys(gotCharts), visKeys(exCharts))
	}
	barKeys := visKeys(exCharts["assetTypes"].([]any)[0].(map[string]any))
	for name, list := range gotCharts {
		for _, b := range list.([]any) {
			if !slices.Equal(visKeys(b.(map[string]any)), barKeys) {
				t.Errorf("charts.%s bar %v, want fields %v", name, b, barKeys)
			}
		}
	}
	noteKeys := visKeys(example["notes"].([]any)[0].(map[string]any))
	for _, n := range got["notes"].([]any) {
		if !slices.Equal(visKeys(n.(map[string]any)), noteKeys) {
			t.Errorf("note %v, want fields %v", n, noteKeys)
		}
	}
}

func countN(f VisFile, n int) *int { return f.Counts[n-1].Count }

func TestVisibilityCounts_Values(t *testing.T) {
	f := visTenantFull().service(t).VisibilityCounts(context.Background())
	want := map[int]int{1: 2, 2: 1, 3: 1, 4: 0, 7: 6, 9: 1, 10: 2, 11: 3, 12: 3, 14: 1, 15: 1, 16: 2, 17: 0, 18: 2}
	for n, w := range want {
		if c := countN(f, n); c == nil || *c != w {
			t.Errorf("count %d: want %d, got %v (%s)", n, w, c, f.Counts[n-1].Note)
		}
	}
	for _, n := range []int{5, 6, 8, 13} {
		if countN(f, n) != nil {
			t.Errorf("count %d must be null", n)
		}
	}
	if !strings.Contains(f.Counts[4].Note, "Infoblox counts 3 Noncompliant assets (Publicly Accessible VM 2, Unsecured Storage Volume 1, Permissive Security Group 0)") {
		t.Errorf("count 5 note: %s", f.Counts[4].Note)
	}
	if !strings.Contains(f.Counts[7].Note, "Assets only ServiceNow reports: 1.") {
		t.Errorf("count 8 note: %s", f.Counts[7].Note)
	}
	if !strings.Contains(f.Counts[11].Note, "1 of them are /29 to /32 links") {
		t.Errorf("count 12 note: %s", f.Counts[11].Note)
	}
	if got := f.Charts.CloudProviders; !slices.Equal(got, []chartItem{{"AWS", 3}, {"Azure", 1}, {"GCP", 1}}) {
		t.Errorf("cloudProviders: %v", got)
	}
	if len(f.Charts.AssetTypes) == 0 || f.Charts.AssetTypes[0] != (chartItem{"Storage Volume", 2}) && f.Charts.AssetTypes[0].Value != 2 {
		t.Errorf("assetTypes: %v", f.Charts.AssetTypes)
	}
	if visCountsRead(f) != 14 {
		t.Errorf("want 14 counts read, got %d", visCountsRead(f))
	}
	if len(f.Notes) != 4 {
		t.Errorf("want one note per null count (4), got %v", f.Notes)
	}
}

// ServiceNow not connected: count 7 is null and says so.
func TestVisibilityCounts_NoServiceNow(t *testing.T) {
	ten := visTenantFull()
	ten.Assets = []fakeAsset{{Type: "Server", Providers: []string{"AWS"}}}
	f := ten.service(t).VisibilityCounts(context.Background())
	if countN(f, 7) != nil || !strings.Contains(f.Counts[6].Note, "ServiceNow isn't connected") {
		t.Fatalf("count 7: %v %s", countN(f, 7), f.Counts[6].Note)
	}
}

// A failed read is null with its reason, never 0.
func TestVisibilityCounts_FailedReadsAreNull(t *testing.T) {
	ten := visTenantFull()
	ten.Fail = func(r *http.Request) (int, string) {
		if r.URL.Path == "/api/cubejs/v1/query" {
			return 200, `{"error":"Continue wait"}`
		}
		return 0, ""
	}
	s := ten.service(t)
	f := s.VisibilityCounts(context.Background())
	for _, n := range []int{1, 2, 3, 4, 7, 9, 10, 14, 15, 16, 17, 18} {
		if countN(f, n) != nil {
			t.Errorf("count %d: cube failed, want null, got %d", n, *countN(f, n))
		}
	}
	if countN(f, 11) == nil {
		t.Errorf("count 11 comes from the subnet API and should still be read")
	}
	// A partial file is not cached: the next call asks again.
	before := ten.calls("/api/cubejs")
	s.VisibilityCounts(context.Background())
	if ten.calls("/api/cubejs") == before {
		t.Fatal("a partial result must not be cached")
	}
}

// When the time budget runs out, the reads still waiting come back null with
// the time-up reason, and the call returns soon after the budget.
func TestVisibilityCounts_TimeBudget(t *testing.T) {
	old := visBudget
	visBudget = 300 * time.Millisecond
	t.Cleanup(func() { visBudget = old })
	ten := visTenantFull()
	ten.Fail = func(r *http.Request) (int, string) {
		if r.URL.Path == subnetPath {
			<-r.Context().Done() // never answers in time
			return 504, ""
		}
		return 0, ""
	}
	start := time.Now()
	f := ten.service(t).VisibilityCounts(context.Background())
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("took %v, want about the 300ms budget", d)
	}
	for _, n := range []int{11, 12} {
		if countN(f, n) != nil || !strings.Contains(f.Counts[n-1].Note, reasonTimeUp) {
			t.Errorf("count %d: want null with the time-up reason, got %v %q", n, countN(f, n), f.Counts[n-1].Note)
		}
	}
}

// No more than visConcurrency reads are in flight at once.
func TestVisibilityCounts_LimitedConcurrency(t *testing.T) {
	var now, peak atomic.Int32
	ten := visTenantFull()
	ten.Fail = func(*http.Request) (int, string) {
		n := now.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		now.Add(-1)
		return 0, ""
	}
	ten.service(t).VisibilityCounts(context.Background())
	// readDNSFlag runs no sample here, so each task is one request.
	if p := peak.Load(); p > visConcurrency {
		t.Fatalf("peak %d reads at once, want at most %d", p, visConcurrency)
	}
}

func TestVisibilityCountsTool_SummaryAndLinkOnly(t *testing.T) {
	out := visDecode(t, visTenantFull().service(t).RunAITool(context.Background(), "visibility_counts", nil))
	if out["download"] != "/api/visibility-counts" {
		t.Fatalf("download link: %v", out)
	}
	sum := out["summary"].(string)
	if !strings.HasPrefix(sum, "Read 14 of 18") || !strings.Contains(sum, "5 Public access assets") {
		t.Fatalf("summary: %s", sum)
	}
	if _, ok := out["counts"]; ok {
		t.Fatal("the tool must not return the whole file")
	}
}
