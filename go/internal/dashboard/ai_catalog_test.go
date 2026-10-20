package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestFindDataRanksZonePathsForAZoneQuestion(t *testing.T) {
	out := findData("how many top level zones do I have")
	var got struct {
		Matches []struct{ Path, Summary string } `json:"matches"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, out)
	}
	if len(got.Matches) == 0 || len(got.Matches) > 5 {
		t.Fatalf("want 1..5 matches, got %d: %s", len(got.Matches), out)
	}
	if got.Matches[0].Path != "/api/ddi/v1/dns/auth_zone" {
		t.Fatalf("auth_zone should rank first: %s", out)
	}
}

func TestFindDataWithNoMatchSaysSo(t *testing.T) {
	out := findData("zzqx")
	if !strings.Contains(out, "No Infoblox data source matched") {
		t.Fatalf("got %s", out)
	}
}

func TestCatalogHoldsNoSecretPaths(t *testing.T) {
	for _, e := range aiCatalog {
		if strings.Contains(e.Path, "{") || strings.Contains(e.Path, "token") ||
			strings.Contains(e.Path, "access_codes") || strings.Contains(e.Path, "download") {
			t.Errorf("catalog must not hold %s", e.Path)
		}
	}
	if len(aiCatalog) < 50 {
		t.Fatalf("catalog looks empty: %d paths", len(aiCatalog))
	}
}

func TestAPIGetRejectsAPathNotInTheCatalog(t *testing.T) {
	s, paths := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, nil)
	})
	for _, p := range []string{"/api/iam/v2/keys", "/api/ddi/v1/dns/auth_zone/../../iam/v2/keys",
		"/api/ddi/v1/dns/auth_zone?x=1", "/host-activation/v1/jointoken", ""} {
		out := s.RunAITool(context.Background(), "api_get", map[string]any{"path": p})
		if !strings.Contains(out, "not a readable data source") {
			t.Errorf("path %q: want refusal, got %s", p, out)
		}
	}
	if len(*paths) != 0 {
		t.Fatalf("refused paths must not reach the tenant, called: %v", *paths)
	}
}

func TestAPIGetReturnsTheExactTotalAndSendsTheFilter(t *testing.T) {
	s, paths := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResultsWithPage(w, []map[string]any{{"fqdn": "com."}, {"fqdn": "net."}},
			map[string]any{"total_size": "1440"})
	})
	out := s.RunAITool(context.Background(), "api_get", map[string]any{
		"path": "/api/ddi/v1/dns/auth_zone", "filter": "fqdn~'^[^.]+\\.$'", "fields": "fqdn,view"})
	var p toolPayload
	if err := json.Unmarshal([]byte(out), &p); err != nil {
		t.Fatalf("not a payload: %v\n%s", err, out)
	}
	if p.TotalCount != 1440 || !p.Truncated || p.Returned != 2 {
		t.Fatalf("want total 1440 from page.total_size, got %+v", p)
	}
	q := (*paths)[0]
	for _, want := range []string{"/api/ddi/v1/dns/auth_zone?", "_filter=fqdn", "_fields=fqdn%2Cview", "_is_total_size_needed=true"} {
		if !strings.Contains(q, want) {
			t.Errorf("request %s lacks %s", q, want)
		}
	}
}

func TestAPIGetWithoutAPageTotalSaysAtLeastAtTheBound(t *testing.T) {
	rows := make([]map[string]any, apiGetLimit)
	for i := range rows {
		rows[i] = map[string]any{"name": "r"}
	}
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, rows)
	})
	out := s.RunAITool(context.Background(), "api_get", map[string]any{"path": "/api/ddi/v1/dns/record"})
	if !strings.Contains(out, fmt.Sprintf("At least %d", apiGetLimit)) {
		t.Fatalf("a full page without a total must not be reported as exact: %s", out)
	}
}

func TestAPIGetRejectsOversizedOrOddArguments(t *testing.T) {
	s, paths := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, nil)
	})
	cases := []map[string]any{
		{"path": "/api/ddi/v1/dns/auth_zone", "filter": strings.Repeat("a", 201)},
		{"path": "/api/ddi/v1/dns/auth_zone", "fields": "fqdn;drop"},
	}
	for _, c := range cases {
		if out := s.RunAITool(context.Background(), "api_get", c); !strings.Contains(out, "not accepted") {
			t.Errorf("%v: want refusal, got %s", c, out)
		}
	}
	if len(*paths) != 0 {
		t.Fatalf("refused calls must not reach the tenant: %v", *paths)
	}
}

func TestAPIGetHidesSecretLookingFields(t *testing.T) {
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, []map[string]any{{"name": "k1", "secret": "s3cr3t", "nested": map[string]any{"password": "p4ss"}}})
	})
	out := s.RunAITool(context.Background(), "api_get", map[string]any{"path": "/api/ddi/v1/dns/acl"})
	if strings.Contains(out, "s3cr3t") || strings.Contains(out, "p4ss") || !strings.Contains(out, "k1") {
		t.Fatalf("secret-looking values must be hidden: %s", out)
	}
}

func TestAPIGetUpstreamFailureIsNotReportedAsEmpty(t *testing.T) {
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})
	out := s.RunAITool(context.Background(), "api_get", map[string]any{"path": "/api/ddi/v1/dns/acl"})
	if !strings.Contains(out, "Could not reach Infoblox") {
		t.Fatalf("got %s", out)
	}
}
