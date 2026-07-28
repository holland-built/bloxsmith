package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

// newAIToolsTestService wires a Service to an httptest REST fake, with s.Mcp
// left nil — RunAITool's REST-backed tools must work even when MCP is
// completely unavailable, which is the whole point of this migration.
func newAIToolsTestService(t *testing.T, handler http.HandlerFunc) (*Service, *[]string) {
	t.Helper()
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path+"?"+r.URL.RawQuery)
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	c := rest.New(srv.URL, rest.NewAuth("test-key", nil))
	return New(c, cache.New()), &paths
}

func writeResults(w http.ResponseWriter, rows []map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"results": rows})
}

// writeResultsWithPage is writeResults plus a raw "page" object, for testing
// the _is_total_size_needed contract (page.total_size as a JSON string).
func writeResultsWithPage(w http.ResponseWriter, rows []map[string]any, page any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"results": rows, "page": page})
}

func TestRunAITool_GetSubnets_UsesRESTNotMCP(t *testing.T) {
	s, paths := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, []map[string]any{
			{"id": "1", "name": "sub1", "address": "10.0.0.0", "cidr": 24,
				"utilization": map[string]any{"total": 256, "used": 10}},
		})
	})
	out := s.RunAITool(context.Background(), "get_subnets", map[string]any{})
	if !strings.Contains(out, "sub1") {
		t.Fatalf("expected subnet data in output, got %q", out)
	}
	if len(*paths) != 1 || !strings.HasPrefix((*paths)[0], "/api/ddi/v1/ipam/subnet?") {
		t.Fatalf("unexpected paths called: %v", *paths)
	}
	if !strings.Contains((*paths)[0], "_limit=5000") {
		t.Fatalf("expected _limit=5000 param, got %s", (*paths)[0])
	}
	if !strings.Contains((*paths)[0], "_is_total_size_needed=true") {
		t.Fatalf("expected _is_total_size_needed=true param, got %s", (*paths)[0])
	}
}

func TestRunAITool_GetHosts_UsesRESTPathAndLimit(t *testing.T) {
	s, paths := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, []map[string]any{
			{"display_name": "host1", "composite_status": "online"},
		})
	})
	out := s.RunAITool(context.Background(), "get_hosts", map[string]any{})
	if !strings.Contains(out, "host1") {
		t.Fatalf("expected host data in output, got %q", out)
	}
	if len(*paths) != 1 || !strings.HasPrefix((*paths)[0], "/api/infra/v1/detail_hosts?") {
		t.Fatalf("unexpected paths called: %v", *paths)
	}
	if !strings.Contains((*paths)[0], "_limit=500") {
		t.Fatalf("expected _limit=500 param, got %s", (*paths)[0])
	}
	if !strings.Contains((*paths)[0], "_is_total_size_needed=true") {
		t.Fatalf("expected _is_total_size_needed=true param, got %s", (*paths)[0])
	}
}

// TestRunAITool_GetHosts_UsesPageTotalSizeWhenPresent is the regression guard
// for the "500 hosts" bug: detail_hosts is a second endpoint (like subnets)
// where the fetched/capped row count is NOT the tenant total. page.total_size
// ("548" over 3 fetched rows) must win as total_count.
func TestRunAITool_GetHosts_UsesPageTotalSizeWhenPresent(t *testing.T) {
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResultsWithPage(w,
			[]map[string]any{
				{"display_name": "host1", "composite_status": "online"},
				{"display_name": "host2", "composite_status": "online"},
				{"display_name": "host3", "composite_status": "offline"},
			},
			map[string]any{"offset": 1, "total_size": "548"})
	})
	out := s.RunAITool(context.Background(), "get_hosts", map[string]any{})
	var payload struct {
		Summary    string `json:"summary"`
		TotalCount int    `json:"total_count"`
		Returned   int    `json:"returned"`
		Truncated  bool   `json:"truncated"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("output is not the expected envelope: %v (%s)", err, out)
	}
	if payload.TotalCount != 548 {
		t.Fatalf("total_count = %d, want 548 (from page.total_size, not the 3 fetched rows)", payload.TotalCount)
	}
	if payload.Returned != 3 {
		t.Fatalf("returned = %d, want 3", payload.Returned)
	}
	if !payload.Truncated {
		t.Fatalf("truncated = false, want true when total_count (548) > returned (3)")
	}
	if !strings.Contains(payload.Summary, "548") || !strings.Contains(payload.Summary, "hosts") {
		t.Fatalf("summary missing total/noun: %q", payload.Summary)
	}
}

// TestRunAITool_GetHosts_MissingPageFallsBackToRowCount covers the no-page
// case (a REST backend that ignores _is_total_size_needed): total_count must
// fall back to the fetched row count, not invent a number.
func TestRunAITool_GetHosts_MissingPageFallsBackToRowCount(t *testing.T) {
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, []map[string]any{
			{"display_name": "host1", "composite_status": "online"},
			{"display_name": "host2", "composite_status": "online"},
		})
	})
	out := s.RunAITool(context.Background(), "get_hosts", map[string]any{})
	var payload struct {
		TotalCount int  `json:"total_count"`
		Truncated  bool `json:"truncated"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("output is not the expected envelope: %v (%s)", err, out)
	}
	if payload.TotalCount != 2 {
		t.Fatalf("total_count = %d, want 2 (fallback to fetched row count)", payload.TotalCount)
	}
	if payload.Truncated {
		t.Fatalf("truncated = true, want false when fallback total equals returned")
	}
}

func TestRunAITool_GetDNS_QueriesViewsAndZones(t *testing.T) {
	s, paths := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/ddi/v1/dns/view"):
			writeResults(w, []map[string]any{{"id": "v1", "name": "default"}})
		case strings.HasPrefix(r.URL.Path, "/api/ddi/v1/dns/auth_zone"):
			writeResults(w, []map[string]any{{"fqdn": "example.com.", "view": "v1"}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	})
	out := s.RunAITool(context.Background(), "get_dns", map[string]any{})
	if !strings.Contains(out, "example.com.") || !strings.Contains(out, "default") {
		t.Fatalf("expected views+zones in output, got %q", out)
	}
	if len(*paths) != 2 {
		t.Fatalf("expected 2 REST calls (views, zones), got %v", *paths)
	}
}

func TestRunAITool_GetDHCPLeases_UsesRESTPath(t *testing.T) {
	s, paths := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, []map[string]any{
			{"address": "10.0.0.5", "hostname": "dev1", "state": "used"},
		})
	})
	out := s.RunAITool(context.Background(), "get_dhcp_leases", map[string]any{})
	if !strings.Contains(out, "dev1") {
		t.Fatalf("expected lease data in output, got %q", out)
	}
	if len(*paths) != 1 || !strings.HasPrefix((*paths)[0], "/api/ddi/v1/dhcp/lease?") {
		t.Fatalf("unexpected paths called: %v", *paths)
	}
}

func TestRunAITool_GetThreatFeeds_UsesRESTPath(t *testing.T) {
	s, paths := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, []map[string]any{
			{"name": "feed1", "threat_level": "high", "item_count": 42},
		})
	})
	out := s.RunAITool(context.Background(), "get_threat_feeds", map[string]any{})
	if !strings.Contains(out, "feed1") {
		t.Fatalf("expected feed data in output, got %q", out)
	}
	if len(*paths) != 1 || !strings.HasPrefix((*paths)[0], "/api/atcfw/v1/named_lists?") {
		t.Fatalf("unexpected paths called: %v", *paths)
	}
}

func TestRunAITool_GetAuditLogs_UsesRESTPathAndLimit(t *testing.T) {
	s, paths := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, []map[string]any{
			{"created_at": "2026-01-01T00:00:00Z", "user_name": "alice", "action": "update"},
		})
	})
	out := s.RunAITool(context.Background(), "get_audit_logs", map[string]any{"limit": float64(5)})
	if !strings.Contains(out, "alice") {
		t.Fatalf("expected audit data in output, got %q", out)
	}
	if len(*paths) != 1 || !strings.HasPrefix((*paths)[0], "/api/auditlog/v1/logs?") {
		t.Fatalf("unexpected paths called: %v", *paths)
	}
	if !strings.Contains((*paths)[0], "_limit=5") {
		t.Fatalf("expected _limit=5 param, got %s", (*paths)[0])
	}
}

func TestRunAITool_GetDNSAnalytics_UsesCubejsREST(t *testing.T) {
	s, paths := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/cubejs/v1/query") {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		q := r.URL.Query().Get("query")
		var parsed map[string]any
		if err := json.Unmarshal([]byte(q), &parsed); err != nil {
			t.Fatalf("query param not valid JSON: %v", err)
		}
		measures, _ := parsed["measures"].([]any)
		if len(measures) != 1 || measures[0] != "NstarDnsActivity.total_query_count" {
			t.Fatalf("unexpected measures: %v", parsed["measures"])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{
				"data": []map[string]any{
					{"NstarDnsActivity.device_name": "dev1", "NstarDnsActivity.total_query_count": "270196"},
				},
			},
		})
	})
	out := s.RunAITool(context.Background(), "get_dns_analytics", map[string]any{"days": float64(7)})
	if !strings.Contains(out, "270196") {
		t.Fatalf("expected cube row in output, got %q", out)
	}
	if len(*paths) != 1 {
		t.Fatalf("expected 1 cubejs call, got %v", *paths)
	}
}

// TestRunAITool_GetSubnets_ReportsTrueTotalWhenTruncated is the regression
// guard for the "26 subnets" bug: capMaps(data, aiSampleCap) used to silently
// drop rows past the cap with no way for the model to know more existed.
// This test covers the no-page-object fallback: when the fake endpoint (like
// a REST backend that ignores _is_total_size_needed) returns no "page",
// total_count falls back to the fetched row count — still correctly
// flagging truncated:true against the capped sample.
func TestRunAITool_GetSubnets_ReportsTrueTotalWhenTruncated(t *testing.T) {
	rows := make([]map[string]any, 150)
	for i := range rows {
		rows[i] = map[string]any{"id": strconv.Itoa(i), "name": "sub", "address": "10.0.0.0", "cidr": 24}
	}
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, rows)
	})
	out := s.RunAITool(context.Background(), "get_subnets", map[string]any{})
	var payload struct {
		TotalCount int  `json:"total_count"`
		Returned   int  `json:"returned"`
		Truncated  bool `json:"truncated"`
		Sample     []map[string]any
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("output is not the expected envelope: %v (%s)", err, out)
	}
	if payload.TotalCount != 150 {
		t.Fatalf("total_count = %d, want 150 (fallback: the fetched row count)", payload.TotalCount)
	}
	if payload.Returned != aiSampleCap {
		t.Fatalf("returned = %d, want %d (the capped sample size)", payload.Returned, aiSampleCap)
	}
	if !payload.Truncated {
		t.Fatalf("truncated = false, want true when total_count > returned")
	}
	if len(payload.Sample) != aiSampleCap {
		t.Fatalf("sample length = %d, want %d", len(payload.Sample), aiSampleCap)
	}
}

// TestRunAITool_GetDNS_CapsViews is the regression guard for defect 2: views
// used to be sent through normViews(viewsD) completely uncapped (312 view
// objects in one payload), which was both a token hog and — with an oversized
// zones payload alongside it — coincided with the model losing count and
// answering "43 zones" for a real 1533. views must now go through the same
// cappedPayload envelope (noun "DNS views") as zones does.
func TestRunAITool_GetDNS_CapsViews(t *testing.T) {
	views := make([]map[string]any, 40)
	for i := range views {
		views[i] = map[string]any{"id": strconv.Itoa(i), "name": "view" + strconv.Itoa(i)}
	}
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/ddi/v1/dns/view"):
			writeResults(w, views)
		case strings.HasPrefix(r.URL.Path, "/api/ddi/v1/dns/auth_zone"):
			writeResults(w, []map[string]any{{"fqdn": "example.com.", "view": "0"}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	})
	out := s.RunAITool(context.Background(), "get_dns", map[string]any{})
	var payload struct {
		Views struct {
			Summary    string           `json:"summary"`
			TotalCount int              `json:"total_count"`
			Returned   int              `json:"returned"`
			Truncated  bool             `json:"truncated"`
			Sample     []map[string]any `json:"sample"`
		} `json:"views"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("output is not the expected envelope: %v (%s)", err, out)
	}
	if payload.Views.TotalCount != 40 {
		t.Fatalf("views.total_count = %d, want 40", payload.Views.TotalCount)
	}
	if payload.Views.Returned != aiSampleCap || len(payload.Views.Sample) != aiSampleCap {
		t.Fatalf("views.returned/sample = %d/%d, want %d/%d",
			payload.Views.Returned, len(payload.Views.Sample), aiSampleCap, aiSampleCap)
	}
	if !payload.Views.Truncated {
		t.Fatalf("views.truncated = false, want true (40 views capped to %d)", aiSampleCap)
	}
	if !strings.Contains(payload.Views.Summary, "40") || !strings.Contains(payload.Views.Summary, "DNS views") {
		t.Fatalf("views.summary missing total/noun: %q", payload.Views.Summary)
	}
}

// TestRunAITool_GetSubnets_UsesPageTotalSizeWhenPresent is the regression
// guard for the "1000 subnets" bug: page.total_size (a JSON STRING) is the
// only authoritative tenant-wide count — the fetched/capped row count is
// NOT the total. When the fake endpoint returns page.total_size="72316" for
// only 3 fetched rows, total_count must reflect 72316, not 3 or 100.
func TestRunAITool_GetSubnets_UsesPageTotalSizeWhenPresent(t *testing.T) {
	s, paths := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResultsWithPage(w,
			[]map[string]any{
				{"id": "1", "name": "sub1", "address": "10.0.0.0", "cidr": 24},
				{"id": "2", "name": "sub2", "address": "10.0.1.0", "cidr": 24},
				{"id": "3", "name": "sub3", "address": "10.0.2.0", "cidr": 24},
			},
			map[string]any{"offset": 0, "page_token": "", "size": 0, "total_size": "72316"})
	})
	out := s.RunAITool(context.Background(), "get_subnets", map[string]any{})
	var payload struct {
		Summary    string `json:"summary"`
		TotalCount int    `json:"total_count"`
		Returned   int    `json:"returned"`
		Truncated  bool   `json:"truncated"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("output is not the expected envelope: %v (%s)", err, out)
	}
	if payload.TotalCount != 72316 {
		t.Fatalf("total_count = %d, want 72316 (from page.total_size, not the 3 fetched rows)", payload.TotalCount)
	}
	if payload.Returned != 3 {
		t.Fatalf("returned = %d, want 3", payload.Returned)
	}
	if !payload.Truncated {
		t.Fatalf("truncated = false, want true when total_count (72316) > returned (3)")
	}
	// The summary sentence carries the authoritative total in plain digits so
	// a mid-tier model (llama-3.3-70b via Groq) parrots the right number
	// instead of the sample size — this is the fix for the "100 subnets" bug.
	if !strings.Contains(payload.Summary, "72316") {
		t.Fatalf("summary does not contain the authoritative total: %q", payload.Summary)
	}
	if !strings.Contains(payload.Summary, "subnets") {
		t.Fatalf("summary missing the per-tool noun %q: %q", "subnets", payload.Summary)
	}
	if !strings.Contains(payload.Summary, "sample") {
		t.Fatalf("summary should flag the sample/truncated case: %q", payload.Summary)
	}
	if !strings.HasPrefix(out, `{"summary":`) {
		t.Fatalf("summary must be the first key in the serialized JSON, got %s", out)
	}
	if len(*paths) != 1 || !strings.Contains((*paths)[0], "_is_total_size_needed=true") {
		t.Fatalf("expected _is_total_size_needed=true on the request, got %v", *paths)
	}
}

// TestRunAITool_GetSubnets_MalformedPageFallsBackWithoutPanic covers a
// missing page object, a non-string total_size, and unparseable/negative
// total_size — all must fall back to the fetched row count rather than
// inventing a number or panicking on a bad type assertion. total_size="0" is
// NOT in this list — a genuine zero is a valid total, not malformed input;
// see TestPageTotalSize_ZeroIsValidNotFallback.
func TestRunAITool_GetSubnets_MalformedPageFallsBackWithoutPanic(t *testing.T) {
	cases := []struct {
		name string
		page any
	}{
		{"missing page", nil},
		{"total_size is a number not a string", map[string]any{"total_size": 72316}},
		{"total_size is garbage", map[string]any{"total_size": "not-a-number"}},
		{"total_size is negative", map[string]any{"total_size": "-3"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
				if tc.page == nil {
					writeResults(w, []map[string]any{{"id": "1", "name": "sub1", "address": "10.0.0.0", "cidr": 24}})
					return
				}
				writeResultsWithPage(w, []map[string]any{{"id": "1", "name": "sub1", "address": "10.0.0.0", "cidr": 24}}, tc.page)
			})
			out := s.RunAITool(context.Background(), "get_subnets", map[string]any{})
			var payload struct {
				TotalCount int  `json:"total_count"`
				Truncated  bool `json:"truncated"`
			}
			if err := json.Unmarshal([]byte(out), &payload); err != nil {
				t.Fatalf("output is not the expected envelope: %v (%s)", err, out)
			}
			if payload.TotalCount != 1 {
				t.Fatalf("total_count = %d, want 1 (fallback to fetched row count)", payload.TotalCount)
			}
			if payload.Truncated {
				t.Fatalf("truncated = true, want false when fallback total equals returned")
			}
		})
	}
}

// TestRunAITool_GetHosts_ReportsUntruncatedTotal is the other half of the
// contract: when nothing was cut, truncated must still be reported (as
// false) and total_count must equal the sample size — a consistent shape
// the model can rely on rather than inferring by counting.
func TestRunAITool_GetHosts_ReportsUntruncatedTotal(t *testing.T) {
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, []map[string]any{
			{"display_name": "host1", "composite_status": "online"},
			{"display_name": "host2", "composite_status": "offline"},
		})
	})
	out := s.RunAITool(context.Background(), "get_hosts", map[string]any{})
	var payload struct {
		Summary    string `json:"summary"`
		TotalCount int    `json:"total_count"`
		Returned   int    `json:"returned"`
		Truncated  bool   `json:"truncated"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("output is not the expected envelope: %v (%s)", err, out)
	}
	if payload.TotalCount != 2 || payload.Returned != 2 {
		t.Fatalf("total_count/returned = %d/%d, want 2/2", payload.TotalCount, payload.Returned)
	}
	if payload.Truncated {
		t.Fatalf("truncated = true, want false when nothing was cut")
	}
	// Untruncated summary must NOT imply a partial/sample list — that would be
	// its own inaccuracy — and must still name the noun and the true count.
	if !strings.Contains(payload.Summary, "2 hosts exist in total; all are listed below.") {
		t.Fatalf("unexpected untruncated summary: %q", payload.Summary)
	}
	if strings.Contains(payload.Summary, "sample") {
		t.Fatalf("untruncated summary should not mention a sample: %q", payload.Summary)
	}
}

// TestRunAITool_UpstreamErrorIsNotReportedAsAbsence is the core regression
// guard for the fetch-failure-vs-absence bug: a 500 from the Infoblox REST
// proxy used to collapse into the tool's "No X data." sentinel (see the
// now-removed TestRunAITool_UpstreamErrorDegradesGracefully, which asserted
// exactly that as the DESIRED behavior). That sentinel is fed straight to an
// LLM which relays it to a human as fact — "you have no hosts" — when the
// truth is Infoblox was unreachable. Every REST-backed tool must now say the
// read FAILED, worded so it cannot be mistaken for an empty result, and must
// NOT emit the absence sentinel.
func TestRunAITool_UpstreamErrorIsNotReportedAsAbsence(t *testing.T) {
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	tools := []struct{ name, absenceSentinel string }{
		{"get_subnets", "No subnet data."},
		{"get_hosts", "No host data."},
		{"get_dns", ""}, // get_dns has no absence sentinel; only the failure property applies
		{"get_dhcp_leases", "No lease data."},
		{"get_threat_feeds", "No threat feed data."},
		{"get_audit_logs", "No audit log data."},
		{"get_dns_analytics", "No DNS analytics data."},
	}
	for _, tc := range tools {
		t.Run(tc.name, func(t *testing.T) {
			out := s.RunAITool(context.Background(), tc.name, map[string]any{})
			if tc.absenceSentinel != "" && out == tc.absenceSentinel {
				t.Fatalf("%s: upstream 500 reported as absence (%q) instead of a lookup failure", tc.name, out)
			}
			if strings.Contains(out, "No ") && strings.Contains(out, " data.") {
				t.Fatalf("%s: failure output still reads like an absence sentinel: %q", tc.name, out)
			}
			if !strings.Contains(out, "lookup failure") {
				t.Fatalf("%s: expected failure output to state it is a lookup failure, got %q", tc.name, out)
			}
			if !strings.Contains(out, "do not tell the user") {
				t.Fatalf("%s: expected failure output to instruct the model not to report absence, got %q", tc.name, out)
			}
		})
	}
}

// TestRunAITool_NetworkErrorIsNotReportedAsAbsence covers a genuine transport
// failure (nothing listening on the port) rather than an HTTP error status —
// GetEx/GetStrict see status 0, a distinct failure path from the >=400 branch
// above, and it must degrade the same way: failure wording, not absence.
func TestRunAITool_NetworkErrorIsNotReportedAsAbsence(t *testing.T) {
	closedSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := closedSrv.URL
	closedSrv.Close() // nothing is listening on this port now

	c := rest.New(deadURL, rest.NewAuth("test-key", nil))
	s := New(c, cache.New())

	out := s.RunAITool(context.Background(), "get_subnets", map[string]any{})
	if out == "No subnet data." {
		t.Fatalf("network error reported as absence: %q", out)
	}
	if !strings.Contains(out, "lookup failure") || !strings.Contains(out, "do not tell the user") {
		t.Fatalf("expected lookup-failure wording, got %q", out)
	}
}

// TestRunAITool_EmptySuccessfulReadKeepsAbsenceWording is the other half of
// the contract: a genuine 200-with-zero-rows result is NOT a failure, and
// must keep the exact pre-existing "No X data." wording unchanged.
func TestRunAITool_EmptySuccessfulReadKeepsAbsenceWording(t *testing.T) {
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/cubejs/v1/query") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"data": []any{}}})
			return
		}
		writeResults(w, []map[string]any{})
	})
	tools := []struct{ name, want string }{
		{"get_subnets", "No subnet data."},
		{"get_hosts", "No host data."},
		{"get_dhcp_leases", "No lease data."},
		{"get_threat_feeds", "No threat feed data."},
		{"get_audit_logs", "No audit log data."},
		{"get_dns_analytics", "No DNS analytics data."},
	}
	for _, tc := range tools {
		t.Run(tc.name, func(t *testing.T) {
			out := s.RunAITool(context.Background(), tc.name, map[string]any{})
			if out != tc.want {
				t.Fatalf("%s: got %q, want %q", tc.name, out, tc.want)
			}
		})
	}
}

// TestRunAITool_MCPUnavailableDoesNotBlockRESTTools is the core regression
// guard for this migration: a Service with a completely nil Mcp client (the
// broken parquet store / dead /mcp case) must still answer the REST-backed
// tools. Only search_entity, which genuinely needs MCP, should fail.
func TestRunAITool_MCPUnavailableDoesNotBlockRESTTools(t *testing.T) {
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, []map[string]any{
			{"id": "1", "name": "sub1", "address": "10.0.0.0", "cidr": 24},
		})
	})
	if s.Mcp != nil {
		t.Fatalf("test setup: expected nil Mcp")
	}
	out := s.RunAITool(context.Background(), "get_subnets", map[string]any{})
	if !strings.Contains(out, "sub1") {
		t.Fatalf("REST-backed tool blocked by nil Mcp: %q", out)
	}
	// search_entity is the one tool still on the MCP path, so it should fail
	// cleanly (not panic) with Mcp nil.
	out = s.RunAITool(context.Background(), "search_entity", map[string]any{"query": "x"})
	if !strings.Contains(out, "Tool error") {
		t.Fatalf("expected search_entity to report a tool error with nil Mcp, got %q", out)
	}
}
